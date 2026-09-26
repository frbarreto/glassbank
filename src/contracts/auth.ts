/**
 * Authentication and authorization contract (block: contracts).
 *
 * Implements docs/ARCHITECTURE.md section 5 (the OAuth 2.1 sequence, the token claims, the
 * canonical-URL rules), ADR-4 (JWT `jti` / `typ`), ADR-14 (`login_id` and grant extension),
 * A-12 and A-13 (the callback allowlist and DCR reconstruction), A-24 and ADR-10 (the
 * login-bound pairing code) and A-36 (`PUBLIC_HOSTS`).
 *
 * Nothing here signs, verifies or stores anything: these are the shapes and the pure rules that
 * `src/auth`, `src/mcp` and `src/xray` all have to agree on.
 */
import { z } from 'zod';

import type { AuthLevel, AuthRejectionReason, ClientInfo, ViewerKind } from './events.js';
import { idSchema } from './events.js';
import type { Persona } from './bank.js';
import type { Scope } from './scopes.js';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

/** Ramp's `ramp_user_tok_` analogue; the verifier strips it before parsing the JWT. */
export const ACCESS_TOKEN_PREFIX = 'mockbank_user_tok_';

export function applyAccessTokenPrefix(token: string): string {
  return token.startsWith(ACCESS_TOKEN_PREFIX) ? token : `${ACCESS_TOKEN_PREFIX}${token}`;
}

export function stripAccessTokenPrefix(token: string): string {
  return token.startsWith(ACCESS_TOKEN_PREFIX) ? token.slice(ACCESS_TOKEN_PREFIX.length) : token;
}

/** Ramp's 401 body, copied verbatim (docs/RAMP_REFERENCE.md section 6.3). */
export const NO_ACCESS_TOKEN_BODY = { detail: 'No access token provided' } as const;

/** Every route the single origin serves for auth (CLAUDE.md invariant 4). */
export const OAUTH_ROUTES = {
  authorize: '/authorize',
  token: '/token',
  register: '/register',
  revoke: '/revoke',
  login: '/login',
  consent: '/consent',
  protectedResourceMetadata: '/.well-known/oauth-protected-resource',
  protectedResourceMetadataForMcp: '/.well-known/oauth-protected-resource/mcp',
  authorizationServerMetadata: '/.well-known/oauth-authorization-server',
  mcp: '/mcp',
} as const;

/** Cookie names. Every cookie is `Secure` + `HttpOnly` (CLAUDE.md invariant 12). */
export const COOKIE_NAMES = {
  /** 30-day signed login cookie set by the AS on the login page (ADR-14). */
  login: 'login_id',
  /** Signed viewer JWT for the dashboard; `SameSite=Lax` so the pairing link works. */
  viewer: 'xray_viewer',
  /** `SameSite=Strict` double-submit CSRF token for `/login` and `/consent`. */
  csrf: 'gb_csrf',
} as const;

/** Advertised in the AS metadata; PKCE S256 is mandatory (A-12). */
export const OAUTH_METADATA_CONSTANTS = {
  responseTypesSupported: ['code'],
  grantTypesSupported: ['authorization_code', 'refresh_token'],
  codeChallengeMethodsSupported: ['S256'],
  // Only `none`: /register issues public clients exclusively and rejects any other method,
  // so advertising `client_secret_post` would describe an endpoint behaviour we do not implement.
  tokenEndpointAuthMethodsSupported: ['none'],
  authorizationResponseIssParameterSupported: true,
} as const;

/** Token lifetimes (A-11, A-26). Refresh lifetime depends on the grant's auth level. */
export const TOKEN_LIFETIMES_SECONDS = {
  code: 10 * 60,
  access: 60 * 60,
  refreshReadOnly: 7 * 24 * 60 * 60,
  refreshReadWrite: 24 * 60 * 60,
  viewer: 24 * 60 * 60,
  txn: 10 * 60,
  login: 30 * 24 * 60 * 60,
} as const;

export function refreshLifetimeSeconds(authLevel: AuthLevel): number {
  return authLevel === 'read_write'
    ? TOKEN_LIFETIMES_SECONDS.refreshReadWrite
    : TOKEN_LIFETIMES_SECONDS.refreshReadOnly;
}

