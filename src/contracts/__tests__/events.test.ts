/**
 * The envelope and the catalogue of docs/XRAY_EVENT_MODEL.md sections 2 and 3.
 */
import { describe, expect, it } from 'vitest';

import {
  ID_PREFIXES,
  XRAY_CONTRACT_VERSION,
  XRAY_EVENT_FAMILIES,
  XRAY_EVENT_TYPES,
  XrayEnvelopeSchema,
  XrayEventSchema,
  dataKeysOf,
  familyOf,
  idPattern,
  idSchema,
  isId,
  isXrayEventType,
  parseXrayEvent,
  parseXrayEventLine,
  safeParseXrayEvent,
} from '../index.js';

const MINIMAL = {
  id: 18_342,
  ts: '2026-09-08T14:03:22.418Z',
  v: 1,
  type: 'server.started',
  data: { boot_id: 'boot_9f2a1c', version: '0.1.0' },
};

describe('the XrayEvent envelope', () => {
  it('fills every correlation field with null when the producer omits it', () => {
    const event = parseXrayEvent(MINIMAL);
    expect(event.v).toBe(XRAY_CONTRACT_VERSION);
    expect(event.xs).toBeNull();
    expect(event.login_id).toBeNull();
    expect(event.grant_id).toBeNull();
    expect(event.persona_id).toBeNull();
    expect(event.seq).toBeNull();
    expect(event.request_id).toBeNull();
    expect(event.era).toBeNull();
    expect(event.client).toBeNull();
    expect(event.protocol_version).toBeNull();
    expect(event.trace_id).toBeNull();
  });

  it('carries login_id so the dashboard can group a human grants (ADR-14)', () => {
    const event = parseXrayEvent({
      ...MINIMAL,
      type: 'auth.verified',
      xs: 'xs_3f1c9a',
      login_id: 'lgn_5d2c7a',
      grant_id: 'grt_8a1e33',
      persona_id: 'per_a1b2',
      seq: 41,
      request_id: '7',
      era: 'legacy',
      client: { name: 'Anthropic', version: '1.0.0' },
      protocol_version: '2025-11-25',
      data: {
        grant_id: 'grt_8a1e33',
        login_id: 'lgn_5d2c7a',
        persona_id: 'per_a1b2',
        scopes: ['profile'],
        auth_level: 'read_only',
        client_id: 'cli_1',
        aud: 'https://host/mcp',
        expires_at: '2026-09-08T15:00:00.000Z',
      },
    });
    expect(event.login_id).toBe('lgn_5d2c7a');
    expect(event.client?.title).toBeNull();
  });

  it('rejects an id that does not carry its documented prefix', () => {
    expect(safeParseXrayEvent({ ...MINIMAL, grant_id: 'nope' }).success).toBe(false);
    expect(safeParseXrayEvent({ ...MINIMAL, xs: 'session-1' }).success).toBe(false);
    expect(safeParseXrayEvent({ ...MINIMAL, persona_id: 'per_a1b2' }).success).toBe(true);
  });

  it('rejects a non-UTC or malformed timestamp', () => {
    expect(safeParseXrayEvent({ ...MINIMAL, ts: '2026-09-08 14:03:22' }).success).toBe(false);
    expect(safeParseXrayEvent({ ...MINIMAL, ts: '2026-09-08T14:03:22.418+02:00' }).success).toBe(
      false,
    );
  });

  it('rejects a contract version other than 1', () => {
    expect(safeParseXrayEvent({ ...MINIMAL, v: 2 }).success).toBe(false);
  });

  it('parses one JSONL line', () => {
    expect(parseXrayEventLine(JSON.stringify(MINIMAL)).id).toBe(18_342);
  });
});

