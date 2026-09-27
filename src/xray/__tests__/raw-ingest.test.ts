/**
 * v0.9 (D-28): the log stores every event as its producer emitted it, the raw request included,
 * and redaction runs on the way out. The admin export is the one reader that gets the log as
 * stored; the dashboard (stream and session page), a pairing viewer and the public lane get
 * `viewEvent`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COOKIE_NAMES,
  PUBLIC_LOGIN_ID,
  REDACTED_PLACEHOLDER,
  XrayEventSchema,
  type RawHttpRequest,
  type XrayEvent,
} from '../../contracts/index.js';

import { createPipeline } from '../emitter.js';
import { createEventLog } from '../log.js';
import { createReadModel } from '../read-model.js';
import { prefixAddressesIn, redactRawRequest, viewEvent } from '../redaction.js';
import { createRing } from '../ring.js';
import { cookieFrom, createHarness, parseFrames, readFrames } from './harness.js';

const ADMIN_TOKEN = 'observer-token-for-tests-at-least-32-chars';
const BEARER = 'Bearer mcpb_at_eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwZXJfYWJjIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
const RATIONALE = 'Check which account the salary lands in before moving anything.';

/** A signed tools/call as a Web Bot Auth agent sends it, through Cloud Run's front end. */
function rawToolsCall(): RawHttpRequest {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
      name: 'load_accounts',
      arguments: { rationale: RATIONALE, account_number: '000123456789' },
      _meta: { progressToken: 'p-1', vendor_hint: 'kept' },
    },
  });
  return {
    method: 'POST',
    url: '/public/mcp',
    http_version: '1.1',
    headers: [
      ['host', 'glassbank.example'],
      ['authorization', BEARER],
      ['cookie', 'glassbank_viewer=secret-cookie'],
      ['x-forwarded-for', '203.0.113.77, 198.51.100.23'],
      ['forwarded', 'for="[2001:db8:cafe::17]:4711";proto=https'],
      ['signature-agent', '"https://chatgpt.com"'],
      ['signature-input', 'sig1=("@authority" "@method" "signature-agent");created=1;keyid="k";tag="web-bot-auth"'],
      ['signature', 'sig1=:bm90LWEtcmVhbC1zaWduYXR1cmU=:'],
      ['content-type', 'application/json'],
    ],
    trailers: [],
    body,
    body_encoding: 'utf8',
    body_bytes: Buffer.byteLength(body),
    body_read: true,
    remote_address: '169.254.1.2',
    remote_port: 40000,
  };
}

const visitor = { xs: 'xs_public01', login_id: PUBLIC_LOGIN_ID, grant_id: 'grt_pub_0123456789ab' };

function httpData(raw: RawHttpRequest): Record<string, unknown> {
  return {
    method: 'POST',
    path: '/public/mcp',
    status: 200,
    duration_ms: 4,
    user_agent: 'agent/1.0',
    remote_ip_prefix: '198.51.100.0/24',
    has_authorization: true,
    raw,
    field_nobody_mapped: { anything: [1, 2, 3] },
  };
}

function headerValue(raw: unknown, name: string): string | undefined {
  const headers = (raw as { headers: [string, string][] }).headers;
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

async function linesOf(response: Response): Promise<XrayEvent[]> {
  const text = await response.text();
  return text
    .trimEnd()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => XrayEventSchema.parse(JSON.parse(line)));
}