// ---------------------------------------------------------------------------
// Callback allowlist (A-13). The allowlist plus mandatory PKCE is the security boundary.
// ---------------------------------------------------------------------------

/** Exactly matched redirect URIs. */
export const EXACT_CALLBACK_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  /** Unverified but harmless (A-13). */
  'https://claude.com/api/mcp/auth_callback',
] as const;

/** Loopback callbacks accepted on any port (Claude Code). */
export const LOOPBACK_CALLBACK_HOSTS = ['localhost', '127.0.0.1'] as const;
export const LOOPBACK_CALLBACK_PATH = '/callback';

/** MCP Inspector's callback; accepted in development only. */
export const DEV_LOOPBACK_CALLBACK_PATH = '/oauth/callback';

/** The human-readable allowlist, for the consent page and for tests. */
export const OAUTH_CALLBACK_ALLOWLIST: readonly string[] = [
  ...EXACT_CALLBACK_URIS,
  'http://localhost/callback (any port)',
  'http://127.0.0.1/callback (any port)',
  'http://localhost:*/oauth/callback (development only)',
];

/**
 * The redirect URIs an unknown `client_id` is reconstructed with after a restart: exactly the
 * claude.ai callback plus the loopback URIs, PKCE required (A-12).
 */
export const RECONSTRUCTED_CLIENT_REDIRECT_URIS: readonly string[] = [
  'https://claude.ai/api/mcp/auth_callback',
  'http://localhost/callback',
  'http://127.0.0.1/callback',
];

export interface RedirectUriPolicy {
  /** Allow the MCP Inspector loopback callback path (`/oauth/callback`, any port). Off in production. */
  readonly allowDevLoopback?: boolean;
}

/** True when `uri` is on the callback allowlist of A-13. */
export function isAllowedRedirectUri(uri: string, policy: RedirectUriPolicy = {}): boolean {
  if ((EXACT_CALLBACK_URIS as readonly string[]).includes(uri)) return true;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.search !== '' || parsed.hash !== '') return false;
  const isLoopback = (LOOPBACK_CALLBACK_HOSTS as readonly string[]).includes(parsed.hostname);
  if (!isLoopback) return false;
  if (parsed.pathname === LOOPBACK_CALLBACK_PATH) return true;
  return policy.allowDevLoopback === true && parsed.pathname === DEV_LOOPBACK_CALLBACK_PATH;
}

// ---------------------------------------------------------------------------
// Canonical URL rules (CLAUDE.md invariant 4, A-36)
// ---------------------------------------------------------------------------

/** What the canonical-URL helpers need from the configuration. */
export interface PublicHostConfig {
  /** Every hostname this service answers on, `host` or `host:port`, lowercase. */
  readonly publicHosts: readonly string[];
  /** Fallback base URL when the request `Host` is not listed; also the base for pairing URLs. */
  readonly publicBaseUrl: string;
}

function normaliseHost(host: string): string {
  return host.trim().toLowerCase();
}

/** True when a request `Host` header is one this service is allowed to answer as. */
export function isPublicHost(host: string | null | undefined, config: PublicHostConfig): boolean {
  if (!host) return false;
  const wanted = normaliseHost(host);
  return config.publicHosts.some((candidate) => normaliseHost(candidate) === wanted);
}

/**
 * The origin every derived URL is built from: the validated request `Host` when it is listed,
 * `PUBLIC_BASE_URL` otherwise. `https` unless the host is the one `PUBLIC_BASE_URL` names over
 * `http`, which is how a local `http://localhost:8080` run keeps working.
 */
export function canonicalBaseUrl(
  requestHost: string | null | undefined,
  config: PublicHostConfig,
): string {
  const fallback = config.publicBaseUrl.replace(/\/+$/, '');
  if (!isPublicHost(requestHost, config)) return fallback;
  const host = normaliseHost(requestHost as string);
  let scheme = 'https';
  try {
    const base = new URL(config.publicBaseUrl);
    if (normaliseHost(base.host) === host) scheme = base.protocol.replace(':', '');
  } catch {
    scheme = 'https';
  }
  return `${scheme}://${host}`;
}

