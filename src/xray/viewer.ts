/**
 * Viewer identity and scope (block: xray).
 *
 * The dashboard cookie is a signed JWT (`typ: viewer`, ADR-4) rather than a session row, which is
 * what lets it survive a restart with no store at all (A-25 loses the log; the viewer keeps
 * working). `src/xray` signs it with the same `JwtService` `src/app.ts` builds for `src/auth`, so
 * `jose` stays inside its two owning blocks (docs/REPO_LAYOUT.md section 3).
 *
 * `resolveScope` turns "this cookie plus this query string" into the one `XrayViewerScope` the
 * fan-out, the replay and every REST route agree on. A pairing viewer sees every grant of its
 * login and nothing else; only an admin cookie may ask for `all=1` (CLAUDE.md invariant 11).
 */
import type { Request, Response } from 'express';

import {
  COOKIE_NAMES,
  PUBLIC_LANE_QUERY,
  PUBLIC_LOGIN_ID,
  TOKEN_LIFETIMES_SECONDS,
  type JwtService,
  type ViewerKind,
  type XrayViewerScope,
} from '../contracts/index.js';

import type { ReadModel } from './read-model.js';
import type { ViewerIdentity } from './types.js';

/** Cookies without `cookie-parser`: this block adds no dependency for six lines of parsing. */
export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // One malformed cookie must never take a request down; the raw value still verifies or not.
      return raw;
    }
  }
  return null;
}

export interface IssueViewerCookieInput {
  readonly jwt: JwtService;
  readonly response: Response;
  readonly viewerKind: ViewerKind;
  /** `null` in observer mode, which is not bound to a login. */
  readonly loginId: string | null;
  readonly audience: string;
  readonly ttlSeconds?: number;
}

/**
 * Mints the viewer JWT and sets it as `xray_viewer`. `SameSite=Lax` on purpose: the pairing
 * landing `/xray/s/:code` is reached by a top-level navigation from the chat window, and a
 * `Strict` cookie would not be sent on the redirect that follows (invariant 12 keeps `Secure` and
 * `HttpOnly`).
 */
export async function issueViewerCookie(input: IssueViewerCookieInput): Promise<string> {
  // The public lane is read with `?lane=public` and never through a cookie (D-26): a cookie would
  // replace the pairing cookie of the same browser.
  if (input.viewerKind === 'public') throw new Error('the public lane is read without a cookie');
  const ttlSeconds = input.ttlSeconds ?? TOKEN_LIFETIMES_SECONDS.viewer;
  const { token, expiresAt } = await input.jwt.sign(
    'viewer',
    { aud: input.audience, login_id: input.loginId, viewer_kind: input.viewerKind },
    ttlSeconds,
  );
  input.response.cookie(COOKIE_NAMES.viewer, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: ttlSeconds * 1000,
    path: '/',
  });
  return expiresAt;
}

/** Clears the cookie; used when a token no longer verifies. */
export function clearViewerCookie(response: Response): void {
  response.clearCookie(COOKIE_NAMES.viewer, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}

/** Verifies the cookie. Returns `null` for absent, malformed, expired or wrong-`typ` tokens. */
export async function readViewer(
  jwt: JwtService,
  request: Request,
): Promise<ViewerIdentity | null> {
  const token = readCookie(request, COOKIE_NAMES.viewer);
  if (token === null || token === '') return null;
  try {
    const claims = await jwt.verify(token, 'viewer');
    return {
      viewer_kind: claims.viewer_kind,
      login_id: claims.login_id,
      expires_at: new Date(claims.exp * 1000).toISOString(),
    };
  } catch {
    // A bad cookie is simply not a viewer. The reason never reaches the client.
    return null;
  }
}

export type ScopeResolution =
  | { readonly ok: true; readonly scope: XrayViewerScope }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly message: string };

/** Reads one query parameter as a string; Express hands arrays for repeated keys. */
function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/** True when a request asks for the public lane (`?lane=public`, contracts v0.7). */
export function wantsPublicLane(query: Record<string, unknown>): boolean {
  return firstString(query.lane) === PUBLIC_LANE_QUERY.lane;
}

/**
 * The reader of the public lane (D-26): no cookie, bound to `PUBLIC_LOGIN_ID`, read-only. What it
 * sees was announced as public to every agent that sent it, in the server instructions and in
 * every public tool description (`PUBLIC_LANE_NOTICE`).
 */
export function publicLaneViewer(now: Date): ViewerIdentity {
  return {
    viewer_kind: 'public',
    login_id: PUBLIC_LOGIN_ID,
    expires_at: new Date(now.getTime() + TOKEN_LIFETIMES_SECONDS.viewer * 1000).toISOString(),
  };
}

/**
 * `?xs=<id>` | `?login=me` | `?all=1` (docs/XRAY_EVENT_MODEL.md section 5). Exactly one applies;
 * with none of them a pairing viewer gets its login, a public reader the public lane (its login is
 * `PUBLIC_LOGIN_ID`) and an admin gets everything.
 */
export function resolveScope(
  viewer: ViewerIdentity,
  query: Record<string, unknown>,
  readModel: ReadModel,
): ScopeResolution {
  const xs = firstString(query.xs);
  const login = firstString(query.login);
  const all = firstString(query.all);
  const isAdmin = viewer.viewer_kind === 'admin';

  if (all === '1' || all === 'true') {
    if (!isAdmin) {
      return {
        ok: false,
        status: 403,
        error: 'forbidden',
        message: 'Observer mode needs the admin cookie.',
      };
    }
    return { ok: true, scope: { viewer_kind: 'admin', filter: 'all', login_id: null, xs: null } };
  }

  if (xs !== null && xs !== '') {
    if (!isAdmin) {
      const owner = readModel.loginOfSession(xs);
      if (owner === null || owner !== viewer.login_id) {
        return {
          ok: false,
          status: 403,
          error: 'forbidden',
          message: 'That session belongs to another login.',
        };
      }
    }
    return {
      ok: true,
      scope: { viewer_kind: viewer.viewer_kind, filter: 'xs', login_id: viewer.login_id, xs },
    };
  }

  if (isAdmin) {
    if (login === 'me') {
      return {
        ok: false,
        status: 400,
        error: 'invalid_request',
        message: 'Observer mode is not bound to a login; use all=1 or xs=<id>.',
      };
    }
    return { ok: true, scope: { viewer_kind: 'admin', filter: 'all', login_id: null, xs: null } };
  }

  if (login !== null && login !== '' && login !== 'me') {
    return {
      ok: false,
      status: 400,
      error: 'invalid_request',
      message: 'The only accepted value is login=me.',
    };
  }
  if (viewer.login_id === null) {
    return {
      ok: false,
      status: 403,
      error: 'forbidden',
      message: 'This viewer cookie is not bound to a login.',
    };
  }
  return {
    ok: true,
    scope: { viewer_kind: viewer.viewer_kind, filter: 'login', login_id: viewer.login_id, xs: null },
  };
}
