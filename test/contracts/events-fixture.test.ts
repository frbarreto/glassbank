/**
 * Every line of `test/fixtures/events.jsonl` must validate against the event contract, and the
 * fixture must actually contain the session described in docs/XRAY_EVENT_MODEL.md section 8.
 *
 * The fixture drives the dashboard's `?fixture=1` mode, so a break here is a break in the demo.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { XrayEvent, XrayEventType } from '../../src/contracts/index.js';
import {
  RESULT_PREVIEW_BYTES,
  TOOL_CATALOG,
  XrayEventSchema,
  dataKeysOf,
  toolErrorText,
} from '../../src/contracts/index.js';
import { RESULT_PREVIEW_TRUNCATION_SUFFIX, catalogRowsOf } from '../../src/mcp/xray.js';

const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/events.jsonl', import.meta.url));
const raw = readFileSync(FIXTURE_PATH, 'utf8');
const lines = raw.split('\n').filter((line) => line.trim() !== '');

/** Parsed once; every test below reads this array. */
const events: XrayEvent[] = lines.map((line, index) => {
  const parsed = XrayEventSchema.safeParse(JSON.parse(line));
  if (!parsed.success) {
    throw new Error(
      `fixture line ${index + 1} does not validate: ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
});

function ofType<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }>[] {
  return events.filter((event): event is Extract<XrayEvent, { type: T }> => event.type === type);
}

describe('test/fixtures/events.jsonl (docs/XRAY_EVENT_MODEL.md section 8)', () => {
  it('is a 200-event session', () => {
    expect(lines).toHaveLength(200);
    expect(events).toHaveLength(200);
  });

  it('every line validates against the event schema', () => {
    // The parse above throws on the first bad line; this asserts the shape survived it.
    for (const event of events) {
      expect(event.v).toBe(1);
      expect(typeof event.type).toBe('string');
      expect(Number.isInteger(event.id)).toBe(true);
      expect(() => new Date(event.ts).toISOString()).not.toThrow();
    }
  });

  it('carries no field name that the contract does not document', () => {
    const offenders: string[] = [];
    for (const line of lines) {
      const parsed = JSON.parse(line) as { type: XrayEventType; data: Record<string, unknown> };
      const allowed = new Set(dataKeysOf(parsed.type));
      for (const key of Object.keys(parsed.data)) {
        if (!allowed.has(key)) offenders.push(`${parsed.type}.data.${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has process-monotonic ids that continue across the restart', () => {
    const ids = events.map((event) => event.id);
    expect(ids[0]).toBe(1);
    for (let index = 1; index < ids.length; index += 1) {
      expect(ids[index]).toBe((ids[index - 1] as number) + 1);
    }
  });

  it('has non-decreasing timestamps', () => {
    for (let index = 1; index < events.length; index += 1) {
      const previous = Date.parse((events[index - 1] as XrayEvent).ts);
      const current = Date.parse((events[index] as XrayEvent).ts);
      expect(current).toBeGreaterThanOrEqual(previous);
    }
  });

  it('numbers seq per xs from 1, and leaves it null outside a session', () => {
    const counters = new Map<string, number>();
    for (const event of events) {
      if (event.xs === null) {
        expect(event.seq).toBeNull();
        continue;
      }
      const expected = (counters.get(event.xs) ?? 0) + 1;
      counters.set(event.xs, expected);
      expect(event.seq).toBe(expected);
    }
    expect([...counters.keys()].sort()).toEqual(['xs_3f1c9a', 'xs_7b4d10']);
  });

  it('never leaks a token, a code or a JWT (redaction rules, section 3)', () => {
    expect(raw).not.toContain('mockbank_user_tok_');
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/"(access_token|refresh_token|code_verifier|authorization)"\s*:/i);
  });

  it('opens with the 401 challenge and the consent that mints the grant', () => {
    const challenge = ofType('auth.challenge')[0];
    expect(challenge?.data.status).toBe(401);
    expect(challenge?.data.scope).toContain('accounts:read');
    expect(challenge?.data.resource_metadata).toContain('/.well-known/oauth-protected-resource');

    const registered = ofType('auth.client.registered')[0];
    expect(registered?.data.redirect_uris).toContain('https://claude.ai/api/mcp/auth_callback');

    const grant = ofType('auth.grant.created')[0];
    expect(grant?.data.auth_level).toBe('read_only');
    expect(grant?.data.scopes).not.toContain('transfers:write');
    expect((challenge as XrayEvent).id).toBeLessThan((grant as XrayEvent).id);
  });

  it('records initialize inside the session, with the reconnect loop counted', () => {
    const initialized = ofType('session.initialized');
    expect(initialized.length).toBeGreaterThanOrEqual(3);
    const inFirstSession = initialized.filter((event) => event.xs === 'xs_3f1c9a');
    expect(inFirstSession.map((event) => event.data.initialize_count)).toEqual([1, 2, 3]);
    // A repeated initialize never opens a second xs (A-27).
    expect(ofType('session.started').filter((event) => event.xs === 'xs_3f1c9a')).toHaveLength(1);
  });

  it('lists the write tools under a read-only grant, marked missing_scopes (ADR-13)', () => {
    const listing = ofType('catalog.tools_listed')[0];
    expect(listing?.data.tools).not.toBeNull();
    expect(listing?.data.count).toBe(17);
    const names = (listing?.data.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('create_transfer');
    expect(names).toContain('lock_or_unlock_card');

    const availability = listing?.data.availability ?? [];
    const transfer = availability.find((row) => row.tool === 'create_transfer');
    expect(transfer).toEqual({
      tool: 'create_transfer',
      listed: true,
      available: false,
      unavailable_reasons: ['missing_scopes'],
      missing_scopes: ['transfers:write'],
    });
    const card = availability.find((row) => row.tool === 'lock_or_unlock_card');
    expect(card?.listed).toBe(true);
    expect(card?.available).toBe(false);
    expect(card?.missing_scopes).toEqual(['cards:write']);
  });

  it('repeats the catalog by reference when the content hash has not changed', () => {
    const listings = ofType('catalog.tools_listed');
    const full = listings.filter((event) => event.data.tools !== null);
    const byReference = listings.filter((event) => event.data.tools === null);
    expect(full.length).toBeGreaterThanOrEqual(1);
    expect(byReference.length).toBeGreaterThanOrEqual(1);
    for (const listing of byReference) {
      expect(listing.data.snapshot_ref).not.toBeNull();
      const referenced = events.find((event) => event.id === listing.data.snapshot_ref);
      expect(referenced?.type).toBe('catalog.tools_listed');
    }
  });

  it('contains a complete load, process, query and clear cycle', () => {
    const load = ofType('etl.load')[0];
    expect(load).toBeDefined();
    const table = (load as Extract<XrayEvent, { type: 'etl.load' }>).data.table;
    const processed = ofType('etl.processed').find((event) => event.data.table === table);
    const queried = ofType('sql.query').find((event) => event.data.table === table);
    const cleared = ofType('sql.table_cleared').find((event) => event.data.table === table);
    expect(processed).toBeDefined();
    expect(queried).toBeDefined();
    expect(cleared).toBeDefined();
    expect((load as XrayEvent).id).toBeLessThan((processed as XrayEvent).id);
    expect((processed as XrayEvent).id).toBeLessThan((queried as XrayEvent).id);
    expect((queried as XrayEvent).id).toBeLessThan((cleared as XrayEvent).id);
    expect(processed?.data.columns_selected.length).toBeGreaterThan(0);
  });

  it('contains a rejected SQL statement and a timed-out one (ADR-9)', () => {
    const rejected = ofType('sql.rejected');
    expect(rejected.map((event) => event.data.rejected_reason)).toContain('denylist');
    expect(rejected.map((event) => event.data.rejected_reason)).toContain('timeout');
    const denied = rejected.find((event) => event.data.rejected_reason === 'denylist');
    expect(denied?.data.sql.toLowerCase()).toContain('attach');
    const timedOut = rejected.find((event) => event.data.rejected_reason === 'timeout');
    expect(timedOut?.data.sql.toLowerCase()).toContain('with recursive');
    expect(ofType('etl.worker_terminated')[0]?.data.reason).toBe('timeout');
  });

  it('shows a 403 step-up followed by auth.grant.updated on the SAME grant (ADR-14)', () => {
    const denied = ofType('tool.call.denied').find(
      (event) => event.data.denied_reason === 'insufficient_scope',
    );
    const stepUp = ofType('auth.stepup.requested')[0];
    const updated = ofType('auth.grant.updated')[0];
    expect(denied?.data.tool).toBe('create_transfer');
    expect(stepUp?.data.scope).toBe('cards:write transfers:write');
    expect(updated).toBeDefined();
    expect(updated?.data.grant_id).toBe(stepUp?.data.grant_id);
    expect(updated?.data.added_scopes).toEqual(['cards:write', 'transfers:write']);
    expect(updated?.data.auth_level).toBe('read_write');
    expect((stepUp as XrayEvent).id).toBeLessThan((updated as XrayEvent).id);
    // No new grant was minted for the step-up.
    expect(ofType('auth.grant.created')).toHaveLength(1);
  });

  it('shows the transfer preview and then the confirmation on the same preview_id', () => {
    const preview = ofType('bank.op').find((event) => event.data.operation === 'transfer.preview');
    const confirm = ofType('bank.op').find((event) => event.data.operation === 'transfer.confirm');
    expect(preview?.data.preview_id).toBeTruthy();
    expect(confirm?.data.preview_id).toBe(preview?.data.preview_id);
    expect(confirm?.data.audit_id).toBeTruthy();
    expect((preview as XrayEvent).id).toBeLessThan((confirm as XrayEvent).id);

    const confirmCall = ofType('tool.call.started').find(
      (event) => event.data.tool === 'create_transfer' && event.data.arguments.confirm === true,
    );
    expect(confirmCall?.data.arguments.expected_total_amount).toBe(128_400);
  });

  it('contains a call that arrived without a rationale (ADR-8)', () => {
    const missing = ofType('intent.missing')[0];
    expect(missing?.data.reason).toBe('absent');
    const started = ofType('tool.call.started').find(
      (event) => event.data.tool === missing?.data.tool && event.data.rationale_present === false,
    );
    expect(started).toBeDefined();
    expect(started?.data.rationale).toBeNull();
    // The call still ran: a completion follows.
    const completed = ofType('tool.call.completed').find(
      (event) => event.id > (started as XrayEvent).id && event.data.tool === missing?.data.tool,
    );
    expect(completed?.data.is_error).toBe(false);
  });

  it('stores every other rationale verbatim and flags it model-authored', () => {
    const declared = ofType('intent.declared');
    expect(declared.length).toBeGreaterThan(10);
    for (const event of declared) {
      expect(event.data.model_authored).toBe(true);
      expect(event.data.source).toBe('rationale');
      expect(event.data.text.length).toBeGreaterThan(10);
      const started = events.find(
        (candidate) =>
          candidate.type === 'tool.call.started' &&
          candidate.id === event.id - 1 &&
          candidate.data.tool === event.data.tool,
      );
      if (started && started.type === 'tool.call.started') {
        expect(started.data.rationale).toBe(event.data.text);
      }
    }
  });

  it('carries a restart marker with a new boot id and a restored cursor (A-15)', () => {
    const starts = ofType('server.started');
    expect(starts).toHaveLength(2);
    const [first, second] = starts;
    expect(first?.data.boot_id).not.toBe(second?.data.boot_id);
    expect(first?.data.restored_max_id).toBeNull();
    expect(second?.data.restored_max_id).toBe((second as XrayEvent).id - 1);
    expect(ofType('server.stopping')[0]?.data.boot_id).toBe(first?.data.boot_id);
    // A new xs opens for the same grant after the restart (section 4).
    const afterRestart = events.filter((event) => event.id > (second as XrayEvent).id);
    expect(afterRestart.some((event) => event.xs === 'xs_7b4d10')).toBe(true);
    expect(
      afterRestart.every((event) => event.grant_id === null || event.grant_id === 'grt_8a1e33'),
    ).toBe(true);
  });

  it('shows the dashboard viewer pairing, a rejection, a drop and a replay', () => {
    expect(ofType('xray.pairing.created')).toHaveLength(1);
    expect(ofType('xray.pairing.rejected')[0]?.data.reason).toBe('unknown_code');
    const connections = ofType('xray.viewer.connected');
    expect(connections).toHaveLength(2);
    expect(connections[0]?.data.last_event_id).toBeNull();
    expect(connections[1]?.data.last_event_id).toBeGreaterThan(0);
    expect(ofType('xray.dropped')[0]?.data.dropped_count).toBeGreaterThan(0);
  });

  it('reduces every remote address to a /24 prefix', () => {
    for (const event of ofType('http.request')) {
      expect(event.data.remote_ip_prefix).toMatch(/^\d+\.\d+\.\d+\.0\/24$/);
    }
  });

  it('pairs every tool call start with a completion or a denial', () => {
    const started = ofType('tool.call.started').length;
    const finished = ofType('tool.call.completed').length + ofType('tool.call.denied').length;
    expect(finished).toBeGreaterThanOrEqual(started);
  });
});

describe('test/fixtures/events.jsonl records what the producers record (contracts v0.5, T7b)', () => {
  const fullListings = ofType('catalog.tools_listed').filter((event) => event.data.tools !== null);

  it('carries the descriptor on the two full listings, 21 and 178, either side of the restart', () => {
    expect(fullListings.map((event) => event.id)).toEqual([21, 178]);
    const restart = ofType('server.started')[1] as XrayEvent;
    expect(restart.id).toBeGreaterThan(21);
    expect(restart.id).toBeLessThan(178);
    for (const listing of fullListings) {
      expect(listing.data.tools).toHaveLength(17);
      for (const tool of listing.data.tools ?? []) expect(tool.descriptor).toBeDefined();
    }
  });

  it('re-hashes every recorded schema to its input_schema_hash, with rationale required (ADR-8)', () => {
    for (const listing of fullListings) {
      for (const tool of listing.data.tools ?? []) {
        const schema = tool.descriptor?.inputSchema as { required?: string[] };
        const digest = createHash('sha256')
          .update(JSON.stringify(schema))
          .digest('hex')
          .slice(0, 16);
        expect(tool.input_schema_hash, tool.name).toBe(digest);
        expect(tool.input_schema_hash).toMatch(/^[0-9a-f]{16}$/);
        expect(schema.required, tool.name).toContain('rationale');
      }
    }
  });

  it('cannot drift from the producer: both listings equal catalogRowsOf(TOOL_CATALOG)', () => {
    const produced = catalogRowsOf(TOOL_CATALOG);
    for (const listing of fullListings) expect(listing.data.tools).toEqual(produced);
  });

  it('stamps every /mcp http.request with the JSON-RPC id of its exchange (src/mcp/index.ts)', () => {
    const rows = ofType('http.request');
    for (const row of rows) {
      if (row.data.path !== '/mcp') {
        expect(row.request_id, `${row.data.method} ${row.data.path} #${row.id}`).toBeNull();
        continue;
      }
      if (row.data.status === 202) {
        // `notifications/initialized` has no id.
        expect(row.request_id).toBeNull();
        continue;
      }
      expect(row.request_id, `/mcp #${row.id}`).not.toBeNull();
      // The exchange is the next non-HTTP event that carries a JSON-RPC id: the call, the listing,
      // the denial, or the `initialize` a 401 was retried as.
      const exchange = events.find(
        (event) => event.id > row.id && event.type !== 'http.request' && event.request_id !== null,
      );
      expect(exchange?.request_id, `/mcp #${row.id}`).toBe(row.request_id);
    }
    const unnumbered = rows.filter((row) => row.data.path === '/mcp' && row.request_id === null);
    expect(unnumbered.map((row) => row.data.status)).toEqual([202]);
    // The gate answers carry theirs too: 401 before auth, 403 step-up, 429, expired token.
    const refused = rows.filter((row) => row.data.path === '/mcp' && row.data.status >= 400);
    expect(refused.map((row) => [row.data.status, row.request_id])).toEqual([
      [401, '0'],
      [403, '14'],
      [429, '28'],
      [401, '0'],
    ]);
  });

  it('nests intent.inferred under the call that closed the sequence (src/tools/registry.ts)', () => {
    const inferred = ofType('intent.inferred');
    expect(inferred.map((event) => [event.id, event.request_id])).toEqual([[63, '10']]);
    const closing = ofType('tool.call.started').find(
      (event) => event.xs === inferred[0]?.xs && event.request_id === '10',
    );
    expect(closing?.data.tool).toBe('clear_table');
  });

  it('keeps exactly one preview cut at 2,048 characters plus the marker, on a successful query', () => {
    const completions = ofType('tool.call.completed');
    const cut = completions.filter((event) =>
      (event.data.text_preview ?? '').endsWith(RESULT_PREVIEW_TRUNCATION_SUFFIX),
    );
    expect(cut).toHaveLength(1);
    const [marked] = cut as [(typeof completions)[number]];
    expect(marked.data.tool).toBe('execute_query');
    expect(marked.data.is_error).toBe(false);
    expect(marked.data.text_preview).toHaveLength(
      RESULT_PREVIEW_BYTES + RESULT_PREVIEW_TRUNCATION_SUFFIX.length,
    );
    expect(marked.data.content_chars).toBeGreaterThan(RESULT_PREVIEW_BYTES);
    expect(marked.data.content_chars).toBeGreaterThanOrEqual(8_400);
    expect(marked.data.content_chars).toBeLessThan(8_500);
    expect(marked.data.text_preview?.startsWith('[{')).toBe(true);
    // The capped query: the handler appends the row-cap sentence to the first 100 rows.
    const query = ofType('sql.query').find(
      (event) => event.xs === marked.xs && event.request_id === marked.request_id,
    );
    expect(query?.data).toMatchObject({ rows_returned: 100, capped: true });
  });

  it('keeps every other preview whole: exactly content_chars long, errors in toolErrorText wording', () => {
    const marker = toolErrorText('');
    const [errorOpening, errorClosing] = marker.split(': . ') as [string, string];
    for (const event of ofType('tool.call.completed')) {
      const preview = event.data.text_preview ?? '';
      if (preview.endsWith(RESULT_PREVIEW_TRUNCATION_SUFFIX)) continue;
      expect(event.data.content_types, `#${event.id}`).toEqual(['text']);
      expect(preview.length, `#${event.id}`).toBe(event.data.content_chars);
      expect(preview.length).toBeLessThanOrEqual(RESULT_PREVIEW_BYTES);
      if (event.data.is_error) {
        expect(preview.startsWith(`${errorOpening}: `), `#${event.id}`).toBe(true);
        expect(preview.endsWith(`. ${errorClosing}`), `#${event.id}`).toBe(true);
        expect(event.data.error?.message).toBe(preview);
      }
    }
  });

  it('returns as many JSON rows as sql.query says it returned', () => {
    for (const query of ofType('sql.query')) {
      const completion = ofType('tool.call.completed').find(
        (event) => event.xs === query.xs && event.request_id === query.request_id,
      );
      const preview = completion?.data.text_preview ?? '';
      if (query.data.capped) continue; // the cut preview is not parseable; checked above
      expect(JSON.parse(preview), `sql.query #${query.id}`).toHaveLength(query.data.rows_returned);
    }
  });
});
