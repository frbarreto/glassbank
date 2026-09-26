/**
 * The read model (docs/XRAY_EVENT_MODEL.md sections 4 and 6).
 *
 * Two things are easy to get wrong and expensive when they are: the visibility predicate, which is
 * the only thing standing between two strangers' sessions, and the catalog snapshot, which
 * claude.ai's reconnect loop sends as a bare `content_hash` most of the time.
 */
import { describe, expect, it } from 'vitest';

import { XrayEventSchema, type XrayEvent, type XrayViewerScope } from '../../contracts/index.js';

import { createReadModel } from '../read-model.js';

let nextId = 1;

function build<T extends XrayEvent['type']>(
  type: T,
  data: unknown,
  correlation: Record<string, unknown> = {},
): XrayEvent {
  const id = nextId;
  nextId += 1;
  return XrayEventSchema.parse({
    id,
    ts: new Date(Date.UTC(2026, 8, 8, 12, 0, id)).toISOString(),
    v: 1,
    type,
    data,
    ...correlation,
  });
}

const CATALOG_TOOL = {
  name: 'load_accounts',
  title: 'Load accounts',
  read_only: true,
  destructive: false,
  idempotent: true,
  scopes: ['accounts:read'],
  input_schema_hash: 'sch_abc',
};

const loginScope = (loginId: string): XrayViewerScope => ({
  viewer_kind: 'pairing',
  filter: 'login',
  login_id: loginId,
  xs: null,
});

describe('visibility', () => {
  it('matches every event of the login, including one that only carries a grant', () => {
    const model = createReadModel();
    model.observe(
      build(
        'auth.grant.created',
        {
          grant_id: 'grt_one0001',
          login_id: 'lgn_one0001',
          persona_id: 'per_one0001',
          scopes: ['accounts:read'],
          auth_level: 'read_only',
          client_id: 'cli_abc',
        },
        { login_id: 'lgn_one0001', grant_id: 'grt_one0001' },
      ),
    );
    const byLogin = build('session.started', { reason: 'first_request' }, {
      xs: 'xs_one00001',
      login_id: 'lgn_one0001',
    });
    // An event the producer could only correlate by grant (the bearer gate before the login is
    // resolved) still belongs to the same viewer.
    const byGrant = build('bank.op', { operation: 'accounts.list', latency_ms: 2, ok: true }, {
      xs: 'xs_one00001',
      grant_id: 'grt_one0001',
    });
    const stranger = build('bank.op', { operation: 'accounts.list', latency_ms: 2, ok: true }, {
      xs: 'xs_two00001',
      login_id: 'lgn_two0001',
    });
    model.observe(byLogin);
    model.observe(byGrant);
    model.observe(stranger);

    expect(model.matchesScope(byLogin, loginScope('lgn_one0001'))).toBe(true);
    expect(model.matchesScope(byGrant, loginScope('lgn_one0001'))).toBe(true);
    expect(model.matchesScope(stranger, loginScope('lgn_one0001'))).toBe(false);
    expect(model.matchesScope(stranger, loginScope('lgn_two0001'))).toBe(true);

    // `all` is the admin filter and `xs` is exact.
    const all: XrayViewerScope = { viewer_kind: 'admin', filter: 'all', login_id: null, xs: null };
    expect(model.matchesScope(stranger, all)).toBe(true);
    const one: XrayViewerScope = {
      viewer_kind: 'pairing',
      filter: 'xs',
      login_id: 'lgn_one0001',
      xs: 'xs_one00001',
    };
    expect(model.matchesScope(byGrant, one)).toBe(true);
    expect(model.matchesScope(stranger, one)).toBe(false);
  });

  it('never matches a login filter with no login', () => {
    const model = createReadModel();
    const event = build('server.started', {
      boot_id: 'boot_x1',
      version: '0.1.0',
    });
    model.observe(event);
    expect(
      model.matchesScope(event, {
        viewer_kind: 'pairing',
        filter: 'login',
        login_id: null,
        xs: null,
      }),
    ).toBe(false);
  });
});

