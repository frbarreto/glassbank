/**
 * The redaction pipeline (docs/XRAY_EVENT_MODEL.md section 3, CLAUDE.md invariant 11).
 *
 * These are the tests the invariant names: "the redaction pipeline is unit-tested". Every rule of
 * section 3 has at least one case here, and the two most dangerous behaviours - "arguments are
 * verbatim by default" and "a token never reaches the log" - are asserted in both directions.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_PREFIX,
  OBSERVER_RATIONALE_PREVIEW_CHARS,
  REDACTED_PLACEHOLDER,
  RESULT_PREVIEW_BYTES,
  TOOL_CATALOG,
  XrayEventSchema,
  type XrayEvent,
} from '../../contracts/index.js';

import {
  MAX_EVENT_CHARS,
  MAX_STRING_CHARS,
  applyObserverRedaction,
  ipPrefixOf,
  isAnthropicEgress,
  maskToLastFour,
  passesLuhn,
  redactEventData,
  shortHash,
} from '../redaction.js';

function event<T extends XrayEvent['type']>(type: T, data: unknown): XrayEvent {
  const redacted = redactEventData(type, data);
  return XrayEventSchema.parse({
    id: 1,
    ts: '2026-09-08T14:00:00.000Z',
    v: 1,
    type,
    data: redacted.data,
  });
}

describe('tool arguments (section 3: verbatim except the deny-lists)', () => {
  it('stores ordinary arguments exactly as the model wrote them', () => {
    const result = redactEventData('tool.call.started', {
      tool: 'load_transactions',
      arguments: {
        account_id: 'acc_9f3a2b7c',
        start_date: '2026-01-01',
        limit: 100,
        nested: { merchant: "Baker's Corner", amount_cents: 1299 },
      },
      rationale: 'The user asked how much they spent on groceries last month.',
      rationale_present: true,
    });
    expect(result.data.arguments).toEqual({
      account_id: 'acc_9f3a2b7c',
      start_date: '2026-01-01',
      limit: 100,
      nested: { merchant: "Baker's Corner", amount_cents: 1299 },
    });
    expect(result.redacted_fields).toEqual([]);
  });

  it('applies the per-tool deny-list from the frozen catalog and lists what it hid', () => {
    // create_transfer's deny-list is ACCOUNT_NUMBER_FIELDS + CARD_NUMBER_FIELDS.
    const result = redactEventData('tool.call.started', {
      tool: 'create_transfer',
      arguments: {
        amount_cents: 25_000,
        payee: { name: 'Grace Whitfield', account_number: '4111111111111111', iban: 'GB00X' },
        rationale: 'Pay the invoice',
      },
      rationale_present: true,
    });
    const args = result.data.arguments as Record<string, unknown>;
    const payee = args.payee as Record<string, unknown>;
    expect(payee.account_number).toBe(REDACTED_PLACEHOLDER);
    expect(payee.iban).toBe(REDACTED_PLACEHOLDER);
    expect(payee.name).toBe('Grace Whitfield');
    expect(args.amount_cents).toBe(25_000);
    expect(result.redacted_fields).toContain('arguments.payee.account_number');
    expect(result.redacted_fields).toContain('arguments.payee.iban');
  });

  it('applies the global pattern deny-list wherever a token turns up', () => {
    const result = redactEventData('tool.call.started', {
      tool: 'execute_query',
      arguments: {
        sql: `SELECT * FROM t WHERE k = '${ACCESS_TOKEN_PREFIX}abc.def-ghi'`,
        header: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaaaaaaaaaaaaaa.bbbb',
      },
      rationale_present: false,
    });
    const args = result.data.arguments as Record<string, string>;
    expect(args.sql).not.toContain(ACCESS_TOKEN_PREFIX);
    expect(args.sql).toContain(REDACTED_PLACEHOLDER);
    expect(args.header).not.toContain('eyJ');
    expect(result.redacted_fields).toContain('arguments.sql');
  });

  it('never stores a value under a token-shaped key, whatever the tool', () => {
    const result = redactEventData('tool.call.started', {
      tool: 'get_current_user',
      arguments: { access_token: 'plain', Authorization: 'Bearer x', nested: { cookie: 'a=b' } },
      rationale_present: false,
    });
    const args = result.data.arguments as Record<string, unknown>;
    expect(args.access_token).toBe(REDACTED_PLACEHOLDER);
    expect(args.Authorization).toBe(REDACTED_PLACEHOLDER);
    expect((args.nested as Record<string, unknown>).cookie).toBe(REDACTED_PLACEHOLDER);
  });

  it('masks a bare card number to its last four wherever it appears', () => {
    const result = redactEventData('tool.call.started', {
      tool: 'lock_or_unlock_card',
      arguments: { note: 'the card 4111 1111 1111 1111 was lost' },
      rationale_present: false,
    });
    const args = result.data.arguments as Record<string, string>;
    expect(args.note).toBe('the card ****1111 was lost');
  });

  it('leaves a long number that is not a card number alone', () => {
    // The Luhn filter is what keeps "verbatim arguments" true for an epoch-millisecond string or
    // an order number. It is a filter, not a proof: roughly one long number in ten passes Luhn by
    // chance and is masked, which is the side to err on.
    const result = redactEventData('tool.call.started', {
      tool: 'execute_query',
      arguments: { since_ms: '1789219200001', order: '9876543210987654' },
      rationale_present: false,
    });
    expect(result.data.arguments).toEqual({
      since_ms: '1789219200001',
      order: '9876543210987654',
    });
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('1789219200001')).toBe(false);
    expect(passesLuhn('123')).toBe(false);
  });

  it('keeps the rationale verbatim and flags it as model-authored', () => {
    const rationale = 'Fetching the last 90 days of card transactions to answer the question.';
    const started = redactEventData('tool.call.started', {
      tool: 'load_cards',
      arguments: {},
      rationale,
      rationale_present: true,
    });
    expect(started.data.rationale).toBe(rationale);
    expect(started.data.rationale_truncated).toBe(false);

    const declared = redactEventData('intent.declared', {
      text: rationale,
      source: 'rationale',
      model_authored: false,
      tool: 'load_cards',
    });
    // The producer's value is overruled: a declared intent is always the model's words.
    expect(declared.data.model_authored).toBe(true);
    expect(declared.data.text).toBe(rationale);
  });
});

describe('http.request (section 3: a /24 prefix and the egress flag, never the address)', () => {
  it('reduces a raw remote_ip to its /24 prefix and sets anthropic_egress', () => {
    const result = redactEventData('http.request', {
      method: 'POST',
      path: '/mcp',
      status: 200,
      duration_ms: 12,
      remote_ip: '160.79.106.42',
    });
    expect(result.data.remote_ip).toBeUndefined();
    expect(result.data.remote_ip_prefix).toBe('160.79.106.0/24');
    expect(result.data.anthropic_egress).toBe(true);
  });

  it('leaves a prefix a producer already reduced alone', () => {
    const result = redactEventData('http.request', {
      method: 'GET',
      path: '/healthz',
      status: 200,
      duration_ms: 1,
      remote_ip_prefix: '203.0.113.0/24',
    });
    expect(result.data.remote_ip_prefix).toBe('203.0.113.0/24');
    expect(result.data.anthropic_egress).toBe(false);
  });

  it('knows the documented egress range', () => {
    expect(isAnthropicEgress('160.79.104.0')).toBe(true);
    expect(isAnthropicEgress('160.79.111.255')).toBe(true);
    expect(isAnthropicEgress('160.79.112.0')).toBe(false);
    expect(isAnthropicEgress('8.8.8.8')).toBe(false);
    expect(isAnthropicEgress(null)).toBe(false);
  });

  it('reduces IPv6 to a /48 and survives a missing address', () => {
    expect(ipPrefixOf('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
    expect(ipPrefixOf('::ffff:203.0.113.9')).toBe('203.0.113.0/24');
    expect(ipPrefixOf(null)).toBeNull();
  });
});

describe('results, numbers and pairing codes', () => {
  it('truncates a result preview to 2 KB', () => {
    const result = redactEventData('tool.call.completed', {
      tool: 'execute_query',
      duration_ms: 8,
      is_error: false,
      text_preview: 'x'.repeat(RESULT_PREVIEW_BYTES * 3),
    });
    const preview = result.data.text_preview as string;
    expect(preview.length).toBeLessThan(RESULT_PREVIEW_BYTES + 40);
    expect(preview.endsWith('[truncated]')).toBe(true);
  });

  it('previews structured content that does not fit', () => {
    const big = { rows: Array.from({ length: 400 }, (_unused, index) => ({ index, note: 'x'.repeat(20) })) };
    const result = redactEventData('tool.call.completed', {
      tool: 'execute_query',
      duration_ms: 8,
      is_error: false,
      structured_content: big,
    });
    expect((result.data.structured_content as { truncated: boolean }).truncated).toBe(true);
  });

  it('masks an account number reported by bank-core and leaves a prefixed id alone', () => {
    const result = redactEventData('bank.op', {
      operation: 'transfer.confirm',
      account_id: 'acc_9f3a2b7c',
      card_id: '4111111111111111',
      latency_ms: 3,
      ok: true,
    });
    expect(result.data.account_id).toBe('acc_9f3a2b7c');
    expect(result.data.card_id).toBe('****1111');
    expect(maskToLastFour('4111-1111-1111-1111')).toBe('****1111');
  });

  it('hashes a plaintext pairing code that reached the emitter by mistake', () => {
    const result = redactEventData('xray.pairing.created', {
      code: 'BANK-7Q2F-K3MZ-8A',
      login_id: 'lgn_abc123',
      expires_at: '2026-09-09T14:00:00.000Z',
    });
    expect(result.data.code).toBe(shortHash('BANK-7Q2F-K3MZ-8A'));
    expect(result.data.code).not.toContain('BANK-');
  });

  it('survives a circular payload instead of throwing', () => {
    const circular: Record<string, unknown> = { operation: 'accounts.list', latency_ms: 1, ok: true };
    circular.self = circular;
    expect(() => redactEventData('bank.op', circular)).not.toThrow();
  });
});

describe('observer mode (section 3: stricter for the admin token)', () => {
  it('hides arguments entirely and cuts the rationale to 80 characters', () => {
    const rationale = 'A'.repeat(200);
    const started = event('tool.call.started', {
      tool: 'load_transactions',
      arguments: { account_id: 'acc_9f3a2b7c', limit: 50 },
      rationale,
      rationale_present: true,
    });
    const observed = applyObserverRedaction(started);
    if (observed.type !== 'tool.call.started') throw new Error('type changed');
    expect(observed.data.arguments).toEqual({});
    expect(observed.data.redacted_fields).toContain('arguments');
    expect((observed.data.rationale ?? '').startsWith('A'.repeat(OBSERVER_RATIONALE_PREVIEW_CHARS))).toBe(
      true,
    );
    expect((observed.data.rationale ?? '').length).toBeLessThan(rationale.length);
    expect(observed.data.rationale_truncated).toBe(true);

    // The stored event is untouched: the owner of the login still sees everything.
    if (started.type !== 'tool.call.started') throw new Error('type changed');
    expect(started.data.arguments).toEqual({ account_id: 'acc_9f3a2b7c', limit: 50 });
    expect(started.data.rationale).toBe(rationale);
  });

  it('cuts a declared intent to the same 80 characters', () => {
    const declared = event('intent.declared', {
      text: 'B'.repeat(300),
      source: 'rationale',
      model_authored: true,
      tool: 'load_cards',
    });
    const observed = applyObserverRedaction(declared);
    if (observed.type !== 'intent.declared') throw new Error('type changed');
    expect(observed.data.text.length).toBeLessThan(300);
    expect(observed.data.truncated).toBe(true);
  });

  it('leaves an event with no arguments and no rationale unchanged', () => {
    const sql = event('sql.query', {
      sql: 'SELECT category, SUM(amount_cents) FROM transactions GROUP BY 1',
      rows_returned: 7,
      duration_ms: 3,
    });
    expect(applyObserverRedaction(sql)).toBe(sql);
  });
});

describe('near-miss key names and the per-event byte budget', () => {
  it('redacts a key that merely CONTAINS a sensitive fragment', () => {
    // `SENSITIVE_KEYS` is an exact match, so these carried their value verbatim into the log.
    const { data } = redactEventData('tool.call.started', {
      tool: 'execute_query',
      arguments: {
        token_value: 'sk-live-abcdefghijklmnop',
        refresh_token_2: 'rt-abcdefghijklmnop',
        my_api_key: 'ak-abcdefghijklmnop',
        code_verifier_backup: 'cv-abcdefghijklmnop',
        stripe_secret: 'ss-abcdefghijklmnop',
      },
    });
    const args = data.arguments as Record<string, unknown>;
    for (const key of Object.keys(args)) {
      expect(args[key]).toBe(REDACTED_PLACEHOLDER);
    }
  });

  it('keeps the OAuth metadata fields that only look sensitive', () => {
    // `token_endpoint_auth_method` is the string "none"; the client panel displays it.
    const { data } = redactEventData('auth.client.registered', {
      client_id: 'cli_1',
      token_endpoint_auth_method: 'none',
    });
    expect(data.token_endpoint_auth_method).toBe('none');
  });

  it('caps one event at MAX_EVENT_CHARS however many fields it has', () => {
    // Every string here is inside MAX_STRING_CHARS and there are fewer than MAX_OBJECT_KEYS of
    // them, yet the payload is 3.3 MB: the per-dimension caps multiply.
    const args: Record<string, string> = {};
    for (let index = 0; index < 200; index += 1) {
      args[`field_${index}`] = `${index}`.padEnd(MAX_STRING_CHARS - 14, 'x');
    }
    const raw = JSON.stringify(args).length;
    expect(raw).toBeGreaterThan(3_000_000);

    const { data, redacted_fields } = redactEventData('tool.call.started', {
      tool: 'execute_query',
      arguments: args,
      rationale: 'the user asked for everything',
    });
    const stored = JSON.stringify(data).length;
    expect(stored).toBeLessThan(MAX_EVENT_CHARS * 3);
    expect(redacted_fields.length).toBeGreaterThan(0);
    // The rationale is the product and is never squeezed out by the arguments.
    expect(data.rationale).toBe('the user asked for everything');
  });
});

describe('cycle guard (ancestor-scoped: a shared sub-object is walked, only a real cycle is marked)', () => {
  it('keeps one object referenced from 17 sibling entries intact in all 17 places', () => {
    // The published catalog shares one `rationale` property object across every schema, so a
    // guard that never forgets a visited object would store 16 of 17 copies as "[circular]" and
    // record nothing in redacted_fields: silently corrupted observability (invariant 13).
    const shared = {
      type: 'string',
      description: 'Why the model is calling this tool',
      minLength: 1,
    };
    const tools = Array.from({ length: 17 }, (_unused, index) => ({
      name: `tool_${index}`,
      schema: { type: 'object', properties: { rationale: shared } },
    }));
    const { data, redacted_fields } = redactEventData('catalog.tools_listed', {
      count: 17,
      content_hash: 'sha256:a1b2c3d4e5f60718',
      tools,
    });
    const stored = data.tools as { schema: { properties: { rationale: unknown } } }[];
    expect(stored).toHaveLength(17);
    for (const row of stored) expect(row.schema.properties.rationale).toEqual(shared);
    expect(JSON.stringify(data)).not.toContain('[circular]');
    expect(redacted_fields).toEqual([]);
  });

  it('marks a self-referencing object as [circular] exactly where the cycle closes', () => {
    // Below the root on purpose: `redactEventData` shallow-copies the root object, so a cycle
    // through the root itself closes one level lower than the original reference.
    const node: Record<string, unknown> = { id: 'n1' };
    const child: Record<string, unknown> = { note: 'child', parent: node };
    node.self = node;
    node.child = child;
    // The same leaf under two siblings is not a cycle and must survive both times.
    const leaf = { tag: 'leaf' };
    node.left = leaf;
    node.right = leaf;

    const { data } = redactEventData('bank.op', {
      operation: 'accounts.list',
      latency_ms: 1,
      ok: true,
      node,
    });
    const stored = data.node as Record<string, unknown>;
    expect(stored.id).toBe('n1');
    expect(stored.self).toBe('[circular]');
    expect((stored.child as Record<string, unknown>).parent).toBe('[circular]');
    expect((stored.child as Record<string, unknown>).note).toBe('child');
    expect(stored.left).toEqual(leaf);
    expect(stored.right).toEqual(leaf);
    expect(data.operation).toBe('accounts.list');
  });

  it('carries every published descriptor of the real catalog through one listing payload', () => {
    // The case the dashboard redesign depends on: `catalog.tools_listed` rows with a `descriptor`
    // built from the frozen catalog must survive the walk byte for byte (the dashboard re-hashes
    // `inputSchema` against `input_schema_hash`) and fit MAX_EVENT_CHARS in one event.
    const rows = TOOL_CATALOG.map((entry) => ({
      name: entry.name,
      title: entry.title,
      read_only: entry.annotations.readOnlyHint === true,
      destructive: entry.annotations.destructiveHint === true,
      idempotent: entry.annotations.idempotentHint,
      scopes: [...entry.requiredScopes],
      input_schema_hash: 'sha256:a1b2c3d4e5f60718',
      descriptor: {
        description: entry.description,
        inputSchema: entry.publishedInputSchema,
        annotations: entry.annotations,
        _meta: {},
      },
    }));
    expect(rows.length).toBeGreaterThanOrEqual(17);

    const { data, redacted_fields } = redactEventData('catalog.tools_listed', {
      count: rows.length,
      content_hash: 'sha256:a1b2c3d4e5f60718',
      snapshot_ref: null,
      tools: rows,
      availability: [],
      feature_flags: [],
    });
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('[circular]');
    expect(serialised).not.toMatch(/\[event size limit\]|\[depth limit\]|\[truncated\]/);
    expect(serialised.length).toBeLessThan(MAX_EVENT_CHARS);
    expect(redacted_fields).toEqual([]);
    const stored = data.tools as { name: string; descriptor: unknown }[];
    expect(stored.map((row) => row.name)).toEqual(rows.map((row) => row.name));
    for (const [index, row] of stored.entries()) {
      expect(row.descriptor).toEqual(rows[index]?.descriptor);
    }
  });
});
