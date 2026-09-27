/**
 * What this block tells the X-ray about itself (CLAUDE.md invariant 13, docs/XRAY_EVENT_MODEL.md
 * sections 2-4).
 *
 * The point of the phase is that a user watching the dashboard sees which tools were available,
 * which one was called, with what arguments and stated intent. Everything here is asserted on
 * events that have been **parsed against the frozen contract** by the harness emitter, so a test
 * that says "the sequence is emitted" has also said "and every event in it is valid".
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  REDACTED_PLACEHOLDER,
  RESULT_PREVIEW_BYTES,
  TOOL_CATALOG,
  toolError,
  toolText,
} from '../../contracts/index.js';
import { RESULT_PREVIEW_TRUNCATION_SUFFIX } from '../xray.js';

import {
  HTTP_REQUEST_ID_SENTINEL,
  READ_ONLY_SCOPES,
  READ_WRITE_SCOPES,
  callFrame,
  createFakeRegistry,
  initializeFrame,
  startMcpHarness,
  tokenFor,
  type McpHarness,
} from './harness.js';

/**
 * The emitter's own constants, read from disk rather than imported: this block may not reach into
 * `src/xray` (docs/REPO_LAYOUT.md section 3), and reading a file is not an import. Whatever is
 * copied into `src/mcp` is compared against these, so the two cannot drift silently.
 */
const REDACTION_SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'xray', 'redaction.ts'),
  'utf8',
);

function emitterLiteral(name: string): string {
  const match = REDACTION_SOURCE.match(new RegExp(`\\bconst ${name} = '([^']*)';`));
  if (match?.[1] === undefined) throw new Error(`${name} is gone from src/xray/redaction.ts`);
  return match[1];
}

function emitterNumber(name: string): number {
  const match = REDACTION_SOURCE.match(new RegExp(`\\bconst ${name} = ([0-9_]+);`));
  if (match?.[1] === undefined) throw new Error(`${name} is gone from src/xray/redaction.ts`);
  return Number(match[1].replaceAll('_', ''));
}

const open: McpHarness[] = [];

