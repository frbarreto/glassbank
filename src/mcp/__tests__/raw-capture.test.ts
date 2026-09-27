/**
 * v0.9 (D-28): every request that reaches the process is on the record once, with its `raw` block:
 * every header in arrival order - the Web Bot Auth `Signature`, `Signature-Input` and
 * `Signature-Agent` included - and the body bytes exactly as sent. `/mcp` and `/public/mcp` report
 * their own requests with correlation; the catch-all observer reports everything else.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { PUBLIC_MCP_PATH, type RawHttpRequest, type XrayEvent } from '../../contracts/index.js';

import { READ_ONLY_SCOPES, startMcpHarness, tokenFor, type McpHarness } from './harness.js';

const WEB_BOT_AUTH = {
  'Signature-Agent': '"https://chatgpt.com"',
  'Signature-Input':
    'sig1=("@authority" "@method" "@path" "signature-agent");created=1735689600;expires=1735693200;keyid="poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U";alg="ed25519";nonce="bm9uY2U=";tag="web-bot-auth"',
  Signature: 'sig1=:YXVkaXQtc2lnbmF0dXJlLW5vdC1yZWFs:',
};

let harness: McpHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function rawOf(event: XrayEvent | undefined): RawHttpRequest {
  const raw = (event?.data as { raw?: RawHttpRequest } | undefined)?.raw;
  if (raw === undefined) throw new Error('the http.request carried no raw block');
  return raw;
}

function header(raw: RawHttpRequest, name: string): string | undefined {
  return raw.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

describe('the raw block on /mcp', () => {
  it('keeps the Web Bot Auth headers and the body byte for byte', async () => {
    harness = await startMcpHarness();
    // Odd spacing and key order on purpose: a re-serialised body would not survive this.
    const body = '{"jsonrpc":"2.0",  "method":"initialize","id":1,"params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"raw","version":"1"},"_meta":{"vendor":"x"}}}';
    const response = await harness.fetch('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokenFor(READ_ONLY_SCOPES)}`,
        'x-vendor-header': 'nobody-mapped-this',
        ...WEB_BOT_AUTH,
      },
      body,
    });
    expect(response.status).toBe(200);
    const requests = harness.xray.of('http.request');
    expect(requests).toHaveLength(1);
    const raw = rawOf(requests[0]);
    expect(header(raw, 'signature-agent')).toBe(WEB_BOT_AUTH['Signature-Agent']);
    expect(header(raw, 'signature-input')).toBe(WEB_BOT_AUTH['Signature-Input']);
    expect(header(raw, 'signature')).toBe(WEB_BOT_AUTH.Signature);
    expect(header(raw, 'x-vendor-header')).toBe('nobody-mapped-this');
    expect(raw).toMatchObject({
      method: 'POST',
      url: '/mcp',
      body,
      body_encoding: 'utf8',
      body_bytes: Buffer.byteLength(body),
      body_read: true,
    });
    // Still correlated like before: the raw block adds to the categorised facts, it replaces none.
    expect(requests[0]?.grant_id).toBe('grt_test');
    expect(requests[0]?.data).toMatchObject({ method: 'POST', path: '/mcp', status: 200 });
  });

  it('keeps a body the JSON parser refused', async () => {
    harness = await startMcpHarness();
    const response = await harness.fetch('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0", broken',
    });
    expect(response.status).toBe(400);
    const raw = rawOf(harness.xray.of('http.request')[0]);
    expect(raw.body).toBe('{"jsonrpc":"2.0", broken');
  });

  it('records the 401 challenge with the request that caused it', async () => {
    harness = await startMcpHarness();
    await harness.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { token: null, headers: WEB_BOT_AUTH });
    const requests = harness.xray.of('http.request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data.status).toBe(401);
    expect(header(rawOf(requests[0]), 'signature')).toBe(WEB_BOT_AUTH.Signature);
    expect(rawOf(requests[0]).body).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  });
});

describe('the raw block on the public lane', () => {
  it('keeps the JSON-RPC method and its _meta that no event maps', async () => {
    harness = await startMcpHarness({ publicLane: {} });
    const frame = {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 3, reason: 'user pressed stop' },
    };
    await harness.publicRpc(frame, WEB_BOT_AUTH);
    const requests = harness.xray.of('http.request');
    expect(requests).toHaveLength(1);
    const raw = rawOf(requests[0]);
    expect(JSON.parse(raw.body ?? '')).toEqual(frame);
    expect(raw.url).toBe(PUBLIC_MCP_PATH);
    expect(header(raw, 'signature-agent')).toBe(WEB_BOT_AUTH['Signature-Agent']);
  });
});

describe('the catch-all observer', () => {
  it('reports a request no MCP endpoint handles, 404 included, once', async () => {
    harness = await startMcpHarness();
    const response = await harness.fetch('/.well-known/http-message-signatures-directory', {
      headers: WEB_BOT_AUTH,
    });
    expect(response.status).toBe(404);
    const requests = harness.xray.of('http.request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data).toMatchObject({
      method: 'GET',
      path: '/.well-known/http-message-signatures-directory',
      status: 404,
    });
    expect(requests[0]?.xs).toBeNull();
    expect(header(rawOf(requests[0]), 'signature')).toBe(WEB_BOT_AUTH.Signature);
  });

  it('keeps a form body as sent', async () => {
    harness = await startMcpHarness();
    const body = 'grant_type=authorization_code&code=abc&code_verifier=xyz&resource=https%3A%2F%2Fx';
    await harness.fetch('/test/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const raw = rawOf(harness.xray.of('http.request')[0]);
    expect(raw).toMatchObject({ body, body_read: true, body_encoding: 'utf8' });
  });

  it('never reports an MCP request twice', async () => {
    harness = await startMcpHarness({ publicLane: {} });
    await harness.rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    await harness.publicRpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await harness.fetch('/mcp', { method: 'GET' });
    expect(harness.xray.of('http.request')).toHaveLength(3);
  });

  it('reports the CORS preflight the MCP routers answer without their own event', async () => {
    harness = await startMcpHarness();
    await harness.fetch('/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST' },
    });
    const requests = harness.xray.of('http.request');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.data).toMatchObject({ method: 'OPTIONS', status: 204 });
  });

  it('leaves out the configured path prefixes and nothing else', async () => {
    harness = await startMcpHarness({ captureSkipPaths: ['/xray', '/health'] });
    await harness.fetch('/xray/api/stream');
    await harness.fetch('/health');
    await harness.fetch('/healthz');
    await harness.fetch('/xraying');
    expect(harness.xray.of('http.request').map((event) => event.data.path)).toEqual([
      '/healthz',
      '/xraying',
    ]);
  });
});
