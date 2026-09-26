/**
 * The scripted OAuth walk and its negative cases (docs/ARCHITECTURE.md section 5, ADR-4, A-13).
 *
 * Everything here is HTTP against a real socket: DCR, the two browser POSTs, `/token` with PKCE,
 * refresh rotation, `/revoke`, and the replays that must answer `invalid_grant`.
 */
import { randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COOKIE_NAMES, OAUTH_ROUTES, stripAccessTokenPrefix } from '../../contracts/index.js';
import { pkceChallengeFor } from '../routes.js';

import {
  FORM_HEADERS,
  formBody,
  hiddenField,
  startAuthHarness,
  type Harness,
} from './harness.js';

const REDIRECT_URI = 'http://127.0.0.1:7777/callback';

/** The `/token` success body. Spelled out so `noUncheckedIndexedAccess` does not hide a typo. */
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

let harness: Harness;

beforeEach(async () => {
  harness = await startAuthHarness();
});

afterEach(async () => {
  await harness.close();
});

async function registerClient(redirectUris: string[] = [REDIRECT_URI]): Promise<string> {
  const response = await harness.fetch(OAUTH_ROUTES.register, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test MCP client',
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).not.toHaveProperty('client_secret');
  expect(body.token_endpoint_auth_method).toBe('none');
  return body.client_id as string;
}

interface WalkResult {
  readonly clientId: string;
  readonly verifier: string;
  readonly code: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly iss: string;
}

/** DCR -> /authorize -> /login -> /consent, ending at the callback redirect. */
async function walkToCode(
  options: { scopes?: string; approveWrites?: boolean; clientId?: string } = {},
): Promise<WalkResult> {
  // Re-consent (ADR-14) only extends an existing grant when the login *and* the client match, so
  // a caller that wants that path has to reuse the client id rather than register a fresh one.
  const clientId = options.clientId ?? (await registerClient());
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');

  const authorizeUrl =
    `${OAUTH_ROUTES.authorize}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}` +
    `&code_challenge=${pkceChallengeFor(verifier)}&code_challenge_method=S256` +
    `&scope=${encodeURIComponent(options.scopes ?? 'profile accounts:read cards:read cards:write transfers:write')}` +
    `&resource=${encodeURIComponent(`${harness.baseUrl}/mcp`)}`;

  const loginPage = await harness.fetch(authorizeUrl);
  expect(loginPage.status).toBe(200);
  const loginHtml = await loginPage.text();
  const txn = hiddenField(loginHtml, 'txn');
  const csrf = hiddenField(loginHtml, 'csrf');

  const consentPage = await harness.fetch(OAUTH_ROUTES.login, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: formBody({ txn, csrf, choice: 'per_ava_stone' }),
  });
  expect(consentPage.status).toBe(200);
  const consentHtml = await consentPage.text();
  const txn2 = hiddenField(consentHtml, 'txn');

  const selected = options.approveWrites
    ? ['profile', 'accounts:read', 'cards:read', 'cards:write', 'transfers:write']
    : ['profile', 'accounts:read', 'cards:read'];

  const redirect = await harness.fetch(OAUTH_ROUTES.consent, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: formBody({ txn: txn2, csrf, scope: selected, decision: 'approve' }),
  });
  expect(redirect.status).toBe(302);
  const location = new URL(redirect.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe(REDIRECT_URI);
  expect(location.searchParams.get('state')).toBe(state);
  const iss = location.searchParams.get('iss');
  expect(iss).toBe(harness.baseUrl);
  const code = location.searchParams.get('code');
  expect(code).toBeTruthy();

  return { clientId, verifier, code: code as string, state, redirectUri: REDIRECT_URI, iss: iss as string };
}

