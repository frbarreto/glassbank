/**
 * The mock authorization server (block: auth).
 *
 * Implements docs/ARCHITECTURE.md section 5 end to end: discovery, DCR, the browser pages
 * carried by a signed `txn` JWT with a CSRF double-submit, the consent success page with the
 * persona id and the dashboard pairing link, `/token` with PKCE S256 and rotating refresh tokens,
 * and `/revoke`. Every refusal and every state change it decides is reported to the X-ray through
 * the injected emitter (`events.ts` states which half of the `auth.*` family is this block's).
 *
 * Hand-rolled rather than mounted on the SDK's `mcpAuthRouter` - see docs/blocks/auth.md for the
 * three reasons (per-request issuer derivation, PRM at two paths, and the browser pages).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import express from 'express';
import type { Request, RequestHandler, Response, Router } from 'express';

import {
  ACCESS_TOKEN_PREFIX,
  COOKIE_NAMES,
  ID_PREFIXES,
  OAUTH_ROUTES,
  TOKEN_LIFETIMES_SECONDS,
  applyAccessTokenPrefix,
  authLevelForScopes,
  canonicalBaseUrl,
  canonicalMcpUrl,
  formatScopeString,
  isAcceptableAudience,
  isAllowedRedirectUri,
  isId,
  issuerUrl,
  normaliseFeatureFlags,
  parseScopeString,
  refreshLifetimeSeconds,
  supportedScopes,
  type AuthRejectionReason,
  type JwtService,
  type OAuthClient,
  type Pairing,
  type PairingCode,
  type Persona,
  type PersonaDirectory,
  type Scope,
  type XrayEmitter,
} from '../contracts/index.js';

import { clientIdFingerprint, type ClientStore } from './clients.js';
import {
  grantCorrelation,
  grantCreatedData,
  grantUpdatedData,
  rejectedData,
  tokenIssuedData,
  tokenRefreshedData,
} from './events.js';
import { isJwtError } from './jwt.js';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import {
  renderConsentPage,
  renderConsentSuccessPage,
  renderErrorPage,
  renderLoginPage,
  type PairingAbsence,
} from './pages.js';
import { clientIpOf, ipPrefixOf, type RateLimiter } from './rate-limit.js';
import type { BoundedLru, ExpiringSet } from './store.js';
import type { AuthConfig, GrantRecord, SpikeLogger } from './types.js';

/** Everything the route handlers share. Built once by `createAuth`. */
export interface AuthRuntime {
  readonly config: AuthConfig;
  readonly jwt: JwtService;
  readonly clients: ClientStore;
  readonly personas: PersonaDirectory;
  readonly grants: BoundedLru<string, GrantRecord>;
  readonly consumedCodes: ExpiringSet;
  readonly rotatedRefresh: ExpiringSet;
  /**
   * Revoked `grant_id`s. An `ExpiringSet`, not a plain `Set`: access tokens are stateless JWTs, so
   * this is the only thing that can stop one, and an unbounded set that is only ever added to
   * grows for the life of the process (ADR-16, and the promise store.ts's header makes).
   * The entry expires at the *refresh* lifetime of the grant, so revoking a short-lived access
   * token still kills the long-lived refresh token.
   */
  readonly revokedGrants: ExpiringSet;
  readonly limiters: {
    readonly register: RateLimiter;
    readonly authorize: RateLimiter;
    readonly consent: RateLimiter;
    /** Keyed on the caller-supplied `client_id`; may only narrow, never replace, `tokenIp`. */
    readonly token: RateLimiter;
    /** Keyed on the client address, which a caller cannot rotate behind a trusted proxy. */
    readonly tokenIp: RateLimiter;
    /** `RATE_LIMIT_LOGIN_GRANTS`: new grants per `login_id` per day (invariant 14). */
    readonly loginGrants: RateLimiter;
  };
  readonly now: () => Date;
  readonly log: SpikeLogger;
  /** The X-ray producer. Already wrapped so it cannot throw into an OAuth response. */
  readonly emitter: XrayEmitter;
  /** The dashboard pairing service (ADR-10), when `src/xray` has been wired in. */
  readonly pairing: Pairing | null;
  /** How long the consent success page waits before redirecting; `0` disables the page. */
  readonly consentSuccessRedirectMs: number;
  readonly newId: (prefix: string) => string;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

/**
 * The hostname this request arrived on. Cloud Run forwards the original `Host`; a tunnel or a
 * reverse proxy uses `X-Forwarded-Host`, which Express only honours with `trust proxy` on
 * (invariant 12).
 */
export function requestHost(request: Request): string | null {
  const forwarded = request.headers['x-forwarded-host'];
  const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const host = (typeof candidate === 'string' && candidate.length > 0 ? candidate : request.headers.host) ?? null;
  if (host === null) return null;
  return host.split(',')[0]?.trim() ?? null;
}

function baseUrlFor(request: Request, config: AuthConfig): string {
  return canonicalBaseUrl(requestHost(request), config);
}

/** `Cache-Control: no-store` plus the anti-framing headers of invariant 15. */
function securityHeaders(response: Response): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

/**
 * Discovery documents and the token endpoints are fetched by browser-based clients (the MCP
 * Inspector UI), so they answer CORS preflights. The Origin *policy* of invariant 10 is a
 * separate, `/mcp`-side concern and lives in `src/mcp`.
 */
function applyCors(request: Request, response: Response): void {
  const origin = request.headers.origin;
  response.setHeader('Access-Control-Allow-Origin', typeof origin === 'string' ? origin : '*');
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, content-type, mcp-protocol-version, x-request-id',
  );
  response.setHeader('Access-Control-Max-Age', '600');
}

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
      // `decodeURIComponent` throws URIError on a value that is not valid percent-encoding.
      // A cookie is only ever compared or verified here, so the undecoded string is a fine
      // answer - and one malformed cookie must never be able to take the process down.
      return raw;
    }
  }
  return null;
}