describe('the event catalogue', () => {
  it('has 47 types across the twelve documented families', () => {
    expect(XRAY_EVENT_TYPES).toHaveLength(47);
    expect(new Set(XRAY_EVENT_TYPES).size).toBe(47);
    const families = new Set(XRAY_EVENT_TYPES.map(familyOf));
    expect([...families].sort()).toEqual([...XRAY_EVENT_FAMILIES].sort());
  });

  it('names every type family.noun.verb or family.noun', () => {
    for (const type of XRAY_EVENT_TYPES) {
      expect(type).toMatch(/^[a-z]+(\.[a-z_]+){1,2}$/);
    }
  });

  it('recognises its own type names', () => {
    expect(isXrayEventType('tool.call.completed')).toBe(true);
    expect(isXrayEventType('tool.call.exploded')).toBe(false);
  });

  it('refuses an unknown type in the strict schema', () => {
    expect(safeParseXrayEvent({ ...MINIMAL, type: 'tool.call.exploded' }).success).toBe(false);
  });

  it('accepts an unknown type in the forward-compatible envelope', () => {
    const parsed = XrayEnvelopeSchema.safeParse({
      ...MINIMAL,
      type: 'analyst.query.ran',
      data: { anything: true },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.data).toEqual({ anything: true });
  });

  it('exposes the documented data keys of one type', () => {
    expect(dataKeysOf('sql.rejected')).toEqual([
      'table',
      'sql',
      'rejected_reason',
      'error',
      'duration_ms',
    ]);
    expect(dataKeysOf('protocol.error')).toContain('mcp.method.name');
  });

  it('validates the payload of every family, not only the envelope', () => {
    expect(
      safeParseXrayEvent({
        ...MINIMAL,
        type: 'sql.rejected',
        data: { sql: 'ATTACH x', rejected_reason: 'nope', error: 'x' },
      }).success,
    ).toBe(false);
    expect(
      safeParseXrayEvent({
        ...MINIMAL,
        type: 'sql.rejected',
        data: { sql: 'ATTACH x', rejected_reason: 'denylist', error: 'x' },
      }).success,
    ).toBe(true);
  });

  it('requires intent.declared to be flagged model-authored', () => {
    expect(
      safeParseXrayEvent({
        ...MINIMAL,
        type: 'intent.declared',
        data: { text: 'why', source: 'rationale', model_authored: false, tool: 'load_cards' },
      }).success,
    ).toBe(false);
  });

  it('defaults the claude.ai budget and content cap on a tool completion', () => {
    const event = parseXrayEvent({
      ...MINIMAL,
      type: 'tool.call.completed',
      data: { tool: 'load_cards', duration_ms: 12, is_error: false },
    });
    expect(event.type).toBe('tool.call.completed');
    if (event.type === 'tool.call.completed') {
      expect(event.data.budget_ms).toBe(300_000);
      expect(event.data.content_cap).toBe(150_000);
    }
  });

  it('keeps clientInfo verbatim, extra keys included (A-28)', () => {
    const event = parseXrayEvent({
      ...MINIMAL,
      client: { name: 'claude-ai', version: '2.0', platform: 'web' },
    });
    expect(event.client).toMatchObject({ name: 'claude-ai', platform: 'web' });
  });
});

describe('id conventions (docs/REPO_LAYOUT.md section 8)', () => {
  it('knows every documented prefix', () => {
    expect(ID_PREFIXES.persona).toBe('per_');
    expect(ID_PREFIXES.transaction).toBe('txn_');
    expect(ID_PREFIXES.transfer).toBe('tr_');
  });

  it('matches and rejects ids by kind', () => {
    expect(isId('per_a1b2', 'persona')).toBe(true);
    expect(isId('grt_8a1e33', 'persona')).toBe(false);
    expect(idPattern('bill').test('bill_0001')).toBe(true);
    expect(idSchema('payee').safeParse('pay_x').success).toBe(true);
    expect(idSchema('payee').safeParse('payee_x').success).toBe(false);
  });
});

describe('the schemas are open: nothing a producer sends is dropped (v0.9, D-28)', () => {
  it('keeps a data key the contract does not document, at any depth', () => {
    const parsed = XrayEventSchema.parse({
      ...MINIMAL,
      type: 'etl.load',
      data: {
        table: 't',
        rows: 1,
        source_tool: 'load_cards',
        duration_ms: 1,
        undocumented: { nested: ['kept'] },
      },
    });
    expect(parsed.data).toHaveProperty('undocumented', { nested: ['kept'] });
    // The categorised keys stay the documented ones; the rest is the unmapped remainder.
    expect(dataKeysOf('etl.load')).not.toContain('undocumented');
  });

  it('keeps an envelope key the contract does not document', () => {
    const parsed = XrayEventSchema.parse({ ...MINIMAL, envelope_extra: 42 }) as Record<string, unknown>;
    expect(parsed.envelope_extra).toBe(42);
  });

  it('keeps unknown keys inside nested catalogue objects', () => {
    const parsed = XrayEventSchema.parse({
      ...MINIMAL,
      type: 'tool.call.completed',
      data: {
        tool: 'load_cards',
        duration_ms: 1,
        is_error: true,
        error: { message: 'boom', class: 'tool', vendor_detail: 'x' },
      },
    });
    expect(parsed.type === 'tool.call.completed' && parsed.data.error).toMatchObject({
      vendor_detail: 'x',
    });
  });

  it('carries the raw request on http.request, headers as ordered pairs', () => {
    const parsed = XrayEventSchema.parse({
      ...MINIMAL,
      type: 'http.request',
      data: {
        method: 'POST',
        path: '/mcp',
        status: 200,
        duration_ms: 3,
        raw: {
          method: 'POST',
          url: '/mcp',
          headers: [
            ['Signature-Agent', '"https://chatgpt.com"'],
            ['X-Dup', 'a'],
            ['X-Dup', 'b'],
          ],
          body: '{"jsonrpc":"2.0"}',
          body_encoding: 'utf8',
          body_bytes: 17,
          body_read: true,
          something_new: true,
        },
      },
    });
    expect(parsed.type === 'http.request' && parsed.data.raw).toMatchObject({
      headers: [
        ['Signature-Agent', '"https://chatgpt.com"'],
        ['X-Dup', 'a'],
        ['X-Dup', 'b'],
      ],
      something_new: true,
      trailers: [],
    });
  });
});