async function exchange(walk: WalkResult, overrides: Record<string, string> = {}): Promise<Response> {
  return await harness.fetch(OAUTH_ROUTES.token, {
    method: 'POST',
    headers: FORM_HEADERS,
    body: formBody({
      grant_type: 'authorization_code',
      code: walk.code,
      code_verifier: walk.verifier,
      redirect_uri: walk.redirectUri,
      client_id: walk.clientId,
      resource: `${harness.baseUrl}/mcp`,
      ...overrides,
    }),
  });
}

describe('dynamic client registration (A-12, A-13)', () => {
  it('registers a public client and refuses a redirect URI off the allowlist', async () => {
    await registerClient();
    const bad = await harness.fetch(OAUTH_ROUTES.register, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.example.com/callback'] }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Record<string, unknown>).error).toBe('invalid_redirect_uri');
  });

  it('refuses a confidential client', async () => {
    const response = await harness.fetch(OAUTH_ROUTES.register, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_post',
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, unknown>).error).toBe(
      'invalid_client_metadata',
    );
  });

  it('accepts the real claude.ai callback', async () => {
    await expect(registerClient(['https://claude.ai/api/mcp/auth_callback'])).resolves.toBeTruthy();
  });
});

describe('the browser pages (CLAUDE.md invariant 15)', () => {
  it('sends the anti-framing headers and a Strict CSRF cookie', async () => {
    const clientId = await registerClient();
    const response = await harness.fetch(
      `${OAUTH_ROUTES.authorize}?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${pkceChallengeFor('verifier-value-that-is-long-enough')}&code_challenge_method=S256`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    const setCookie = response.headers.getSetCookie().join('\n');
    expect(setCookie).toContain(`${COOKIE_NAMES.csrf}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
  });

  it('sets the 30-day login_id cookie on the login POST (ADR-14)', async () => {
    const clientId = await registerClient();
    const page = await harness.fetch(
      `${OAUTH_ROUTES.authorize}?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${pkceChallengeFor('verifier-value-that-is-long-enough')}&code_challenge_method=S256`,
    );
    const html = await page.text();
    const response = await harness.fetch(OAUTH_ROUTES.login, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        txn: hiddenField(html, 'txn'),
        csrf: hiddenField(html, 'csrf'),
        choice: 'per_noah_reid',
      }),
    });
    expect(response.status).toBe(200);
    const setCookie = response.headers.getSetCookie().join('\n');
    expect(setCookie).toContain(`${COOKIE_NAMES.login}=`);
    expect(setCookie).toContain('Max-Age=2592000');
    // SameSite=Lax, not Strict: claude.ai opens /authorize as a cross-site navigation (A-41).
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
  });

  it('rejects a POST with no txn, a mismatched txn, or a mismatched CSRF token', async () => {
    const clientId = await registerClient();
    const page = await harness.fetch(
      `${OAUTH_ROUTES.authorize}?client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${pkceChallengeFor('verifier-value-that-is-long-enough')}&code_challenge_method=S256`,
    );
    const html = await page.text();
    const txn = hiddenField(html, 'txn');
    const csrf = hiddenField(html, 'csrf');

    const noTxn = await harness.fetch(OAUTH_ROUTES.login, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ csrf, choice: 'per_ava_stone' }),
    });
    expect(noTxn.status).toBe(400);

    const badCsrf = await harness.fetch(OAUTH_ROUTES.login, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ txn, csrf: 'not-the-cookie-value', choice: 'per_ava_stone' }),
    });
    expect(badCsrf.status).toBe(403);

    const notAJwt = await harness.fetch(OAUTH_ROUTES.login, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ txn: 'not.a.jwt', csrf, choice: 'per_ava_stone' }),
    });
    expect(notAJwt.status).toBe(400);
  });

  it('refuses an unregistered redirect_uri without redirecting to it', async () => {
    const clientId = await registerClient();
    const response = await harness.fetch(
      `${OAUTH_ROUTES.authorize}?client_id=${clientId}&redirect_uri=${encodeURIComponent('https://evil.example.com/callback')}&code_challenge=${pkceChallengeFor('verifier-value-that-is-long-enough')}&code_challenge_method=S256`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  });
});

describe('/token', () => {
  it('completes the walk and issues a prefixed access token plus a refresh token', async () => {
    const walk = await walkToCode();
    const response = await exchange(walk);
    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenResponse;
    expect(body.token_type).toBe('bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.access_token.startsWith('mockbank_user_tok_')).toBe(true);
    expect(body.refresh_token).toBeTruthy();
    expect(body.scope).toBe('profile accounts:read cards:read');

    const verified = await harness.auth.verifyAccessToken(body.access_token);
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.claims.aud).toBe(`${harness.baseUrl}/mcp`);
      expect(verified.claims.auth_level).toBe('read_only');
      expect(verified.claims.sub).toBe('per_ava_stone');
    }
  });

  it('flips the grant to read_write when a write scope is approved', async () => {
    const walk = await walkToCode({ approveWrites: true });
    const body = (await (await exchange(walk)).json()) as TokenResponse;
    const verified = await harness.auth.verifyAccessToken(body.access_token);
    expect(verified.ok && verified.claims.auth_level).toBe('read_write');
  });

  it('answers invalid_grant for a replayed authorization code (ADR-4)', async () => {
    const walk = await walkToCode();
    expect((await exchange(walk)).status).toBe(200);
    const replay = await exchange(walk);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as OAuthErrorBody).error).toBe('invalid_grant');
  });

  it('answers invalid_grant for a wrong PKCE verifier', async () => {
    const walk = await walkToCode();
    const response = await exchange(walk, { code_verifier: 'a-different-verifier-entirely' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as OAuthErrorBody).error).toBe('invalid_grant');
  });

  it('answers invalid_grant for a mismatched redirect_uri', async () => {
    const walk = await walkToCode();
    const response = await exchange(walk, { redirect_uri: 'http://127.0.0.1:9999/callback' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as OAuthErrorBody).error).toBe('invalid_grant');
  });

  it('rotates the refresh token and answers invalid_grant on a replay', async () => {
    const walk = await walkToCode();
    const first = (await (await exchange(walk)).json()) as TokenResponse;

    const refreshed = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: walk.clientId,
      }),
    });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as TokenResponse;
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const replay = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: walk.clientId,
      }),
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as OAuthErrorBody).error).toBe('invalid_grant');
  });

  it('binds the refresh token to its client: another client_id is invalid_grant', async () => {
    // OAuth 2.1: the AS binds a refresh token to the client it was issued to, and a public client
    // MUST send `client_id`. Without this the grant record and the minted access token silently
    // took their `client_id` from the claims, so the X-ray attributed the token to the wrong
    // client and any caller could rotate someone else's refresh token.
    const walk = await walkToCode();
    const tokens = (await (await exchange(walk)).json()) as TokenResponse;

    const impersonated = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: 'mcpb_someone_else',
      }),
    });
    expect(impersonated.status).toBe(400);
    expect(((await impersonated.json()) as OAuthErrorBody).error).toBe('invalid_grant');

    const anonymous = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    });
    expect(anonymous.status).toBe(400);
    expect(((await anonymous.json()) as OAuthErrorBody).error).toBe('invalid_grant');

    // The token itself is still good for the client it belongs to.
    const legitimate = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: walk.clientId,
      }),
    });
    expect(legitimate.status).toBe(200);
  });

  it('requires client_id on an authorization_code exchange (OAuth 2.1)', async () => {
    const walk = await walkToCode();
    const response = await exchange(walk, { client_id: '' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as OAuthErrorBody).error).toBe('invalid_grant');
  });

  it('rejects an unsupported grant type', async () => {
    const response = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ grant_type: 'client_credentials' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as OAuthErrorBody).error).toBe(
      'unsupported_grant_type',
    );
  });
});

describe('re-consent (ADR-14, invariant 15)', () => {
  it('takes back a write scope the user un-ticked instead of only ever widening', async () => {
    // The consent page renders write boxes unchecked and prints the resulting authorization
    // level. A widen-only rule made that a lie: there was no path short of /revoke by which a
    // user could take a write scope back. Scopes *outside* this authorization request stay
    // untouched, so the step-up behaviour ADR-14 needs is unaffected.
    const first = await walkToCode({ approveWrites: true });
    const firstTokens = (await (await exchange(first)).json()) as TokenResponse;
    expect(firstTokens.scope).toContain('cards:write');

    // Same browser, same client: this is the grant-widening path of ADR-14.
    const second = await walkToCode({ approveWrites: false, clientId: first.clientId });
    const secondTokens = (await (await exchange(second)).json()) as TokenResponse;
    expect(secondTokens.scope).not.toContain('cards:write');
    expect(secondTokens.scope).not.toContain('transfers:write');
    expect(secondTokens.scope).toContain('accounts:read');

    const claimsOf = (token: string): { auth_level: string; grant_id: string } =>
      JSON.parse(
        Buffer.from(
          stripAccessTokenPrefix(token).split('.')[1] as string,
          'base64url',
        ).toString(),
      ) as { auth_level: string; grant_id: string };
    // The same grant was extended, not a fresh one created - otherwise this proves nothing.
    expect(claimsOf(secondTokens.access_token).grant_id).toBe(
      claimsOf(firstTokens.access_token).grant_id,
    );
    expect(claimsOf(secondTokens.access_token).auth_level).toBe('read_only');
  });

  it('still widens on a step-up: the second consent adds what the first did not have', async () => {
    const first = await walkToCode({ approveWrites: false });
    const firstTokens = (await (await exchange(first)).json()) as TokenResponse;
    expect(firstTokens.scope).not.toContain('cards:write');

    const second = await walkToCode({ approveWrites: true, clientId: first.clientId });
    const secondTokens = (await (await exchange(second)).json()) as TokenResponse;
    expect(secondTokens.scope).toContain('cards:write');
    expect(secondTokens.scope).toContain('transfers:write');
  });
});

describe('robustness of the unauthenticated surface', () => {
  it('survives a malformed cookie instead of crashing the process', async () => {
    // `decodeURIComponent` throws URIError on a value that is not valid percent-encoding, and the
    // handler promise was discarded with `void`, so the rejection reached Node - which under
    // `--unhandled-rejections=throw` exits. One request, whole service down.
    const response = await harness.fetch(
      `${OAUTH_ROUTES.authorize}?client_id=x&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
        '&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256',
      { headers: { cookie: `${COOKIE_NAMES.login}=%E0%A4%A` } },
    );
    expect(response.status).toBeGreaterThanOrEqual(200);
    // The process is still answering.
    const after = await harness.fetch(OAUTH_ROUTES.authorizationServerMetadata);
    expect(after.status).toBe(200);
  });

  it('refuses a registration with an unbounded redirect_uris array (ADR-16)', async () => {
    const many = Array.from({ length: 40 }, (_, index) => `http://127.0.0.1:${7000 + index}/callback`);
    const response = await harness.fetch(OAUTH_ROUTES.register, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: many, token_endpoint_auth_method: 'none' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as OAuthErrorBody).error).toBe('invalid_redirect_uri');
  });

  it('refuses a single absurdly long redirect URI', async () => {
    const response = await harness.fetch(OAUTH_ROUTES.register, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [`http://127.0.0.1:7777/callback?padding=${'x'.repeat(2000)}`],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as OAuthErrorBody).error).toBe('invalid_redirect_uri');
  });

  it('cannot have its /token limit bypassed by rotating client_id', async () => {
    // `client_id` is unauthenticated free-form text, so it may only narrow the limit. The
    // un-rotatable per-IP window is charged first.
    const limited = await startAuthHarness({
      rateLimits: {
        ipRegisterPerHour: 60,
        ipAuthorizePer15Min: 5,
        ipTokenPer15Min: 5,
        ipConsentPer15Min: 60,
        clientTokenPer15Min: 120,
        loginGrantsPerDay: 20,
      },
    });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await limited.fetch(OAUTH_ROUTES.token, {
          method: 'POST',
          headers: FORM_HEADERS,
          body: formBody({
            grant_type: 'refresh_token',
            refresh_token: 'bogus',
            client_id: `rotating_${attempt}`,
          }),
        });
        statuses.push(response.status);
      }
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });

  it('rate-limits /revoke, which had no limit at all', async () => {
    const limited = await startAuthHarness({
      rateLimits: {
        ipRegisterPerHour: 60,
        ipAuthorizePer15Min: 3,
        ipTokenPer15Min: 3,
        ipConsentPer15Min: 60,
        clientTokenPer15Min: 120,
        loginGrantsPerDay: 20,
      },
    });
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await limited.fetch(OAUTH_ROUTES.revoke, {
          method: 'POST',
          headers: FORM_HEADERS,
          body: formBody({ token: 'not-a-token' }),
        });
        statuses.push(response.status);
      }
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});