/** Every cookie this service sets is `Secure` and `HttpOnly` (invariant 12). */
function setCookie(
  response: Response,
  name: string,
  value: string,
  options: { readonly maxAgeSeconds: number; readonly sameSite: 'strict' | 'lax' },
): void {
  response.cookie(name, value, {
    httpOnly: true,
    secure: true,
    sameSite: options.sameSite,
    maxAge: options.maxAgeSeconds * 1000,
    path: '/',
  });
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function oauthError(
  response: Response,
  status: number,
  error: string,
  description: string,
): void {
  response.status(status).json({ error, error_description: description });
}

/** PKCE S256: `BASE64URL(SHA256(ASCII(code_verifier)))` (RFC 7636). */
export function pkceChallengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function redirectWithError(
  response: Response,
  redirectUri: string,
  state: string | null,
  issuer: string,
  error: string,
  description: string,
): void {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state !== null) url.searchParams.set('state', state);
  url.searchParams.set('iss', issuer);
  response.redirect(302, url.toString());
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

export function buildAuthRouter(runtime: AuthRuntime): Router {
  const router = express.Router();
  const { config } = runtime;
  const enabledFlags = normaliseFeatureFlags(config.featureFlags);
  const allowDevLoopback = config.nodeEnv !== 'production';

  // Body parsing, scoped to this router's own endpoints.
  //
  // The router is mounted at the root, so an unscoped `router.use(...)` would parse every request
  // on its way to /mcp as well and impose this 256 kb limit there instead of the mcp block's
  // 4 mb. The composition root mounts its own fallback parsers *after* both routers, so this
  // limit is the one that actually applies to /register, /token, /revoke, /login and /consent.
  const BODY_PARSED_ROUTES = [
    OAUTH_ROUTES.register,
    OAUTH_ROUTES.authorize,
    OAUTH_ROUTES.login,
    OAUTH_ROUTES.consent,
    OAUTH_ROUTES.token,
    OAUTH_ROUTES.revoke,
  ];
  router.use(BODY_PARSED_ROUTES, express.json({ limit: '256kb' }));
  router.use(BODY_PARSED_ROUTES, express.urlencoded({ extended: false, limit: '256kb' }));

  function log(event: string, request: Request, extra: Record<string, unknown> = {}): void {
    runtime.log({
      event,
      ts: runtime.now().toISOString(),
      method: request.method,
      path: request.path,
      remote_ip_prefix: ipPrefixOf(clientIpOf(request)),
      user_agent: request.get('user-agent') ?? null,
      origin: request.get('origin') ?? null,
      host: requestHost(request),
      ...extra,
    });
  }

  /**
   * One `auth.rejected` from the authorization server's own endpoints. The `mcp` gate emits the
   * bearer-token half of this event type; these are the browser and `/token` refusals, which the
   * gate never sees (docs/blocks/auth.md "Events owned").
   */
  function rejected(
    reason: AuthRejectionReason,
    input: {
      readonly status: number;
      readonly error: string;
      readonly clientId?: string | null;
      readonly loginId?: string | null;
      readonly personaId?: string | null;
      readonly grantId?: string | null;
    },
  ): void {
    const fingerprint =
      typeof input.clientId === 'string' ? clientIdFingerprint(input.clientId) : null;
    runtime.emitter.emit(
      'auth.rejected',
      rejectedData({
        status: input.status,
        error: input.error,
        reason,
        clientFingerprint: fingerprint,
      }),
      {
        login_id: input.loginId ?? null,
        persona_id: input.personaId ?? null,
        grant_id: input.grantId ?? null,
      },
    );
  }

  function limited(
    limiter: RateLimiter,
    key: string,
    request: Request,
    response: Response,
  ): boolean {
    const decision = limiter.hit(key);
    if (decision.allowed) return false;
    response.setHeader('Retry-After', String(decision.retryAfterSeconds));
    log('auth.rate_limited', request, { limit_key: key });
    oauthError(
      response,
      429,
      'too_many_requests',
      'Too many requests from this caller; retry after the interval in the Retry-After header.',
    );
    return true;
  }

  // ---- Discovery -----------------------------------------------------------------------------

  const metadataHandler =
    (build: (baseUrl: string) => unknown): RequestHandler =>
    (request, response) => {
      applyCors(request, response);
      response.setHeader('Cache-Control', 'public, max-age=60');
      const baseUrl = baseUrlFor(request, config);
      log('auth.metadata_served', request, { base_url: baseUrl });
      response.status(200).json(build(baseUrl));
    };

  const preflight: RequestHandler = (request, response) => {
    applyCors(request, response);
    response.status(204).end();
  };

  for (const path of [
    OAUTH_ROUTES.protectedResourceMetadata,
    OAUTH_ROUTES.protectedResourceMetadataForMcp,
    OAUTH_ROUTES.authorizationServerMetadata,
    OAUTH_ROUTES.register,
    OAUTH_ROUTES.token,
    OAUTH_ROUTES.revoke,
  ]) {
    router.options(path, preflight);
  }

  // RFC 9728 wants the metadata at the resource-specific path; claude.ai and some clients probe
  // the bare path first. Both are served, with the same body (invariant 4).
  router.get(
    OAUTH_ROUTES.protectedResourceMetadataForMcp,
    metadataHandler((baseUrl) => protectedResourceMetadata(baseUrl, enabledFlags)),
  );
  router.get(
    OAUTH_ROUTES.protectedResourceMetadata,
    metadataHandler((baseUrl) => protectedResourceMetadata(baseUrl, enabledFlags)),
  );
  router.get(
    OAUTH_ROUTES.authorizationServerMetadata,
    metadataHandler((baseUrl) => authorizationServerMetadata(baseUrl, enabledFlags)),
  );

  // ---- Dynamic client registration (RFC 7591) ------------------------------------------------

  router.post(OAUTH_ROUTES.register, (request, response) => {
    applyCors(request, response);
    if (limited(runtime.limiters.register, clientIpOf(request), request, response)) return;

    const result = runtime.clients.register(request.body);
    if (!result.ok) {
      log('auth.client.rejected', request, { reason: result.failure.error });
      response.status(400).json(result.failure);
      return;
    }
    const client = result.client;
    log('auth.client.registered', request, {
      client_id: clientIdFingerprint(client.client_id),
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      application_type: client.application_type,
      dcr_store_size: runtime.clients.size,
    });
    // Only the fingerprint: a raw `client_id` never reaches an event (invariant 7).
    runtime.emitter.emit('auth.client.registered', {
      client_id: clientIdFingerprint(client.client_id),
      client_name: client.client_name,
      redirect_uris: [...client.redirect_uris],
      token_endpoint_auth_method: client.token_endpoint_auth_method,
      application_type: client.application_type,
    });
    response.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: client.client_id_issued_at,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: client.grant_types,
      response_types: client.response_types,
      token_endpoint_auth_method: 'none',
      application_type: client.application_type,
      scope: client.scope ?? formatScopeString(supportedScopes(enabledFlags)),
    });
  });

  // ---- /authorize ----------------------------------------------------------------------------

  async function handleAuthorize(request: Request, response: Response): Promise<void> {
    securityHeaders(response);
    if (limited(runtime.limiters.authorize, clientIpOf(request), request, response)) return;

    const source = request.method === 'POST' ? bodyOf(request) : request.query;
    const get = (name: string): string | null => firstString((source as Record<string, unknown>)[name]);

    const baseUrl = baseUrlFor(request, config);
    const issuer = issuerUrl(baseUrl);
    const clientId = get('client_id');
    if (clientId === null || clientId.length === 0) {
      response
        .status(400)
        .type('html')
        .send(renderErrorPage('Missing client', 'The authorization request carried no client_id.'));
      return;
    }

    const resolved = runtime.clients.resolve(clientId);
    if (resolved.reconstructed) {
      // A-12: after a restart the DCR store is empty; rebuilding the client with exactly the
      // claude.ai callback plus loopback keeps an existing connector working.
      log('auth.client.reconstructed', request, {
        client_id: clientIdFingerprint(clientId),
        redirect_uris: resolved.client.redirect_uris,
      });
      // `evicted_from_lru` is the other documented reason, and the AUTH_DB_PATH table is exactly
      // what makes it unreachable: a client the LRU dropped is re-hydrated from SQLite instead of
      // being rebuilt, so a reconstruction now means the id is unknown to both layers.
      runtime.emitter.emit('auth.client.reconstructed', {
        client_id: clientIdFingerprint(clientId),
        client_name: 'unknown (reconstructed)',
        redirect_uris: [...resolved.client.redirect_uris],
        reason: 'unknown_client_after_restart',
      });
    }
    const client = resolved.client;

    const requestedRedirect = get('redirect_uri');
    const redirectUri =
      requestedRedirect ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : null);
    if (
      redirectUri === null ||
      !client.redirect_uris.includes(redirectUri) ||
      !isAllowedRedirectUri(redirectUri, { allowDevLoopback })
    ) {
      // Never redirect to an unvalidated URI: this is the security boundary (A-12, A-13).
      log('auth.rejected', request, { reason: 'invalid_redirect_uri' });
      // The client id is known (or was just rebuilt); what is unknown is this callback, and the
      // contract's nearest reason for "this client may not be who it claims" is `unknown_client`.
      rejected('unknown_client', {
        status: 400,
        error: 'invalid_request',
        clientId,
      });
      response
        .status(400)
        .type('html')
        .send(
          renderErrorPage(
            'Unrecognised callback URL',
            'The redirect_uri is not registered for this client and is not on this server’s callback allowlist.',
          ),
        );
      return;
    }

    const state = get('state');
    const responseType = get('response_type');
    if (responseType !== null && responseType !== 'code') {
      redirectWithError(
        response,
        redirectUri,
        state,
        issuer,
        'unsupported_response_type',
        'Only the authorization code flow is supported.',
      );
      return;
    }

    const codeChallenge = get('code_challenge');
    const codeChallengeMethod = get('code_challenge_method') ?? 'S256';
    if (codeChallenge === null || codeChallenge.length < 16) {
      redirectWithError(
        response,
        redirectUri,
        state,
        issuer,
        'invalid_request',
        'PKCE is mandatory: send code_challenge with code_challenge_method=S256.',
      );
      return;
    }
    if (codeChallengeMethod !== 'S256') {
      redirectWithError(
        response,
        redirectUri,
        state,
        issuer,
        'invalid_request',
        'Only code_challenge_method=S256 is supported.',
      );
      return;
    }

    const supported = supportedScopes(enabledFlags);
    const requestedScopes = parseScopeString(get('scope')).filter((scope) =>
      supported.includes(scope),
    );
    const scopes: Scope[] =
      requestedScopes.length > 0 ? requestedScopes : supported.filter((scope) => !scope.endsWith(':write'));

    const requestedResource = get('resource');
    const resource =
      requestedResource !== null && isAcceptableAudience(requestedResource, config)
        ? requestedResource
        : canonicalMcpUrl(baseUrl);

    // Login continuity (ADR-14): the browser may already carry a 30-day login cookie.
    const known = await readLoginCookie(request);

    const csrf = randomBytes(24).toString('base64url');
    setCookie(response, COOKIE_NAMES.csrf, csrf, {
      maxAgeSeconds: TOKEN_LIFETIMES_SECONDS.txn,
      sameSite: 'strict',
    });

    const { token: txn } = await runtime.jwt.sign(
      'txn',
      {
        iss: issuer,
        aud: canonicalMcpUrl(baseUrl),
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        scope: formatScopeString(scopes),
        resource,
        login_id: known?.login_id ?? null,
        persona_id: known?.persona_id ?? null,
      },
      TOKEN_LIFETIMES_SECONDS.txn,
    );

    log('auth.authorize_started', request, {
      client_id: clientIdFingerprint(clientId),
      client_reconstructed: resolved.reconstructed,
      scopes,
      resource,
      has_state: state !== null,
      returning_browser: known !== null,
    });

    response
      .status(200)
      .type('html')
      .send(
        renderLoginPage({
          txn,
          csrf,
          personas: await runtime.personas.list(),
          clientName: client.client_name ?? 'An unnamed MCP client',
          clientReconstructed: resolved.reconstructed,
          requestedScopes: scopes,
          knownPersonaId: known?.persona_id ?? null,
          error: null,
          loginPath: OAUTH_ROUTES.login,
        }),
      );
  }

  // `next(error)` rather than `void handler(...)`: a rejected promise nobody observes is an
  // `unhandledRejection`, which Node 23 turns into a process exit (a total outage on a
  // `--max-instances=1` service). Express answers 500 through the composition root's handler.
  router.get(OAUTH_ROUTES.authorize, (request, response, next) => {
    handleAuthorize(request, response).catch(next);
  });
  router.post(OAUTH_ROUTES.authorize, (request, response, next) => {
    handleAuthorize(request, response).catch(next);
  });

  /** The signed 30-day `login_id` cookie, when the browser carries a valid one (ADR-14). */
  async function readLoginCookie(
    request: Request,
  ): Promise<{ login_id: string; persona_id: string } | null> {
    const raw = readCookie(request, COOKIE_NAMES.login);
    if (raw === null) return null;
    try {
      const claims = await runtime.jwt.verify(raw, 'login');
      return { login_id: claims.login_id, persona_id: claims.sub };
    } catch {
      return null;
    }
  }

  // ---- The browser POSTs ---------------------------------------------------------------------

  interface TxnCheck {
    readonly ok: boolean;
    readonly status: number;
    readonly title: string;
    readonly detail: string;
  }

  /**
   * Invariant 15: a POST whose `txn` is missing, expired or mismatched is rejected, and the
   * CSRF token in the form must equal the `SameSite=Strict` cookie (double submit).
   */
  function checkCsrf(request: Request): TxnCheck {
    const submitted = firstString(bodyOf(request).csrf);
    const cookie = readCookie(request, COOKIE_NAMES.csrf);
    if (submitted === null || cookie === null || !constantTimeEquals(submitted, cookie)) {
      return {
        ok: false,
        status: 403,
        title: 'Security check failed',
        detail:
          'This form could not be verified. Start the connection again from your MCP client.',
      };
    }
    return { ok: true, status: 200, title: '', detail: '' };
  }

  /**
   * The contract's rejection reason for a failed `txn` verification. `JwtError.reason` is already
   * one of `malformed` / `invalid_signature` / `expired` / `wrong_typ`, which are four of the
   * nine values `AuthRejectedData.reason` allows, so the mapping is an identity plus a fallback.
   */
  function jwtRejectionReason(error: unknown): AuthRejectionReason {
    return isJwtError(error) ? error.reason : 'malformed';
  }

  function txnFailure(error: unknown): TxnCheck {
    const expired = isJwtError(error) && error.reason === 'expired';
    return {
      ok: false,
      status: 400,
      title: expired ? 'This sign-in expired' : 'Invalid sign-in request',
      detail: expired
        ? 'Sign-in requests are valid for ten minutes. Start the connection again from your MCP client.'
        : 'The sign-in state was missing or could not be verified. Start the connection again from your MCP client.',
    };
  }

  function fail(response: Response, check: TxnCheck): void {
    response.status(check.status).type('html').send(renderErrorPage(check.title, check.detail));
  }

  router.post(OAUTH_ROUTES.login, (request, response, next) => {
    (async () => {
      securityHeaders(response);
      if (limited(runtime.limiters.consent, clientIpOf(request), request, response)) return;

      const csrf = checkCsrf(request);
      if (!csrf.ok) {
        log('auth.rejected', request, { reason: 'csrf_mismatch' });
        rejected('malformed', { status: 403, error: 'invalid_request' });
        fail(response, csrf);
        return;
      }

      const body = bodyOf(request);
      const rawTxn = firstString(body.txn);
      if (rawTxn === null) {
        log('auth.rejected', request, { reason: 'txn_missing' });
        rejected('no_access_token', { status: 400, error: 'invalid_request' });
        fail(response, txnFailure(null));
        return;
      }
      let txnClaims;
      try {
        txnClaims = await runtime.jwt.verify(rawTxn, 'txn');
      } catch (error) {
        log('auth.rejected', request, { reason: 'txn_invalid' });
        rejected(jwtRejectionReason(error), { status: 400, error: 'invalid_request' });
        fail(response, txnFailure(error));
        return;
      }

      const pasted = firstString(body.persona_id)?.trim() ?? '';
      const choice = firstString(body.choice) ?? '';
      let persona: Persona | null = null;

      let personaSource: 'seeded' | 'generated' | 'recovered' = 'seeded';

      if (pasted.length > 0) {
        personaSource = 'recovered';
        if (!isId(pasted, 'persona')) {
          response
            .status(400)
            .type('html')
            .send(
              renderLoginPage({
                txn: rawTxn,
                csrf: firstString(body.csrf) ?? '',
                personas: await runtime.personas.list(),
                clientName: 'An MCP client',
                clientReconstructed: false,
                requestedScopes: parseScopeString(txnClaims.scope),
                knownPersonaId: null,
                error: `"${pasted}" is not a customer id. A customer id looks like per_ followed by letters and digits.`,
                loginPath: OAUTH_ROUTES.login,
              }),
            );
          return;
        }
        persona = await runtime.personas.get(pasted);
      } else if (choice === '__new__') {
        persona = await runtime.personas.createDemoPersona();
        personaSource = 'generated';
        log('auth.persona.created', request, { persona_id: persona.id });
      } else if (choice.length > 0) {
        persona = await runtime.personas.get(choice);
      }

      if (persona === null) {
        // A pasted id nobody knows, or a radio value that no longer resolves: fall back to the
        // first seeded persona rather than failing the sign-in of a demo bank.
        const [first] = await runtime.personas.list();
        persona = first ?? (await runtime.personas.createDemoPersona());
        personaSource = first === undefined ? 'generated' : 'seeded';
      }

      // The login groups a human's grants (ADR-14). The cookie is reused when it already points
      // at this persona; choosing a different customer starts a new login so the dashboard does
      // not mix two personas under one viewer.
      const existing = await readLoginCookie(request);
      const loginId =
        existing !== null && existing.persona_id === persona.id
          ? existing.login_id
          : runtime.newId(ID_PREFIXES.login);
      if (existing === null || existing.login_id !== loginId) {
        log('auth.login.created', request, { login_id: loginId, persona_id: persona.id });
        runtime.emitter.emit(
          'auth.login.created',
          {
            login_id: loginId,
            persona_id: persona.id,
            expires_at: new Date(
              runtime.now().getTime() + TOKEN_LIFETIMES_SECONDS.login * 1000,
            ).toISOString(),
            persona_source: personaSource,
            shared_persona: persona.shared,
          },
          { login_id: loginId, persona_id: persona.id },
        );
      }

      const baseUrl = baseUrlFor(request, config);
      const { token: loginToken } = await runtime.jwt.sign(
        'login',
        {
          iss: issuerUrl(baseUrl),
          aud: canonicalMcpUrl(baseUrl),
          login_id: loginId,
          sub: persona.id,
        },
        TOKEN_LIFETIMES_SECONDS.login,
      );
      // SameSite=Lax, not Strict: claude.ai opens /authorize as a cross-site top-level
      // navigation, and a Strict cookie would not be sent on it - login continuity (A-41)
      // depends on this cookie surviving that hop.
      setCookie(response, COOKIE_NAMES.login, loginToken, {
        maxAgeSeconds: TOKEN_LIFETIMES_SECONDS.login,
        sameSite: 'lax',
      });

      const remainingSeconds = Math.max(
        30,
        txnClaims.exp - Math.floor(runtime.now().getTime() / 1000),
      );
      const { token: nextTxn } = await runtime.jwt.sign(
        'txn',
        {
          iss: txnClaims.iss ?? issuerUrl(baseUrl),
          aud: txnClaims.aud,
          client_id: txnClaims.client_id,
          redirect_uri: txnClaims.redirect_uri,
          state: txnClaims.state,
          code_challenge: txnClaims.code_challenge,
          code_challenge_method: 'S256',
          scope: txnClaims.scope,
          resource: txnClaims.resource,
          login_id: loginId,
          persona_id: persona.id,
        },
        remainingSeconds,
      );

      const client = runtime.clients.get(txnClaims.client_id);
      const extending = findGrant(loginId, txnClaims.client_id);

      response
        .status(200)
        .type('html')
        .send(
          renderConsentPage({
            txn: nextTxn,
            csrf: firstString(body.csrf) ?? '',
            persona,
            clientName: client?.client_name ?? 'An unnamed MCP client',
            requestedScopes: parseScopeString(txnClaims.scope),
            extendingGrantId: extending?.grant_id ?? null,
            error: null,
            consentPath: OAUTH_ROUTES.consent,
            showSuccessPage: runtime.consentSuccessRedirectMs > 0,
          }),
        );
    })().catch(next);
  });

  /** A grant of this login for this client, if the browser already authorized it (ADR-14). */
  function findGrant(loginId: string, clientId: string): GrantRecord | null {
    for (const grant of runtime.grants.values()) {
      if (grant.login_id === loginId && grant.client_id === clientId) {
        if (!runtime.revokedGrants.has(grant.grant_id)) return grant;
      }
    }
    return null;
  }

  router.post(OAUTH_ROUTES.consent, (request, response, next) => {
    (async () => {
      securityHeaders(response);
      if (limited(runtime.limiters.consent, clientIpOf(request), request, response)) return;

      const csrf = checkCsrf(request);
      if (!csrf.ok) {
        log('auth.rejected', request, { reason: 'csrf_mismatch' });
        rejected('malformed', { status: 403, error: 'invalid_request' });
        fail(response, csrf);
        return;
      }

      const body = bodyOf(request);
      const rawTxn = firstString(body.txn);
      if (rawTxn === null) {
        log('auth.rejected', request, { reason: 'txn_missing' });
        rejected('no_access_token', { status: 400, error: 'invalid_request' });
        fail(response, txnFailure(null));
        return;
      }
      let txnClaims;
      try {
        txnClaims = await runtime.jwt.verify(rawTxn, 'txn');
      } catch (error) {
        log('auth.rejected', request, { reason: 'txn_invalid' });
        rejected(jwtRejectionReason(error), { status: 400, error: 'invalid_request' });
        fail(response, txnFailure(error));
        return;
      }
      if (txnClaims.persona_id === null || txnClaims.login_id === null) {
        fail(response, txnFailure(null));
        return;
      }

      const baseUrl = baseUrlFor(request, config);
      const issuer = issuerUrl(baseUrl);

      if (firstString(body.decision) === 'deny') {
        log('auth.consent_denied', request, { client_id: clientIdFingerprint(txnClaims.client_id) });
        redirectWithError(
          response,
          txnClaims.redirect_uri,
          txnClaims.state,
          issuer,
          'access_denied',
          'The user declined the authorization request.',
        );
        return;
      }

      const requested = parseScopeString(txnClaims.scope);
      const rawSelected = body.scope;
      const selected = parseScopeString(
        (Array.isArray(rawSelected) ? rawSelected : [rawSelected])
          .filter((value): value is string => typeof value === 'string')
          .join(' '),
      );
      const granted: Scope[] = requested.filter(
        (scope) => selected.includes(scope) || scope === 'profile',
      );
      if (!granted.includes('profile')) granted.unshift('profile');

      const authLevel = authLevelForScopes(granted);
      const persona = await runtime.personas.get(txnClaims.persona_id);
      if (persona === null) {
        fail(response, txnFailure(null));
        return;
      }

      const existing = findGrant(txnClaims.login_id, txnClaims.client_id);
      const nowIso = runtime.now().toISOString();

      // RATE_LIMIT_LOGIN_GRANTS (invariant 14): a cap on how many *new* grants one browser may
      // mint in a day. Extending an existing grant is free - that is the ADR-14 step-up path and
      // capping it would break a legitimate write authorization - and so is the rehydration of a
      // known grant at /token, which creates no new authorization.
      if (existing === null) {
        const decision = runtime.limiters.loginGrants.hit(txnClaims.login_id);
        if (!decision.allowed) {
          log('auth.rate_limited', request, {
            limit_key: txnClaims.login_id,
            limit: 'login_grants_per_day',
          });
          // Answered as a page, not as a redirect carrying `error=`: this is an abuse control, and
          // a client that is handed an OAuth error retries immediately, which is the loop the cap
          // exists to stop. `Retry-After` tells the human when to come back.
          // `rate_limited` since contracts v0.2: an abuse control, not a protocol failure, so the
          // dashboard can tell a daily cap apart from a replayed code.
          rejected('rate_limited', {
            status: 429,
            error: 'too_many_requests',
            clientId: txnClaims.client_id,
            loginId: txnClaims.login_id,
            personaId: txnClaims.persona_id,
          });
          response.setHeader('Retry-After', String(decision.retryAfterSeconds));
          response
            .status(429)
            .type('html')
            .send(
              renderErrorPage(
                'Too many connections today',
                'This browser has authorized too many new connections in the last 24 hours. ' +
                  'Existing connections keep working; try again later.',
              ),
            );
          return;
        }
      }

      let grant: GrantRecord;
      if (existing !== null) {
        // ADR-14: the same browser re-consenting extends the grant it already has, so an open
        // X-ray and any cached tools/list keep working across a step-up. Scopes outside *this*
        // authorization request are untouched; a scope that was requested and then un-ticked is
        // taken back, because the consent page shows its box unchecked and prints the resulting
        // authorization level - a widen-only rule made the page lie.
        const requestedNow = new Set<string>(requested);
        const grantedNow = new Set<string>(granted);
        const kept = existing.scopes.filter(
          (scope) => !requestedNow.has(scope) || grantedNow.has(scope),
        );
        const widened = Array.from(new Set([...kept, ...granted]));
        grant = {
          ...existing,
          scopes: widened,
          auth_level: authLevelForScopes(widened),
          updated_at: nowIso,
        };
        runtime.grants.set(grant.grant_id, grant);
        const heldBefore = new Set<string>(existing.scopes);
        const addedScopes = widened.filter((scope) => !heldBefore.has(scope));
        log('auth.grant.updated', request, {
          grant_id: grant.grant_id,
          login_id: grant.login_id,
          persona_id: grant.persona_id,
          scopes: grant.scopes,
          auth_level: grant.auth_level,
          added_scopes: addedScopes,
        });
        runtime.emitter.emit(
          'auth.grant.updated',
          grantUpdatedData({
            grant,
            addedScopes,
            clientFingerprint: clientIdFingerprint(grant.client_id),
            // A re-consent that adds a write scope is the ADR-13 step-up; one that adds nothing
            // new (or takes a scope back) is an ordinary re-consent.
            reason: addedScopes.some((scope) => scope.endsWith(':write')) ? 'step_up' : 're_consent',
          }),
          grantCorrelation(grant),
        );
      } else {
        grant = {
          grant_id: runtime.newId(ID_PREFIXES.grant),
          login_id: txnClaims.login_id,
          persona_id: persona.id,
          client_id: txnClaims.client_id,
          scopes: granted,
          auth_level: authLevel,
          parent_grant_id: null,
          created_at: nowIso,
          updated_at: nowIso,
        };
        runtime.grants.set(grant.grant_id, grant);
        log('auth.grant.created', request, {
          grant_id: grant.grant_id,
          login_id: grant.login_id,
          persona_id: grant.persona_id,
          scopes: grant.scopes,
          auth_level: grant.auth_level,
          client_id: clientIdFingerprint(grant.client_id),
        });
        runtime.emitter.emit(
          'auth.grant.created',
          grantCreatedData({
            grant,
            clientFingerprint: clientIdFingerprint(grant.client_id),
            clientName: runtime.clients.get(grant.client_id)?.client_name ?? null,
            sharedPersona: persona.shared,
            nowMs: runtime.now().getTime(),
          }),
          grantCorrelation(grant),
        );
      }

      const { token: code } = await runtime.jwt.sign(
        'code',
        {
          iss: issuer,
          aud: txnClaims.resource,
          sub: grant.persona_id,
          client_id: grant.client_id,
          grant_id: grant.grant_id,
          login_id: grant.login_id,
          scope: formatScopeString(grant.scopes as Scope[]),
          auth_level: grant.auth_level,
          redirect_uri: txnClaims.redirect_uri,
          code_challenge: txnClaims.code_challenge,
          code_challenge_method: 'S256',
          resource: txnClaims.resource,
        },
        TOKEN_LIFETIMES_SECONDS.code,
      );

      const url = new URL(txnClaims.redirect_uri);
      url.searchParams.set('code', code);
      if (txnClaims.state !== null) url.searchParams.set('state', txnClaims.state);
      // RFC 9207: the client can tell which AS answered.
      url.searchParams.set('iss', issuer);
      const callbackUrl = url.toString();

      // docs/ARCHITECTURE.md section 5: the success page, so a user can open the X-ray before the
      // first tool call. It is only rendered for the browser that was given our consent form
      // (the hidden `show_success` field); everything else gets the 302 it has always got.
      const wantsSuccessPage =
        runtime.consentSuccessRedirectMs > 0 && firstString(body.show_success) === '1';
      if (wantsSuccessPage) {
        const { pairing, absence } = await mintPairingLink(grant);
        response
          .status(200)
          .type('html')
          .send(
            renderConsentSuccessPage({
              persona,
              clientName: runtime.clients.get(grant.client_id)?.client_name ?? 'the MCP client',
              grantedScopes: grant.scopes as Scope[],
              callbackUrl,
              pairing,
              pairingAbsence: absence,
              redirectMs: runtime.consentSuccessRedirectMs,
              extendedGrantId: existing === null ? null : grant.grant_id,
            }),
          );
        return;
      }

      response.redirect(302, callbackUrl);
    })().catch(next);
  });

  /**
   * The dashboard link for the success page (ADR-10). Bound to the **login**, never to the grant,
   * so a step-up or a second device keeps the same X-ray. `xray:read` gates it, because that is
   * exactly what the scope says on the consent page; a failure to mint one is never fatal.
   */
  async function mintPairingLink(
    grant: GrantRecord,
  ): Promise<{ pairing: PairingCode | null; absence: PairingAbsence | null }> {
    if (!grant.scopes.includes('xray:read')) return { pairing: null, absence: 'not_requested' };
    if (runtime.pairing === null) return { pairing: null, absence: 'unavailable' };
    try {
      return { pairing: await runtime.pairing.createCode({ login_id: grant.login_id }), absence: null };
    } catch {
      // The X-ray is an observer of this flow, never a gate on it (invariant 5 over invariant 13).
      return { pairing: null, absence: 'unavailable' };
    }
  }

  // ---- /token --------------------------------------------------------------------------------

  router.post(OAUTH_ROUTES.token, (request, response, next) => {
    (async () => {
      applyCors(request, response);
      response.setHeader('Cache-Control', 'no-store');
      const body = bodyOf(request);
      const clientId = firstString(body.client_id);
      // Two keys, both charged. `client_id` is unauthenticated free-form text on a public-client
      // server, so keying only on it let a caller bypass the limit entirely by sending a fresh
      // id each time - and every bypassed request still ran an HMAC verify. The caller-chosen
      // key may only *narrow* the limit, never replace the one it cannot rotate.
      if (limited(runtime.limiters.tokenIp, `ip:${clientIpOf(request)}`, request, response)) {
        return;
      }
      if (
        clientId !== null &&
        limited(runtime.limiters.token, `cid:${clientId}`, request, response)
      ) {
        return;
      }

      const grantType = firstString(body.grant_type);
      if (grantType === 'authorization_code') {
        await exchangeCode(request, response, body);
        return;
      }
      if (grantType === 'refresh_token') {
        await exchangeRefresh(request, response, body);
        return;
      }
      oauthError(
        response,
        400,
        'unsupported_grant_type',
        'Supported grant types are authorization_code and refresh_token.',
      );
    })().catch(next);
  });

  async function issueTokens(
    request: Request,
    response: Response,
    grant: GrantRecord,
    audience: string,
    reason: 'authorization_code' | 'refresh_token',
    parentJti: string | null,
  ): Promise<void> {
    const baseUrl = baseUrlFor(request, config);
    const issuer = issuerUrl(baseUrl);
    const scopeString = formatScopeString(grant.scopes as Scope[]);
    const shared = {
      iss: issuer,
      aud: audience,
      sub: grant.persona_id,
      client_id: grant.client_id,
      grant_id: grant.grant_id,
      login_id: grant.login_id,
      scope: scopeString,
      auth_level: grant.auth_level,
    };

    const access = await runtime.jwt.sign('access', shared, TOKEN_LIFETIMES_SECONDS.access);
    // A-26: the refresh lifetime *is* Ramp's idle-expiry policy, extended on every rotation.
    const refreshTtl = refreshLifetimeSeconds(grant.auth_level);
    const refresh = await runtime.jwt.sign(
      'refresh',
      { ...shared, parent_jti: parentJti },
      refreshTtl,
    );

    log(reason === 'authorization_code' ? 'auth.token.issued' : 'auth.token.refreshed', request, {
      grant_id: grant.grant_id,
      login_id: grant.login_id,
      persona_id: grant.persona_id,
      client_id: clientIdFingerprint(grant.client_id),
      auth_level: grant.auth_level,
      scopes: grant.scopes,
      aud: audience,
      access_expires_at: access.expiresAt,
      refresh_expires_at: refresh.expiresAt,
      rotated_from_jti: parentJti,
    });
    // Expiries and a `jti`, never a token string (invariant 7).
    const fingerprint = clientIdFingerprint(grant.client_id);
    if (reason === 'authorization_code') {
      runtime.emitter.emit(
        'auth.token.issued',
        tokenIssuedData({
          grant,
          clientFingerprint: fingerprint,
          audience,
          accessExpiresAt: access.expiresAt,
          refreshExpiresAt: refresh.expiresAt,
        }),
        grantCorrelation(grant),
      );
    } else {
      runtime.emitter.emit(
        'auth.token.refreshed',
        tokenRefreshedData({
          grant,
          clientFingerprint: fingerprint,
          accessExpiresAt: access.expiresAt,
          refreshExpiresAt: refresh.expiresAt,
          rotatedJti: parentJti,
        }),
        grantCorrelation(grant),
      );
    }

    response.status(200).json({
      // Ramp's `ramp_user_tok_` analogue; the verifier strips it before parsing the JWT.
      access_token: applyAccessTokenPrefix(access.token),
      token_type: 'bearer',
      expires_in: TOKEN_LIFETIMES_SECONDS.access,
      refresh_token: refresh.token,
      scope: scopeString,
    });
  }

  async function exchangeCode(
    request: Request,
    response: Response,
    body: Record<string, unknown>,
  ): Promise<void> {
    const code = firstString(body.code);
    const verifier = firstString(body.code_verifier);
    const redirectUri = firstString(body.redirect_uri);
    const clientId = firstString(body.client_id);

    if (code === null || verifier === null) {
      rejected('malformed', { status: 400, error: 'invalid_request', clientId });
      oauthError(
        response,
        400,
        'invalid_request',
        'An authorization_code exchange needs code and code_verifier.',
      );
      return;
    }

    let claims;
    try {
      claims = await runtime.jwt.verify(code, 'code');
    } catch (error) {
      log('auth.token.rejected', request, { reason: 'invalid_code' });
      rejected(jwtRejectionReason(error), { status: 400, error: 'invalid_grant', clientId });
      oauthError(response, 400, 'invalid_grant', 'The authorization code is invalid or expired.');
      return;
    }

    // ADR-4: codes are single use. The consumed set is evicted at `exp`, so a restart reopens a
    // replay window bounded by the remaining ten minutes (A-11).
    if (runtime.consumedCodes.has(claims.jti)) {
      log('auth.token.rejected', request, { reason: 'code_replayed', grant_id: claims.grant_id });
      rejected('invalid_grant', {
        status: 400,
        error: 'invalid_grant',
        clientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
        personaId: claims.sub,
      });
      oauthError(response, 400, 'invalid_grant', 'This authorization code was already used.');
      return;
    }
    runtime.consumedCodes.add(claims.jti, claims.exp);

    // OAuth 2.1: a public client MUST send `client_id`, and the AS MUST bind the code to the
    // client it was issued to. `!== null &&` let a caller skip the check by omitting the field.
    if (clientId === null || clientId !== claims.client_id) {
      rejected('unknown_client', {
        status: 400,
        error: 'invalid_grant',
        clientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
      });
      oauthError(response, 400, 'invalid_grant', 'This code was issued to a different client.');
      return;
    }
    if (redirectUri !== null && redirectUri !== claims.redirect_uri) {
      rejected('invalid_grant', {
        status: 400,
        error: 'invalid_grant',
        clientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
      });
      oauthError(response, 400, 'invalid_grant', 'The redirect_uri does not match the code.');
      return;
    }
    if (pkceChallengeFor(verifier) !== claims.code_challenge) {
      log('auth.token.rejected', request, { reason: 'pkce_mismatch', grant_id: claims.grant_id });
      rejected('invalid_grant', {
        status: 400,
        error: 'invalid_grant',
        clientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
      });
      oauthError(response, 400, 'invalid_grant', 'The PKCE code_verifier does not match.');
      return;
    }
    if (runtime.revokedGrants.has(claims.grant_id)) {
      rejected('revoked_grant', {
        status: 400,
        error: 'invalid_grant',
        clientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
      });
      oauthError(response, 400, 'invalid_grant', 'This grant was revoked.');
      return;
    }

    const grant = runtime.grants.get(claims.grant_id) ?? {
      grant_id: claims.grant_id,
      login_id: claims.login_id ?? runtime.newId(ID_PREFIXES.login),
      persona_id: claims.sub,
      client_id: claims.client_id,
      scopes: parseScopeString(claims.scope),
      auth_level: claims.auth_level,
      parent_grant_id: null,
      created_at: runtime.now().toISOString(),
      updated_at: runtime.now().toISOString(),
    };
    runtime.grants.set(grant.grant_id, grant);

    const requestedResource = firstString(body.resource);
    const audience =
      requestedResource !== null && isAcceptableAudience(requestedResource, config)
        ? requestedResource
        : claims.resource;

    await issueTokens(request, response, grant, audience, 'authorization_code', null);
  }

  async function exchangeRefresh(
    request: Request,
    response: Response,
    body: Record<string, unknown>,
  ): Promise<void> {
    const token = firstString(body.refresh_token);
    if (token === null) {
      rejected('malformed', { status: 400, error: 'invalid_request' });
      oauthError(response, 400, 'invalid_request', 'A refresh exchange needs refresh_token.');
      return;
    }

    let claims;
    try {
      claims = await runtime.jwt.verify(token, 'refresh');
    } catch (error) {
      log('auth.token.rejected', request, { reason: 'invalid_refresh' });
      rejected(jwtRejectionReason(error), { status: 400, error: 'invalid_grant' });
      oauthError(response, 400, 'invalid_grant', 'The refresh token is invalid or expired.');
      return;
    }

    // OAuth 2.1: a refresh token is bound to the client it was issued to. Without this check any
    // caller could rotate someone else's refresh token, and the minted access token would silently
    // take its `client_id` from the claims - so the X-ray would attribute it to the wrong client.
    const presentedClientId = firstString(body.client_id);
    if (presentedClientId === null || presentedClientId !== claims.client_id) {
      log('auth.token.rejected', request, { reason: 'client_mismatch' });
      rejected('unknown_client', {
        status: 400,
        error: 'invalid_grant',
        clientId: presentedClientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
      });
      oauthError(
        response,
        400,
        'invalid_grant',
        'This refresh token was issued to a different client.',
      );
      return;
    }

    // Rotation is a MUST for public clients: a refresh token presented twice is dead, and so is
    // one presented after /revoke (ADR-4).
    if (runtime.rotatedRefresh.has(claims.jti)) {
      log('auth.token.rejected', request, {
        reason: 'refresh_replayed',
        grant_id: claims.grant_id,
      });
      // Reuse of a rotated refresh token, which OAuth 2.1 lets an AS answer by revoking the whole
      // family. This server deliberately does not: the token family of a public demo is trivially
      // copied out of a chat transcript, and killing a live session because someone replayed a
      // stale copy is a denial of service on the honest user. The replay is refused and reported.
      rejected('invalid_grant', {
        status: 400,
        error: 'invalid_grant',
        clientId: presentedClientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
        personaId: claims.sub,
      });
      oauthError(response, 400, 'invalid_grant', 'This refresh token was already used.');
      return;
    }
    if (runtime.revokedGrants.has(claims.grant_id)) {
      rejected('revoked_grant', {
        status: 400,
        error: 'invalid_grant',
        clientId: presentedClientId,
        grantId: claims.grant_id,
        loginId: claims.login_id,
      });
      oauthError(response, 400, 'invalid_grant', 'This grant was revoked.');
      return;
    }
    runtime.rotatedRefresh.add(claims.jti, claims.exp);

    const grant = runtime.grants.get(claims.grant_id) ?? {
      grant_id: claims.grant_id,
      login_id: claims.login_id ?? runtime.newId(ID_PREFIXES.login),
      persona_id: claims.sub,
      client_id: claims.client_id,
      scopes: parseScopeString(claims.scope),
      auth_level: claims.auth_level,
      parent_grant_id: null,
      created_at: runtime.now().toISOString(),
      updated_at: runtime.now().toISOString(),
    };
    runtime.grants.set(grant.grant_id, grant);

    const requestedResource = firstString(body.resource);
    const audience =
      requestedResource !== null && isAcceptableAudience(requestedResource, config)
        ? requestedResource
        : claims.aud;

    await issueTokens(request, response, grant, audience, 'refresh_token', claims.jti);
  }

  // ---- /revoke (RFC 7009) --------------------------------------------------------------------

  router.post(OAUTH_ROUTES.revoke, (request, response, next) => {
    (async () => {
      applyCors(request, response);
      response.setHeader('Cache-Control', 'no-store');
      // The only OAuth endpoint that had no limit at all, and every call runs up to two JWT
      // verifies plus an insert into `revokedGrants`. RFC 7009's "answer 200 whatever the token
      // was" is about token validity; a 429 reveals nothing about which tokens exist.
      if (limited(runtime.limiters.tokenIp, `ip:${clientIpOf(request)}`, request, response)) {
        return;
      }
      const body = bodyOf(request);
      const token = firstString(body.token);
      // RFC 7009: the endpoint answers 200 whatever the token was, so it cannot be used to probe
      // which tokens exist.
      if (token === null) {
        response.status(200).json({});
        return;
      }

      for (const typ of ['refresh', 'access'] as const) {
        try {
          const claims = await runtime.jwt.verify(
            typ === 'access' ? token.replace(ACCESS_TOKEN_PREFIX, '') : token,
            typ,
          );
          if (typ === 'refresh') runtime.rotatedRefresh.add(claims.jti, claims.exp);
          // Revoking any token of a grant kills the grant: the access tokens are stateless and
          // this set is the only thing that can stop them (ADR-4). The entry expires at the
          // grant's *refresh* lifetime, never at the presented token's `exp`: revoking a
          // one-hour access token has to keep the seven-day refresh token dead too.
          runtime.revokedGrants.add(
            claims.grant_id,
            Math.floor(runtime.now().getTime() / 1000) + refreshLifetimeSeconds(claims.auth_level),
          );
          log('auth.token.revoked', request, {
            grant_id: claims.grant_id,
            login_id: claims.login_id,
            token_typ: typ,
          });
          runtime.emitter.emit(
            'auth.token.revoked',
            {
              grant_id: claims.grant_id,
              login_id: claims.login_id,
              client_id: clientIdFingerprint(claims.client_id),
              reason: 'revocation_request',
            },
            {
              grant_id: claims.grant_id,
              login_id: claims.login_id,
              persona_id: claims.sub,
            },
          );
          break;
        } catch {
          // Try the next typ; an unknown token is still a 200.
        }
      }
      response.status(200).json({});
    })().catch(next);
  });

  return router;
}

/** The public view of a registered client, for the X-ray and for `AuthContext`. */
export function describeClient(store: ClientStore, clientId: string): OAuthClient {
  const { client, reconstructed } = store.resolve(clientId);
  return {
    client_id: clientIdFingerprint(client.client_id),
    client_name: client.client_name ?? (reconstructed ? 'unknown (reconstructed)' : null),
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    reconstructed: client.reconstructed,
  };
}
