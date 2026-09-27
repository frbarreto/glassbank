/**
 * The public lane, `POST /public/mcp` (D-26): no bearer, no challenge, the six public tools, every
 * event filed under the visitor's pseudo grant and `PUBLIC_LOGIN_ID`, and a rate limit on
 * `tools/call` only. The signed-in `/mcp` next to it is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  PUBLIC_LANE_NOTICE,
  PUBLIC_LOGIN_ID,
  PUBLIC_TOOL_NAMES,
  isPublicGrantId,
} from '../../contracts/index.js';

import { callFrame, initializeFrame, startMcpHarness, type McpHarness } from './harness.js';

const open: McpHarness[] = [];

async function harnessWith(options: Parameters<typeof startMcpHarness>[0] = { publicLane: {} }) {
  const harness = await startMcpHarness(options);
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

interface RpcBody {
  result?: {
    serverInfo?: { name: string; title?: string };
    instructions?: string;
    tools?: { name: string; inputSchema: { required: string[] } }[];
    content?: { text: string }[];
  };
  error?: { code: number; message: string };
}

describe('POST /public/mcp (D-26)', () => {
  it('initializes without a bearer and tells the agent the lane is public', async () => {
    const harness = await harnessWith();
    const response = await harness.publicRpc(initializeFrame(1));
    expect(response.status).toBe(200);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as RpcBody;
    expect(body.result?.serverInfo?.name).toBe('glass-bank-public');
    expect(body.result?.instructions).toContain('public dashboard');

    await waitFor(() => harness.xray.of('http.request').length === 1, 'http.request');
    expect(harness.xray.typesOf()).toEqual(['session.started', 'session.initialized', 'http.request']);
    for (const event of harness.xray.events) {
      expect(event.login_id, event.type).toBe(PUBLIC_LOGIN_ID);
      expect(isPublicGrantId(event.grant_id), event.type).toBe(true);
      expect(event.persona_id, event.type).toBeNull();
      expect(event.xs, event.type).toMatch(/^xs_/);
    }
    expect(harness.xray.of('http.request')[0]?.data.path).toBe('/public/mcp');
    harness.expectNoInvalidEvents();
  });

  it('lists exactly the six public tools, rationale required, and records the listing', async () => {
    const harness = await harnessWith();
    const response = await harness.publicRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const body = (await response.json()) as RpcBody;
    expect(body.result?.tools?.map((tool) => tool.name)).toEqual(PUBLIC_TOOL_NAMES);
    for (const tool of body.result?.tools ?? []) expect(tool.inputSchema.required).toContain('rationale');
    const listed = harness.xray.of('catalog.tools_listed')[0];
    expect(listed?.data.count).toBe(6);
    expect(listed?.data.tools?.[0]?.descriptor?.description.endsWith(PUBLIC_LANE_NOTICE)).toBe(true);
    harness.expectNoInvalidEvents();
  });

  it('calls a public tool with the host-aware base URL, the pseudo grant and the JSON-RPC id', async () => {
    const harness = await harnessWith();
    const response = await harness.publicRpc(
      callFrame('get_product', { product_id: 'clear_checking', rationale: 'compare plans' }, 41),
    );
    const body = (await response.json()) as RpcBody;
    expect(body.result?.content?.[0]?.text).toBe('fake public registry answered get_product');
    const call = harness.publicRegistry?.calls[0];
    expect(call?.name).toBe('get_product');
    expect(call?.context.publicBaseUrl).toBe(harness.baseUrl);
    expect(call?.context.requestId).toBe('41');
    expect(isPublicGrantId(call?.context.grantId)).toBe(true);
    expect(call?.context.xs).toMatch(/^xs_/);

    const started = harness.xray.of('tool.call.started')[0];
    expect(started?.data.required_scopes).toEqual([]);
    expect(started?.request_id).toBe('41');
    expect(started?.login_id).toBe(PUBLIC_LOGIN_ID);
    expect(harness.xray.of('tool.call.completed')[0]?.data.is_error).toBe(false);
    harness.expectNoInvalidEvents();
  });

  it('never challenges: a signed-in tool name is an unknown tool, a bearer is ignored', async () => {
    const harness = await harnessWith();
    const unknown = await harness.publicRpc(callFrame('load_accounts', { rationale: 'x' }, 5));
    expect(unknown.status).toBe(200);
    expect(unknown.headers.get('www-authenticate')).toBeNull();
    expect(((await unknown.json()) as RpcBody).error?.code).toBe(-32601);
    expect(harness.publicRegistry?.calls).toEqual([]);

    const withBearer = await harness.publicRpc(callFrame('list_products', {}, 6), {
      authorization: 'Bearer something',
    });
    expect(withBearer.status).toBe(200);
    await waitFor(() => harness.xray.of('http.request').length === 2, 'two http.request');
    expect(harness.xray.of('http.request')[1]?.data.has_authorization).toBe(true);
    expect(harness.publicRegistry?.calls[0]?.name).toBe('list_products');
  });

  it('groups a visitor by IP prefix and User-Agent, one session per visitor', async () => {
    const harness = await harnessWith();
    await harness.publicRpc(initializeFrame(1), { 'user-agent': 'agent-a' });
    await harness.publicRpc(callFrame('list_products', {}, 2), { 'user-agent': 'agent-a' });
    await harness.publicRpc(initializeFrame(1), { 'user-agent': 'agent-b' });
    const started = harness.xray.of('session.started');
    expect(started).toHaveLength(2);
    expect(started[0]?.grant_id).not.toBe(started[1]?.grant_id);
    expect(started[0]?.xs).not.toBe(started[1]?.xs);
    expect(harness.handler.stats().publicSessions).toBe(2);
  });

  it('limits tools/call per IP prefix, never the handshake or the listing (invariant 14)', async () => {
    const harness = await harnessWith({ publicLane: { ipToolCallsPerMin: 2 } });
    for (const id of [1, 2]) {
      expect((await harness.publicRpc(callFrame('list_products', {}, id))).status).toBe(200);
    }
    const limited = await harness.publicRpc(callFrame('get_branch', { branch_id: 'x' }, 3));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    const denied = harness.xray.of('tool.call.denied')[0];
    expect(denied?.data.denied_reason).toBe('rate_limited');
    expect(denied?.login_id).toBe(PUBLIC_LOGIN_ID);
    // A different User-Agent on the same network shares the limit: the key is the IP prefix.
    const other = await harness.publicRpc(callFrame('list_products', {}, 4), { 'user-agent': 'other' });
    expect(other.status).toBe(429);
    expect((await harness.publicRpc(initializeFrame(5))).status).toBe(200);
    expect((await harness.publicRpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' })).status).toBe(200);
    harness.expectNoInvalidEvents();
  });

  it('limits the lane as a whole to protect the shared instance (invariant 1)', async () => {
    const harness = await harnessWith({ publicLane: { toolCallsPerMin: 1 } });
    expect((await harness.publicRpc(callFrame('list_products', {}, 1))).status).toBe(200);
    expect((await harness.publicRpc(callFrame('list_products', {}, 2))).status).toBe(429);
  });

  it('answers GET with 405 and files it under the public login', async () => {
    const harness = await harnessWith();
    const response = await harness.fetch('/public/mcp');
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    const request = harness.xray.of('http.request')[0];
    expect(request?.login_id).toBe(PUBLIC_LOGIN_ID);
    expect(isPublicGrantId(request?.grant_id)).toBe(true);
  });

  it('refuses a foreign Origin under allowlist, like /mcp (invariant 10)', async () => {
    const harness = await harnessWith({ publicLane: {}, config: { originPolicy: 'allowlist' } });
    const response = await harness.publicRpc(initializeFrame(1), { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(harness.xray.of('session.rejected')[0]?.login_id).toBe(PUBLIC_LOGIN_ID);
  });

  it('leaves /mcp exactly as it was: no bearer is still a 401 challenge (invariant 5)', async () => {
    const harness = await harnessWith();
    const response = await harness.rpc(initializeFrame(1), { token: null });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('ends the public sessions on shutdown, under the public login', async () => {
    const harness = await startMcpHarness({ publicLane: {} });
    await harness.publicRpc(initializeFrame(1));
    const result = harness.handler.shutdown();
    expect(result.sessions_ended).toBe(1);
    const ended = harness.xray.of('session.ended')[0];
    expect(ended?.data.reason).toBe('server_stopping');
    expect(ended?.login_id).toBe(PUBLIC_LOGIN_ID);
    await harness.close();
  });

  it('is absent when not configured', async () => {
    const harness = await harnessWith({});
    expect(harness.handler.publicLane).toBeNull();
    expect((await harness.publicRpc(initializeFrame(1))).status).toBe(404);
  });
});
