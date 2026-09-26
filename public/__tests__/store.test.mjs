/**
 * The timeline reducer (block: dashboard).
 *
 * `public/store.js` is what every panel reads, so this is the test that matters most: it folds
 * the recorded 200-event session and asserts the read model the panels expect - sessions grouped
 * by login and grant, calls with their nested work, the catalog snapshot, the counters and the
 * behaviour on an overlapping `Last-Event-ID` replay.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PENDING_HTTP, createStore, insertSorted } from '../store.js';
import { callKeyOf, statusOf, summaryOf } from '../catalogue.js';
import { joinCatalog } from '../panel-possibility.js';
import { loadFixture, storeFromFixture } from './helpers.mjs';

describe('the event reducer', () => {
  it('applies every fixture event and knows of no unknown type', () => {
    const store = storeFromFixture();
    expect(store.size).toBe(200);
    expect(store.lastEventId).toBe(200);
    expect(store.getUnknownTypes()).toEqual([]);
    expect(store.getCounters().unknown).toBe(0);
  });

  it('keeps events and calls chronological when a backfill delivers sessions newest first', () => {
    // `backfillHistory` reads the newest session before the older ones, then the SSE replay
    // arrives; the store must fold that to the same state as the recording in order.
    const events = loadFixture();
    const late = events.filter((event) => event.id >= 120);
    const early = events.filter((event) => event.id < 120);
    const shuffled = createStore();
    for (const event of late) shuffled.apply(event);
    for (const event of early) shuffled.apply(event);
    const ordered = storeFromFixture();

    const ids = shuffled.getEvents().map((event) => event.id);
    expect(ids).toEqual(events.map((event) => event.id));
    expect(shuffled.getEvents({ xs: 'xs_3f1c9a' }).map((event) => event.id)).toEqual(
      ordered.getEvents({ xs: 'xs_3f1c9a' }).map((event) => event.id),
    );

    const starts = shuffled.getCalls().map((call) => call.event_id);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(shuffled.getCalls()).toEqual(ordered.getCalls());
    expect(shuffled.getSessions()).toEqual(ordered.getSessions());
    expect(shuffled.getLoginGroups()).toEqual(ordered.getLoginGroups());
    expect(shuffled.getGrant('grt_8a1e33')).toEqual(ordered.getGrant('grt_8a1e33'));
    expect(shuffled.getBoots()).toEqual(ordered.getBoots());
    expect(shuffled.getCounters()).toEqual(ordered.getCounters());
    expect(shuffled.getToolStats()).toEqual(ordered.getToolStats());
    expect(shuffled.lastEventId).toBe(200);
    expect(shuffled.lastEventTs).toBe(ordered.lastEventTs);
    expect(shuffled.state.firstEventTs).toBe(ordered.state.firstEventTs);
  });

  it('inserts by key with an O(1) append for the live stream', () => {
    const list = [];
    for (const value of [5, 9, 2, 9, 1, 12]) insertSorted(list, value, (item) => item);
    expect(list).toEqual([1, 2, 5, 9, 9, 12]);
  });

  it('is idempotent across an overlapping replay', () => {
    const store = storeFromFixture();
    const before = {
      size: store.size,
      calls: store.getCalls().length,
      sessions: store.getSessions().length,
      counters: store.getCounters(),
    };
    for (const event of loadFixture()) store.apply(event);
    expect(store.size).toBe(before.size);
    expect(store.getCalls().length).toBe(before.calls);
    expect(store.getSessions().length).toBe(before.sessions);
    expect(store.getCounters().calls).toBe(before.counters.calls);
    expect(store.getCounters().duplicates).toBe(200);
  });

  it('segments the run into two X-ray sessions with the counters the panel shows', () => {
    const store = storeFromFixture();
    const sessions = store.getSessions();
    expect(sessions.map((session) => session.xs)).toEqual(['xs_7b4d10', 'xs_3f1c9a']);

    const first = store.getSession('xs_3f1c9a');
    expect(first.call_count).toBe(20);
    expect(first.error_count).toBe(6);
    expect(first.initialize_count).toBe(3);
    expect(first.ended).toBe(true);
    expect(first.end_reason).toBe('server_stopping');
    expect(first.protocol_version).toBe('2025-11-25');
    expect(first.era).toBe('legacy');
    expect(first.client.name).toBe('Anthropic');

    const second = store.getSession('xs_7b4d10');
    expect(second.call_count).toBe(4);
    expect(second.error_count).toBe(0);
    expect(second.ended).toBe(false);
  });

  it('marks the restart: the two sessions ran under different server boots', () => {
    const store = storeFromFixture();
    const boots = store.getBoots().map((boot) => boot.boot_id);
    expect(boots).toEqual(['boot_9f2a1c40', 'boot_4e7b2811']);
    expect(store.getSession('xs_3f1c9a').boot_id).toBe('boot_9f2a1c40');
    expect(store.getSession('xs_7b4d10').boot_id).toBe('boot_4e7b2811');
  });

  it('keeps both sessions under one login and one grant (ADR-14)', () => {
    const store = storeFromFixture();
    const groups = store.getLoginGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].login_id).toBe('lgn_5d2c7a');
    expect(groups[0].shared_persona).toBe(true);
    expect(groups[0].grants).toHaveLength(1);
    expect(groups[0].grants[0].grant_id).toBe('grt_8a1e33');
    expect(groups[0].grants[0].sessions.map((session) => session.xs).sort()).toEqual([
      'xs_3f1c9a',
      'xs_7b4d10',
    ]);
  });

  it('records the step-up as a widening of the same grant, not a new one', () => {
    const store = storeFromFixture();
    const grant = store.getGrant('grt_8a1e33');
    expect(grant.parent_grant_id).toBeNull();
    expect(grant.added_scopes).toEqual(['cards:write', 'transfers:write']);
    expect(grant.auth_level).toBe('read_write');
    expect(grant.scopes).toContain('transfers:write');
  });

  it('separates the grant expiry from the access-token expiry', () => {
    const store = storeFromFixture();
    const grant = store.getGrant('grt_8a1e33');
    expect(grant.expires_at).toBe('2026-09-15T14:00:14.000Z');
    expect(grant.token_expires_at).toBe('2026-09-08T17:10:00.000Z');
  });

  it('nests the bank, ETL, SQL and intent events under the call that caused them', () => {
    const store = storeFromFixture();
    const call = store.getCall('xs_3f1c9a#5');
    expect(call.tool).toBe('load_transactions');
    expect(call.status).toBe('ok');
    expect(call.rationale_present).toBe(true);
    expect(call.rationale).toMatch(/where their money went last month/);
    expect(call.required_scopes).toEqual(['transactions:read']);
    expect(call.budget_ms).toBe(300_000);
    const children = call.child_event_ids.map((id) => store.getEventById(id).type);
    expect(children).toEqual(['intent.declared', 'bank.op', 'etl.load']);
  });

  it('keeps a denied call as a call, with the scopes that were missing', () => {
    const store = storeFromFixture();
    const denied = store.getCalls().filter((call) => call.status === 'denied');
    expect(denied.map((call) => call.tool)).toEqual(['create_transfer', 'execute_query']);
    expect(denied[0].missing_scopes).toEqual(['cards:write', 'transfers:write']);
    expect(denied[0].denied_reason).toBe('insufficient_scope');
  });

  it('gives a call the gate refused before it started the HTTP row that carried it', () => {
    // Neither denial has a `tool.call.started`: `tool.call.denied` opens the call, so it must claim
    // the parked `http.request` itself or the 403 and the 429 never reach the page.
    const store = storeFromFixture();
    expect(store.getCall('xs_3f1c9a#14').http).toMatchObject({ event_id: 76, status: 403 });
    expect(store.getCall('xs_3f1c9a#28').http).toMatchObject({ event_id: 159, status: 429 });
    expect(store.state.pendingHttp.has('xs_3f1c9a#14')).toBe(false);
    expect(store.state.pendingHttp.has('xs_3f1c9a#28')).toBe(false);
  });

  it('carries the failure of a timed-out query all the way to the call', () => {
    const store = storeFromFixture();
    // `describeScratchError` words the timeout for the model (src/tools/errors.ts).
    const call = store.getCalls().find((candidate) => candidate.error?.message?.includes('ran longer than the 2000 ms budget'));
    expect(call.tool).toBe('execute_query');
    expect(call.status).toBe('error');
    expect(call.error.class).toBe('tool');
    const children = call.child_event_ids.map((id) => store.getEventById(id).type);
    expect(children).toContain('sql.rejected');
    expect(children).toContain('etl.worker_terminated');
  });

  it('reports a call with no completion as in flight', () => {
    const store = storeFromFixture();
    expect(store.getInFlightCalls()).toHaveLength(0);
    store.apply({
      id: 5000,
      ts: '2026-09-08T14:09:00.000Z',
      v: 1,
      xs: 'xs_7b4d10',
      login_id: 'lgn_5d2c7a',
      grant_id: 'grt_8a1e33',
      persona_id: 'per_a1b2',
      seq: 99,
      request_id: '99',
      era: 'legacy',
      client: null,
      protocol_version: '2025-11-25',
      trace_id: null,
      type: 'tool.call.started',
      data: {
        tool: 'execute_query',
        arguments: {},
        redacted_fields: [],
        rationale: null,
        rationale_present: false,
        rationale_truncated: false,
        meta: null,
        required_scopes: [],
        budget_ms: 300_000,
      },
    });
    const inFlight = store.getInFlightCalls();
    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].tool).toBe('execute_query');
    expect(inFlight[0].status).toBe('running');
  });

  it('keeps the latest catalog snapshot and reuses it when the server only sends a hash', () => {
    const store = storeFromFixture();
    const catalog = store.getCatalog('xs_3f1c9a');
    expect(catalog.tools).toHaveLength(17);
    expect(catalog.availability).toHaveLength(17);
    expect(catalog.feature_flags).toEqual(['writes', 'transfers']);
    // Event 73 repeats the hash with `tools: null`; the tool array survives it.
    expect(catalog.repeated).toBe(true);
    expect(catalog.content_hash).toMatch(/^sha256:/);
  });

  it('computes per-tool percentiles in the browser', () => {
    const store = storeFromFixture();
    const stats = store.getToolStats();
    const query = stats.find((row) => row.tool === 'execute_query');
    expect(query.calls).toBe(7);
    expect(query.errors).toBe(3);
    expect(query.p50).toBeLessThan(query.p95);
    expect(query.max).toBe(2028);
  });

  it('counts what the header and the health panel display', () => {
    const store = storeFromFixture();
    const counters = store.getCounters();
    expect(counters.calls).toBe(24);
    expect(counters.failed_calls).toBe(6);
    expect(counters.protocol_errors).toBe(1);
    expect(counters.queries).toBe(4);
    expect(counters.rejected_sql).toBe(2);
    expect(counters.tables_loaded).toBe(4);
    expect(counters.dropped_events).toBe(37);
    expect(counters.initializes).toBe(4);
  });

  it('merges sessions the API knows about but the replay window does not', () => {
    const store = createStore();
    store.mergeServerSessions([
      {
        xs: 'xs_older',
        login_id: 'lgn_5d2c7a',
        grant_id: 'grt_8a1e33',
        parent_grant_id: null,
        persona: { id: 'per_a1b2', name: 'Ava Bennett', kind: 'retail', shared: true },
        client: { name: 'Claude', version: '1.0.0', title: null },
        protocol_version: '2025-11-25',
        era: 'legacy',
        started_at: '2026-09-08T13:00:00.000Z',
        last_seen_at: '2026-09-08T13:10:00.000Z',
        initialize_count: 2,
        call_count: 9,
        error_count: 1,
        token_expires_at: null,
        boot_id: 'boot_older',
      },
    ]);
    const session = store.getSession('xs_older');
    expect(session.call_count).toBe(9);
    expect(session.source).toBe('api');
    expect(store.getLoginGroups()[0].login_id).toBe('lgn_5d2c7a');
  });

  it('survives an event type it has never heard of and counts it as unknown', () => {
    const store = storeFromFixture();
    const unknown = {
      id: 9001,
      ts: '2026-09-08T14:10:00.000Z',
      v: 1,
      xs: 'xs_7b4d10',
      login_id: 'lgn_5d2c7a',
      grant_id: 'grt_8a1e33',
      persona_id: 'per_a1b2',
      seq: 100,
      request_id: null,
      era: null,
      client: null,
      protocol_version: null,
      trace_id: null,
      type: 'ledger.posting.created',
      data: { amount_cents: 1234, currency: 'USD' },
    };
    expect(() => store.apply(unknown)).not.toThrow();
    expect(store.getUnknownTypes()).toEqual([{ type: 'ledger.posting.created', count: 1 }]);
    expect(callKeyOf(unknown)).toBeNull();
    expect(statusOf(unknown)).toBe('info');
    expect(summaryOf(unknown)).toMatch(/newer than the dashboard/);
    expect(store.getEventById(9001)).toBe(unknown);
  });
});

describe('the session call count is not double-counted', () => {
  it('reports the same total whether or not /xray/api/sessions was merged first', () => {
    // `/xray/api/sessions` counts the same `tool.call.started` events the backfill then folds, so
    // adding the two reported 9 calls as 18 on a real session.
    const events = loadFixture();
    const xs = events.find((event) => event.xs)?.xs;
    const started = events.filter((event) => event.xs === xs && event.type === 'tool.call.started').length;
    const failed = events.filter(
      (event) => event.xs === xs && event.type === 'tool.call.completed' && event.data?.is_error,
    ).length;
    expect(started).toBeGreaterThan(0);

    const foldOnly = createStore();
    for (const event of events) foldOnly.apply(event);
    expect(foldOnly.getSession(xs).call_count).toBe(started);

    const serverFirst = createStore();
    serverFirst.mergeServerSessions([
      { xs, login_id: null, grant_id: null, started_at: events[0].ts, last_seen_at: events[0].ts,
        call_count: started, error_count: failed, initialize_count: 1 },
    ]);
    for (const event of events) serverFirst.apply(event);
    expect(serverFirst.getSession(xs).call_count).toBe(started);
    expect(serverFirst.getSession(xs).error_count).toBe(foldOnly.getSession(xs).error_count);
  });

  it('keeps the server total for a session whose events were never backfilled', () => {
    const store = createStore();
    store.mergeServerSessions([
      { xs: 'xs_old00001', login_id: 'lgn_x', grant_id: 'grt_x', started_at: '2026-09-01T00:00:00.000Z',
        last_seen_at: '2026-09-01T00:10:00.000Z', call_count: 42, error_count: 3, initialize_count: 1 },
    ]);
    expect(store.getSession('xs_old00001').call_count).toBe(42);
    expect(store.getSession('xs_old00001').error_count).toBe(3);
  });
});

describe('clearing the page', () => {
  it('forgets everything folded but keeps the SSE cursor', () => {
    const store = storeFromFixture();
    const lastId = store.lastEventId;
    expect(store.size).toBe(200);
    expect(store.getCalls({}).length).toBeGreaterThan(0);

    store.clear();

    expect(store.size).toBe(0);
    expect(store.getEvents({})).toEqual([]);
    expect(store.getCalls({})).toEqual([]);
    expect(store.getSessions()).toEqual([]);
    expect(store.getLoginGroups()).toEqual([]);
    expect(store.getBoots()).toEqual([]);
    expect(store.getToolNames()).toEqual([]);
    expect(store.getCatalog('xs_3f1c9a')).toBe(null);
    expect(store.getEventById(60)).toBe(null);
    const counters = store.getCounters();
    expect(counters.events).toBe(0);
    expect(counters.calls).toBe(0);
    expect(counters.errors).toBe(0);
    // The cursor survives, or the next reconnect replays exactly what was just hidden.
    expect(store.lastEventId).toBe(lastId);
  });

  it('still folds new events after a clear', () => {
    const store = storeFromFixture();
    const events = loadFixture();
    store.clear();
    for (const event of events.slice(-5)) store.apply(event);
    expect(store.size).toBe(5);
  });
});

describe('what a call keeps beside its arguments', () => {
  const envelope = (overrides) => ({
    id: 9100,
    ts: '2026-09-08T14:10:00.000Z',
    v: 1,
    xs: 'xs_7b4d10',
    login_id: 'lgn_5d2c7a',
    grant_id: 'grt_8a1e33',
    persona_id: 'per_a1b2',
    seq: 400,
    request_id: '400',
    era: 'legacy',
    client: null,
    protocol_version: '2025-11-25',
    trace_id: null,
    ...overrides,
  });
  const started = (overrides, data = {}) =>
    envelope({
      type: 'tool.call.started',
      data: {
        tool: 'execute_query',
        arguments: {},
        redacted_fields: [],
        rationale: null,
        rationale_present: false,
        rationale_truncated: false,
        meta: null,
        required_scopes: [],
        budget_ms: 300_000,
        ...data,
      },
      ...overrides,
    });
  const fixtureEvent = (id) => loadFixture().find((event) => event.id === id);

  it('keeps the started-event rationale after intent.declared and records the declared copy beside it', () => {
    // The started event keeps up to 8,192 characters of the rationale; the gate's `intent.declared`
    // keeps 1,024. Both are recorded, neither overwrites the other.
    const long = 'Total the card spend by merchant for August, largest first. '.repeat(20).slice(0, 1100);
    expect(long).toHaveLength(1100);
    const store = createStore();
    store.apply(started({ id: 9101 }, { arguments: { rationale: long }, rationale: long, rationale_present: true }));
    store.apply(
      envelope({
        id: 9102,
        type: 'intent.declared',
        data: { text: long.slice(0, 1024), source: 'rationale', model_authored: true, tool: 'execute_query', truncated: true },
      }),
    );
    const call = store.getCall('xs_7b4d10#400');
    expect(call.rationale).toBe(long);
    expect(call.rationale_truncated).toBe(false);
    expect(call.rationale_declared).toBe(long.slice(0, 1024));
    expect(call.rationale_declared_truncated).toBe(true);
    expect(call.rationale_present).toBe(true);
    expect(call.child_event_ids).toEqual([9102]);

    // A declaration still marks the rationale present, but never invents the started-event copy.
    const bare = createStore();
    bare.apply(started({ id: 9103, request_id: '401' }));
    bare.apply(envelope({ id: 9104, request_id: '401', type: 'intent.declared', data: { text: 'late', truncated: false } }));
    expect(bare.getCall('xs_7b4d10#401')).toMatchObject({ rationale: null, rationale_present: true, rationale_declared: 'late' });

    // Over the recording the two copies read the same, and the inspector's copy is the started one.
    const fixture = storeFromFixture();
    const load = fixture.getCall('xs_3f1c9a#5');
    const declared = load.child_event_ids.map((id) => fixture.getEventById(id)).find((event) => event.type === 'intent.declared');
    expect(load.rationale).toBe(fixture.getEventById(load.event_id).data.rationale);
    expect(load.rationale_declared).toBe(declared.data.text);
    expect(load.rationale_declared_truncated).toBe(false);
  });

  it('attaches an http.request to its call by JSON-RPC id in either arrival order and never as a child', () => {
    const http = envelope({
      id: 9111,
      request_id: '401',
      type: 'http.request',
      data: {
        method: 'POST',
        path: '/mcp',
        status: 200,
        duration_ms: 12,
        user_agent: 'Claude-User/1.0 (+https://claude.ai)',
        remote_ip_prefix: '160.79.104.0/24',
        anthropic_egress: true,
        origin: null,
        origin_decision: 'absent',
        mcp_protocol_version_header: '2025-11-25',
        mcp_session_id: null,
        has_authorization: true,
        content_type: 'application/json',
        sse: false,
        rate_limited: false,
      },
    });
    const call = started({ id: 9110, request_id: '401' });
    const facts = { event_id: 9111, status: 200, duration_ms: 12 };

    const callFirst = createStore();
    callFirst.apply(call);
    callFirst.apply(http);
    expect(callFirst.getCall('xs_7b4d10#401').http).toEqual(facts);
    expect(callFirst.getCall('xs_7b4d10#401').child_event_ids).toEqual([]);

    const httpFirst = createStore();
    httpFirst.apply(http);
    expect(httpFirst.state.pendingHttp.size).toBe(1);
    httpFirst.apply(call);
    expect(httpFirst.getCall('xs_7b4d10#401').http).toEqual(facts);
    expect(httpFirst.getCall('xs_7b4d10#401').child_event_ids).toEqual([]);
    expect(httpFirst.state.pendingHttp.size).toBe(0);
    expect(httpFirst.getCounters().http_requests).toBe(1);

    // The waiting room is bounded: the oldest parked row leaves first.
    const crowded = createStore();
    for (let index = 0; index < MAX_PENDING_HTTP + 1; index += 1) {
      crowded.apply({ ...http, id: 20_000 + index, request_id: `r${index}` });
    }
    expect(crowded.state.pendingHttp.size).toBe(MAX_PENDING_HTTP);
    expect(crowded.state.pendingHttp.has('xs_7b4d10#r0')).toBe(false);
    // A row with no JSON-RPC id (a notification, a well-known lookup) is counted and nothing more.
    crowded.apply({ ...http, id: 30_000, request_id: null });
    expect(crowded.state.pendingHttp.size).toBe(MAX_PENDING_HTTP);
    expect(callKeyOf({ ...http, request_id: null })).toBeNull();
  });

  it('resolves a hash-only listing of a new session of the same grant by content_hash', () => {
    const store = storeFromFixture();
    const hash = 'sha256:1c9f4b6d2ae08357';
    const full = loadFixture().filter((event) => event.type === 'catalog.tools_listed' && event.data.tools?.length);
    const latest = full.at(-1);
    expect(store.getCatalogByHash(hash)).toMatchObject({ event_id: latest.id, xs: latest.xs });
    expect(store.getCatalogByHash(hash).tools).toBe(store.getEventById(latest.id).data.tools);
    expect(store.getCatalogByHash('sha256:nobody')).toBeNull();

    // Event 73 re-lists the hash with `tools: null`; here a third session of the grant does the same.
    const relisted = fixtureEvent(73);
    store.apply({ ...relisted, id: 9120, xs: 'xs_new', seq: 1, data: { ...relisted.data, snapshot_ref: null } });
    const catalog = store.getCatalog('xs_new');
    expect(catalog.resolved_from).toBe('hash');
    expect(catalog.event_id).toBe(latest.id);
    expect(catalog.tools).toHaveLength(17);
    // The entries are the recorded ones, untouched: whatever a listing carries per tool survives.
    expect(catalog.tools).toBe(store.getCatalogByHash(hash).tools);
    expect(catalog.repeated).toBe(true);
    expect(catalog.availability).toHaveLength(17);
    // Which is what lets Possibility space show annotations instead of "annotations unknown".
    expect(joinCatalog(catalog).every((row) => row.tool_meta)).toBe(true);
    expect(store.getCatalog('xs_3f1c9a').resolved_from).toBe('hash');
  });

  it('resolves snapshot_ref across sessions', () => {
    const store = storeFromFixture();
    const relisted = fixtureEvent(88);
    const unknownHash = 'sha256:0000000000000000';
    store.apply({ ...relisted, id: 9130, xs: 'xs_new', seq: 1, data: { ...relisted.data, content_hash: unknownHash, snapshot_ref: 21 } });
    const catalog = store.getCatalog('xs_new');
    expect(catalog.resolved_from).toBe('snapshot_ref');
    expect(catalog.event_id).toBe(21);
    expect(catalog.tools).toBe(store.getEventById(21).data.tools);
    expect(catalog.content_hash).toBe(unknownHash);
    expect(store.getCatalogByHash(unknownHash)).toBeNull();

    // A reference to a listing this page never saw resolves to nothing, not to a guess.
    const cold = createStore();
    cold.apply({ ...relisted, id: 9131, xs: 'xs_new', seq: 1, data: { ...relisted.data, content_hash: unknownHash, snapshot_ref: 21 } });
    expect(cold.getCatalog('xs_new')).toMatchObject({ resolved_from: 'none', tools: [], event_id: 9131 });
    // The session's own previous catalog is the last resort.
    cold.apply({ ...fixtureEvent(21), id: 9132, xs: 'xs_new', seq: 2 });
    expect(cold.getCatalog('xs_new')).toMatchObject({ resolved_from: 'event', event_id: 9132 });
    cold.apply({ ...relisted, id: 9133, xs: 'xs_new', seq: 3, data: { ...relisted.data, content_hash: 'sha256:1111111111111111', snapshot_ref: null } });
    expect(cold.getCatalog('xs_new')).toMatchObject({ resolved_from: 'previous', event_id: 9132 });
    expect(cold.getCatalog('xs_new').tools).toHaveLength(17);
  });

  it('nests intent.inferred under the call when it carries a request_id', () => {
    const store = storeFromFixture();
    const inferred = loadFixture().find((event) => event.type === 'intent.inferred');
    // The recording (contracts v0.5) carries the id of the call that closed the sequence, as
    // src/tools/registry.ts emits it: clear_table #10, and no other call.
    expect(inferred.request_id).toBe('10');
    expect(store.getCall('xs_3f1c9a#10').child_event_ids).toContain(inferred.id);
    expect(store.getCall('xs_3f1c9a#9').child_event_ids).not.toContain(inferred.id);
    expect(store.getSession('xs_3f1c9a').inferred_workflow).toMatchObject({ workflow: 'spend_analysis', confidence: 0.85 });

    store.apply({ ...inferred, id: 9140, request_id: '9', data: { ...inferred.data, confidence: 0.4 } });
    expect(store.getCall('xs_3f1c9a#9').child_event_ids).toContain(9140);
    expect(store.getSession('xs_3f1c9a').inferred_workflow.confidence).toBe(0.4);
  });

  it('counts a repeated request_id inside one xs', () => {
    // The recording reuses ids 2 to 5 across its two sessions, never inside one.
    expect(storeFromFixture().getCounters().id_collisions).toBe(0);

    const store = createStore();
    store.apply(started({ id: 9150, request_id: '7' }, { tool: 'load_cards' }));
    store.apply(started({ id: 9151, request_id: '7' }, { tool: 'execute_query' }));
    expect(store.getCounters().id_collisions).toBe(1);
    expect(store.getCounters().calls).toBe(2);
    expect(store.getCalls().map((call) => call.tool)).toEqual(['execute_query']);
    expect(store.getCall('xs_7b4d10#7').event_id).toBe(9151);

    // The older start arriving second does not take the key back.
    const reversed = createStore();
    reversed.apply(started({ id: 9151, request_id: '7' }, { tool: 'execute_query' }));
    reversed.apply(started({ id: 9150, request_id: '7' }, { tool: 'load_cards' }));
    expect(reversed.getCounters().id_collisions).toBe(1);
    expect(reversed.getCalls().map((call) => call.event_id)).toEqual([9151]);
    expect(reversed.state.callOrder).toEqual(['xs_7b4d10#7']);
  });
});