/** The canonical MCP URL: the PRM `resource`, and the `aud` every access token carries. */
export function canonicalMcpUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${OAUTH_ROUTES.mcp}`;
}

/** The OAuth issuer: the origin itself (the AS lives on the same host). */
export function issuerUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** The `resource_metadata` value of every `WWW-Authenticate` challenge. */
export function resourceMetadataUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${OAUTH_ROUTES.protectedResourceMetadataForMcp}`;
}

/** Every `aud` the verifier accepts: one canonical MCP URL per listed host, plus the fallback. */
export function acceptableAudiences(config: PublicHostConfig): string[] {
  const audiences = new Set<string>();
  for (const host of config.publicHosts) {
    audiences.add(canonicalMcpUrl(canonicalBaseUrl(host, config)));
  }
  audiences.add(canonicalMcpUrl(config.publicBaseUrl));
  return [...audiences];
}

export function isAcceptableAudience(aud: string, config: PublicHostConfig): boolean {
  return acceptableAudiences(config).includes(aud);
}

// ---------------------------------------------------------------------------
// WWW-Authenticate challenges (CLAUDE.md invariants 5 and 9)
// ---------------------------------------------------------------------------

function renderChallenge(parameters: readonly (readonly [string, string])[]): string {
  return `Bearer ${parameters.map(([key, value]) => `${key}="${value}"`).join(', ')}`;
}

/**
 * The 401 that starts auth. Parameter order matches docs/ARCHITECTURE.md section 5 verbatim;
 * order is not semantically significant, but matching the document keeps the fixtures honest.
 */
export function buildUnauthorizedChallenge(input: {
  readonly resourceMetadata: string;
  readonly scopes: readonly string[];
  readonly error?: string;
}): string {
  const parameters: (readonly [string, string])[] = [];
  if (input.error) parameters.push(['error', input.error]);
  parameters.push(['resource_metadata', input.resourceMetadata]);
  parameters.push(['scope', input.scopes.join(' ')]);
  return renderChallenge(parameters);
}

/**
 * The 403 step-up (ADR-13). `scopes` must list **every** still-needed write scope, because
 * Claude does not carry earlier step-up scopes forward.
 */
export function buildInsufficientScopeChallenge(input: {
  readonly resourceMetadata: string;
  readonly scopes: readonly string[];
}): string {
  return renderChallenge([
    ['error', 'insufficient_scope'],
    ['scope', input.scopes.join(' ')],
    ['resource_metadata', input.resourceMetadata],
  ]);
}

// ---------------------------------------------------------------------------
// JWT claims (ADR-4). Every token carries `jti` and `typ`; the verifier rejects a wrong `typ`.
// ---------------------------------------------------------------------------

export const JWT_TYPES = ['code', 'access', 'refresh', 'viewer', 'txn', 'login'] as const;
export type JwtType = (typeof JWT_TYPES)[number];

const CommonClaims = z.object({
  jti: z.string().min(1),
  iat: z.int().nonnegative(),
  exp: z.int().nonnegative(),
  iss: z.string().nullish(),
});

/** Claims shared by the tokens that represent a grant (`code`, `access`, `refresh`). */
const GrantClaims = CommonClaims.extend({
  aud: z.string(),
  /** `sub` is the persona id. */
  sub: idSchema('persona'),
  client_id: z.string(),
  grant_id: idSchema('grant'),
  login_id: idSchema('login').nullable().default(null),
  /** Space-separated OAuth scope string. */
  scope: z.string(),
  auth_level: z.enum(['read_only', 'read_write']),
});

/** The authorization code: single use, 10 minutes, checked against the `/token` request. */
export const CodeClaimsSchema = GrantClaims.extend({
  typ: z.literal('code'),
  redirect_uri: z.string(),
  code_challenge: z.string(),
  code_challenge_method: z.literal('S256'),
  resource: z.string(),
});

export const AccessClaimsSchema = GrantClaims.extend({
  typ: z.literal('access'),
});