describe('the catalog snapshot', () => {
  it('resolves a hash-only re-list from the event the snapshot_ref points at', () => {
    const log = new Map<number, XrayEvent>();
    const model = createReadModel({ lookupEvent: (id) => log.get(id) ?? null });
    const full = build(
      'catalog.tools_listed',
      {
        count: 1,
        content_hash: 'hash_v1',
        tools: [CATALOG_TOOL],
        availability: [],
        feature_flags: ['writes'],
      },
      { xs: 'xs_cat00001', login_id: 'lgn_cat00001' },
    );
    log.set(full.id, full);
    model.observe(full);

    // claude.ai re-lists every 25-80 s and the array is repeated only when the hash changes.
    const repeat = build(
      'catalog.tools_listed',
      {
        count: 1,
        content_hash: 'hash_v1',
        snapshot_ref: full.id,
        availability: [
          {
            tool: 'create_transfer',
            listed: true,
            available: false,
            unavailable_reasons: ['missing_scopes'],
            missing_scopes: ['transfers:write'],
          },
        ],
        feature_flags: ['writes'],
      },
      { xs: 'xs_cat00002', login_id: 'lgn_cat00001' },
    );
    log.set(repeat.id, repeat);
    model.observe(repeat);

    const snapshot = model.catalog('xs_cat00002');
    expect(snapshot?.content_hash).toBe('hash_v1');
    expect(snapshot?.tools.map((tool) => tool.name)).toEqual(['load_accounts']);
    expect(snapshot?.availability[0]?.tool).toBe('create_transfer');
  });

  it('resolves a hash-only re-list from the hash cache when the log is gone', () => {
    const model = createReadModel();
    model.observe(
      build(
        'catalog.tools_listed',
        { count: 1, content_hash: 'hash_v2', tools: [CATALOG_TOOL] },
        { xs: 'xs_cache0001' },
      ),
    );
    model.observe(
      build(
        'catalog.tools_listed',
        { count: 1, content_hash: 'hash_v2', snapshot_ref: 9999 },
        { xs: 'xs_cache0002' },
      ),
    );
    expect(model.catalog('xs_cache0002')?.tools.map((tool) => tool.name)).toEqual([
      'load_accounts',
    ]);
  });

  it('updates availability from catalog.availability without losing the tools', () => {
    const model = createReadModel();
    model.observe(
      build(
        'catalog.tools_listed',
        { count: 1, content_hash: 'hash_v3', tools: [CATALOG_TOOL] },
        { xs: 'xs_avail0001' },
      ),
    );
    model.observe(
      build(
        'catalog.availability',
        {
          content_hash: 'hash_v3',
          availability: [
            {
              tool: 'load_accounts',
              listed: true,
              available: true,
              unavailable_reasons: [],
              missing_scopes: [],
            },
          ],
          source: 'get_tool_availability',
        },
        { xs: 'xs_avail0001' },
      ),
    );
    const snapshot = model.catalog('xs_avail0001');
    expect(snapshot?.tools).toHaveLength(1);
    expect(snapshot?.availability[0]?.available).toBe(true);
  });
});

