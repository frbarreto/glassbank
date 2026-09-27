/**
 * `GET /xray/api/export` (contracts v0.8, D-27): the event log as JSONL, oldest first, in the same
 * scopes as the stream - the public lane with no cookie, a pairing cookie for its own login, the
 * admin token as a cookie or a bearer for everything - and verbatim for every reader, the admin one
 * included, because the export is the operator's copy of the log (CLAUDE.md invariant 11).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COOKIE_NAMES,
  PUBLIC_LOGIN_ID,
  XRAY_EXPORT_CONTENT_TYPE,
  XrayEventSchema,
  type XrayEvent,
} from '../../contracts/index.js';

import { EXPORT_PAGE_ROWS } from '../routes.js';
import { cookieFrom, createHarness, readFrames } from './harness.js';

const ADMIN_TOKEN = 'observer-token-for-tests-at-least-32-chars';
const LONG_RATIONALE =
  'The user wants to see every account they hold before deciding where the salary should land.';

const visitor = {
  xs: 'xs_public01',
  login_id: PUBLIC_LOGIN_ID,
  grant_id: 'grt_pub_0123456789ab',
};
const alpha = { xs: 'xs_alpha001', login_id: 'lgn_alpha01', grant_id: 'grt_alpha01' };
const beta = { xs: 'xs_beta0001', login_id: 'lgn_beta001', grant_id: 'grt_beta001' };

function seed(harness: ReturnType<typeof createHarness>): void {
  const emit = harness.xray.emitter;
  for (const who of [visitor, alpha, beta]) {
    emit.emit('session.started', { reason: 'first_request' }, who);
    emit.emit(
      'tool.call.started',
      {
        tool: who === visitor ? 'list_products' : 'load_accounts',
        arguments: { family: 'accounts' },
        rationale: LONG_RATIONALE,
        rationale_present: true,
      },
      { ...who, request_id: '1' },
    );
  }
  harness.xray.flush();
}

/** The body split into parsed lines; every line must be a valid envelope. */
async function linesOf(response: Response): Promise<XrayEvent[]> {
  const text = await response.text();
  if (text === '') return [];
  expect(text.endsWith('\n')).toBe(true);
  return text
    .trimEnd()
    .split('\n')
    .map((line) => XrayEventSchema.parse(JSON.parse(line)));
}