async function harnessWith(options: Parameters<typeof startMcpHarness>[0] = {}) {
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

describe('the documented sequence of a tools/call', () => {
  it('emits session.started, tool.call.started, tool.call.completed and http.request', async () => {
    const registry = createFakeRegistry();
    registry.answer('load_accounts', toolText('two accounts', { rows: 2 }));
    const harness = await harnessWith({ registry });

    const response = await harness.rpc(
      callFrame('load_accounts', { rationale: 'the user asked what they have' }),
      { token: tokenFor(READ_ONLY_SCOPES, 'grt_seq') },
    );
    expect(response.status).toBe(200);

    expect(harness.xray.typesOf()).toEqual([
      'session.started',
      'tool.call.started',
      'tool.call.completed',
      'http.request',
    ]);
    harness.expectNoInvalidEvents();

    const started = harness.xray.of('tool.call.started')[0];
    expect(started?.data.tool).toBe('load_accounts');
    // Verbatim: redaction is the emitter's job, not the transport's (section 3).
    expect(started?.data.arguments).toEqual({ rationale: 'the user asked what they have' });
    expect(started?.data.rationale).toBe('the user asked what they have');
    expect(started?.data.rationale_present).toBe(true);
    expect(started?.data.required_scopes).toEqual(['accounts:read']);
    expect(started?.data.budget_ms).toBe(300_000);

    const completed = harness.xray.of('tool.call.completed')[0];
    expect(completed?.data.tool).toBe('load_accounts');
    expect(completed?.data.is_error).toBe(false);
    expect(completed?.data.content_types).toEqual(['text']);
    expect(completed?.data.text_preview).toBe('two accounts');
    expect(completed?.data.structured_content).toEqual({ rows: 2 });
    expect(completed?.data.content_cap).toBe(150_000);

    // Every event of the request carries the same correlation, which is what lets the dashboard
    // draw one session (contracts/events.ts envelope).
    const xs = harness.xray.events[0]?.xs;
    expect(xs).toMatch(/^xs_/);
    for (const event of harness.xray.events) {
      expect(event.xs, event.type).toBe(xs);
      expect(event.grant_id, event.type).toBe('grt_seq');
      expect(event.login_id, event.type).toBe('lgn_test');
      expect(event.persona_id, event.type).toBe('per_ava_stone');
    }

    const request = harness.xray.of('http.request')[0];
    expect(request?.data.status).toBe(200);
    expect(request?.data.path).toBe('/mcp');
    expect(request?.data.has_authorization).toBe(true);
    expect(request?.data.sse).toBe(false);
    expect(request?.data.rate_limited).toBe(false);
  });

  it('reports a tool error as is_error with the tool class, never as a protocol code (A-08)', async () => {
    const registry = createFakeRegistry();
    registry.answer('load_cards', toolError('the card service is unavailable'));
    const harness = await harnessWith({ registry });

    await harness.rpc(callFrame('load_cards', { rationale: 'show the cards' }), {
      token: tokenFor(READ_ONLY_SCOPES, 'grt_err'),
    });

    const completed = harness.xray.of('tool.call.completed')[0];
    expect(completed?.data.is_error).toBe(true);
    expect(completed?.data.error?.class).toBe('tool');
    expect(completed?.data.error?.message).toContain('the card service is unavailable');
    expect(harness.xray.of('protocol.error')).toHaveLength(0);
    harness.expectNoInvalidEvents();
  });

  it('hands the tool handler the correlated emitter, so its own events land in the session', async () => {
    const registry = createFakeRegistry();
    const harness = await harnessWith({ registry });
    registry.answer('load_bills', toolText('no bills'));

    await harness.rpc(callFrame('load_bills', { rationale: 'check the bills' }), {
      token: tokenFor(READ_ONLY_SCOPES, 'grt_ctx'),
    });

    const context = registry.calls[0]?.context;
    expect(context).toBeDefined();
    context?.xray.emit('bank.op', { operation: 'bills.list', latency_ms: 3, ok: true });
    const bankOp = harness.xray.of('bank.op')[0];
    expect(bankOp?.xs).toMatch(/^xs_/);
    expect(bankOp?.grant_id).toBe('grt_ctx');
    expect(bankOp?.persona_id).toBe('per_ava_stone');
    harness.expectNoInvalidEvents();
  });
});

/**
 * The correlation contract of a call: `request_id` is the **JSON-RPC id** (the envelope says so,
 * `src/contracts/events.ts`), and it is the same value on `tool.call.started` and on every event
 * the call causes. The dashboard keys a call on `<xs>#<request_id>` (`callKeyOf` in
 * `public/catalogue.js`), so a child event with any other `request_id` is not merely mislabelled:
 * it never appears under the call at all, and the one view built to show what a call did comes up
 * empty (CLAUDE.md invariant 13).
 *
 * `src/mcp` used to pass `res.locals.requestId` - the HTTP UUID of `requestIdMiddleware` in
 * `src/app.ts` - as `ToolContext.requestId`. The harness now mounts that middleware's sentinel in
 * front of the handler (`HTTP_REQUEST_ID_SENTINEL`), which is what makes these assertions able to
 * fail; without it the wrong source is `undefined` and falls through to the right value.
 */
describe('the request_id of a tools/call and of everything it causes', () => {
  /**
   * What `src/tools/registry.ts` does on every call: it builds its own correlation with
   * `correlationOf(context.auth, context.requestId)` (`src/tools/rationale.ts`) and emits
   * `intent.declared` through it, rather than letting the injected emitter's ambient correlation
   * decide. That explicit `request_id` is the field the defect corrupted. It is reproduced here
   * instead of imported because this block's tests inject their own `ToolRegistry` (harness
   * header), so what stays under test is `src/mcp`.
   */
  function answerLikeTheToolsBlock(registry: ReturnType<typeof createFakeRegistry>, tool: string) {
    registry.answer(tool, async () => {
      const context = registry.calls.at(-1)?.context;
      context?.xray.emit(
        'intent.declared',
        {
          text: 'the user asked what they have',
          source: 'rationale',
          model_authored: true,
          tool,
          truncated: false,
        },
        {
          xs: context.auth.xs,
          login_id: context.auth.login_id,
          grant_id: context.auth.grant_id,
          persona_id: context.auth.persona.id,
          request_id: context.requestId,
        },
      );
      return toolText('two accounts');
    });
  }

  it('hands the tools block the JSON-RPC id as ToolContext.requestId, never the HTTP request id', async () => {
    const registry = createFakeRegistry();
    answerLikeTheToolsBlock(registry, 'load_accounts');
    const harness = await harnessWith({ registry });

    const response = await harness.rpc(
      callFrame('load_accounts', { rationale: 'the user asked what they have' }, 'rpc-7'),
      { token: tokenFor(READ_ONLY_SCOPES, 'grt_corr') },
    );
    expect(response.status).toBe(200);
    // The HTTP id is on the wire (src/app.ts echoes it), which is precisely why it is available
    // to be confused with the JSON-RPC id.
    expect(response.headers.get('x-request-id')).toBe(HTTP_REQUEST_ID_SENTINEL);

    const context = registry.calls[0]?.context;
    expect(context?.requestId).toBe('rpc-7');
    expect(context?.requestId).not.toBe(HTTP_REQUEST_ID_SENTINEL);

    const started = harness.xray.of('tool.call.started')[0];
    const completed = harness.xray.of('tool.call.completed')[0];
    const intent = harness.xray.of('intent.declared')[0];
    expect(started?.request_id).toBe('rpc-7');
    expect(completed?.request_id).toBe('rpc-7');
    // One key, `<xs>#<request_id>`: the child event nests under the call only if both halves match.
    expect(intent?.request_id).toBe(started?.request_id);
    expect(intent?.xs).toBe(started?.xs);
    expect(intent?.request_id).not.toBe(HTTP_REQUEST_ID_SENTINEL);
    harness.expectNoInvalidEvents();
  });

  it('gives two calls in one session two different keys, instead of collapsing them into one', async () => {
    const registry = createFakeRegistry();
    answerLikeTheToolsBlock(registry, 'load_accounts');
    const harness = await harnessWith({ registry });
    const token = tokenFor(READ_ONLY_SCOPES, 'grt_corr2');

    await harness.rpc(callFrame('load_accounts', { rationale: 'first' }, 'rpc-1'), { token });
    await harness.rpc(callFrame('load_accounts', { rationale: 'second' }, 'rpc-2'), { token });

    // A per-request HTTP id would differ per call; a per-connection one would not. Either way the
    // guarantee the dashboard needs is that the child event's id is the *call's* id, and the two
    // calls of one session are told apart by it.
    expect(registry.calls.map((call) => call.context.requestId)).toEqual(['rpc-1', 'rpc-2']);
    expect(harness.xray.of('intent.declared').map((event) => event.request_id)).toEqual([
      'rpc-1',
      'rpc-2',
    ]);
    expect(harness.xray.of('tool.call.started').map((event) => event.request_id)).toEqual([
      'rpc-1',
      'rpc-2',
    ]);
    harness.expectNoInvalidEvents();
  });
});

describe('catalog.tools_listed', () => {
  it('carries the full array once and elides it while the content hash is unchanged', async () => {
    const harness = await harnessWith();
    const token = tokenFor(READ_WRITE_SCOPES, 'grt_cat');

    await harness.rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token });
    await harness.rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { token });
    await harness.rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { token });

    const listings = harness.xray.of('catalog.tools_listed');
    expect(listings).toHaveLength(3);

    const first = listings[0];
    expect(first?.data.count).toBe(TOOL_CATALOG.length);
    expect(first?.data.tools).toHaveLength(TOOL_CATALOG.length);
    expect(first?.data.tools?.[0]?.name).toBe(TOOL_CATALOG[0]?.name);
    expect(first?.data.tools?.[0]?.input_schema_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(first?.data.availability).toHaveLength(TOOL_CATALOG.length);

    // claude.ai re-lists every 25-80 s: the array is not repeated, the hash is.
    for (const repeat of listings.slice(1)) {
      expect(repeat.data.tools).toBeNull();
      expect(repeat.data.content_hash).toBe(first?.data.content_hash);
      // The availability table is small and always carried, so the possibility-space panel is
      // right even on an elided listing.
      expect(repeat.data.availability).toHaveLength(TOOL_CATALOG.length);
    }
    harness.expectNoInvalidEvents();
  });

  it('carries the array again when the grant sees a different catalog', async () => {
    const harness = await harnessWith();
    await harness.rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: tokenFor(READ_WRITE_SCOPES, 'grt_hash') },
    );
    // A narrower grant is shown fewer tools, so the hash moves and the array comes back.
    await harness.rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: tokenFor(['profile', 'accounts:read'], 'grt_hash') },
    );

    const listings = harness.xray.of('catalog.tools_listed');
    expect(listings[0]?.data.tools).not.toBeNull();
    expect(listings[1]?.data.tools).not.toBeNull();
    expect(listings[1]?.data.content_hash).not.toBe(listings[0]?.data.content_hash);
    expect(listings[1]?.data.count).toBeLessThan(listings[0]?.data.count ?? 0);
  });

  it('keeps the elision per grant, never across grants', async () => {
    const harness = await harnessWith();
    await harness.rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: tokenFor(READ_WRITE_SCOPES, 'grt_one') },
    );
    await harness.rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { token: tokenFor(READ_WRITE_SCOPES, 'grt_two') },
    );
    const listings = harness.xray.of('catalog.tools_listed');
    expect(listings[0]?.data.tools).not.toBeNull();
    expect(listings[1]?.data.tools).not.toBeNull();
    expect(listings[0]?.data.content_hash).toBe(listings[1]?.data.content_hash);
  });

  it('answers prompts/list and resources/list with their own catalog events', async () => {
    const harness = await harnessWith();
    await harness.rpc({ jsonrpc: '2.0', id: 1, method: 'prompts/list' });
    await harness.rpc({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    expect(harness.xray.of('catalog.prompts_listed')[0]?.data.count).toBe(0);
    expect(harness.xray.of('catalog.resources_listed')[0]?.data.count).toBe(0);
    // ADR-3: an empty list is not an error.
    expect(harness.xray.of('protocol.error')).toHaveLength(0);
  });
});