describe('the log stores what it is given (v0.9, D-28)', () => {
  let harness: ReturnType<typeof createHarness>;
  let baseUrl: string;

  beforeEach(async () => {
    harness = createHarness({ adminToken: ADMIN_TOKEN });
    harness.xray.emitter.emit('http.request', httpData(rawToolsCall()) as never, {
      ...visitor,
      request_id: '7',
    });
    harness.xray.emitter.emit(
      'tool.call.started',
      {
        tool: 'load_accounts',
        arguments: { rationale: RATIONALE, account_number: '000123456789', api_key: 'sk-live-1' },
        rationale: RATIONALE,
        rationale_present: true,
      },
      { ...visitor, request_id: '7' },
    );
    harness.xray.flush();
    baseUrl = await harness.listen();
  });

  afterEach(async () => {
    await harness.close();
  });

  it('hands the admin export every byte as it arrived: headers, body, addresses', async () => {
    const events = await linesOf(
      await fetch(`${baseUrl}/xray/api/export`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }),
    );
    const http = events.find((event) => event.type === 'http.request');
    const raw = (http?.data as { raw: RawHttpRequest }).raw;
    expect(raw).toEqual(rawToolsCall());
    expect(headerValue(raw, 'authorization')).toBe(BEARER);
    expect(headerValue(raw, 'x-forwarded-for')).toBe('203.0.113.77, 198.51.100.23');
    // A field no schema names is stored where the producer put it.
    expect(http?.data).toHaveProperty('field_nobody_mapped', { anything: [1, 2, 3] });

    const started = events.find((event) => event.type === 'tool.call.started');
    expect(started?.data).toMatchObject({
      arguments: { account_number: '000123456789', api_key: 'sk-live-1' },
      redacted_fields: [],
    });
  });

  it('shows the public lane a redacted view that keeps the Web Bot Auth headers', async () => {
    const events = await linesOf(await fetch(`${baseUrl}/xray/api/export?lane=public`));
    const raw = (events.find((event) => event.type === 'http.request')?.data as { raw: unknown }).raw;
    expect(headerValue(raw, 'authorization')).toBe(REDACTED_PLACEHOLDER);
    expect(headerValue(raw, 'cookie')).toBe(REDACTED_PLACEHOLDER);
    expect(headerValue(raw, 'x-forwarded-for')).toBe('203.0.113.0/24, 198.51.100.0/24');
    expect(headerValue(raw, 'forwarded')).toBe('for="[2001:db8:cafe::/48]:4711";proto=https');
    expect(headerValue(raw, 'signature-agent')).toBe('"https://chatgpt.com"');
    expect(headerValue(raw, 'signature')).toBe('sig1=:bm90LWEtcmVhbC1zaWduYXR1cmU=:');
    expect(headerValue(raw, 'signature-input')).toContain('tag="web-bot-auth"');
    expect((raw as { remote_address: string }).remote_address).toBe('169.254.1.0/24');

    const body = JSON.parse((raw as { body: string }).body) as {
      params: { arguments: Record<string, unknown>; _meta: Record<string, unknown> };
    };
    // The same deny-list as the categorised `tool.call.started`, and the rationale verbatim.
    expect(body.params.arguments).toEqual({ rationale: RATIONALE, account_number: REDACTED_PLACEHOLDER });
    expect(body.params._meta).toEqual({ progressToken: 'p-1', vendor_hint: 'kept' });

    const started = events.find((event) => event.type === 'tool.call.started');
    expect(started?.data).toMatchObject({
      arguments: { account_number: REDACTED_PLACEHOLDER, api_key: REDACTED_PLACEHOLDER },
    });
  });

  it('streams the same redacted view to a live viewer', async () => {
    const frames = await readFrames(await fetch(`${baseUrl}/xray/api/stream?lane=public`), {
      until: (seen) => seen.some((frame) => frame.includes('"http.request"')),
    });
    const http = parseFrames(frames)
      .map((frame) => frame.data as XrayEvent)
      .find((event) => event?.type === 'http.request');
    expect(headerValue((http?.data as { raw: unknown }).raw, 'authorization')).toBe(REDACTED_PLACEHOLDER);
  });

  it('hides tools/call arguments in the raw body from the observer, as in the categorised event', async () => {
    const login = await fetch(`${baseUrl}/xray/api/admin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    });
    const cookie = `${COOKIE_NAMES.viewer}=${cookieFrom(login.headers, COOKIE_NAMES.viewer) ?? ''}`;
    const page = (await (
      await fetch(`${baseUrl}/xray/api/sessions/${visitor.xs}/events`, { headers: { cookie } })
    ).json()) as { data: XrayEvent[] };
    const raw = (page.data.find((event) => event.type === 'http.request')?.data as { raw: { body: string } })
      .raw;
    const body = JSON.parse(raw.body) as { params: { name: string; arguments: unknown } };
    expect(body.params).toMatchObject({ name: 'load_accounts', arguments: {} });
  });
});

describe('redactRawRequest', () => {
  it('hides the authorization code of an OAuth token request, form or JSON', () => {
    const form = redactRawRequest({
      ...rawToolsCall(),
      headers: [['content-type', 'application/x-www-form-urlencoded']],
      body: 'grant_type=authorization_code&code=abc123&code_verifier=v&client_id=mcpb_1',
    }) as { body: string };
    const params = new URLSearchParams(form.body);
    expect(params.get('code')).toBe(REDACTED_PLACEHOLDER);
    expect(params.get('code_verifier')).toBe(REDACTED_PLACEHOLDER);
    expect(params.get('client_id')).toBe('mcpb_1');

    const json = redactRawRequest({
      ...rawToolsCall(),
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'r', code: 'c' }),
    }) as { body: string };
    expect(JSON.parse(json.body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: REDACTED_PLACEHOLDER,
      code: REDACTED_PLACEHOLDER,
    });
  });

  it('hides a credential passed in the query string', () => {
    const view = redactRawRequest({ ...rawToolsCall(), url: '/mcp?access_token=abc&x=1' }) as {
      url: string;
    };
    expect(view.url).toBe(`/mcp?access_token=${encodeURIComponent(REDACTED_PLACEHOLDER)}&x=1`);
  });

  it('leaves a body that is neither JSON nor a form as text', () => {
    const view = redactRawRequest({ ...rawToolsCall(), body: 'plain words' }) as { body: string };
    expect(view.body).toBe('plain words');
  });

  it('cuts every address in a forwarding header to its prefix', () => {
    expect(prefixAddressesIn('203.0.113.77:8080, 2001:db8:1:2::9')).toBe(
      '203.0.113.0/24, 2001:db8:1::/48',
    );
    expect(prefixAddressesIn('unknown')).toBe('unknown');
  });
});

describe('viewEvent', () => {
  it('never changes the stored event', () => {
    const stored = XrayEventSchema.parse({
      id: 1,
      ts: '2026-09-27T00:00:00.000Z',
      v: 1,
      type: 'http.request',
      data: httpData(rawToolsCall()),
    });
    const before = JSON.stringify(stored);
    viewEvent(stored, 'public');
    viewEvent(stored, 'admin');
    expect(JSON.stringify(stored)).toBe(before);
  });
});

describe('the byte cap (XRAY_MAX_LOG_BYTES)', () => {
  function event(id: number, size: number): XrayEvent {
    return XrayEventSchema.parse({
      id,
      ts: '2026-09-27T00:00:00.000Z',
      v: 1,
      type: 'sql.query',
      data: { sql: 'x'.repeat(size), rows_returned: 0, duration_ms: 1 },
    });
  }

  it('drops the oldest whole events and always keeps the newest', () => {
    const log = createEventLog({ path: ':memory:' });
    log.append([event(1, 1000), event(2, 1000), event(3, 1000)]);
    const one = Buffer.byteLength(JSON.stringify(event(3, 1000)));
    expect(log.storedBytes()).toBe(3 * one);
    expect(log.trimToMaxBytes(2 * one)).toBe(1);
    expect(log.recent(10).map((stored) => stored.id)).toEqual([2, 3]);
    expect(log.storedBytes()).toBe(2 * one);
    // One event over the budget on its own still stays: the newest is never dropped.
    expect(log.trimToMaxBytes(10)).toBe(1);
    expect(log.recent(10).map((stored) => stored.id)).toEqual([3]);
    // The stored event is whole.
    expect((log.readById(3)?.data as { sql: string }).sql).toHaveLength(1000);
    log.close();
  });

  it('is enforced on every flush, not only by the periodic retention', () => {
    const log = createEventLog({ path: ':memory:' });
    const pipeline = createPipeline({
      ring: createRing(100),
      log,
      readModel: createReadModel(),
      maxLogBytes: 5000,
    });
    for (let index = 0; index < 20; index += 1) {
      pipeline.emitter.emit('sql.query', { sql: 'y'.repeat(1000), rows_returned: 0, duration_ms: 1 });
    }
    pipeline.flush();
    expect(log.storedBytes()).toBeLessThanOrEqual(5000);
    expect(log.count()).toBeGreaterThan(0);
    log.close();
  });
});