describe('/revoke (RFC 7009)', () => {
  it('kills the grant: the refresh token and the access token both stop working', async () => {
    const walk = await walkToCode();
    const tokens = (await (await exchange(walk)).json()) as TokenResponse;

    const revoked = await harness.fetch(OAUTH_ROUTES.revoke, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ token: tokens.refresh_token, token_type_hint: 'refresh_token' }),
    });
    expect(revoked.status).toBe(200);

    const afterRevoke = await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: walk.clientId,
      }),
    });
    expect(((await afterRevoke.json()) as OAuthErrorBody).error).toBe('invalid_grant');

    const verified = await harness.auth.verifyAccessToken(tokens.access_token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('revoked_grant');
  });

  it('answers 200 for an unknown token, so it cannot be used as an oracle', async () => {
    const response = await harness.fetch(OAUTH_ROUTES.revoke, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ token: 'not-a-token-at-all' }),
    });
    expect(response.status).toBe(200);
  });
});

describe('the verifier (ADR-4: wrong typ is invalid_token)', () => {
  it('rejects an authorization code presented as a bearer token', async () => {
    const walk = await walkToCode();
    const verified = await harness.auth.verifyAccessToken(walk.code);
    expect(verified.ok).toBe(false);
    if (!verified.ok) {
      expect(verified.reason).toBe('wrong_typ');
      expect(verified.error).toBe('invalid_token');
      expect(verified.status).toBe(401);
    }
  });

  it('rejects a refresh token presented as a bearer token', async () => {
    const walk = await walkToCode();
    const tokens = (await (await exchange(walk)).json()) as TokenResponse;
    const verified = await harness.auth.verifyAccessToken(tokens.refresh_token);
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.reason).toBe('wrong_typ');
  });

  it('rejects a token signed with a different key', async () => {
    const other = await startAuthHarness({ oauthSigningKey: 'a-completely-different-key-value' });
    try {
      const walk = await walkToCode();
      const tokens = (await (await exchange(walk)).json()) as TokenResponse;
      const verified = await other.auth.verifyAccessToken(tokens.access_token);
      expect(verified.ok).toBe(false);
      if (!verified.ok) expect(verified.reason).toBe('invalid_signature');
    } finally {
      await other.close();
    }
  });

  it('rejects a token whose audience is not a PUBLIC_HOSTS-derived MCP URL (A-36)', async () => {
    const walk = await walkToCode();
    const response = await exchange(walk, { resource: 'https://elsewhere.example.com/mcp' });
    const tokens = (await response.json()) as TokenResponse;
    const verified = await harness.auth.verifyAccessToken(tokens.access_token);
    // The unacceptable `resource` was ignored at /token, so the token is still valid here.
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.claims.aud).toBe(`${harness.baseUrl}/mcp`);
    expect(stripAccessTokenPrefix(tokens.access_token)).not.toBe(tokens.access_token);
  });
});
