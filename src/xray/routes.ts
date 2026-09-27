/**
 * The X-ray HTTP surface (block: xray).
 *
 * Every route of docs/XRAY_EVENT_MODEL.md section 6, typed against `src/contracts/xray-api.ts`.
 * The router is mounted at `/xray` by the composition root, so the paths here are the routes of
 * `XRAY_ROUTES` with that prefix removed - the constants stay the single source of truth.
 *
 * Three rules run through all of it (CLAUDE.md invariant 11):
 *   - nothing private is answered without a viewer cookie, and a pairing cookie only ever sees the
 *     grants of its own login (`resolveScope` and `readModel.matchesScope` decide);
 *   - an admin cookie sees everything, harder redacted (`applyObserverRedaction`);
 *   - every event leaves through `viewEvent` (v0.9, D-28): the log stores events as they arrived
 *     and the redaction of `redaction.ts` runs here, on the way out, never on the way in;
 *   - `?lane=public` (v0.7, D-26) answers without a cookie for the public lane alone: the pseudo
 *     login `PUBLIC_LOGIN_ID`, read-only, whose callers were told their calls are public.
 *
 * The export (v0.8, D-27) is the one exception to the second and third rules: it hands the
 * operator the log as stored - raw requests, headers and bodies included - and it also takes the
 * admin token as a bearer so a single `curl` downloads it. A pairing viewer's or the public
 * lane's export is redacted like the dashboard.
 *
 * The SPA itself, `/xray/assets/*` and `/xray/fixtures/events.jsonl` belong to the `dashboard`
 * block: this router leaves those paths untouched so the static handler behind it answers them.
 */
import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';

import {
  MAX_EVENTS_PAGE_LIMIT,
  PUBLIC_LOGIN_ID,
  XRAY_EXPORT_CONTENT_TYPE,
  XRAY_ROUTES,
  type PairResponse,
  type ViewerMeResponse,
  type XrayCatalogResponse,
  type XrayErrorResponse,
  type XrayPersonaSummary,
  type XraySessionDetailResponse,
  type XraySessionEventsResponse,
  type XraySessionSummary,
  type XrayDeleteResponse,
  type XraySessionBankResponse,
  type XraySessionsResponse,
  type XrayEvent,
  type XrayViewerScope,
} from '../contracts/index.js';

import type { Pipeline } from './emitter.js';
import type { EventLog } from './log.js';
import type { XrayPairing } from './pairing.js';
import type { ReadModel, SessionRow } from './read-model.js';
import { ipPrefixOf, viewEvent } from './redaction.js';
import type { Ring } from './ring.js';
import { logFilterFor, openSseStream, type SseStream } from './sse.js';
import type { BankSummaryLookup, PersonaLookup, ViewerIdentity, XrayConfig } from './types.js';
import {
  issueViewerCookie,
  publicLaneViewer,
  readViewer,
  resolveScope,
  wantsPublicLane,
} from './viewer.js';
import type { JwtService } from '../contracts/index.js';

const MOUNT_PREFIX = '/xray';

/** `/xray/api/me` -> `/api/me`: the routes of the contract, relative to the mount point. */
function mounted(route: string): string {
  if (!route.startsWith(MOUNT_PREFIX)) return route;
  const remainder = route.slice(MOUNT_PREFIX.length);
  return remainder === '' ? '/' : remainder;
}

export interface XrayRoutesRuntime {
  readonly config: XrayConfig;
  readonly jwt: JwtService;
  readonly pipeline: Pipeline;
  readonly log: EventLog;
  readonly readModel: ReadModel;
  /** The live buffer; the replay falls back to it when the log is degraded. */
  readonly ring: Ring;
  readonly pairing: XrayPairing;
  readonly now: () => Date;
  readonly lookupPersona?: PersonaLookup | undefined;
  readonly lookupBankSummary?: BankSummaryLookup | undefined;
  readonly heartbeatMs?: number | undefined;
  readonly onError: (error: unknown, where: string) => void;
  /** Every open stream, so `shutdown` can end them inside the 10 s SIGTERM budget. */
  readonly streams: Set<SseStream>;
}

