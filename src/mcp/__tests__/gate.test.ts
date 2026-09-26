/**
 * The bearer gate (CLAUDE.md invariants 5 and 6, ADR-13).
 *
 * These are the shapes claude.ai reacts to, so every assertion is on the literal bytes: the
 * status code, the `WWW-Authenticate` header and the response body.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_CHALLENGE_SCOPE_STRING } from '../../contracts/index.js';

import {
  READ_ONLY_SCOPES,
  READ_WRITE_SCOPES,
  initializeFrame,
  startMcpHarness,
  tokenFor,
  type McpHarness,
} from './harness.js';

let harness: McpHarness;

beforeAll(async () => {
  harness = await startMcpHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('401: no access token (invariant 5)', () => {
  it('answers Ramp’s body and the resource_metadata challenge, never 200 + isError', async () => {
    const response = await harness.rpc(initializeFrame(), { token: null });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: 'No access token provided' });

    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toBe(
      `Bearer resource_metadata="${harness.baseUrl}/.well-known/oauth-protected-resource/mcp", ` +
        `scope="${DEFAULT_CHALLENGE_SCOPE_STRING}"`,
    );
    // The read-only hint only; write scopes are asked for by the 403 step-up.
    expect(challenge).not.toContain('cards:write');
  });

  it('answers 401 with error="invalid_token" when the verifier rejects the token', async () => {
    const response = await harness.rpc(initializeFrame(), { token: 'garbage-without-separator' });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('builds the challenge URL from the request Host when it is in PUBLIC_HOSTS (A-36)', async () => {
    const response = await harness.rpc(initializeFrame(), { token: null });
    expect(response.headers.get('www-authenticate')).toContain(harness.baseUrl);
  });
});

describe('403: insufficient_scope step-up (ADR-13)', () => {
  it('produces the documented challenge for a write tool under a read-only grant', async () => {
    const response = await harness.rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'lock_or_unlock_card', arguments: { rationale: 'the user asked' } },
      },
      { token: tokenFor(READ_ONLY_SCOPES) },
    );
    expect(response.status).toBe(403);
    // docs/ARCHITECTURE.md section 5 and docs/TOOL_CATALOG.md section 2, verbatim.
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="cards:write transfers:write", ' +
        `resource_metadata="${harness.baseUrl}/.well-known/oauth-protected-resource/mcp"`,
    );
    const body = (await response.json()) as { error: string; error_description: string };
    expect(body.error).toBe('insufficient_scope');
    // The sentence names what THIS tool needs. The header over-asks so one re-consent covers
    // everything, but the description is what the model reads and relays to the user, and
    // `lock_or_unlock_card` needs `cards:write` alone - not permission to move money.
    expect(body.error_description).toContain('The tool lock_or_unlock_card needs cards:write,');
    expect(body.error_description).not.toContain('needs cards:write transfers:write');
    // The wider list is still offered, as the way to avoid a second round trip.
    expect(body.error_description).toContain('Re-authorize with cards:write transfers:write');
  });

  it('does not tell the user a read-only tool needs permission to move money', async () => {
    // `xray_get_session_link` needs `xray:read` and nothing else; a grant without it used to be
    // told the tool "needs cards:write transfers:write xray:read".
    const response = await harness.rpc(
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'xray_get_session_link', arguments: { rationale: 'show me the session' } },
      },
      { token: tokenFor(['profile', 'accounts:read', 'transactions:read']) },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error_description: string };
    expect(body.error_description).toContain('The tool xray_get_session_link needs xray:read,');
    expect(body.error_description).not.toContain('needs cards:write');
  });

  it('lets the same call through once the write scopes are granted', async () => {
    const response = await harness.rpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'lock_or_unlock_card', arguments: { rationale: 'the user asked' } },
      },
      { token: tokenFor(READ_WRITE_SCOPES) },
    );
    expect(response.status).toBe(200);
  });

  it('checks every call in a JSON-RPC batch, not only the first', async () => {
    const response = await harness.rpc(
      [
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'get_current_user', arguments: { rationale: 'who am i' } },
        },
        {
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'create_transfer', arguments: { rationale: 'move money' } },
        },
      ],
      { token: tokenFor(READ_ONLY_SCOPES) },
    );
    expect(response.status).toBe(403);
  });

  it('does not step up for a tool the grant can already call', async () => {
    const response = await harness.rpc(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'get_current_user', arguments: { rationale: 'who am i' } },
      },
      { token: tokenFor(READ_ONLY_SCOPES) },
    );
    expect(response.status).toBe(200);
  });

  it('emits tool.call.denied and auth.stepup.requested with the scopes it asked for', async () => {
    harness.xray.clear();
    await harness.rpc(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'create_transfer', arguments: {} },
      },
      { token: tokenFor(READ_ONLY_SCOPES) },
    );
    const denied = harness.xray.of('tool.call.denied').at(-1);
    expect(denied?.data.tool).toBe('create_transfer');
    expect(denied?.data.denied_reason).toBe('insufficient_scope');
    expect(denied?.data.status).toBe(403);
    expect(denied?.data.missing_scopes).toEqual(['cards:write', 'transfers:write']);

    const stepUp = harness.xray.of('auth.stepup.requested').at(-1);
    expect(stepUp?.data.scope).toBe('cards:write transfers:write');
    expect(stepUp?.data.tool).toBe('create_transfer');
    expect(stepUp?.data.resource_metadata).toBe(
      `${harness.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    // The refusal belongs to the session it happened in, not to nothing (A-27).
    expect(denied?.xs).toMatch(/^xs_/);
    expect(denied?.grant_id).toBe('grt_test');
    harness.expectNoInvalidEvents();
  });
});

describe('feature flags bound the step-up (ADR-13)', () => {
  it('answers -32601 for a flag-disabled tool instead of demanding unissuable scopes', async () => {
    // With `writes` off the AS advertises no write scopes and /authorize filters a request down
    // to what it will issue, so a 403 asking for `cards:write` sent the client into a loop it
    // could never escape: re-authorize, get the same read-only grant, retry, 403 again. A tool
    // hidden by its feature flag must look unknown, which is what the SDK's -32601 says.
    const noWrites = await startMcpHarness({ config: { featureFlags: ['transfers'] } });
    try {
      const response = await noWrites.rpc(
        {
          jsonrpc: '2.0',
          id: 20,
          method: 'tools/call',
          params: { name: 'lock_or_unlock_card', arguments: { rationale: 'the user asked' } },
        },
        { token: tokenFor(READ_ONLY_SCOPES) },
      );
      expect(response.status).not.toBe(403);
      expect(response.headers.get('www-authenticate')).toBeNull();
      const body = (await response.json()) as { error?: { code: number } };
      expect(body.error?.code).toBe(-32601);
    } finally {
      await noWrites.close();
    }
  });

  it('never names a scope the authorization server would refuse to issue', async () => {
    // `writes` on, `transfers` off: `create_transfer` is flag-disabled, so the challenge for
    // `lock_or_unlock_card` must not ask for `transfers:write` on its behalf.
    const noTransfers = await startMcpHarness({ config: { featureFlags: ['writes'] } });
    try {
      const response = await noTransfers.rpc(
        {
          jsonrpc: '2.0',
          id: 21,
          method: 'tools/call',
          params: { name: 'lock_or_unlock_card', arguments: { rationale: 'the user asked' } },
        },
        { token: tokenFor(READ_ONLY_SCOPES) },
      );
      expect(response.status).toBe(403);
      const challenge = response.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain('scope="cards:write"');
      expect(challenge).not.toContain('transfers:write');
    } finally {
      await noTransfers.close();
    }
  });
});

describe('CORS on the real response, not only the preflight', () => {
  it('puts Access-Control-Allow-Origin and the exposed headers on the 401', async () => {
    // Only the OPTIONS preflight carried these, so a browser blocked every actual response and
    // JavaScript could never read `WWW-Authenticate`: the Inspector UI could not connect at all.
    const response = await harness.rpc(initializeFrame(30), {
      token: null,
      headers: { origin: 'https://claude.ai' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(response.headers.get('vary')).toContain('Origin');
    expect(response.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('puts them on the 403 step-up and on the 405 too', async () => {
    const stepUp = await harness.rpc(
      {
        jsonrpc: '2.0',
        id: 31,
        method: 'tools/call',
        params: { name: 'lock_or_unlock_card', arguments: { rationale: 'the user asked' } },
      },
      { token: tokenFor(READ_ONLY_SCOPES), headers: { origin: 'https://claude.ai' } },
    );
    expect(stepUp.status).toBe(403);
    expect(stepUp.headers.get('access-control-allow-origin')).toBe('https://claude.ai');

    const notAllowed = await harness.fetch('/mcp', {
      method: 'GET',
      headers: { origin: 'https://claude.ai' },
    });
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(notAllowed.headers.get('access-control-expose-headers')).toContain('WWW-Authenticate');
  });

  it('does not echo an origin the allowlist policy rejects', async () => {
    const strict = await startMcpHarness({ config: { originPolicy: 'allowlist' } });
    try {
      const response = await strict.rpc(initializeFrame(32), {
        token: null,
        headers: { origin: 'https://evil.example' },
      });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
      expect(response.headers.get('vary')).toContain('Origin');
    } finally {
      await strict.close();
    }
  });
});

describe('405 on GET and DELETE (invariant 6, ADR-3)', () => {
  it('answers 405 with Allow: POST and no session semantics', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await harness.fetch('/mcp', { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('Mcp-Session-Id');
    }
  });
});

describe('Origin policy (invariant 10)', () => {
  it('allows an unknown Origin under log-only and records the decision', async () => {
    harness.logs.length = 0;
    const response = await harness.rpc(initializeFrame(8), {
      headers: { origin: 'https://somewhere-else.example.com' },
    });
    expect(response.status).toBe(200);
    const request = harness.logs.find((record) => record.event === 'http.request');
    expect(request?.origin_decision).toBe('logged');
  });

  it('rejects an unknown Origin under allowlist and allows claude.ai and an absent Origin', async () => {
    const strict = await startMcpHarness({ config: { originPolicy: 'allowlist' } });
    try {
      const rejected = await strict.rpc(initializeFrame(9), {
        headers: { origin: 'https://somewhere-else.example.com' },
      });
      expect(rejected.status).toBe(403);

      const allowed = await strict.rpc(initializeFrame(10), {
        headers: { origin: 'https://claude.ai' },
      });
      expect(allowed.status).toBe(200);

      const absent = await strict.rpc(initializeFrame(11));
      expect(absent.status).toBe(200);
    } finally {
      await strict.close();
    }
  });
});

describe('per-request logging (fills docs/observations/claude-ai.md)', () => {
  it('records the protocol version header, clientInfo, Origin and User-Agent', async () => {
    harness.logs.length = 0;
    await harness.rpc(initializeFrame(12), {
      headers: {
        'mcp-protocol-version': '2025-11-25',
        origin: 'https://claude.ai',
        'user-agent': 'Claude-User/1.0',
      },
    });
    const request = harness.logs.find((record) => record.event === 'http.request');
    expect(request?.mcp_protocol_version_header).toBe('2025-11-25');
    expect(request?.initialize_protocol_version).toBe('2025-11-25');
    expect(request?.client_info).toEqual({ name: 'test-client', version: '0.0.1' });
    expect(request?.origin).toBe('https://claude.ai');
    expect(request?.user_agent).toBe('Claude-User/1.0');
    expect(request?.rpc_methods).toEqual(['initialize']);
  });

  it('never writes a token into a log line (invariant 7)', async () => {
    harness.logs.length = 0;
    const token = tokenFor(READ_ONLY_SCOPES, 'grt_secret');
    await harness.rpc(initializeFrame(13), { token });
    const serialised = JSON.stringify(harness.logs);
    expect(serialised).not.toContain('mockbank_user_tok_');
  });
});
