/**
 * The overview, the account route and the per-session identity (block: xray, contracts v0.10).
 *
 * D-32: `GET /xray/api/stats` counts every event the viewer's scope may read and nothing else - the
 * public lane its anonymous calls, a pairing cookie its own login, the admin everything (without
 * argument values, D-5). D-29: a session's identity keeps the three answers apart - the signature
 * verdict, `clientInfo`, the `User-Agent`. D-31: the account route follows the persona card's rule.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COOKIE_NAMES,
  PUBLIC_LOGIN_ID,
  type XrayBankActivity,
  type XraySessionsResponse,
  type XrayStatsResponse,
} from '../../contracts/index.js';

import { cookieFrom, createHarness } from './harness.js';

const ADMIN_TOKEN = 'observer-token-for-tests-0123456789';
const PUBLIC_XS = 'xs_public01';
const PUBLIC_GRANT = 'grt_pub_0123456789ab';
const PRIVATE_XS = 'xs_private1';

let clock = Date.parse('2026-09-27T12:00:00.000Z');
const now = (): Date => new Date(clock);

const visitor = {
  xs: PUBLIC_XS,
  login_id: PUBLIC_LOGIN_ID,
  grant_id: PUBLIC_GRANT,
  client: { name: 'claude-ai', version: '0.1.0', title: null },
};
const signedIn = {
  xs: PRIVATE_XS,
  login_id: 'lgn_alpha01',
  grant_id: 'grt_alpha01',
  persona_id: 'per_alpha1',
  client: { name: 'Codex', version: '0.153.4', title: null },
};

function httpRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    path: '/public/mcp',
    status: 200,
    duration_ms: 3,
    user_agent: 'Claude-User',
    ...overrides,
  };
}

function seed(harness: ReturnType<typeof createHarness>): void {
  const emit = harness.xray.emitter;
  // Two hours ago: a public call the 1 h window must leave out.
  clock -= 2 * 3_600_000;
  emit.emit(
    'tool.call.started',
    {
      tool: 'list_products',
      arguments: { family: 'checking' },
      rationale: 'old call',
      rationale_present: true,
    },
    { ...visitor, request_id: '1' },
  );
  emit.emit(
    'tool.call.completed',
    { tool: 'list_products', duration_ms: 4, is_error: false },
    {
      ...visitor,
      request_id: '1',
    },
  );
  clock += 2 * 3_600_000;

  emit.emit(
    'session.initialized',
    {
      protocol_version_negotiated: '2025-11-25',
      client: { name: 'claude-ai', version: '0.1.0', title: null },
      initialize_count: 1,
    },
    visitor,
  );
  emit.emit(
    'http.request',
    httpRequest({
      signature: {
        present: true,
        verdict: 'verified',
        agent: 'https://agent.example',
        keyid: 'kid-1',
        challenge_sent: true,
      },
    }),
    { ...visitor, request_id: '2' },
  );
  emit.emit(
    'tool.call.started',
    {
      tool: 'search_prices',
      arguments: { product_id: 'clear_checking', query: 'wire' },
      rationale: 'The user compares wire fees between banks.',
      rationale_present: true,
    },
    { ...visitor, request_id: '2' },
  );
  emit.emit(
    'tool.call.completed',
    { tool: 'search_prices', duration_ms: 10, is_error: false },
    {
      ...visitor,
      request_id: '2',
    },
  );
  emit.emit(
    'tool.call.started',
    {
      tool: 'get_product',
      arguments: { product_id: 'nope' },
      rationale_present: false,
    },
    { ...visitor, request_id: '3' },
  );
  emit.emit(
    'tool.call.completed',
    {
      tool: 'get_product',
      duration_ms: 2,
      is_error: true,
      error: { message: 'Ran into an error: no product nope.', class: 'tool' },
    },
    { ...visitor, request_id: '3' },
  );
  emit.emit('http.request', httpRequest({ status: 429, rate_limited: true }), visitor);

  emit.emit('http.request', httpRequest({ path: '/mcp', user_agent: 'openai-mcp/1.0.0 (Codex)' }), {
    ...signedIn,
    request_id: '7',
  });
  emit.emit(
    'tool.call.started',
    {
      tool: 'load_accounts',
      arguments: { account_type: 'checking' },
      rationale: 'A signed-in session the public lane must never show.',
      rationale_present: true,
    },
    { ...signedIn, request_id: '7' },
  );
  emit.emit(
    'tool.call.denied',
    {
      tool: 'create_transfer',
      denied_reason: 'insufficient_scope',
      missing_scopes: ['transfers:write'],
    },
    { ...signedIn, request_id: '8' },
  );
  harness.xray.flush();
}

describe('the overview and the account (v0.10)', () => {
  let harness: ReturnType<typeof createHarness>;
  let baseUrl: string;
  const activityCalls: { persona_id: string; months: number }[] = [];

  beforeEach(async () => {
    clock = Date.parse('2026-09-27T12:00:00.000Z');
    activityCalls.length = 0;
    harness = createHarness({
      adminToken: ADMIN_TOKEN,
      now,
      lookupBankActivity: async (session, options) => {
        activityCalls.push({ persona_id: session.persona_id, months: options.months });
        return {
          persona: { id: session.persona_id },
          months: options.months,
        } as unknown as XrayBankActivity;
      },
    });
    seed(harness);
    baseUrl = await harness.listen();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function json<T>(path: string, cookie?: string): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: cookie ? { cookie: `${COOKIE_NAMES.viewer}=${cookie}` } : {},
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  async function adminCookie(): Promise<string> {
    const response = await fetch(`${baseUrl}/xray/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const cookie = cookieFrom(response.headers, COOKIE_NAMES.viewer);
    if (!cookie) throw new Error('no admin cookie');
    return cookie;
  }

  async function pairingCookie(loginId: string): Promise<string> {
    const minted = await harness.xray.pairing.createCode({ login_id: loginId });
    const response = await fetch(`${baseUrl}/xray/s/${minted.code}`, { redirect: 'manual' });
    const cookie = cookieFrom(response.headers, COOKIE_NAMES.viewer);
    if (!cookie) throw new Error('no pairing cookie');
    return cookie;
  }

  it('counts the public lane for anyone, and only the public lane', async () => {
    const { status, body } = await json<XrayStatsResponse>(
      '/xray/api/stats?lane=public&window=24h',
    );
    expect(status).toBe(200);
    expect(body.viewer_kind).toBe('public');
    expect(body.totals).toMatchObject({
      sessions: 1,
      visitors: 1,
      calls: 3,
      calls_ok: 2,
      calls_failed: 1,
      calls_denied: 0,
      rate_limited: 1,
      http_requests: 2,
      signed_requests: 1,
      verified_requests: 1,
      calls_without_rationale: 1,
    });
    expect(body.by_tool.map((row) => row.tool).sort()).toEqual([
      'get_product',
      'list_products',
      'search_prices',
    ]);
    expect(JSON.stringify(body)).not.toContain('load_accounts');
    expect(body.by_client).toEqual([
      expect.objectContaining({
        label: 'claude-ai 0.1.0',
        signature_verdict: 'verified',
        signed_agent: 'https://agent.example',
        sessions: 1,
        calls: 3,
      }),
    ]);
    // Scalar arguments are counted, the rationale never is.
    expect(body.top_arguments).toContainEqual({
      tool: 'search_prices',
      key: 'query',
      value: 'wire',
      count: 1,
    });
    expect(JSON.stringify(body.top_arguments)).not.toContain('wire fees');
    expect(body.recent_errors.map((error) => error.kind)).toEqual(['rate_limited', 'tool_error']);
    expect(body.recent_errors[1]?.message).toContain('no product nope');
  });

  it('narrows to the window asked for', async () => {
    const lastHour = await json<XrayStatsResponse>('/xray/api/stats?lane=public&window=1h');
    expect(lastHour.body.window).toBe('1h');
    expect(lastHour.body.totals.calls).toBe(2);
    expect(lastHour.body.bucket_minutes).toBe(5);
    expect(lastHour.body.by_time.reduce((sum, bucket) => sum + bucket.calls, 0)).toBe(2);
    const unknown = await json<XrayStatsResponse>('/xray/api/stats?lane=public&window=forever');
    expect(unknown.body.window).toBe('24h');
  });

  it('gives a pairing cookie its own login and nothing of the public lane', async () => {
    const cookie = await pairingCookie('lgn_alpha01');
    const { body } = await json<XrayStatsResponse>('/xray/api/stats', cookie);
    expect(body.viewer_kind).toBe('pairing');
    expect(body.totals).toMatchObject({ sessions: 1, calls: 2, calls_denied: 1 });
    expect(body.by_tool.map((row) => row.tool).sort()).toEqual([
      'create_transfer',
      'load_accounts',
    ]);
    expect(body.top_arguments).toEqual([
      { tool: 'load_accounts', key: 'account_type', value: 'checking', count: 1 },
    ]);
  });

  it('gives the admin every lane but no argument values (D-5)', async () => {
    const cookie = await adminCookie();
    const { body } = await json<XrayStatsResponse>('/xray/api/stats?all=1', cookie);
    expect(body.viewer_kind).toBe('admin');
    expect(body.totals.sessions).toBe(2);
    expect(body.top_arguments).toEqual([]);
  });

  it('refuses a caller with no cookie outside the public lane', async () => {
    const { status } = await json('/xray/api/stats');
    expect(status).toBe(401);
  });

  it("puts each session's identity on the session list, the three answers apart", async () => {
    const { body } = await json<XraySessionsResponse>('/xray/api/sessions?lane=public');
    expect(body.data[0]?.identity).toEqual({
      signature_verdict: 'verified',
      signed_agent: 'https://agent.example',
      keyid: 'kid-1',
      signed_requests: 1,
      verified_requests: 1,
      challenged: true,
      client_name: 'claude-ai',
      client_version: '0.1.0',
      user_agent: 'Claude-User',
      anthropic_egress: false,
    });
  });

  it('serves the account view with the persona card rule', async () => {
    const cookie = await pairingCookie('lgn_alpha01');
    const ok = await json<XrayBankActivity>(
      `/xray/api/sessions/${PRIVATE_XS}/bank/activity?months=6`,
      cookie,
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ months: 6, xs: PRIVATE_XS, login_id: 'lgn_alpha01' });
    expect(activityCalls).toEqual([{ persona_id: 'per_alpha1', months: 6 }]);

    const publicVisitor = await json<{ error: string }>(
      `/xray/api/sessions/${PUBLIC_XS}/bank/activity?lane=public`,
    );
    expect(publicVisitor.status).toBe(404);
    expect(publicVisitor.body.error).toBe('no_persona');

    const stranger = await pairingCookie('lgn_beta001');
    const refused = await json(`/xray/api/sessions/${PRIVATE_XS}/bank/activity`, stranger);
    expect(refused.status).toBe(403);
  });
});

describe('the account view without a bank', () => {
  it('answers 503 when nothing is wired', async () => {
    const harness = createHarness({ adminToken: ADMIN_TOKEN });
    harness.xray.emitter.emit('session.started', { reason: 'first_request' }, signedIn);
    harness.xray.flush();
    const baseUrl = await harness.listen();
    try {
      const login = await fetch(`${baseUrl}/xray/api/admin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: ADMIN_TOKEN }),
      });
      const cookie = cookieFrom(login.headers, COOKIE_NAMES.viewer);
      const response = await fetch(
        `${baseUrl}/xray/api/sessions/${PRIVATE_XS}/bank/activity?all=1`,
        {
          headers: { cookie: `${COOKIE_NAMES.viewer}=${cookie ?? ''}` },
        },
      );
      expect(response.status).toBe(503);
    } finally {
      await harness.close();
    }
  });
});