describe('sessions and grants', () => {
  it('counts what the dashboard shows and keeps the grant lineage', () => {
    const model = createReadModel();
    model.setBootId('boot_counters');
    const where = { xs: 'xs_count0001', login_id: 'lgn_count001', grant_id: 'grt_count002' };
    model.observe(
      build(
        'auth.grant.created',
        {
          grant_id: 'grt_count001',
          login_id: 'lgn_count001',
          persona_id: 'per_count001',
          scopes: ['accounts:read'],
          auth_level: 'read_only',
          client_id: 'cli_count',
        },
        { login_id: 'lgn_count001' },
      ),
    );
    model.observe(
      build(
        'auth.grant.created',
        {
          grant_id: 'grt_count002',
          parent_grant_id: 'grt_count001',
          login_id: 'lgn_count001',
          persona_id: 'per_count001',
          scopes: ['accounts:read', 'cards:write'],
          auth_level: 'read_write',
          client_id: 'cli_count',
        },
        { login_id: 'lgn_count001' },
      ),
    );
    model.observe(build('session.started', { reason: 'first_request' }, where));
    model.observe(
      build(
        'session.initialized',
        { protocol_version_negotiated: '2025-11-25', initialize_count: 3 },
        where,
      ),
    );
    model.observe(
      build(
        'tool.call.started',
        { tool: 'load_accounts', arguments: {}, rationale_present: false },
        where,
      ),
    );
    model.observe(
      build('tool.call.completed', { tool: 'load_accounts', duration_ms: 4, is_error: true }, where),
    );
    model.observe(build('etl.load', { table: 'accounts', rows: 12, source_tool: 'load_accounts', duration_ms: 3 }, where));
    model.observe(build('sql.query', { sql: 'SELECT 1', rows_returned: 1, duration_ms: 1 }, where));
    model.observe(build('bank.op', { operation: 'accounts.list', latency_ms: 2, ok: true }, where));
    model.observe(build('protocol.error', { code: -32601, message: 'unknown method' }, where));
    model.observe(
      build(
        'auth.token.revoked',
        { grant_id: 'grt_count002', reason: 'revocation_request' },
        { login_id: 'lgn_count001' },
      ),
    );

    const rows = model.sessions(loginScope('lgn_count001'));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.initialize_count).toBe(3);
    expect(row?.call_count).toBe(1);
    expect(row?.error_count).toBe(2);
    expect(row?.parent_grant_id).toBe('grt_count001');
    expect(row?.boot_id).toBe('boot_counters');

    expect(model.counters('xs_count0001')).toMatchObject({
      calls: 1,
      errors: 2,
      protocol_errors: 1,
      tables_loaded: 1,
      queries: 1,
      bank_operations: 1,
    });

    expect(model.grantIdsForLogin('lgn_count001').sort()).toEqual(['grt_count001', 'grt_count002']);
    expect(model.sessionIdsForLogin('lgn_count001')).toEqual(['xs_count0001']);
    expect(model.personaOfLogin('lgn_count001')).toBe('per_count001');
    expect(model.grant('grt_count002')?.revoked).toBe(true);
    expect(model.grant('grt_count002')?.auth_level).toBe('read_write');
  });

  it('groups the observer list by login, newest login and newest session first', () => {
    const model = createReadModel();
    const touch = (xs: string, login: string): void => {
      model.observe(build('session.started', { reason: 'first_request' }, { xs, login_id: login }));
    };
    // Interleaved on purpose: the ids (and therefore the timestamps) alternate between logins.
    touch('xs_group0a01', 'lgn_groupa01');
    touch('xs_group0b01', 'lgn_groupb01');
    touch('xs_group0a02', 'lgn_groupa01');
    touch('xs_group0b02', 'lgn_groupb01');
    touch('xs_group0a03', 'lgn_groupa01');

    const all = model.sessions({
      viewer_kind: 'admin',
      filter: 'all',
      login_id: null,
      xs: null,
    });
    expect(all.map((row) => row.xs)).toEqual([
      // login A moved most recently, and its own sessions are newest first...
      'xs_group0a03',
      'xs_group0a02',
      'xs_group0a01',
      // ...then login B, also newest first.
      'xs_group0b02',
      'xs_group0b01',
    ]);
  });

  it('marks a grant whose client had to be rebuilt after a restart (A-12)', () => {
    const model = createReadModel();
    model.observe(
      build('auth.client.reconstructed', {
        client_id: 'cli_rebuilt',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        reason: 'unknown_client_after_restart',
      }),
    );
    model.observe(
      build(
        'auth.grant.created',
        {
          grant_id: 'grt_rebuilt1',
          login_id: 'lgn_rebuilt1',
          persona_id: 'per_rebuilt',
          scopes: ['accounts:read'],
          auth_level: 'read_only',
          client_id: 'cli_rebuilt',
        },
        { login_id: 'lgn_rebuilt1' },
      ),
    );
    expect(model.grant('grt_rebuilt1')?.client_reconstructed).toBe(true);
  });
});

describe('forgetting (v0.4)', () => {
  it('forgets one session without touching the rest of the login', () => {
    const model = createReadModel();
    for (const xs of ['xs_one00001', 'xs_two00001']) {
      model.observe(
        build("session.started", { reason: "first_request" }, {
          xs,
          login_id: 'lgn_owner0001',
          grant_id: 'grt_owner0001',
        }),
      );
    }
    expect(model.sessionIdsForLogin('lgn_owner0001').sort()).toEqual(['xs_one00001', 'xs_two00001']);

    expect(model.forgetSession('xs_one00001')).toBe(true);
    expect(model.session('xs_one00001')).toBeNull();
    expect(model.session('xs_two00001')).not.toBeNull();
    expect(model.sessionIdsForLogin('lgn_owner0001')).toEqual(['xs_two00001']);
    // Forgetting what is already gone is not an error.
    expect(model.forgetSession('xs_one00001')).toBe(false);
  });

  it('forgets a whole login and leaves a stranger alone', () => {
    const model = createReadModel();
    const seed = (xs: string, login: string, grant: string): void => {
      model.observe(
        build("session.started", { reason: "first_request" }, {
          xs,
          login_id: login,
          grant_id: grant,
        }),
      );
    };
    seed('xs_mine00001', 'lgn_mine00001', 'grt_mine00001');
    seed('xs_mine00002', 'lgn_mine00001', 'grt_mine00001');
    seed('xs_other0001', 'lgn_other0001', 'grt_other0001');

    expect(model.forgetLogin('lgn_mine00001')).toBe(2);
    expect(model.session('xs_mine00001')).toBeNull();
    expect(model.session('xs_mine00002')).toBeNull();
    expect(model.sessionIdsForLogin('lgn_mine00001')).toEqual([]);
    expect(model.grantIdsForLogin('lgn_mine00001')).toEqual([]);
    // The stranger's session, grant and login are untouched.
    expect(model.session('xs_other0001')).not.toBeNull();
    expect(model.sessionIdsForLogin('lgn_other0001')).toEqual(['xs_other0001']);
    expect(model.forgetLogin('lgn_nobody001')).toBe(0);
  });
});
