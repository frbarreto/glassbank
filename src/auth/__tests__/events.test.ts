/**
 * The `auth.*` X-ray events (CLAUDE.md invariant 13, docs/XRAY_EVENT_MODEL.md section 3).
 *
 * Every event here goes through `parseXrayEvent` inside the recording emitter, so a payload that
 * does not satisfy the frozen contract fails the test instead of being silently dropped. The
 * other half of the file is invariant 7: no bearer token, refresh token, code, verifier, `txn`
 * cookie or raw `client_id` may appear anywhere in the emitted stream.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OAUTH_ROUTES } from '../../contracts/index.js';
import { clientIdFingerprint } from '../clients.js';

import {
  DEFAULT_REDIRECT_URI,
  FORM_HEADERS,
  formBody,
  hiddenField,
  registerTestClient,
  startAuthHarness,
  walkToCode,
  type Harness,
} from './harness.js';

let harness: Harness;

beforeEach(async () => {
  harness = await startAuthHarness();
});

afterEach(async () => {
  await harness.close();
});

/** Every string in the emitted stream, so a leak can be searched for. */
function emittedJson(): string {
  return JSON.stringify(harness.emitter.events);
}

describe('the auth block as an X-ray producer', () => {
  it('emits auth.client.registered with the fingerprint, never the raw client_id', async () => {
    const clientId = await registerTestClient(harness);

    const [registered] = harness.emitter.ofType('auth.client.registered');
    expect(registered).toBeDefined();
    expect(registered?.data.client_id).toBe(clientIdFingerprint(clientId));
    expect(registered?.data.client_name).toBe('Test MCP client');
    expect(registered?.data.redirect_uris).toEqual([DEFAULT_REDIRECT_URI]);
    expect(registered?.data.token_endpoint_auth_method).toBe('none');
    expect(emittedJson()).not.toContain(clientId);
  });

  it('emits login.created, grant.created and token.issued through one walk', async () => {
    const walk = await walkToCode(harness);
    await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'authorization_code',
        code: walk.code ?? '',
        code_verifier: walk.verifier,
        redirect_uri: walk.redirectUri,
        client_id: walk.clientId,
        resource: `${harness.baseUrl}/mcp`,
      }),
    });

    expect(harness.emitter.invalid).toEqual([]);

    const [login] = harness.emitter.ofType('auth.login.created');
    expect(login?.data.persona_id).toBe('per_ava_stone');
    expect(login?.data.persona_source).toBe('seeded');
    expect(login?.data.shared_persona).toBe(true);
    expect(login?.login_id).toBe(login?.data.login_id);

    const [grant] = harness.emitter.ofType('auth.grant.created');
    expect(grant?.data.login_id).toBe(login?.data.login_id);
    expect(grant?.data.auth_level).toBe('read_only');
    expect(grant?.data.scopes).toContain('accounts:read');
    expect(grant?.data.shared_persona).toBe(true);
    expect(grant?.data.client_id).toBe(clientIdFingerprint(walk.clientId));
    // The envelope correlates, not just the payload: the dashboard filters on these.
    expect(grant?.grant_id).toBe(grant?.data.grant_id);
    expect(grant?.persona_id).toBe('per_ava_stone');

    const [issued] = harness.emitter.ofType('auth.token.issued');
    expect(issued?.data.grant_id).toBe(grant?.data.grant_id);
    expect(issued?.data.aud).toBe(`${harness.baseUrl}/mcp`);
    expect(Date.parse(issued?.data.expires_at ?? '')).toBeGreaterThan(Date.now());
    expect(issued?.data.refresh_expires_at).not.toBeNull();
  });

  it('emits token.refreshed with the rotated jti and never a token string', async () => {
    const walk = await walkToCode(harness);
    const first = (await (
      await harness.fetch(OAUTH_ROUTES.token, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: formBody({
          grant_type: 'authorization_code',
          code: walk.code ?? '',
          code_verifier: walk.verifier,
          redirect_uri: walk.redirectUri,
          client_id: walk.clientId,
        }),
      })
    ).json()) as { access_token: string; refresh_token: string };

    await harness.fetch(OAUTH_ROUTES.token, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
        client_id: walk.clientId,
      }),
    });

    const [refreshed] = harness.emitter.ofType('auth.token.refreshed');
    expect(refreshed).toBeDefined();
    expect(refreshed?.data.rotated_jti).toEqual(expect.any(String));
    expect(refreshed?.data.rotated_jti).not.toBe('');

    const stream = emittedJson();
    expect(stream).not.toContain(first.access_token);
    expect(stream).not.toContain(first.refresh_token);
    expect(stream).not.toContain(walk.code);
    expect(stream).not.toContain(walk.verifier);
  });

  it('emits token.revoked for a revocation request', async () => {
    const walk = await walkToCode(harness);
    const tokens = (await (
      await harness.fetch(OAUTH_ROUTES.token, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: formBody({
          grant_type: 'authorization_code',
          code: walk.code ?? '',
          code_verifier: walk.verifier,
          redirect_uri: walk.redirectUri,
          client_id: walk.clientId,
        }),
      })
    ).json()) as { refresh_token: string };

    await harness.fetch(OAUTH_ROUTES.revoke, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ token: tokens.refresh_token }),
    });

    const [revoked] = harness.emitter.ofType('auth.token.revoked');
    expect(revoked?.data.reason).toBe('revocation_request');
    expect(revoked?.data.grant_id).toBe(harness.emitter.ofType('auth.grant.created')[0]?.data.grant_id);
    expect(emittedJson()).not.toContain(tokens.refresh_token);
  });

  it('emits grant.updated with added_scopes on a step-up, not a second grant.created', async () => {
    const first = await walkToCode(harness, { scopes: 'profile accounts:read cards:write' });
    harness.emitter.clear();
    await walkToCode(harness, {
      clientId: first.clientId,
      scopes: 'profile accounts:read cards:write',
      approve: ['profile', 'accounts:read', 'cards:write'],
    });

    expect(harness.emitter.ofType('auth.grant.created')).toHaveLength(0);
    const [updated] = harness.emitter.ofType('auth.grant.updated');
    expect(updated?.data.added_scopes).toEqual(['cards:write']);
    expect(updated?.data.auth_level).toBe('read_write');
    expect(updated?.data.reason).toBe('step_up');
    expect(updated?.data.grant_id).toBe(updated?.grant_id);
  });

  it('emits grant.updated with reason re_consent when nothing new was added', async () => {
    const first = await walkToCode(harness, { scopes: 'profile accounts:read' });
    harness.emitter.clear();
    await walkToCode(harness, { clientId: first.clientId, scopes: 'profile accounts:read' });

    const [updated] = harness.emitter.ofType('auth.grant.updated');
    expect(updated?.data.added_scopes).toEqual([]);
    expect(updated?.data.reason).toBe('re_consent');
  });

  it('emits auth.rejected for a CSRF mismatch on a browser POST', async () => {
    const clientId = await registerTestClient(harness);
    const loginPage = await harness.fetch(
      `${OAUTH_ROUTES.authorize}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(DEFAULT_REDIRECT_URI)}` +
        '&code_challenge=abcdefghijklmnopqrstuvwxyz012345&code_challenge_method=S256',
    );
    const html = await loginPage.text();
    harness.emitter.clear();

    const response = await harness.fetch(OAUTH_ROUTES.login, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: formBody({ txn: hiddenField(html, 'txn'), csrf: 'not-the-cookie', choice: 'per_ava_stone' }),
    });

    expect(response.status).toBe(403);
    const [rejected] = harness.emitter.ofType('auth.rejected');
    expect(rejected?.data.status).toBe(403);
    expect(rejected?.data.reason).toBe('malformed');
    expect(rejected?.data.error).toBe('invalid_request');
  });

  it('emits auth.rejected for a replayed authorization code and a wrong verifier', async () => {
    const walk = await walkToCode(harness);
    const exchange = async (verifier: string): Promise<Response> =>
      await harness.fetch(OAUTH_ROUTES.token, {
        method: 'POST',
        headers: FORM_HEADERS,
        body: formBody({
          grant_type: 'authorization_code',
          code: walk.code ?? '',
          code_verifier: verifier,
          redirect_uri: walk.redirectUri,
          client_id: walk.clientId,
        }),
      });

    harness.emitter.clear();
    const wrong = await exchange('a-different-verifier-entirely-0123456789');
    expect(wrong.status).toBe(400);
    // The first exchange consumed the code, so the second is a replay.
    const replay = await exchange(walk.verifier);
    expect(replay.status).toBe(400);

    const reasons = harness.emitter.ofType('auth.rejected').map((event) => event.data.reason);
    expect(reasons).toEqual(['invalid_grant', 'invalid_grant']);
    expect(harness.emitter.ofType('auth.rejected')[0]?.data.client_id).toBe(
      clientIdFingerprint(walk.clientId),
    );
  });

  it('emits auth.client.reconstructed for a client id nothing remembers (A-12)', async () => {
    await harness.fetch(
      `${OAUTH_ROUTES.authorize}?response_type=code&client_id=mcpb_never_registered` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/mcp/auth_callback')}` +
        '&code_challenge=abcdefghijklmnopqrstuvwxyz012345&code_challenge_method=S256',
    );

    const [reconstructed] = harness.emitter.ofType('auth.client.reconstructed');
    expect(reconstructed?.data.reason).toBe('unknown_client_after_restart');
    expect(reconstructed?.data.client_name).toBe('unknown (reconstructed)');
    expect(reconstructed?.data.client_id).toBe(clientIdFingerprint('mcpb_never_registered'));
    expect(reconstructed?.data.redirect_uris).toContain('https://claude.ai/api/mcp/auth_callback');
  });

  it('emits auth.login.created with persona_source generated for a new demo customer', async () => {
    await walkToCode(harness, { choice: '__new__' });
    const [login] = harness.emitter.ofType('auth.login.created');
    expect(login?.data.persona_source).toBe('generated');
    expect(login?.data.shared_persona).toBe(false);
  });

  it('never lets a throwing emitter break an OAuth endpoint (invariant 5 over invariant 13)', async () => {
    const broken = await startAuthHarness(
      {},
      {
        emitter: {
          emit() {
            throw new Error('the X-ray is on fire');
          },
        },
      },
    );
    try {
      const walk = await walkToCode(broken);
      expect(walk.consent.status).toBe(302);
      expect(walk.code).toBeTruthy();
    } finally {
      await broken.close();
    }
  });

  it('emits nothing at all when no emitter is injected', async () => {
    // The stdout logger is the fallback, and it must not double up with the emitter: a block with
    // an emitter logs through it, a block without one keeps printing.
    const lines: { event: string }[] = [];
    const quiet = await startAuthHarness({}, { emitter: undefined, log: (record) => lines.push(record) });
    try {
      await walkToCode(quiet);
      expect(quiet.emitter.events).toEqual([]);
      expect(lines.map((line) => line.event)).toContain('auth.grant.created');
    } finally {
      await quiet.close();
    }
  });
});
