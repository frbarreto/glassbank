/**
 * The MCP protocol surface (ADR-3, ADR-8, docs/TOOL_CATALOG.md sections 1-5).
 *
 * The transport is exercised over real HTTP rather than through the SDK client, because the
 * things at risk are HTTP-level: the `Accept` requirement, the absence of `Mcp-Session-Id`, and
 * the fact that a `tools/call` without `rationale` gets past the SDK at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TOOL_CATALOG } from '../../contracts/index.js';
import { NOT_IMPLEMENTED_MESSAGE } from '../bootstrap-tools.js';

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

interface RpcSuccess<T> {
  jsonrpc: '2.0';
  id: number | string;
  result: T;
}

interface RpcFailure {
  jsonrpc: '2.0';
  id: number | string | null;
  error: { code: number; message: string };
}

async function call<T>(body: unknown, token?: string): Promise<RpcSuccess<T>> {
  const response = await harness.rpc(body, token === undefined ? {} : { token });
  expect(response.status).toBe(200);
  const parsed = (await response.json()) as RpcSuccess<T> | RpcFailure;
  if ('error' in parsed) throw new Error(`JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed;
}

interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required: string[] };
  annotations: Record<string, unknown>;
  _meta: Record<string, unknown>;
}

describe('initialize', () => {
  it('returns an InitializeResult with the instructions and no Mcp-Session-Id (ADR-3)', async () => {
    const response = await harness.rpc(initializeFrame());
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();

    const body = (await response.json()) as RpcSuccess<{
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
      instructions: string;
    }>;
    expect(body.result.serverInfo.name).toBe('glass-bank');
    expect(body.result.capabilities).toHaveProperty('tools');
    // Empty prompts and resources capabilities are declared so the discovery loop gets lists,
    // not -32601 (ADR-3).
    expect(body.result.capabilities).toHaveProperty('prompts');
    expect(body.result.capabilities).toHaveProperty('resources');

    const instructions = body.result.instructions;
    for (const point of [
      'fictional bank',
      '1000 = $10.00',
      'load_*',
      'process_data',
      'execute_query',
      'load_statement_lines',
      'rationale',
      'create_transfer',
      'xray_get_session_link',
    ]) {
      expect(instructions, point).toContain(point);
    }
  });

  it('answers 406 when the client does not accept text/event-stream', async () => {
    const response = await harness.rpc(initializeFrame(), {
      headers: { accept: 'application/json' },
    });
    expect(response.status).toBe(406);
  });
});

describe('tools/list', () => {
  it('lists every tool a full read-write grant can use', async () => {
    const body = await call<{ tools: ToolDescriptor[] }>(
      { jsonrpc: '2.0', id: 20, method: 'tools/list' },
      tokenFor(READ_WRITE_SCOPES),
    );
    expect(body.result.tools).toHaveLength(TOOL_CATALOG.length);
    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      TOOL_CATALOG.map((entry) => entry.name),
    );
  });

  it('keeps the write tools listed under a read-only grant (ADR-13)', async () => {
    const body = await call<{ tools: ToolDescriptor[] }>(
      { jsonrpc: '2.0', id: 21, method: 'tools/list' },
      tokenFor(READ_ONLY_SCOPES),
    );
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain('lock_or_unlock_card');
    expect(names).toContain('create_transfer');
  });

  it('hides a tool whose read scope is missing, and only that one', async () => {
    const body = await call<{ tools: ToolDescriptor[] }>(
      { jsonrpc: '2.0', id: 22, method: 'tools/list' },
      tokenFor(['profile', 'accounts:read']),
    );
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toContain('load_accounts');
    expect(names).not.toContain('load_cards');
    // A missing write scope never hides a tool.
    expect(names).toContain('create_transfer');
  });

  it('publishes the raw JSON schema with rationale required (ADR-8)', async () => {
    const body = await call<{ tools: ToolDescriptor[] }>(
      { jsonrpc: '2.0', id: 23, method: 'tools/list' },
      tokenFor(READ_WRITE_SCOPES),
    );
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.required, tool.name).toContain('rationale');
      const rationale = tool.inputSchema.properties.rationale as {
        type: string;
        description: string;
        minLength: number;
        maxLength: number;
      };
      expect(rationale.type).toBe('string');
      expect(rationale.minLength).toBe(1);
      expect(rationale.maxLength).toBe(1024);
      expect(rationale.description).toContain('Briefly explain why you are calling this tool');
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });

  it('carries the Ramp metadata in _meta', async () => {
    const body = await call<{ tools: ToolDescriptor[] }>(
      { jsonrpc: '2.0', id: 24, method: 'tools/list' },
      tokenFor(READ_WRITE_SCOPES),
    );
    const transfer = body.result.tools.find((tool) => tool.name === 'create_transfer');
    expect(transfer?._meta['x-destructive']).toBe(true);
    expect(transfer?._meta['x-gated-by']).toEqual(['writes', 'transfers']);
  });

  it('drops the write tools entirely when their feature flag is off (ADR-12)', async () => {
    const flagless = await startMcpHarness({ config: { featureFlags: [] } });
    try {
      const response = await flagless.rpc(
        { jsonrpc: '2.0', id: 25, method: 'tools/list' },
        { token: tokenFor(READ_WRITE_SCOPES) },
      );
      const body = (await response.json()) as RpcSuccess<{ tools: ToolDescriptor[] }>;
      const names = body.result.tools.map((tool) => tool.name);
      expect(names).not.toContain('create_transfer');
      expect(names).not.toContain('lock_or_unlock_card');
      expect(names).toContain('load_accounts');
    } finally {
      await flagless.close();
    }
  });
});

describe('tools/call', () => {
  it('reaches the handler with no rationale at all (ADR-8: the SDK must not reject it)', async () => {
    harness.xray.clear();
    const body = await call<{ content: { type: string; text: string }[]; isError?: boolean }>({
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'get_current_user', arguments: {} },
    });
    // If the SDK's zod path were in use this would have been -32602 before any handler ran.
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content[0]?.text).toContain('Ava Stone');
    // `intent.missing` belongs to the `tools` block; what `mcp` owns is the fact on the call.
    const started = harness.xray.of('tool.call.started').at(-1);
    expect(started?.data.tool).toBe('get_current_user');
    expect(started?.data.rationale_present).toBe(false);
    expect(started?.data.rationale).toBeNull();
  });

  it('reaches the handler with an empty rationale and reports it as not present', async () => {
    harness.xray.clear();
    const body = await call<{ content: { text: string }[]; isError?: boolean }>({
      jsonrpc: '2.0',
      id: 31,
      method: 'tools/call',
      params: { name: 'get_current_user', arguments: { rationale: '   ' } },
    });
    expect(body.result.isError).toBeUndefined();
    const started = harness.xray.of('tool.call.started').at(-1);
    expect(started?.data.rationale_present).toBe(false);
    expect(started?.data.rationale).toBe('   ');
  });

  it('stores a declared rationale verbatim: it is the product (invariant 11)', async () => {
    harness.xray.clear();
    await call({
      jsonrpc: '2.0',
      id: 36,
      method: 'tools/call',
      params: { name: 'get_current_user', arguments: { rationale: 'the user asked who they are' } },
    });
    const started = harness.xray.of('tool.call.started').at(-1);
    expect(started?.data.rationale).toBe('the user asked who they are');
    expect(started?.data.rationale_present).toBe(true);
    expect(started?.data.rationale_truncated).toBe(false);
  });

  it('flags an over-long rationale instead of failing the call (ADR-8)', async () => {
    harness.xray.clear();
    const body = await call<{ isError?: boolean }>({
      jsonrpc: '2.0',
      id: 37,
      method: 'tools/call',
      params: { name: 'get_current_user', arguments: { rationale: 'x'.repeat(2000) } },
    });
    expect(body.result.isError).toBeUndefined();
    expect(harness.xray.of('tool.call.started').at(-1)?.data.rationale_truncated).toBe(true);
  });

  it('answers get_current_user with the persona, grant and boot id', async () => {
    const body = await call<{
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
    }>({
      jsonrpc: '2.0',
      id: 32,
      method: 'tools/call',
      params: { name: 'get_current_user', arguments: { rationale: 'introduce the customer' } },
    });
    expect(body.result.structuredContent.persona_id).toBe('per_ava_stone');
    expect(body.result.structuredContent.auth_level).toBe('read_only');
    expect(body.result.structuredContent.boot_id).toBe('boot_test_0001');
    expect(String(body.result.structuredContent.xray_session_id)).toMatch(/^xs_/);
  });

  it('answers get_tool_availability with a row per catalog entry', async () => {
    const body = await call<{
      structuredContent: { availability: { tool: string; listed: boolean }[] };
    }>(
      {
        jsonrpc: '2.0',
        id: 33,
        method: 'tools/call',
        params: { name: 'get_tool_availability', arguments: { rationale: 'explain the limits' } },
      },
      tokenFor(READ_ONLY_SCOPES),
    );
    const rows = body.result.structuredContent.availability;
    expect(rows).toHaveLength(TOOL_CATALOG.length);
    const transfer = rows.find((row) => row.tool === 'create_transfer');
    expect(transfer?.listed).toBe(true);
  });

  it('marks the tools with no wired handler clearly instead of pretending', async () => {
    const body = await call<{ content: { text: string }[]; isError: boolean }>({
      jsonrpc: '2.0',
      id: 34,
      method: 'tools/call',
      params: { name: 'load_accounts', arguments: { rationale: 'load the accounts' } },
    });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toContain(NOT_IMPLEMENTED_MESSAGE);
    expect(body.result.content[0]?.text).toContain('Ran into an error');
  });

  it('answers -32601 for an unknown tool (A-08: protocol codes stay for protocol problems)', async () => {
    const response = await harness.rpc({
      jsonrpc: '2.0',
      id: 35,
      method: 'tools/call',
      params: { name: 'no_such_tool', arguments: {} },
    });
    const body = (await response.json()) as RpcFailure;
    expect(body.error.code).toBe(-32601);
  });
});

describe('prompts and resources (ADR-3)', () => {
  it('answers prompts/list and resources/list with empty lists and no error', async () => {
    const prompts = await call<{ prompts: unknown[] }>({
      jsonrpc: '2.0',
      id: 40,
      method: 'prompts/list',
    });
    expect(prompts.result.prompts).toEqual([]);

    const resources = await call<{ resources: unknown[] }>({
      jsonrpc: '2.0',
      id: 41,
      method: 'resources/list',
    });
    expect(resources.result.resources).toEqual([]);

    const templates = await call<{ resourceTemplates: unknown[] }>({
      jsonrpc: '2.0',
      id: 42,
      method: 'resources/templates/list',
    });
    expect(templates.result.resourceTemplates).toEqual([]);
  });
});
