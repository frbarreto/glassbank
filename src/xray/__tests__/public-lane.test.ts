/**
 * The public lane on the X-ray (contracts v0.7, D-26, CLAUDE.md invariant 11): `?lane=public`
 * answers without a cookie, shows the pseudo login `PUBLIC_LOGIN_ID` and nothing else, never
 * erases, ignores a cookie the browser also holds, and has its own stream budget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COOKIE_NAMES, PUBLIC_LOGIN_ID } from '../../contracts/index.js';

import { createHarness, readFrames } from './harness.js';

const PUBLIC_XS = 'xs_public01';
const PUBLIC_GRANT = 'grt_pub_0123456789ab';

function seed(harness: ReturnType<typeof createHarness>): void {
  const emit = harness.xray.emitter;
  const visitor = {
    xs: PUBLIC_XS,
    login_id: PUBLIC_LOGIN_ID,
    grant_id: PUBLIC_GRANT,
    client: { name: 'claude-ai', version: '0.1.0', title: null },
    protocol_version: '2025-11-25',
    era: 'legacy' as const,
  };
  emit.emit('session.started', { reason: 'first_request' }, visitor);
  emit.emit(
    'tool.call.started',
    {
      tool: 'search_prices',
      arguments: { product_id: 'clear_checking', query: 'wire' },
      rationale: 'The user compares wire fees between banks.',
      rationale_present: true,
    },
    { ...visitor, request_id: '3' },
  );
  emit.emit('bank.op', { operation: 'public.prices', rows: 3, latency_ms: 0.1, ok: true }, {
    ...visitor,
    request_id: '3',
  });

  const signedIn = {
    xs: 'xs_private1',
    login_id: 'lgn_alpha01',
    grant_id: 'grt_alpha01',
    persona_id: 'per_alpha1',
  };
  emit.emit('session.started', { reason: 'first_request' }, signedIn);
  emit.emit(
    'tool.call.started',
    {
      tool: 'load_accounts',
      arguments: {},
      rationale: 'A signed-in session the public lane must never show.',
      rationale_present: true,
    },
    signedIn,
  );
  harness.xray.flush();
}

describe('the public lane on the X-ray (D-26)', () => {
  let harness: ReturnType<typeof createHarness>;
  let baseUrl: string;

  beforeEach(async () => {
    harness = createHarness({ adminToken: 'observer-token-for-tests', maxPublicStreams: 1 });
    seed(harness);
    baseUrl = await harness.listen();
  });

  afterEach(async () => {
    await harness.close();
  });

  async function json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const response = await fetch(`${baseUrl}${path}`, init);
    return { status: response.status, body: (await response.json()) as T };
  }

  it('describes the public reader without a cookie and sets none', async () => {
    const response = await fetch(`${baseUrl}/xray/api/me?lane=public`);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = (await response.json()) as { viewer_kind: string; login_id: string; grant_ids: string[] };
    expect(body.viewer_kind).toBe('public');
    expect(body.login_id).toBe(PUBLIC_LOGIN_ID);
    expect(body.grant_ids).toEqual([PUBLIC_GRANT]);
  });

  it('lists only the public sessions, and shows their calls verbatim', async () => {
    const sessions = await json<{ data: { xs: string; login_id: string }[] }>(
      '/xray/api/sessions?lane=public',
    );
    expect(sessions.body.data.map((row) => row.xs)).toEqual([PUBLIC_XS]);

    const events = await json<{ data: { type: string; data: Record<string, unknown> }[] }>(
      `/xray/api/sessions/${PUBLIC_XS}/events?lane=public`,
    );
    expect(events.status).toBe(200);
    const started = events.body.data.find((event) => event.type === 'tool.call.started');
    // Not observer-redacted: the agent was told this lane is public (PUBLIC_LANE_NOTICE).
    expect(started?.data.arguments).toEqual({ product_id: 'clear_checking', query: 'wire' });
    expect(started?.data.rationale).toBe('The user compares wire fees between banks.');
    expect(events.body.data.some((event) => event.type === 'bank.op')).toBe(true);
  });

  it('refuses a signed-in session, observer mode and every erase', async () => {
    expect((await json('/xray/api/sessions/xs_private1/events?lane=public')).status).toBe(403);
    expect((await json('/xray/api/sessions/xs_private1?lane=public')).status).toBe(403);
    expect((await json('/xray/api/stream?lane=public&all=1')).status).toBe(403);
    const eraseOne = await json(`/xray/api/sessions/${PUBLIC_XS}?lane=public`, { method: 'DELETE' });
    expect(eraseOne.status).toBe(403);
    const eraseAll = await json('/xray/api/events?lane=public', { method: 'DELETE' });
    expect(eraseAll.status).toBe(403);
  });

  it('ignores a pairing cookie the same browser holds, so both tabs can stay open', async () => {
    const minted = await harness.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
    const landing = await fetch(`${baseUrl}/xray/s/${minted.code}`, { redirect: 'manual' });
    const cookie = landing.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${COOKIE_NAMES.viewer}=`))
      ?.split(';')[0];
    expect(cookie).toBeDefined();
    const headers = { cookie: cookie ?? '' };

    const paired = await json<{ data: { xs: string }[] }>('/xray/api/sessions', { headers });
    expect(paired.body.data.map((row) => row.xs)).toEqual(['xs_private1']);
    const lane = await json<{ data: { xs: string }[] }>('/xray/api/sessions?lane=public', { headers });
    expect(lane.body.data.map((row) => row.xs)).toEqual([PUBLIC_XS]);
  });

  it('streams the public lane with its own budget', async () => {
    const first = await fetch(`${baseUrl}/xray/api/stream?lane=public`);
    expect(first.status).toBe(200);
    // `maxPublicStreams: 1`: a second public reader waits, whoever it is.
    const second = await fetch(`${baseUrl}/xray/api/stream?lane=public`);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('5');

    const frames = await readFrames(first, {
      until: (seen) => seen.some((frame) => frame.includes('public.prices')),
    });
    expect(frames.some((frame) => frame.includes('lgn_alpha01'))).toBe(false);
  });
});