function sendError(response: Response, status: number, error: string, message: string): void {
  const body: XrayErrorResponse = { error, message };
  response.status(status).json(body);
}

/** The `/24` prefix of the caller, honouring `trust proxy` (invariants 11 and 12). */
function ipPrefixOfRequest(request: Request): string | null {
  return ipPrefixOf(request.ip ?? request.socket.remoteAddress ?? null);
}

/**
 * What a stream is counted against. A pairing viewer is bound to its login (invariant 11), so the
 * login is the quota; an admin observer and a login-less scope fall back to the session or to one
 * shared admin bucket, which is deliberate - observer mode is a single operator, not the public.
 */
function keyForStreamQuota(scope: XrayViewerScope): string {
  if (scope.viewer_kind === 'admin') return 'admin';
  if (scope.viewer_kind === 'public') return 'public';
  if (scope.login_id !== null && scope.login_id !== undefined) return `lgn:${scope.login_id}`;
  return `xs:${scope.xs ?? 'unknown'}`;
}

/** Rows per SQLite page of an export: one page is parsed and written before the loop yields. */
export const EXPORT_PAGE_ROWS = 1000;

/** `glass-bank-xray-20260926T141500Z.jsonl`: sortable, and safe in a `Content-Disposition`. */
function exportFileName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return `glass-bank-xray-${stamp}.jsonl`;
}

/** The token of an `Authorization: Bearer <token>` header, or `null`. */
function bearerOf(request: Request): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.get('authorization') ?? '');
  return match?.[1] ?? null;
}