describe('the tool descriptor on catalog.tools_listed (contracts v0.5)', () => {
  it('records one descriptor per listed tool, each re-hashing to its own row digest', async () => {
    const harness = await harnessWith();
    await harness.rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: tokenFor(READ_WRITE_SCOPES, 'grt_desc') },
    );

    const listing = harness.xray.of('catalog.tools_listed')[0];
    const rows = listing?.data.tools ?? [];
    expect(rows).toHaveLength(TOOL_CATALOG.length);
    expect(TOOL_CATALOG).toHaveLength(17);

    // All seventeen rows of one payload, never a sample: every published schema carries the same
    // `PUBLISHED_RATIONALE_PROPERTY` object, so a redaction walker whose cycle guard is not
    // ancestor-scoped stores sixteen of them as "[circular]" and the digest check on the
    // dashboard fails (that walk is asserted in src/xray/__tests__/redaction.test.ts; this block
    // may not import it, so what is proven here is that the producer hands over intact rows).
    for (const row of rows) {
      const entry = TOOL_CATALOG.find((tool) => tool.name === row.name);
      expect(entry, row.name).toBeDefined();
      expect(row.descriptor?.description, row.name).toBe(entry?.description);
      expect(row.descriptor?.annotations, row.name).toEqual(entry?.annotations);
      expect(row.descriptor?._meta['x-required-scopes'], row.name).toEqual(entry?.requiredScopes);
      expect(row.descriptor?.inputSchema, row.name).toEqual(entry?.publishedInputSchema);
      const rehashed = createHash('sha256')
        .update(JSON.stringify(row.descriptor?.inputSchema))
        .digest('hex')
        .slice(0, 16);
      expect(rehashed, row.name).toBe(row.input_schema_hash);
    }

    const serialised = JSON.stringify(listing?.data);
    expect(serialised).not.toContain('[circular]');
    expect(serialised).not.toContain(REDACTED_PLACEHOLDER);
    harness.expectNoInvalidEvents();
  });

  it('fits one full listing under the event size budget of the emitter', async () => {
    const harness = await harnessWith();
    await harness.rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: tokenFor(READ_WRITE_SCOPES, 'grt_size') },
    );

    const serialised = JSON.stringify(harness.xray.of('catalog.tools_listed')[0]?.data);
    // 32 KB of which the descriptors are 27 KB, paid once per grant per process boot: every
    // later listing elides the array while the content hash holds (catalog-memory.ts).
    expect(serialised.length).toBeGreaterThan(25_000);
    expect(serialised.length).toBeLessThan(emitterNumber('MAX_EVENT_CHARS'));
    expect(serialised).not.toContain(emitterLiteral('BUDGET_MARKER'));
    expect(serialised).not.toContain(emitterLiteral('DEPTH_MARKER'));
  });

  it('answers tools/list with the descriptor this block published before v0.5', async () => {
    const harness = await harnessWith();
    const response = await harness.rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: tokenFor(READ_WRITE_SCOPES, 'grt_wire') },
    );
    const body = (await response.json()) as { result: { tools: unknown[] } };

    // The object `transport.ts` used to build by hand, rebuilt here from the catalog: the wire
    // shape, key order included, must not have moved when it started calling the contract helper.
    const expected = TOOL_CATALOG.map((entry) => ({
      name: entry.name,
      title: entry.title,
      description: entry.description,
      inputSchema: entry.publishedInputSchema,
      annotations: entry.annotations,
      _meta: {
        'x-read-only': entry.metadata['x-read-only'],
        'x-destructive': entry.metadata['x-destructive'],
        'x-gated-by': entry.metadata['x-gated-by'],
        'x-required-scopes': entry.requiredScopes,
        'x-kind': entry.kind,
      },
    }));
    expect(body.result.tools).toHaveLength(TOOL_CATALOG.length);
    expect(JSON.stringify(body.result.tools)).toBe(JSON.stringify(expected));
  });
});