describe('GET /xray/api/export (v0.8, D-27)', () => {
  let harness: ReturnType<typeof createHarness>;
  let baseUrl: string;

  beforeEach(async () => {
    harness = createHarness({ adminToken: ADMIN_TOKEN, pairFailuresPerMinute: 2 });
    seed(harness);
    baseUrl = await harness.listen();
  });

  afterEach(async () => {
    await harness.close();
  });

  const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

  it('answers 401 with no cookie, no bearer and no lane', async () => {
    const response = await fetch(`${baseUrl}/xray/api/export`);
    expect(response.status).toBe(401);
  });

  it('downloads the whole log verbatim with the admin token as a bearer', async () => {
    const response = await fetch(`${baseUrl}/xray/api/export`, bearer(ADMIN_TOKEN));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(XRAY_EXPORT_CONTENT_TYPE);
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="glass-bank-xray-\d{8}T\d{6}Z\.jsonl"$/,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    const events = await linesOf(response);
    expect(new Set(events.map((event) => event.login_id))).toEqual(
      new Set([PUBLIC_LOGIN_ID, 'lgn_alpha01', 'lgn_beta001']),
    );
    const ids = events.map((event) => event.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    // Verbatim: the observer view hides arguments and cuts the rationale at 80, the export does not.
    const started = events.find((event) => event.type === 'tool.call.started' && event.xs === alpha.xs);
    expect(started?.data).toMatchObject({ arguments: { family: 'accounts' }, rationale: LONG_RATIONALE });
  });

  it('keeps the observer view redacted: only the export is verbatim', async () => {
    const login = await fetch(`${baseUrl}/xray/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const cookie = `${COOKIE_NAMES.viewer}=${cookieFrom(login.headers, COOKIE_NAMES.viewer) ?? ''}`;
    const page = (await (
      await fetch(`${baseUrl}/xray/api/sessions/${alpha.xs}/events`, { headers: { cookie } })
    ).json()) as { data: XrayEvent[] };
    const observed = page.data.find((event) => event.type === 'tool.call.started');
    expect(observed?.data).not.toHaveProperty('arguments.family');

    const exported = await linesOf(
      await fetch(`${baseUrl}/xray/api/export?xs=${alpha.xs}`, { headers: { cookie } }),
    );
    expect(exported.map((event) => event.xs)).toEqual([alpha.xs, alpha.xs]);
    expect(exported[1]?.data).toMatchObject({ rationale: LONG_RATIONALE });
  });

  it('refuses a wrong bearer with 403 and rate-limits the failures per IP prefix', async () => {
    expect((await fetch(`${baseUrl}/xray/api/export`, bearer('wrong-token'))).status).toBe(403);
    expect((await fetch(`${baseUrl}/xray/api/export`, bearer('wrong-token'))).status).toBe(403);
    // `pairFailuresPerMinute: 2`: the limiter shared with the pairing and admin exchanges.
    expect((await fetch(`${baseUrl}/xray/api/export`, bearer(ADMIN_TOKEN))).status).toBe(429);
  });

  it('exports the public lane with no cookie, and nothing else', async () => {
    const events = await linesOf(await fetch(`${baseUrl}/xray/api/export?lane=public`));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.login_id === PUBLIC_LOGIN_ID)).toBe(true);
    expect((await fetch(`${baseUrl}/xray/api/export?lane=public&all=1`)).status).toBe(403);
    expect((await fetch(`${baseUrl}/xray/api/export?lane=public&xs=${alpha.xs}`)).status).toBe(403);
  });

  it('exports the own login for a pairing cookie, never another', async () => {
    const minted = await harness.xray.pairing.createCode({ login_id: alpha.login_id });
    const landing = await fetch(`${baseUrl}/xray/s/${minted.code}`, { redirect: 'manual' });
    const cookie = `${COOKIE_NAMES.viewer}=${cookieFrom(landing.headers, COOKIE_NAMES.viewer) ?? ''}`;
    const events = await linesOf(await fetch(`${baseUrl}/xray/api/export`, { headers: { cookie } }));
    // The session's two events, then the `xray.pairing.created` that minted this very cookie.
    expect(events.map((event) => event.xs)).toEqual([alpha.xs, alpha.xs, null]);
    expect(events.every((event) => event.login_id === alpha.login_id)).toBe(true);
    expect((await fetch(`${baseUrl}/xray/api/export?all=1`, { headers: { cookie } })).status).toBe(403);
    const stranger = await fetch(`${baseUrl}/xray/api/export?xs=${beta.xs}`, { headers: { cookie } });
    expect(stranger.status).toBe(403);
  });

  it('continues from ?after= so a second export only brings what is new', async () => {
    const first = await linesOf(await fetch(`${baseUrl}/xray/api/export`, bearer(ADMIN_TOKEN)));
    const lastId = first.at(-1)?.id ?? 0;
    harness.xray.emitter.emit('session.ended', { reason: 'idle_gap' }, alpha);
    const second = await linesOf(
      await fetch(`${baseUrl}/xray/api/export?after=${lastId}`, bearer(ADMIN_TOKEN)),
    );
    expect(second.map((event) => event.type)).toEqual(['session.ended']);
    const nothing = await fetch(`${baseUrl}/xray/api/export?after=${lastId + 1}`, bearer(ADMIN_TOKEN));
    expect(nothing.status).toBe(200);
    expect(await nothing.text()).toBe('');
  });

  it('pages through more rows than one SQLite page, in order and without gaps', async () => {
    const total = EXPORT_PAGE_ROWS * 2 + 500;
    for (let index = 0; index < total; index += 1) {
      harness.xray.emitter.emit(
        'bank.op',
        { operation: 'public.prices', rows: index, latency_ms: 0.1, ok: true },
        { ...visitor, request_id: String(index) },
      );
    }
    harness.xray.flush();
    const events = await linesOf(await fetch(`${baseUrl}/xray/api/export?lane=public`));
    const ops = events.filter((event) => event.type === 'bank.op');
    expect(ops).toHaveLength(total);
    expect(ops.map((event) => (event.data as { rows: number }).rows)).toEqual(
      Array.from({ length: total }, (_unused, index) => index),
    );
  });

  it('falls back to the ring when the log is degraded', async () => {
    harness.xray.log.close();
    expect(harness.xray.log.degraded).toBe(true);
    const events = await linesOf(await fetch(`${baseUrl}/xray/api/export`, bearer(ADMIN_TOKEN)));
    expect(events.filter((event) => event.type === 'tool.call.started')).toHaveLength(3);
  });

  it('counts against the stream budget, like a live stream', async () => {
    await harness.close();
    harness = createHarness({ adminToken: ADMIN_TOKEN, maxPublicStreams: 1 });
    seed(harness);
    baseUrl = await harness.listen();
    const stream = await fetch(`${baseUrl}/xray/api/stream?lane=public`);
    expect(stream.status).toBe(200);
    const refused = await fetch(`${baseUrl}/xray/api/export?lane=public`);
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('5');
    await readFrames(stream, { until: () => true, timeoutMs: 200 });
  });
});
