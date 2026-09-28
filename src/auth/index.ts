/**
 * The `auth` block factory.
 *
 * `createAuth(deps)` builds the mock OAuth 2.1 authorization server **and** the resource-server
 * verifier that `src/mcp` needs, and returns both. `src/app.ts` mounts `auth.router` at the root
 * and injects `auth.verifyAccessToken` into `createMcp`.
 *
 * L5 finished what the T0.3 spike left: the DCR store is persisted in the `AUTH_DB_PATH` SQLite
 * table, every `auth.*` event this block decides goes through the injected `XrayEmitter`, the
 * consent success page shows the persona id and the dashboard pairing link, and
 * `RATE_LIMIT_LOGIN_GRANTS` is enforced. See docs/blocks/auth.md for what is still open.
 */
import { randomBytes } from 'node:crypto';

import type { RequestHandler } from 'express';

import { refreshLifetimeSeconds, type PersonaDirectory, type VerifyAccessToken } from '../contracts/index.js';

import { createClientPersistence } from './client-db.js';
import { createClientStore, type ClientStore } from './clients.js';
import { createBotAuth, type BotAuth } from './bot-auth.js';
import { safeEmitter } from './events.js';
import { createJwtService } from './jwt.js';
import { createSpikePersonaDirectory } from './personas.js';
import { createRateLimiter } from './rate-limit.js';
import { buildAuthRouter, describeClient, type AuthRuntime } from './routes.js';
import { BoundedLru, ExpiringSet } from './store.js';
import type { AuthDeps, GrantRecord, SpikeLogger, SpikeLogRecord } from './types.js';
import { createAccessTokenVerifier } from './verify.js';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

/**
 * How long the consent success page stays on screen before it sends the browser to the client
 * callback. Long enough to read a `per_` id and click the X-ray link into a new tab, short enough
 * that the popup does not look stuck. `AuthDeps.consentSuccessRedirectMs: 0` turns the page off.
 */
export const DEFAULT_CONSENT_SUCCESS_REDIRECT_MS = 4000;

/** What `createAuth` hands back to the composition root. */
export interface Auth {
  /** Mounted at `/` by `src/app.ts`: discovery, `/register`, `/authorize`, `/token`, `/revoke`. */
  readonly router: RequestHandler;
  /** Injected into `src/mcp` as the contract's `VerifyAccessToken`. */
  readonly verifyAccessToken: VerifyAccessToken;
  /** The signing service; `src/app.ts` passes the same instance to `src/xray` for viewer cookies. */
  readonly jwt: ReturnType<typeof createJwtService>;
  /** The registered-client view the X-ray and `AuthContext` need. */
  readonly lookupClient: (clientId: string) => ReturnType<typeof describeClient>;
  /** The persona directory in use, so the spike wiring can share it with `src/mcp`. */
  readonly personas: PersonaDirectory;
  /** Test and dashboard hook: the grants this process remembers. */
  readonly grants: BoundedLru<string, GrantRecord>;
  /** Test hook: revoke without going through `/revoke`. */
  readonly revokeGrant: (grantId: string) => void;
  /**
   * The id generator the block actually uses. Exposed so a test can sample it directly: the ids it
   * mints have to satisfy `idSchema` from the contracts, and a 3% failure rate is invisible to a
   * test that only walks the flow once (see `__tests__/ids.test.ts`).
   */
  readonly newId: (prefix: string) => string;
  readonly clients: ClientStore;
  /**
   * v0.10 (D-29): the Web Bot Auth check. `src/app.ts` mounts `botAuth.middleware` in front of
   * every route; it verifies a signature when one arrives, invites one on the MCP endpoints when
   * `BOT_AUTH_CHALLENGE=advertise`, and never changes an answer.
   */
  readonly botAuth: BotAuth;
  /**
   * Releases the `AUTH_DB_PATH` handle. `src/server.ts` calls it from the SIGTERM path; it is
   * synchronous and safe to call twice.
   */
  readonly close: () => void;
}

const defaultLogger = (record: SpikeLogRecord): void => {
  // The stdout fallback. It is only installed when no `XrayEmitter` was injected, so a half-wired
  // tree stays debuggable and a fully wired one does not report everything twice.
  console.log(JSON.stringify(record));
};

const noopLogger: SpikeLogger = () => {};