describe('the text preview of tool.call.completed', () => {
  it('copies the marker the emitter appends, so the two cannot drift', () => {
    expect(RESULT_PREVIEW_TRUNCATION_SUFFIX).toBe(emitterLiteral('TRUNCATION_SUFFIX'));
  });

  it('marks a preview it had to cut and still counts the whole result', async () => {
    const registry = createFakeRegistry();
    const whole = 'a'.repeat(RESULT_PREVIEW_BYTES * 2);
    registry.answer('load_accounts', toolText(whole));
    const harness = await harnessWith({ registry });

    await harness.rpc(callFrame('load_accounts', { rationale: 'the user asked for everything' }), {
      token: tokenFor(READ_ONLY_SCOPES, 'grt_cut'),
    });

    const completed = harness.xray.of('tool.call.completed')[0];
    expect(completed?.data.content_chars).toBe(whole.length);
    const preview = completed?.data.text_preview ?? '';
    expect(preview.endsWith(RESULT_PREVIEW_TRUNCATION_SUFFIX)).toBe(true);
    expect(preview.slice(0, -RESULT_PREVIEW_TRUNCATION_SUFFIX.length)).toBe(
      whole.slice(0, RESULT_PREVIEW_BYTES),
    );
    harness.expectNoInvalidEvents();
  });

  it('keeps a result that fits the cap whole and unmarked', async () => {
    const registry = createFakeRegistry();
    const whole = 'b'.repeat(RESULT_PREVIEW_BYTES);
    registry.answer('load_accounts', toolText(whole));
    const harness = await harnessWith({ registry });

    await harness.rpc(callFrame('load_accounts', { rationale: 'the user asked for everything' }), {
      token: tokenFor(READ_ONLY_SCOPES, 'grt_whole'),
    });

    const completed = harness.xray.of('tool.call.completed')[0];
    expect(completed?.data.content_chars).toBe(whole.length);
    expect(completed?.data.text_preview).toBe(whole);
    harness.expectNoInvalidEvents();
  });
});