/** Resolves once the socket can take more, or once it is gone: a closed client must not hang us. */
function drained(response: Response): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.on('drain', done);
    response.on('close', done);
  });
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function positiveInteger(value: unknown, fallback: number, max: number): number {
  const raw = firstString(value);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

/** The tiny landing page for a failed `/xray/s/:code`. English only, no dashboard assets. */
function pairingErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Glass Bank X-ray</title></head>
  <body>
    <h1>This link did not work</h1>
    <p>${message}</p>
    <p><a href="/xray/">Open the dashboard and enter the code by hand</a></p>
  </body>
</html>
`;
}

const PAIRING_FAILURE_STATUS: Record<string, number> = {
  rate_limited: 429,
  expired: 410,
  unknown_code: 404,
  malformed: 400,
};

const PAIRING_FAILURE_MESSAGE: Record<string, string> = {
  rate_limited: 'Too many failed attempts from this address. Try again in a minute.',
  expired: 'That pairing code has expired. Ask for a new link in the chat.',
  unknown_code: 'That pairing code is not valid.',
  malformed: 'A pairing code looks like BANK-XXXX-XXXX-XX.',
};

export function buildXrayRouter(runtime: XrayRoutesRuntime): Router {
  const { config, jwt, pipeline, log, readModel, ring, pairing } = runtime;
  const router: Router = express.Router();

  // Small bodies only: both POST routes carry one short string.
  router.use(express.json({ limit: '32kb' }));

  /** Resolves the viewer cookie or answers 401; `?lane=public` needs no cookie and ignores one. */
  const requireViewer: RequestHandler = (request, response, next) => {
    if (wantsPublicLane(request.query as Record<string, unknown>)) {
      response.locals.viewer = publicLaneViewer(runtime.now());
      next();
      return;
    }
    void (async () => {
      const viewer = await readViewer(jwt, request);
      if (!viewer) {
        sendError(
          response,
          401,
          'unauthorized',
          'Open the pairing link from the chat, or enter the code on the dashboard.',
        );
        return;
      }
      response.locals.viewer = viewer;
      next();
    })().catch((error: unknown) => {
      runtime.onError(error, 'requireViewer');
      sendError(response, 500, 'internal_error', 'The viewer cookie could not be read.');
    });
  };

  function viewerOf(response: Response): ViewerIdentity {
    return response.locals.viewer as ViewerIdentity;
  }

  /** Open SSE streams and exports per quota key; see `keyForStreamQuota`. */
  const streamsByKey = new Map<string, number>();

  /**
   * The stream budget, shared by the SSE streams and the exports: both are long responses that
   * hold a socket and a buffer. Answers the 429 itself and returns `null` when the budget is spent;
   * otherwise returns the quota key to hold with `holdStreamSlot`.
   */
  function streamQuotaKeyOrRefuse(scope: XrayViewerScope, response: Response): string | null {
    // Nothing else bounds these: each open stream owns a queue, and Cloud Run allows 250
    // concurrent requests against 1 GiB. A viewer that stops reading must cost a bounded amount.
    const streamKey = keyForStreamQuota(scope);
    const perLogin = streamsByKey.get(streamKey) ?? 0;
    if (runtime.streams.size >= runtime.config.xrayMaxStreams) {
      response.setHeader('Retry-After', '5');
      sendError(
        response,
        429,
        'too_many_streams',
        'This server is already serving as many live streams as it can. Retry in a few seconds.',
      );
      return null;
    }
    const perKeyCap =
      scope.viewer_kind === 'public'
        ? runtime.config.xrayMaxPublicStreams
        : runtime.config.xrayMaxStreamsPerLogin;
    if (perLogin >= perKeyCap) {
      response.setHeader('Retry-After', '5');
      sendError(
        response,
        429,
        'too_many_streams',
        'This login already has the maximum number of live dashboard streams open. Close one tab and retry.',
      );
      return null;
    }
    return streamKey;
  }

  /** Counts `handle` against `streamKey` until the request or the response closes. */
  function holdStreamSlot(
    streamKey: string,
    handle: SseStream,
    request: Request,
    response: Response,
  ): void {
    runtime.streams.add(handle);
    streamsByKey.set(streamKey, (streamsByKey.get(streamKey) ?? 0) + 1);
    let forgotten = false;
    const forget = (): void => {
      if (forgotten) return; // `close` fires on both the request and the response.
      forgotten = true;
      runtime.streams.delete(handle);
      const remaining = (streamsByKey.get(streamKey) ?? 1) - 1;
      if (remaining <= 0) streamsByKey.delete(streamKey);
      else streamsByKey.set(streamKey, remaining);
    };
    request.on('close', forget);
    response.on('close', forget);
  }

  /** Resolves the scope for a request, answering the error itself when it cannot. */
  function scopeOf(query: Record<string, unknown>, response: Response): XrayViewerScope | null {
    const resolution = resolveScope(viewerOf(response), query, readModel);
    if (!resolution.ok) {
      sendError(response, resolution.status, resolution.error, resolution.message);
      return null;
    }
    return resolution.scope;
  }

  async function personaOf(personaId: string | null): Promise<XrayPersonaSummary | null> {
    if (personaId === null || !runtime.lookupPersona) return null;
    try {
      return await runtime.lookupPersona(personaId);
    } catch (error) {
      runtime.onError(error, 'lookupPersona');
      return null;
    }
  }

  async function toSummary(row: SessionRow): Promise<XraySessionSummary> {
    return {
      xs: row.xs,
      login_id: row.login_id,
      grant_id: row.grant_id,
      parent_grant_id: row.parent_grant_id,
      persona: await personaOf(row.persona_id),
      client: row.client,
      protocol_version: row.protocol_version,
      era: row.era,
      started_at: row.started_at,
      last_seen_at: row.last_seen_at,
      initialize_count: row.initialize_count,
      call_count: row.call_count,
      error_count: row.error_count,
      token_expires_at: row.token_expires_at,
      boot_id: row.boot_id,
    };
  }

  // -------------------------------------------------------------------------
  // Pairing and observer mode
  // -------------------------------------------------------------------------

  /** `GET /xray/s/:code`: the link shown in chat. Sets the cookie, then hands over to the SPA. */
  router.get(mounted(XRAY_ROUTES.pairingLanding), (request, response) => {
    void (async () => {
      const code = String(request.params.code ?? '');
      const result = await pairing.exchange(code, {
        remote_ip_prefix: ipPrefixOfRequest(request),
      });
      if (!result.ok) {
        const status = PAIRING_FAILURE_STATUS[result.reason] ?? 400;
        const message = PAIRING_FAILURE_MESSAGE[result.reason] ?? 'That pairing code is not valid.';
        if (request.accepts(['html', 'json']) === 'json') {
          sendError(response, status, result.reason, message);
        } else {
          response.status(status).type('html').send(pairingErrorPage(message));
        }
        return;
      }
      await issueViewerCookie({
        jwt,
        response,
        viewerKind: result.viewer_kind,
        loginId: result.login_id,
        audience: config.publicBaseUrl,
      });
      response.redirect(302, XRAY_ROUTES.spa);
    })().catch((error: unknown) => {
      runtime.onError(error, 'pairingLanding');
      sendError(response, 500, 'internal_error', 'The pairing code could not be exchanged.');
    });
  });

  /** `POST /xray/api/pair {code}`: the same exchange for the code box in the SPA. */
  router.post(mounted(XRAY_ROUTES.pair), (request, response) => {
    void (async () => {
      const body = (request.body ?? {}) as { code?: unknown };
      const code = typeof body.code === 'string' ? body.code : '';
      const result = await pairing.exchange(code, {
        remote_ip_prefix: ipPrefixOfRequest(request),
      });
      if (!result.ok) {
        sendError(
          response,
          PAIRING_FAILURE_STATUS[result.reason] ?? 400,
          result.reason,
          PAIRING_FAILURE_MESSAGE[result.reason] ?? 'That pairing code is not valid.',
        );
        return;
      }
      const expiresAt = await issueViewerCookie({
        jwt,
        response,
        viewerKind: result.viewer_kind,
        loginId: result.login_id,
        audience: config.publicBaseUrl,
      });
      const payload: PairResponse = {
        ok: true,
        viewer_kind: result.viewer_kind,
        login_id: result.login_id,
        expires_at: expiresAt,
      };
      response.status(200).json(payload);
    })().catch((error: unknown) => {
      runtime.onError(error, 'pair');
      sendError(response, 500, 'internal_error', 'The pairing code could not be exchanged.');
    });
  });

  /** `POST /xray/api/admin {token}`: the single observer entry point (Decision D-5). */
  router.post(mounted(XRAY_ROUTES.admin), (request, response) => {
    void (async () => {
      const key = ipPrefixOfRequest(request) ?? 'unknown';
      if (pairing.limiter.isLimited(key)) {
        sendError(response, 429, 'rate_limited', PAIRING_FAILURE_MESSAGE.rate_limited as string);
        return;
      }
      const body = (request.body ?? {}) as { token?: unknown };
      const token = typeof body.token === 'string' ? body.token : '';
      const result = await pairing.exchangeAdminToken(token);
      if (!result.ok) {
        pairing.limiter.recordFailure(key);
        sendError(response, 403, 'forbidden', 'That admin token is not valid.');
        return;
      }
      const expiresAt = await issueViewerCookie({
        jwt,
        response,
        viewerKind: 'admin',
        loginId: null,
        audience: config.publicBaseUrl,
      });
      const payload: PairResponse = {
        ok: true,
        viewer_kind: 'admin',
        login_id: null,
        expires_at: expiresAt,
      };
      response.status(200).json(payload);
    })().catch((error: unknown) => {
      runtime.onError(error, 'admin');
      sendError(response, 500, 'internal_error', 'The admin token could not be exchanged.');
    });
  });

  // -------------------------------------------------------------------------
  // The read model
  // -------------------------------------------------------------------------

  router.get(mounted(XRAY_ROUTES.me), requireViewer, (_request, response) => {
    void (async () => {
      const viewer = viewerOf(response);
      if (viewer.viewer_kind === 'admin') {
        const payload: ViewerMeResponse = {
          viewer_kind: 'admin',
          login_id: null,
          expires_at: viewer.expires_at,
        };
        response.status(200).json(payload);
        return;
      }
      if (viewer.viewer_kind === 'public') {
        const payload: ViewerMeResponse = {
          viewer_kind: 'public',
          login_id: PUBLIC_LOGIN_ID,
          grant_ids: readModel.grantIdsForLogin(PUBLIC_LOGIN_ID),
          persona: null,
          expires_at: viewer.expires_at,
        };
        response.status(200).json(payload);
        return;
      }
      const loginId = viewer.login_id ?? '';
      const payload: ViewerMeResponse = {
        viewer_kind: 'pairing',
        login_id: viewer.login_id,
        grant_ids: readModel.grantIdsForLogin(loginId),
        persona: await personaOf(readModel.personaOfLogin(loginId)),
        expires_at: viewer.expires_at,
      };
      response.status(200).json(payload);
    })().catch((error: unknown) => {
      runtime.onError(error, 'me');
      sendError(response, 500, 'internal_error', 'The viewer could not be described.');
    });
  });

  router.get(mounted(XRAY_ROUTES.sessions), requireViewer, (request, response) => {
    void (async () => {
      const scope = scopeOf(request.query as Record<string, unknown>, response);
      if (!scope) return;
      const rows = readModel.sessions(scope);
      const data = await Promise.all(rows.map((row) => toSummary(row)));
      const payload: XraySessionsResponse = { data, page: { next: null } };
      response.status(200).json(payload);
    })().catch((error: unknown) => {
      runtime.onError(error, 'sessions');
      sendError(response, 500, 'internal_error', 'The sessions could not be listed.');
    });
  });

  router.get(mounted(XRAY_ROUTES.sessionEvents), requireViewer, (request, response) => {
    void (async () => {
      const xs = String(request.params.xs ?? '');
      const scope = scopeOf({ ...(request.query as Record<string, unknown>), xs }, response);
      if (!scope) return;
      pipeline.flush();
      const after = positiveInteger(request.query.after, 0, Number.MAX_SAFE_INTEGER);
      const limit = positiveInteger(request.query.limit, 200, MAX_EVENTS_PAGE_LIMIT);
      const events = log
        .readSession(xs, after, limit)
        .filter((event) => readModel.matchesScope(event, scope))
        .map((event) => viewEvent(event, scope.viewer_kind));
      const lastId = events.length > 0 ? events[events.length - 1]?.id : undefined;
      const payload: XraySessionEventsResponse = {
        data: events,
        page: { next: events.length === limit && lastId ? String(lastId) : null },
      };
      response.status(200).json(payload);
    })().catch((error: unknown) => {
      runtime.onError(error, 'sessionEvents');
      sendError(response, 500, 'internal_error', 'The session history could not be read.');
    });
  });

  /**
   * `DELETE /xray/api/sessions/:xs` and `DELETE /xray/api/events` (v0.4): the viewer erases its
   * own history. Observer mode is refused: an operator holding the admin token can read every
   * session, and letting that same token destroy someone else's evidence is not a read model
   * (invariant 11). The erase covers the SQLite log, the live ring - or the next
   * `Last-Event-ID` replay would bring it all back - and the read model.
   */
  function erase(
    response: Response,
    target: { readonly kind: 'session'; readonly xs: string } | { readonly kind: 'login' },
  ): void {
    const viewer = viewerOf(response);
    if (viewer.viewer_kind !== 'pairing' || viewer.login_id === null) {
      sendError(
        response,
        403,
        'forbidden',
        'Observer mode and the public lane are read-only. Only the viewer who owns a login may erase its history.',
      );
      return;
    }
    const loginId = viewer.login_id;
    const query = target.kind === 'session' ? { xs: target.xs } : { login: 'me' };
    const scope = scopeOf(query, response);
    if (!scope) return;

    // Queued events first, or an event emitted a moment ago would survive the delete and be
    // written to the log straight afterwards.
    pipeline.flush();

    let deleted: number;
    let sessionsGone: number;
    if (target.kind === 'session') {
      deleted = log.deleteMatching({ kind: 'xs', xs: target.xs });
      ring.remove((event) => event.xs === target.xs);
      sessionsGone = readModel.forgetSession(target.xs) ? 1 : 0;
    } else {
      const sessionIds = readModel.sessionIdsForLogin(loginId);
      const grantIds = readModel.grantIdsForLogin(loginId);
      const owned = new Set(sessionIds);
      const ownedGrants = new Set(grantIds);
      deleted = log.deleteMatching({ kind: 'login', loginId, sessionIds, grantIds });
      ring.remove(
        (event) =>
          event.login_id === loginId ||
          (event.xs !== null && owned.has(event.xs)) ||
          (event.grant_id !== null && ownedGrants.has(event.grant_id)),
      );
      sessionsGone = readModel.forgetLogin(loginId);
    }

    // Emitted after the delete on purpose: it is the one record that survives it. A page able to
    // destroy its own evidence with no trace would be worse than one that cannot erase at all.
    pipeline.emitter.emit(
      'xray.events.deleted',
      {
        scope: target.kind,
        xs_deleted: target.kind === 'session' ? target.xs : null,
        deleted_count: deleted,
        sessions_deleted: sessionsGone,
        viewer_kind: viewer.viewer_kind,
      },
      { login_id: loginId },
    );

    const payload: XrayDeleteResponse = {
      deleted,
      sessions: sessionsGone,
      scope: target.kind,
    };
    response.status(200).json(payload);
  }

  router.delete(mounted(XRAY_ROUTES.session), requireViewer, (request, response) => {
    try {
      erase(response, { kind: 'session', xs: String(request.params.xs ?? '') });
    } catch (error) {
      runtime.onError(error, 'deleteSession');
      sendError(response, 500, 'internal_error', 'The session could not be erased.');
    }
  });

  router.delete(mounted(XRAY_ROUTES.events), requireViewer, (_request, response) => {
    try {
      erase(response, { kind: 'login' });
    } catch (error) {
      runtime.onError(error, 'deleteEvents');
      sendError(response, 500, 'internal_error', 'The history could not be erased.');
    }
  });

  router.get(mounted(XRAY_ROUTES.session), requireViewer, (request, response) => {
    void (async () => {
      const xs = String(request.params.xs ?? '');
      const scope = scopeOf({ ...(request.query as Record<string, unknown>), xs }, response);
      if (!scope) return;
      const row = readModel.session(xs);
      if (!row) {
        sendError(response, 404, 'not_found', 'No such session.');
        return;
      }
      const catalog = readModel.catalog(xs);
      const payload: XraySessionDetailResponse = {
        session: await toSummary(row),
        grant: row.grant_id ? readModel.grant(row.grant_id) : null,
        catalog,
        availability: catalog?.availability ?? [],
        counters: readModel.counters(xs),
      };
      response.status(200).json(payload);
    })().catch((error: unknown) => {
      runtime.onError(error, 'session');
      sendError(response, 500, 'internal_error', 'The session could not be read.');
    });
  });

  /**
   * `GET /xray/api/sessions/:xs/bank` (v0.3): the persona card. Same visibility rule as the
   * session detail; the numbers are the ones the tools return to the model, overlay applied.
   */
  router.get(mounted(XRAY_ROUTES.sessionBank), requireViewer, (request, response) => {
    void (async () => {
      const xs = String(request.params.xs ?? '');
      const scope = scopeOf({ ...(request.query as Record<string, unknown>), xs }, response);
      if (!scope) return;
      const row = readModel.session(xs);
      if (!row) {
        sendError(response, 404, 'not_found', 'No such session.');
        return;
      }
      if (row.persona_id === null) {
        sendError(response, 404, 'no_persona', 'This session has no persona yet.');
        return;
      }
      if (!runtime.lookupBankSummary) {
        sendError(response, 503, 'unavailable', 'The bank is not wired into this dashboard.');
        return;
      }
      const summary = await runtime.lookupBankSummary({
        persona_id: row.persona_id,
        login_id: row.login_id,
        grant_id: row.grant_id,
      });
      if (summary === null) {
        sendError(response, 404, 'no_persona', 'The persona behind this session is unknown.');
        return;
      }
      const payload: XraySessionBankResponse = { ...summary, xs: row.xs, login_id: row.login_id };
      response.status(200).json(payload);
    })().catch((error: unknown) => {
      runtime.onError(error, 'sessionBank');
      sendError(response, 500, 'internal_error', 'The persona card could not be built.');
    });
  });

  router.get(mounted(XRAY_ROUTES.catalog), requireViewer, (request, response) => {
    const xs = firstString(request.query.xs);
    if (xs === null || xs === '') {
      sendError(response, 400, 'invalid_request', 'A session id is required: ?xs=<id>.');
      return;
    }
    const scope = scopeOf(request.query as Record<string, unknown>, response);
    if (!scope) return;
    const snapshot = readModel.catalog(xs);
    if (!snapshot) {
      sendError(response, 404, 'not_found', 'No catalog snapshot for that session yet.');
      return;
    }
    const payload: XrayCatalogResponse = snapshot;
    response.status(200).json(payload);
  });

  // -------------------------------------------------------------------------
  // The stream
  // -------------------------------------------------------------------------

  router.get(mounted(XRAY_ROUTES.stream), requireViewer, (request, response) => {
    const scope = scopeOf(request.query as Record<string, unknown>, response);
    if (!scope) return;
    // No timeout on an SSE response: Cloud Run cuts it at 60 minutes and the replay hides the cut.
    request.socket.setTimeout(0);
    request.socket.setNoDelay(true);
    request.socket.setKeepAlive(true);
    const streamKey = streamQuotaKeyOrRefuse(scope, response);
    if (streamKey === null) return;

    const stream = openSseStream({
      request,
      response,
      scope,
      pipeline,
      log,
      readModel,
      ring,
      now: runtime.now,
      ...(runtime.heartbeatMs === undefined ? {} : { heartbeatMs: runtime.heartbeatMs }),
      onError: runtime.onError,
    });
    holdStreamSlot(streamKey, stream, request, response);
  });

  // -------------------------------------------------------------------------
  // The export (v0.8, D-27)
  // -------------------------------------------------------------------------

  /**
   * The export's reader: `?lane=public` first, as everywhere; then the admin token as a bearer,
   * checked like `POST /xray/api/admin` (constant time, failures rate-limited per IP prefix);
   * otherwise the viewer cookie.
   */
  const requireExportViewer: RequestHandler = (request, response, next) => {
    const token = wantsPublicLane(request.query as Record<string, unknown>) ? null : bearerOf(request);
    if (token === null) {
      requireViewer(request, response, next);
      return;
    }
    void (async () => {
      const key = ipPrefixOfRequest(request) ?? 'unknown';
      if (pairing.limiter.isLimited(key)) {
        sendError(response, 429, 'rate_limited', PAIRING_FAILURE_MESSAGE.rate_limited as string);
        return;
      }
      const result = await pairing.exchangeAdminToken(token);
      if (!result.ok) {
        pairing.limiter.recordFailure(key);
        sendError(response, 403, 'forbidden', 'That admin token is not valid.');
        return;
      }
      const viewer: ViewerIdentity = {
        viewer_kind: 'admin',
        login_id: null,
        expires_at: runtime.now().toISOString(),
      };
      response.locals.viewer = viewer;
      next();
    })().catch((error: unknown) => {
      runtime.onError(error, 'requireExportViewer');
      sendError(response, 500, 'internal_error', 'The admin token could not be checked.');
    });
  };

  /**
   * `GET /xray/api/export` (v0.8, D-27): every event the scope may read, as JSONL, oldest first.
   * The upper bound is the newest id when the request arrives, so a busy server cannot keep an
   * export open forever. Pages of `EXPORT_PAGE_ROWS` come from the SQLite log - from the ring when
   * the log is degraded - and the loop yields between pages and waits for `drain`, so a
   * 200,000-row export never holds the event loop or buffers the whole log in memory. Verbatim on
   * purpose for the admin: the export is the operator's copy, and the observer view stays the
   * redacted one. Any other reader gets `viewEvent`, the dashboard's own view (v0.9, D-28).
   */
  router.get(mounted(XRAY_ROUTES.export), requireExportViewer, (request, response) => {
    const query = request.query as Record<string, unknown>;
    const scope = scopeOf(query, response);
    if (!scope) return;
    const streamKey = streamQuotaKeyOrRefuse(scope, response);
    if (streamKey === null) return;
    const handle: SseStream = { close: () => response.destroy() };
    holdStreamSlot(streamKey, handle, request, response);

    void (async () => {
      pipeline.flush();
      const after = positiveInteger(query.after, 0, Number.MAX_SAFE_INTEGER);
      const until = log.degraded ? (ring.last(1)[0]?.id ?? 0) : log.maxId();
      const filter = logFilterFor(scope, readModel);
      const page = (cursor: number): XrayEvent[] =>
        log.degraded
          ? ring.after(cursor, EXPORT_PAGE_ROWS)
          : log.readAfter(cursor, EXPORT_PAGE_ROWS, filter);

      response.status(200);
      response.setHeader('Content-Type', XRAY_EXPORT_CONTENT_TYPE);
      response.setHeader(
        'Content-Disposition',
        `attachment; filename="${exportFileName(runtime.now())}"`,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.flushHeaders();

      let cursor = after;
      let done = cursor >= until;
      while (!done && !response.destroyed) {
        const rows = page(cursor);
        let chunk = '';
        for (const event of rows) {
          if (event.id > until) break;
          cursor = event.id;
          if (!readModel.matchesScope(event, scope)) continue;
          // The operator's copy is the log as stored (D-27, D-28); every other reader of the
          // export - a pairing viewer, the public lane - gets the same view as the dashboard.
          const shown = scope.viewer_kind === 'admin' ? event : viewEvent(event, scope.viewer_kind);
          chunk += `${JSON.stringify(shown)}\n`;
        }
        // Past the bound, a short page or the bound itself: nothing older is left to read.
        done = rows.length < EXPORT_PAGE_ROWS || cursor >= until || (rows.at(-1)?.id ?? 0) > until;
        if (chunk !== '' && !response.write(chunk)) await drained(response);
        if (!done) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      response.end();
    })().catch((error: unknown) => {
      runtime.onError(error, 'export');
      // The status line is long gone: cutting the body is the only honest signal left.
      if (response.headersSent) response.destroy();
      else sendError(response, 500, 'internal_error', 'The event log could not be exported.');
    });
  });

  // Anything else under /xray/api is a 404 in the contract's error shape. The SPA, its assets and
  // the fixtures live outside /api and fall through to the `dashboard` static handler.
  router.use('/api', (request, response) => {
    sendError(response, 404, 'not_found', `No X-ray route for ${request.method} ${request.path}.`);
  });

  return router;
}