export const RefreshClaimsSchema = GrantClaims.extend({
  typ: z.literal('refresh'),
  /** `jti` of the refresh token this one replaced, for rotation forensics. */
  parent_jti: z.string().nullable().default(null),
});

/** The dashboard viewer cookie: bound to the login, never to a grant (ADR-10). */
export const ViewerClaimsSchema = CommonClaims.extend({
  typ: z.literal('viewer'),
  aud: z.string(),
  /** `null` in observer mode, where the admin sees every session, redacted. */
  login_id: idSchema('login').nullable().default(null),
  viewer_kind: z.enum(['pairing', 'admin']),
});

/** The signed state that travels `/authorize` -> `/login` -> `/consent` (invariant 15). */
export const TxnClaimsSchema = CommonClaims.extend({
  typ: z.literal('txn'),
  aud: z.string(),
  client_id: z.string(),
  redirect_uri: z.string(),
  state: z.string().nullable().default(null),
  code_challenge: z.string(),
  code_challenge_method: z.literal('S256'),
  scope: z.string(),
  resource: z.string(),
  /** Filled once the browser has chosen a persona on `/login`. */
  login_id: idSchema('login').nullable().default(null),
  persona_id: idSchema('persona').nullable().default(null),
});

/** The 30-day browser cookie that groups a human's grants (ADR-14). */
export const LoginClaimsSchema = CommonClaims.extend({
  typ: z.literal('login'),
  aud: z.string(),
  login_id: idSchema('login'),
  sub: idSchema('persona'),
});

export const JwtClaimsSchema = z.discriminatedUnion('typ', [
  CodeClaimsSchema,
  AccessClaimsSchema,
  RefreshClaimsSchema,
  ViewerClaimsSchema,
  TxnClaimsSchema,
  LoginClaimsSchema,
]);

export type CodeClaims = z.infer<typeof CodeClaimsSchema>;
export type AccessClaims = z.infer<typeof AccessClaimsSchema>;
export type RefreshClaims = z.infer<typeof RefreshClaimsSchema>;
export type ViewerClaims = z.infer<typeof ViewerClaimsSchema>;
export type TxnClaims = z.infer<typeof TxnClaimsSchema>;
export type LoginClaims = z.infer<typeof LoginClaimsSchema>;
export type JwtClaims = z.infer<typeof JwtClaimsSchema>;

/** The schema for one `typ`, so a verifier can reject a code presented as a bearer token. */
export const JWT_CLAIMS_SCHEMAS = {
  code: CodeClaimsSchema,
  access: AccessClaimsSchema,
  refresh: RefreshClaimsSchema,
  viewer: ViewerClaimsSchema,
  txn: TxnClaimsSchema,
  login: LoginClaimsSchema,
} as const;