describe('session.*', () => {
  it('reports the negotiated protocol version the SDK actually answered with', async () => {
    const harness = await harnessWith();
    for (const requested of ['2025-11-25', '2024-11-05', '1999-01-01']) {
      harness.xray.clear();
      const response = await harness.rpc(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: requested,
            capabilities: { roots: {} },
            clientInfo: { name: 'claude-ai', version: '1.0.0' },
          },
        },
        { token: tokenFor(READ_ONLY_SCOPES, 'grt_init') },
      );
      const body = (await response.json()) as { result: { protocolVersion: string } };
      const initialized = harness.xray.of('session.initialized')[0];
      expect(initialized?.data.protocol_version_requested).toBe(requested);
      expect(initialized?.data.protocol_version_negotiated).toBe(body.result.protocolVersion);
      expect(initialized?.data.client_capabilities).toEqual({ roots: {} });
      expect(initialized?.data.server_capabilities).toHaveProperty('tools');
      expect(initialized?.data.instructions_sent).toBe(true);
      expect(initialized?.data.client?.name).toBe('claude-ai');
      expect(initialized?.era).toBe('legacy');
    }
  });

  it('counts re-initializations inside one session instead of starting a new one', async () => {
    const harness = await harnessWith();
    const token = tokenFor(READ_ONLY_SCOPES, 'grt_reinit');
    await harness.rpc(initializeFrame(1), { token });
    await harness.rpc(initializeFrame(2), { token });
    await harness.rpc(initializeFrame(3), { token });

    expect(harness.xray.of('session.started')).toHaveLength(1);
    expect(
      harness.xray.of('session.initialized').map((event) => event.data.initialize_count),
    ).toEqual([1, 2, 3]);
    const sessions = new Set(harness.xray.of('session.initialized').map((event) => event.xs));
    expect(sessions.size).toBe(1);
  });

  it('splits the session on an idle gap and ends the old one lazily (A-27)', async () => {
    let clock = Date.parse('2026-09-08T10:00:00.000Z');
    const harness = await harnessWith({
      config: { xsIdleGapMinutes: 15 },
      now: () => new Date(clock),
    });
    const token = tokenFor(READ_ONLY_SCOPES, 'grt_gap');

    await harness.rpc(initializeFrame(1), { token });
    clock += 60_000;
    await harness.rpc(callFrame('get_current_user', { rationale: 'who am i' }, 2), { token });
    const firstXs = harness.xray.of('session.started')[0]?.xs;

    // Fourteen minutes of silence is still the same session.
    clock += 14 * 60_000;
    await harness.rpc(callFrame('get_current_user', { rationale: 'again' }, 3), { token });
    expect(harness.xray.of('session.started')).toHaveLength(1);
    expect(harness.xray.of('session.ended')).toHaveLength(0);

    // Sixteen more minutes is not.
    clock += 16 * 60_000;
    await harness.rpc(callFrame('get_current_user', { rationale: 'much later' }, 4), { token });

    const starts = harness.xray.of('session.started');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.data.reason).toBe('idle_gap');
    expect(starts[1]?.data.idle_ms).toBe(16 * 60_000);
    expect(starts[1]?.xs).not.toBe(firstXs);

    const ended = harness.xray.of('session.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]?.xs).toBe(firstXs);
    expect(ended[0]?.data.reason).toBe('idle_gap');
    expect(ended[0]?.data.call_count).toBe(2);
    expect(ended[0]?.data.initialize_count).toBe(1);
    expect(ended[0]?.data.duration_ms).toBe(15 * 60_000);
    // session.ended is emitted before the new session starts, so the timeline reads in order.
    const types = harness.xray.typesOf();
    expect(types.indexOf('session.ended')).toBeLessThan(types.lastIndexOf('session.started'));
    harness.expectNoInvalidEvents();
  });

  it('sweeps an idle session even when no further request arrives', async () => {
    let clock = Date.parse('2026-09-08T10:00:00.000Z');
    const harness = await harnessWith({
      config: { xsIdleGapMinutes: 15 },
      now: () => new Date(clock),
    });
    await harness.rpc(initializeFrame(1), { token: tokenFor(READ_ONLY_SCOPES, 'grt_sweep') });
    expect(harness.handler.sweep()).toBe(0);

    clock += 20 * 60_000;
    expect(harness.handler.sweep()).toBe(1);
    expect(harness.xray.of('session.ended')[0]?.data.reason).toBe('idle_gap');
    expect(harness.handler.stats().sessions).toBe(0);
  });

  it('closes every session on shutdown, which is the SIGTERM hook (invariant 12)', async () => {
    const harness = await harnessWith();
    await harness.rpc(initializeFrame(1), { token: tokenFor(READ_ONLY_SCOPES, 'grt_stop_a') });
    await harness.rpc(initializeFrame(2), { token: tokenFor(READ_ONLY_SCOPES, 'grt_stop_b') });

    const result = harness.handler.shutdown();
    expect(result.sessions_ended).toBe(2);
    const ended = harness.xray.of('session.ended');
    expect(ended).toHaveLength(2);
    expect(ended.every((event) => event.data.reason === 'server_stopping')).toBe(true);
    expect(ended.every((event) => event.data.idle_ms === null)).toBe(true);
    harness.expectNoInvalidEvents();
  });

  it('records an initialize the SDK refused as session.rejected, not as initialized', async () => {
    const harness = await harnessWith();
    // No `protocolVersion`. The SDK's own envelope validation rejects it - measured as -32603,
    // not the -32602 the JSON-RPC spec would suggest, which is exactly why this block reads the
    // code off the response instead of inventing one.
    const response = await harness.rpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } },
      { token: tokenFor(READ_ONLY_SCOPES, 'grt_badinit') },
    );
    const body = (await response.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32603);
    expect(harness.xray.of('session.initialized')).toHaveLength(0);
    const rejected = harness.xray.of('session.rejected')[0];
    expect(rejected?.data.reason).toBe('initialize');
    expect(harness.xray.of('protocol.error')[0]?.data.code).toBe(-32603);
    harness.expectNoInvalidEvents();
  });

  it('records a rejected Origin as session.rejected (invariant 10)', async () => {
    const harness = await harnessWith({ config: { originPolicy: 'allowlist' } });
    const response = await harness.rpc(initializeFrame(1), {
      headers: { origin: 'https://evil.example' },
    });
    expect(response.status).toBe(403);
    const rejected = harness.xray.of('session.rejected')[0];
    expect(rejected?.data.reason).toBe('origin_rejected');
    expect(harness.xray.of('http.request')[0]?.data.origin_decision).toBe('rejected');
  });
});

