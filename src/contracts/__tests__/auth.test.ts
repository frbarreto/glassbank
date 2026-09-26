/**
 * The OAuth constants and pure rules of docs/ARCHITECTURE.md section 5, A-12, A-13 and A-36.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_PREFIX,
  DEFAULT_CHALLENGE_SCOPES,
  JWT_CLAIMS_SCHEMAS,
  JWT_TYPES,
  JwtClaimsSchema,
  NO_ACCESS_TOKEN_BODY,
  OAUTH_CALLBACK_ALLOWLIST,
  OAUTH_METADATA_CONSTANTS,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_ENTROPY_BITS,
  PAIRING_CODE_PATTERN,
  RECONSTRUCTED_CLIENT_REDIRECT_URIS,
  TOKEN_LIFETIMES_SECONDS,
  acceptableAudiences,
  applyAccessTokenPrefix,
  buildInsufficientScopeChallenge,
  buildUnauthorizedChallenge,
  canonicalBaseUrl,
  canonicalMcpUrl,
  formatPairingCode,
  isAcceptableAudience,
  isAllowedRedirectUri,
  isJwtType,
  isPairingCode,
  isPublicHost,
  issuerUrl,
  pairingUrl,
  refreshLifetimeSeconds,
  resourceMetadataUrl,
  stripAccessTokenPrefix,
} from '../index.js';

const CLOUD = {
  publicHosts: ['mcp-bank-520283334162.us-central1.run.app', 'mcp-bank-abc123-uc.a.run.app'],
  publicBaseUrl: 'https://mcp-bank-abc123-uc.a.run.app',
};

const LOCAL = {
  publicHosts: ['localhost:8080'],
  publicBaseUrl: 'http://localhost:8080',
};

describe('the callback allowlist (A-13)', () => {
  it('accepts the two hosted callbacks exactly', () => {
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback?x=1')).toBe(false);
    expect(isAllowedRedirectUri('https://claude.ai.evil.example/api/mcp/auth_callback')).toBe(
      false,
    );
  });

  it('accepts the loopback callbacks on any port (Claude Code)', () => {
    expect(isAllowedRedirectUri('http://localhost/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:57123/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.1:9999/callback')).toBe(true);
    expect(isAllowedRedirectUri('http://127.0.0.2:9999/callback')).toBe(false);
    expect(isAllowedRedirectUri('https://localhost/callback')).toBe(false);
  });

  it('accepts the Inspector callback only in development', () => {
    expect(isAllowedRedirectUri('http://localhost:6274/oauth/callback')).toBe(false);
    expect(
      isAllowedRedirectUri('http://localhost:6274/oauth/callback', { allowDevLoopback: true }),
    ).toBe(true);
  });

  it('rejects anything unparsable or off-path', () => {
    expect(isAllowedRedirectUri('not a url')).toBe(false);
    expect(isAllowedRedirectUri('http://localhost/other')).toBe(false);
    expect(isAllowedRedirectUri('http://localhost/callback#frag')).toBe(false);
  });

  it('reconstructs an unknown client with exactly the documented URIs (A-12)', () => {
    expect(RECONSTRUCTED_CLIENT_REDIRECT_URIS).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost/callback',
      'http://127.0.0.1/callback',
    ]);
    for (const uri of RECONSTRUCTED_CLIENT_REDIRECT_URIS) {
      expect(isAllowedRedirectUri(uri)).toBe(true);
    }
    expect(OAUTH_CALLBACK_ALLOWLIST.length).toBe(5);
  });
});

describe('canonical URLs (CLAUDE.md invariant 4, A-36)', () => {
  it('derives everything from the validated request Host when it is listed', () => {
    const base = canonicalBaseUrl('mcp-bank-520283334162.us-central1.run.app', CLOUD);
    expect(base).toBe('https://mcp-bank-520283334162.us-central1.run.app');
    expect(canonicalMcpUrl(base)).toBe('https://mcp-bank-520283334162.us-central1.run.app/mcp');
    expect(issuerUrl(base)).toBe('https://mcp-bank-520283334162.us-central1.run.app');
    expect(resourceMetadataUrl(base)).toBe(
      'https://mcp-bank-520283334162.us-central1.run.app/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('falls back to PUBLIC_BASE_URL for a host that is not listed', () => {
    expect(canonicalBaseUrl('someone-else.example.com', CLOUD)).toBe(CLOUD.publicBaseUrl);
    expect(canonicalBaseUrl(null, CLOUD)).toBe(CLOUD.publicBaseUrl);
    expect(isPublicHost('MCP-BANK-ABC123-UC.A.RUN.APP', CLOUD)).toBe(true);
  });

  it('keeps http for a local run so the tunnel and localhost both work (Decision D-2)', () => {
    expect(canonicalBaseUrl('localhost:8080', LOCAL)).toBe('http://localhost:8080');
    expect(canonicalMcpUrl(canonicalBaseUrl('localhost:8080', LOCAL))).toBe(
      'http://localhost:8080/mcp',
    );
  });

  it('accepts an aud derived from any listed host', () => {
    const audiences = acceptableAudiences(CLOUD);
    expect(audiences).toContain('https://mcp-bank-520283334162.us-central1.run.app/mcp');
    expect(audiences).toContain('https://mcp-bank-abc123-uc.a.run.app/mcp');
    expect(isAcceptableAudience('https://mcp-bank-abc123-uc.a.run.app/mcp', CLOUD)).toBe(true);
    expect(isAcceptableAudience('https://evil.example.com/mcp', CLOUD)).toBe(false);
  });
});

describe('the WWW-Authenticate challenges (CLAUDE.md invariants 5 and 9)', () => {
  it('renders the 401 exactly as documented', () => {
    expect(
      buildUnauthorizedChallenge({
        resourceMetadata: 'https://host/.well-known/oauth-protected-resource/mcp',
        scopes: DEFAULT_CHALLENGE_SCOPES,
      }),
    ).toBe(
      'Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/mcp", scope="profile accounts:read transactions:read cards:read transfers:read bills:read payees:read xray:read"',
    );
    expect(NO_ACCESS_TOKEN_BODY).toEqual({ detail: 'No access token provided' });
  });

  it('renders the 403 step-up exactly as documented (ADR-13)', () => {
    expect(
      buildInsufficientScopeChallenge({
        resourceMetadata: 'https://host/.well-known/oauth-protected-resource/mcp',
        scopes: ['cards:write', 'transfers:write'],
      }),
    ).toBe(
      'Bearer error="insufficient_scope", scope="cards:write transfers:write", resource_metadata="https://host/.well-known/oauth-protected-resource/mcp"',
    );
  });
});

describe('access token prefix (Ramp style)', () => {
  it('applies and strips the prefix idempotently', () => {
    expect(ACCESS_TOKEN_PREFIX).toBe('mockbank_user_tok_');
    const token = applyAccessTokenPrefix('abc.def.ghi');
    expect(token).toBe('mockbank_user_tok_abc.def.ghi');
    expect(applyAccessTokenPrefix(token)).toBe(token);
    expect(stripAccessTokenPrefix(token)).toBe('abc.def.ghi');
    expect(stripAccessTokenPrefix('abc.def.ghi')).toBe('abc.def.ghi');
  });
});

describe('JWT claims (ADR-4)', () => {
  const base = {
    jti: 'jti_1',
    iat: 1_757_340_000,
    exp: 1_757_343_600,
    aud: 'https://host/mcp',
    sub: 'per_a1b2',
    client_id: 'cli_1',
    grant_id: 'grt_8a1e33',
    login_id: 'lgn_5d2c7a',
    scope: 'profile accounts:read',
    auth_level: 'read_only' as const,
  };

  it('lists the six documented typ values', () => {
    expect(JWT_TYPES).toEqual(['code', 'access', 'refresh', 'viewer', 'txn', 'login']);
    expect(Object.keys(JWT_CLAIMS_SCHEMAS).sort()).toEqual([...JWT_TYPES].sort());
    expect(isJwtType('access')).toBe(true);
    expect(isJwtType('bearer')).toBe(false);
  });

  it('parses an access token and rejects it as any other typ', () => {
    const claims = { ...base, typ: 'access' };
    expect(JwtClaimsSchema.safeParse(claims).success).toBe(true);
    expect(JWT_CLAIMS_SCHEMAS.access.safeParse(claims).success).toBe(true);
    expect(JWT_CLAIMS_SCHEMAS.refresh.safeParse(claims).success).toBe(false);
    expect(JWT_CLAIMS_SCHEMAS.code.safeParse(claims).success).toBe(false);
  });

  it('requires the extra code claims that /token checks', () => {
    expect(JWT_CLAIMS_SCHEMAS.code.safeParse({ ...base, typ: 'code' }).success).toBe(false);
    const full = {
      ...base,
      typ: 'code',
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      code_challenge: 'abc',
      code_challenge_method: 'S256',
      resource: 'https://host/mcp',
    };
    expect(JWT_CLAIMS_SCHEMAS.code.safeParse(full).success).toBe(true);
    expect(
      JWT_CLAIMS_SCHEMAS.code.safeParse({ ...full, code_challenge_method: 'plain' }).success,
    ).toBe(false);
  });

  it('binds the viewer cookie to a login, or to nothing in observer mode (ADR-10)', () => {
    const viewer = {
      jti: 'jti_2',
      iat: 1,
      exp: 2,
      aud: 'https://host/xray',
      typ: 'viewer',
      login_id: 'lgn_5d2c7a',
      viewer_kind: 'pairing',
    };
    expect(JWT_CLAIMS_SCHEMAS.viewer.safeParse(viewer).success).toBe(true);
    const admin = JWT_CLAIMS_SCHEMAS.viewer.safeParse({
      ...viewer,
      login_id: null,
      viewer_kind: 'admin',
    });
    expect(admin.success).toBe(true);
    expect(admin.data?.login_id).toBeNull();
  });

  it('sets the documented lifetimes, shorter for a read-write grant (A-26)', () => {
    expect(TOKEN_LIFETIMES_SECONDS.code).toBe(600);
    expect(TOKEN_LIFETIMES_SECONDS.access).toBe(3600);
    expect(refreshLifetimeSeconds('read_only')).toBe(7 * 24 * 3600);
    expect(refreshLifetimeSeconds('read_write')).toBe(24 * 3600);
    expect(TOKEN_LIFETIMES_SECONDS.login).toBe(30 * 24 * 3600);
  });

  it('advertises PKCE S256 and a public client (A-12)', () => {
    expect(OAUTH_METADATA_CONSTANTS.codeChallengeMethodsSupported).toEqual(['S256']);
    expect(OAUTH_METADATA_CONSTANTS.tokenEndpointAuthMethodsSupported).toContain('none');
    expect(OAUTH_METADATA_CONSTANTS.authorizationResponseIssParameterSupported).toBe(true);
  });
});

describe('pairing codes (ADR-10, A-24)', () => {
  it('uses a 32-character alphabet without 0, O, 1 or I', () => {
    expect(PAIRING_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(PAIRING_CODE_ALPHABET).size).toBe(32);
    for (const banned of ['0', 'O', '1', 'I']) {
      expect(PAIRING_CODE_ALPHABET).not.toContain(banned);
    }
    expect(PAIRING_CODE_ENTROPY_BITS).toBe(50);
    expect(PAIRING_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(40);
  });

  it('formats and recognises BANK-XXXX-XXXX-XX', () => {
    expect(formatPairingCode('7Q2FK3MZ8A')).toBe('BANK-7Q2F-K3MZ-8A');
    expect(isPairingCode('BANK-7Q2F-K3MZ-8A')).toBe(true);
    expect(isPairingCode('BANK-7Q2F-K3MZ-80')).toBe(false);
    expect(isPairingCode('bank-7q2f-k3mz-8a')).toBe(false);
    expect(PAIRING_CODE_PATTERN.test('BANK-AAAA-AAAA-AA')).toBe(true);
    expect(() => formatPairingCode('short')).toThrow();
  });

  it('builds the link shown in chat from PUBLIC_BASE_URL', () => {
    expect(pairingUrl('https://host/', 'BANK-7Q2F-K3MZ-8A')).toBe(
      'https://host/xray/s/BANK-7Q2F-K3MZ-8A',
    );
  });
});