export function isJwtType(value: unknown): value is JwtType {
  return typeof value === 'string' && (JWT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// AuthContext: what every tool handler is given about the caller
// ---------------------------------------------------------------------------

/** The registered OAuth client, as far as the server knows it. Never trusted for gating (A-28). */
export interface OAuthClient {
  /** Short hash of the registered `client_id`; the raw value never reaches an event. */
  readonly client_id: string;
  readonly client_name: string | null;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method: string;
  /** True when this client was rebuilt after a restart from an unknown id (A-12). */
  readonly reconstructed: boolean;
}

/** The verified caller. Built by the bearer gate in `src/mcp`, injected into every handler. */
export interface AuthContext {
  readonly persona: Persona;
  /** `null` only for a grant minted before the login cookie existed. */
  readonly login_id: string | null;
  readonly grant_id: string;
  readonly parent_grant_id: string | null;
  readonly scopes: readonly Scope[];
  readonly auth_level: AuthLevel;
  /** `clientInfo` from `initialize`, verbatim; display it, never gate on it (A-28). */
  readonly client: ClientInfo | null;
  readonly oauth_client: OAuthClient;
  /** The X-ray session this request belongs to; `get_current_user` returns it. */
  readonly xs: string | null;
  /** Changes on every restart, so a user can see why a locked card is active again (A-15). */
  readonly boot_id: string;
  readonly token_expires_at: string;
  /** The canonical MCP URL this token was minted for. */
  readonly aud: string;
}

// ---------------------------------------------------------------------------
// The injected JWT helper (docs/REPO_LAYOUT.md section 3)
// ---------------------------------------------------------------------------

/** The claims of one `typ`. */
export type ClaimsFor<T extends JwtType> = Extract<JwtClaims, { typ: T }>;

/** What a caller supplies; the implementation adds `typ`, `jti`, `iat` and `exp`. */
export type SignableClaims<T extends JwtType> = Omit<ClaimsFor<T>, 'typ' | 'jti' | 'iat' | 'exp'>;

/**
 * Signing and verification of every JWT this service mints. `src/auth` implements it over
 * `jose` with `OAUTH_SIGNING_KEY`; `src/app` injects the same instance into `src/xray`, which
 * only needs it for the viewer cookie, so `jose` stays inside its two owning blocks.
 */
export interface JwtService {
  sign<T extends JwtType>(
    typ: T,
    claims: SignableClaims<T>,
    ttlSeconds: number,
  ): Promise<{ readonly token: string; readonly jti: string; readonly expiresAt: string }>;
  /** Rejects a token whose `typ` is not `expected`: a code presented as a bearer is invalid. */
  verify<T extends JwtType>(token: string, expected: T): Promise<ClaimsFor<T>>;
}

/** What the bearer gate in `src/mcp` gets back from the verifier `src/auth` injects. */
export type AccessTokenVerification =
  | { readonly ok: true; readonly claims: AccessClaims }
  | {
      readonly ok: false;
      readonly reason: AuthRejectionReason;
      readonly error: string;
      readonly status: 401 | 403;
    };

/** The one function `src/mcp` needs from `src/auth`; injected by the composition root. */
export type VerifyAccessToken = (
  token: string,
  context?: { readonly audience?: string; readonly now?: Date },
) => Promise<AccessTokenVerification>;

// ---------------------------------------------------------------------------
// Pairing: the login-bound dashboard code (ADR-10, A-24)
// ---------------------------------------------------------------------------

/** Ten characters from a 32-character alphabet without `0`, `O`, `1` or `I`: 50 bits. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_PATTERN = /^BANK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/;
export const PAIRING_CODE_LENGTH = 10;
export const PAIRING_CODE_ENTROPY_BITS = 50;
export const PAIRING_CODE_TTL_HOURS = 24;

export function isPairingCode(value: unknown): value is string {
  return typeof value === 'string' && PAIRING_CODE_PATTERN.test(value);
}

/** Groups ten alphabet characters as `BANK-XXXX-XXXX-XX`. */
export function formatPairingCode(characters: string): string {
  if (characters.length !== PAIRING_CODE_LENGTH) {
    throw new Error(`a pairing code needs exactly ${PAIRING_CODE_LENGTH} characters`);
  }
  return `BANK-${characters.slice(0, 4)}-${characters.slice(4, 8)}-${characters.slice(8, 10)}`;
}

/** The pairing URL shown in chat: always built from `PUBLIC_BASE_URL` (A-36). */
export function pairingUrl(baseUrl: string, code: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/xray/s/${code}`;
}

export interface PairingCode {
  readonly code: string;
  readonly url: string;
  readonly expires_at: string;
}

export type PairingRejectionReason = 'unknown_code' | 'expired' | 'rate_limited' | 'malformed';

export type PairingExchangeResult =
  | {
      readonly ok: true;
      readonly login_id: string;
      readonly viewer_kind: ViewerKind;
      readonly expires_at: string;
    }
  | { readonly ok: false; readonly reason: PairingRejectionReason };

/**
 * Mints and redeems the dashboard pairing codes. Bound to the **login**, never to a grant, and
 * multi-use inside its TTL so a reload or a second device keeps working (ADR-10).
 */
export interface Pairing {
  createCode(input: {
    readonly login_id: string;
    readonly ttl_hours?: number;
  }): Promise<PairingCode>;
  exchange(
    code: string,
    context?: { readonly remote_ip_prefix?: string | null },
  ): Promise<PairingExchangeResult>;
  /** Exchanges the admin token for observer mode (Decision D-5). */
  exchangeAdminToken(token: string): Promise<PairingExchangeResult>;
}