describe('the last-seen clientInfo (the T0.3 gap)', () => {
  it('carries clientInfo from initialize onto a later stateless tools/call', async () => {
    const registry = createFakeRegistry();
    const harness = await harnessWith({ registry });
    const token = tokenFor(READ_ONLY_SCOPES, 'grt_client');

    await harness.rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'claude-ai', version: '2.0.0', title: 'Claude' },
        },
      },
      { token },
    );
    harness.xray.clear();

    // The transport is stateless, so this frame carries no clientInfo at all (ADR-3).
    await harness.rpc(callFrame('load_payees', { rationale: 'list the payees' }, 2), { token });

    expect(registry.calls[0]?.context.auth.client?.name).toBe('claude-ai');
    expect(registry.calls[0]?.context.auth.client?.title).toBe('Claude');
    for (const event of harness.xray.events) {
      expect(event.client?.name, event.type).toBe('claude-ai');
      expect(event.protocol_version, event.type).toBe('2025-11-25');
    }
  });
});

describe('tool.call.denied', () => {
  it('denies with rate_limited once the grant has spent its per-minute budget (invariant 14)', async () => {
    const harness = await harnessWith({ config: { grantToolCallsPerMin: 1 } });
    const token = tokenFor(READ_ONLY_SCOPES, 'grt_limit');

    const first = await harness.rpc(callFrame('get_current_user', { rationale: 'once' }, 1), {
      token,
    });
    expect(first.status).toBe(200);

    const second = await harness.rpc(callFrame('get_current_user', { rationale: 'twice' }, 2), {
      token,
    });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');

    const denied = harness.xray.of('tool.call.denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.data.denied_reason).toBe('rate_limited');
    expect(denied[0]?.data.tool).toBe('get_current_user');
    expect(denied[0]?.data.status).toBe(429);
    expect(harness.xray.of('http.request').at(-1)?.data.rate_limited).toBe(true);
    harness.expectNoInvalidEvents();
  });

  it('denies with feature_flag for a tool the deployment turned off (ADR-13)', async () => {
    const harness = await harnessWith({ config: { featureFlags: [] } });
    const response = await harness.rpc(
      callFrame('create_transfer', { rationale: 'move money' }, 1),
      { token: tokenFor(READ_WRITE_SCOPES, 'grt_flag') },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);

    const denied = harness.xray.of('tool.call.denied')[0];
    expect(denied?.data.denied_reason).toBe('feature_flag');
    expect(denied?.data.tool).toBe('create_transfer');
    // The client sees a JSON-RPC error inside an HTTP 200, and the event says so.
    expect(denied?.data.status).toBe(200);
    // ...and the -32601 it was answered with is recorded too.
    expect(harness.xray.of('protocol.error')[0]?.data.code).toBe(-32601);
    harness.expectNoInvalidEvents();
  });
});

describe('protocol.error', () => {
  it('records the -32601 the SDK answers for an unknown method', async () => {
    const harness = await harnessWith();
    await harness.rpc({ jsonrpc: '2.0', id: 9, method: 'sampling/createMessage', params: {} });
    const error = harness.xray.of('protocol.error')[0];
    expect(error?.data.code).toBe(-32601);
    expect(error?.data['mcp.method.name']).toBe('sampling/createMessage');
    harness.expectNoInvalidEvents();
  });

  it('records the -32601 for a tool that is not in the catalog at all', async () => {
    const harness = await harnessWith();
    await harness.rpc(callFrame('no_such_tool', {}, 10));
    const error = harness.xray.of('protocol.error')[0];
    expect(error?.data.code).toBe(-32601);
    expect(error?.data['mcp.method.name']).toBe('tools/call');
    // A name that is not a tool is not a denial: nothing was denied, it does not exist.
    expect(harness.xray.of('tool.call.denied')).toHaveLength(0);
  });
});

describe('a body that never reached the handler', () => {
  it('records the parse failure the JSON body parser rejected', async () => {
    const harness = await harnessWith();
    const response = await fetch(new URL('/mcp', harness.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokenFor(READ_ONLY_SCOPES, 'grt_parse')}`,
      },
      body: '{"jsonrpc":"2.0", this is not json',
    });
    // `src/app.ts` owns the response; this block only has to make sure it is not invisible.
    expect(response.status).toBe(400);
    const error = harness.xray.of('protocol.error')[0];
    expect(error?.data.code).toBe(-32700);
    const request = harness.xray.of('http.request')[0];
    expect(request?.data.status).toBe(400);
    expect(harness.xray.of('http.request')).toHaveLength(1);
    harness.expectNoInvalidEvents();
  });
});

describe('tool.call.cancelled', () => {
  it('reports a call the client abandoned as client_cancelled', async () => {
    const registry = createFakeRegistry();
    let release = (): void => undefined;
    registry.answer(
      'load_transactions',
      () =>
        new Promise((resolve) => {
          release = () => resolve(toolText('late'));
        }),
    );
    const harness = await harnessWith({ registry });

    // A raw socket rather than `fetch`: aborting a `fetch` only cancels the client's read, and
    // undici may hold the pooled connection open for seconds, which is not what claude.ai
    // dropping a request looks like. Destroying the socket is.
    const url = new URL('/mcp', harness.baseUrl);
    const clientRequest = httpRequest({
      hostname: url.hostname,
      port: url.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokenFor(READ_ONLY_SCOPES, 'grt_cancel')}`,
      },
    });
    clientRequest.on('error', () => undefined);
    clientRequest.end(JSON.stringify(callFrame('load_transactions', { rationale: 'a long report' }, 1)));

    await waitFor(() => harness.xray.of('tool.call.started').length === 1, 'the call to start');
    clientRequest.destroy();
    await waitFor(
      () => harness.xray.of('tool.call.cancelled').length === 1,
      'the cancellation to be recorded',
    );

    const cancelled = harness.xray.of('tool.call.cancelled')[0];
    expect(cancelled?.data.tool).toBe('load_transactions');
    expect(cancelled?.data.reason).toBe('client_cancelled');
    expect(cancelled?.xs).toMatch(/^xs_/);
    release();
    harness.expectNoInvalidEvents();
  });

  it('reports a call still running at shutdown as server_stopping', async () => {
    const registry = createFakeRegistry();
    let release = (): void => undefined;
    registry.answer(
      'load_statement_lines',
      () =>
        new Promise((resolve) => {
          release = () => resolve(toolText('done'));
        }),
    );
    const harness = await harnessWith({ registry });

    const pending = harness.rpc(
      callFrame('load_statement_lines', { rationale: 'the whole year' }, 1),
      { token: tokenFor(READ_ONLY_SCOPES, 'grt_shutdown') },
    );
    await waitFor(() => harness.xray.of('tool.call.started').length === 1, 'the call to start');

    const result = harness.handler.shutdown();
    expect(result.calls_cancelled).toBe(1);
    expect(harness.xray.of('tool.call.cancelled')[0]?.data.reason).toBe('server_stopping');

    release();
    await pending;
  });
});