export function createAuth(deps: AuthDeps): Auth {
  const { config } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (deps.emitter === undefined ? defaultLogger : noopLogger);
  // Wrapped, not used raw: an OAuth endpoint must not 500 because the X-ray threw (invariant 5
  // outranks invariant 13).
  const emitter = safeEmitter(deps.emitter, (error, type) => {
    log({ event: 'auth.emitter_failed', type, error: String(error) });
  });
  // Hex, not base64url: `idSchema` (src/contracts/events.ts) requires the first character after the
  // prefix to be alphanumeric, and base64url starts with `-` or `_` about 3% of the time. That made
  // roughly one grant in thirty unverifiable at /token - an intermittent `invalid_grant` that a single
  // test run would usually miss.
  const randomId = deps.randomId ?? ((bytes: number) => randomBytes(bytes).toString('hex'));

  const jwt = createJwtService({ signingKey: config.oauthSigningKey, now });
  const personas = deps.personas ?? createSpikePersonaDirectory({ now });
  // A-12: the client table survives an ordinary restart, so `client_name` and a ported loopback
  // callback are not lost. A file that cannot be opened degrades to the in-memory LRU, which is
  // exactly the T0.3 behaviour, and is reported once through the logger.
  const persistence = createClientPersistence({
    path: config.authDbPath,
    onError: (error, operation) => {
      log({ event: 'auth.client_store_failed', operation, error: String(error) });
    },
  });
  const clients = createClientStore({
    capacity: config.maxDcrClients,
    allowDevLoopback: config.nodeEnv !== 'production',
    now,
    persistence,
  });

  // An ExpiringSet, not a plain Set: this is the only thing that can stop a stateless access
  // token, so it cannot simply be dropped - it has to expire on the grant's longest token
  // lifetime (ADR-4, ADR-16). `/revoke` supplies that expiry from the token's `auth_level`.
  const revokedGrants = new ExpiringSet(now);
  const runtime: AuthRuntime = {
    config,
    jwt,
    clients,
    personas,
    grants: new BoundedLru<string, GrantRecord>(2000),
    consumedCodes: new ExpiringSet(now),
    rotatedRefresh: new ExpiringSet(now),
    revokedGrants,
    limiters: {
      register: createRateLimiter({
        limit: config.rateLimits.ipRegisterPerHour,
        windowMs: ONE_HOUR_MS,
        now,
      }),
      authorize: createRateLimiter({
        limit: config.rateLimits.ipAuthorizePer15Min,
        windowMs: FIFTEEN_MINUTES_MS,
        now,
      }),
      consent: createRateLimiter({
        limit: config.rateLimits.ipConsentPer15Min,
        windowMs: FIFTEEN_MINUTES_MS,
        now,
      }),
      token: createRateLimiter({
        limit: config.rateLimits.clientTokenPer15Min,
        windowMs: FIFTEEN_MINUTES_MS,
        now,
      }),
      // `/token` and `/revoke` also charge a per-IP window, because `client_id` comes from the
      // request body and a caller can rotate it, so the per-client limit alone is forgeable.
      // `RATE_LIMIT_IP_TOKEN` is its own knob (default 300/15 min, the same budget as /authorize,
      // sized for Anthropic's shared 160.79.104.0/21 egress) so token traffic can be tuned
      // without moving the authorization budget.
      tokenIp: createRateLimiter({
        limit: config.rateLimits.ipTokenPer15Min,
        windowMs: FIFTEEN_MINUTES_MS,
        now,
      }),
      // RATE_LIMIT_LOGIN_GRANTS: keyed on the `login_id` cookie, charged only when /consent mints
      // a *new* grant. A step-up that extends an existing grant is deliberately free (ADR-14).
      loginGrants: createRateLimiter({
        limit: config.rateLimits.loginGrantsPerDay,
        windowMs: ONE_DAY_MS,
        now,
      }),
    },
    now,
    log,
    emitter,
    pairing: deps.pairing ?? null,
    consentSuccessRedirectMs:
      deps.consentSuccessRedirectMs ?? DEFAULT_CONSENT_SUCCESS_REDIRECT_MS,
    newId: (prefix: string) => `${prefix}${randomId(12)}`,
  };

  const verifyAccessToken = createAccessTokenVerifier({
    jwt,
    hosts: config,
    isGrantRevoked: (grantId) => revokedGrants.has(grantId),
  });

  return {
    router: buildAuthRouter(runtime) as unknown as RequestHandler,
    verifyAccessToken,
    jwt,
    lookupClient: (clientId: string) => describeClient(clients, clientId),
    personas,
    grants: runtime.grants,
    revokeGrant: (grantId: string) => {
      // The test hook has no token to read an `auth_level` from, so it uses the longest lifetime.
      revokedGrants.add(
        grantId,
        Math.floor(now().getTime() / 1000) + refreshLifetimeSeconds('read_write'),
      );
    },
    newId: runtime.newId,
    clients,
    botAuth: createBotAuth({ config, emitter, now }),
    close: () => clients.close(),
  };
}

export { createSpikePersonaDirectory, SEEDED_PERSONAS } from './personas.js';
export { pkceChallengeFor } from './routes.js';
export { createClientPersistence, createNullClientPersistence } from './client-db.js';
export type { ClientPersistence } from './client-db.js';
export {
  ACCEPT_SIGNATURE_VALUE,
  DIRECTORY_PATH,
  createBotAuth,
  jwkThumbprint,
  signatureBase,
  verdictRank,
} from './bot-auth.js';
export type { BotAuth, BotAuthConfig, DirectoryFetcher } from './bot-auth.js';
export type { AuthConfig, AuthDeps, AuthRateLimitConfig, GrantRecord, SpikeLogger, SpikeLogRecord } from './types.js';