describe('http.request', () => {
  it('is emitted for the 405 on GET and DELETE too (invariant 6)', async () => {
    const harness = await harnessWith();
    await harness.fetch('/mcp', { method: 'GET' });
    await harness.fetch('/mcp', { method: 'DELETE' });
    const requests = harness.xray.of('http.request');
    expect(requests.map((event) => event.data.method)).toEqual(['GET', 'DELETE']);
    expect(requests.every((event) => event.data.status === 405)).toBe(true);
    harness.expectNoInvalidEvents();
  });

  it('stores only the /24 prefix of the caller address (invariant 11)', async () => {
    const harness = await harnessWith();
    await harness.rpc(initializeFrame(1), {
      headers: { 'x-forwarded-for': '203.0.113.42', 'user-agent': 'Claude-User/1.0' },
    });
    const request = harness.xray.of('http.request')[0];
    expect(request?.data.remote_ip_prefix).toBe('203.0.113.0/24');
    expect(request?.data.user_agent).toBe('Claude-User/1.0');
    expect(request?.data.anthropic_egress).toBe(false);
  });

  it('flags Anthropic egress addresses', async () => {
    const harness = await harnessWith();
    await harness.rpc(initializeFrame(1), { headers: { 'x-forwarded-for': '160.79.104.7' } });
    expect(harness.xray.of('http.request')[0]?.data.anthropic_egress).toBe(true);
  });
});

describe('invariant 7: a token reaches the log only as the raw request carried it (D-28)', () => {
  it('keeps the Authorization header verbatim in `raw` and nowhere else', async () => {
    const harness = await harnessWith();
    const token = tokenFor(READ_ONLY_SCOPES, 'grt_secret');
    await harness.rpc(initializeFrame(1), { token });
    await harness.rpc(callFrame('get_current_user', { rationale: 'who am i' }, 2), { token });

    // The record: the header exactly as sent, on every request that carried it.
    const requests = harness.xray.events.filter((event) => event.type === 'http.request');
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      const headers = (request.data as { raw?: { headers: [string, string][] } }).raw?.headers ?? [];
      expect(headers.find(([name]) => name.toLowerCase() === 'authorization')?.[1]).toBe(
        `Bearer ${token}`,
      );
    }

    // Every categorised field: no token value, whoever produced it. The viewer surfaces hide the
    // raw header too (src/xray/redaction.ts, `viewEvent`).
    const withoutRaw = harness.xray.events.map((event) =>
      event.type === 'http.request' ? { ...event, data: { ...event.data, raw: undefined } } : event,
    );
    const serialised = JSON.stringify(withoutRaw);
    expect(serialised).not.toContain('mockbank_user_tok_');
    expect(serialised).not.toContain(token);
  });
});
