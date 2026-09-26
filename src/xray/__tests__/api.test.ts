/**
 * The X-ray read model over HTTP (docs/XRAY_EVENT_MODEL.md section 6, CLAUDE.md invariant 11).
 *
 * The property under test is the privacy one: a pairing cookie sees **every grant of its login and
 * nothing else**, an admin cookie sees everything but harder redacted, and no cookie sees anything.
 * Everything runs against a real Express server on a real socket, because the cookie, the status
 * codes and the redirect are part of the contract.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COOKIE_NAMES, type XrayPersonaSummary } from '../../contracts/index.js';

import { cookieFrom, createHarness, createTempDb, TEST_SIGNING_KEY } from './harness.js';

const PERSONAS: Record<string, XrayPersonaSummary> = {
  per_alpha1: { id: 'per_alpha1', name: 'Ada Whitfield', kind: 'retail', shared: true },
  per_beta01: { id: 'per_beta01', name: 'Owen Marsh', kind: 'business', shared: false },
};

/** A fetch client that keeps one cookie, the way a browser would. */
function createClient(baseUrl: string) {
  let cookie: string | null = null;
  return {
    get cookie() {
      return cookie;
    },
    set(value: string | null) {
      cookie = value;
    },
    async request(path: string, init: RequestInit = {}): Promise<Response> {
      const headers = new Headers(init.headers);
      if (cookie !== null) headers.set('cookie', `${COOKIE_NAMES.viewer}=${cookie}`);
      const response = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' });
      const fresh = cookieFrom(response.headers, COOKIE_NAMES.viewer);
      if (fresh !== null) cookie = fresh;
      return response;
    },
    async json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
      const response = await this.request(path, init);
      const body = (await response.json()) as T;
      return { status: response.status, body };
    },
  };
}

interface Fixture {
  readonly harness: ReturnType<typeof createHarness>;
  readonly baseUrl: string;
}

/**
 * Two logins. Login A holds two grants (the second extends the first, so the dashboard can show
 * the lineage) with one session each; login B is a stranger.
 */
function seed(harness: ReturnType<typeof createHarness>): void {
  const emit = harness.xray.emitter;
  emit.emit(
    'auth.grant.created',
    {
      grant_id: 'grt_alpha01',
      login_id: 'lgn_alpha01',
      persona_id: 'per_alpha1',
      scopes: ['accounts:read', 'transactions:read'],
      auth_level: 'read_only',
      client_id: 'cli_claudeai',
      client_name: 'Claude',
      shared_persona: true,
    },
    { login_id: 'lgn_alpha01', grant_id: 'grt_alpha01', persona_id: 'per_alpha1' },
  );
  emit.emit(
    'auth.grant.created',
    {
      grant_id: 'grt_alpha02',
      parent_grant_id: 'grt_alpha01',
      login_id: 'lgn_alpha01',
      persona_id: 'per_alpha1',
      scopes: ['accounts:read', 'cards:write'],
      auth_level: 'read_write',
      client_id: 'cli_claudeai',
      client_name: 'Claude',
      shared_persona: true,
    },
    { login_id: 'lgn_alpha01', grant_id: 'grt_alpha02', persona_id: 'per_alpha1' },
  );
  emit.emit(
    'auth.grant.created',
    {
      grant_id: 'grt_beta001',
      login_id: 'lgn_beta001',
      persona_id: 'per_beta01',
      scopes: ['accounts:read'],
      auth_level: 'read_only',
      client_id: 'cli_inspector',
    },
    { login_id: 'lgn_beta001', grant_id: 'grt_beta001', persona_id: 'per_beta01' },
  );

  const correlation = (xs: string, login: string, grant: string, persona: string) => ({
    xs,
    login_id: login,
    grant_id: grant,
    persona_id: persona,
    client: { name: 'Claude', version: '1.0.0', title: null },
    protocol_version: '2025-11-25',
    era: 'legacy' as const,
  });

  for (const [xs, grant] of [
    ['xs_alpha001', 'grt_alpha01'],
    ['xs_alpha002', 'grt_alpha02'],
  ] as const) {
    const where = correlation(xs, 'lgn_alpha01', grant, 'per_alpha1');
    emit.emit('session.started', { reason: 'first_request' }, where);
    emit.emit(
      'session.initialized',
      { protocol_version_negotiated: '2025-11-25', initialize_count: 2 },
      where,
    );
    emit.emit(
      'catalog.tools_listed',
      {
        count: 2,
        content_hash: 'hash_alpha',
        tools: [
          {
            name: 'load_accounts',
            title: 'Load accounts',
            read_only: true,
            destructive: false,
            idempotent: true,
            scopes: ['accounts:read'],
            input_schema_hash: 'sch_1',
          },
        ],
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
      where,
    );
    emit.emit(
      'tool.call.started',
      {
        tool: 'load_transactions',
        arguments: { account_id: 'acc_9f3a2b7c', limit: 25 },
        rationale: 'The user asked for last month of grocery spending, so I load transactions first.',
        rationale_present: true,
      },
      where,
    );
    emit.emit(
      'tool.call.completed',
      { tool: 'load_transactions', duration_ms: 42, is_error: false, text_preview: 'Loaded 25 rows' },
      where,
    );
  }

  const strangerWhere = correlation('xs_beta0001', 'lgn_beta001', 'grt_beta001', 'per_beta01');
  emit.emit('session.started', { reason: 'first_request' }, strangerWhere);
  emit.emit(
    'tool.call.started',
    {
      tool: 'load_accounts',
      arguments: { secret_note: 'this belongs to another login' },
      rationale: 'A stranger session that must never reach the first viewer.',
      rationale_present: true,
    },
    strangerWhere,
  );
  harness.xray.flush();
}

describe('the X-ray API', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const harness = createHarness({
      adminToken: 'observer-token-for-tests',
      lookupPersona: async (id) => PERSONAS[id] ?? null,
    });
    seed(harness);
    const baseUrl = await harness.listen();
    fixture = { harness, baseUrl };
  });

  afterEach(async () => {
    await fixture.harness.close();
  });

  it('answers 401 without a viewer cookie', async () => {
    const client = createClient(fixture.baseUrl);
    for (const path of [
      '/xray/api/me',
      '/xray/api/sessions',
      '/xray/api/sessions/xs_alpha001',
      '/xray/api/sessions/xs_alpha001/events',
      '/xray/api/catalog?xs=xs_alpha001',
      '/xray/api/stream',
    ]) {
      const response = await client.request(path);
      expect(response.status, path).toBe(401);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('unauthorized');
      expect(typeof body.message).toBe('string');
    }
  });

  it('exchanges a pairing code on the landing route and redirects to the SPA', async () => {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
    const client = createClient(fixture.baseUrl);
    const response = await client.request(`/xray/s/${minted.code}`);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/xray/');
    const raw = response.headers.getSetCookie().join(';');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Lax');
    expect(client.cookie).not.toBeNull();
  });

  it('shows a pairing viewer every grant of its login and nothing else', async () => {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
    const client = createClient(fixture.baseUrl);
    await client.request(`/xray/s/${minted.code}`);

    const me = await client.json<{
      viewer_kind: string;
      login_id: string;
      grant_ids: string[];
      persona: XrayPersonaSummary;
    }>('/xray/api/me');
    expect(me.status).toBe(200);
    expect(me.body.viewer_kind).toBe('pairing');
    expect(me.body.login_id).toBe('lgn_alpha01');
    expect(me.body.grant_ids.sort()).toEqual(['grt_alpha01', 'grt_alpha02']);
    expect(me.body.persona.name).toBe('Ada Whitfield');
    expect(me.body.persona.shared).toBe(true);

    const sessions = await client.json<{
      data: { xs: string; grant_id: string; parent_grant_id: string | null; login_id: string }[];
    }>('/xray/api/sessions');
    expect(sessions.status).toBe(200);
    expect(sessions.body.data.map((row) => row.xs).sort()).toEqual(['xs_alpha001', 'xs_alpha002']);
    expect(sessions.body.data.every((row) => row.login_id === 'lgn_alpha01')).toBe(true);
    // The grant lineage: the second grant extends the first (ADR-14).
    const extended = sessions.body.data.find((row) => row.grant_id === 'grt_alpha02');
    expect(extended?.parent_grant_id).toBe('grt_alpha01');

    // The stranger's session is invisible in every shape the API offers.
    for (const path of [
      '/xray/api/sessions/xs_beta0001',
      '/xray/api/sessions/xs_beta0001/events',
      '/xray/api/catalog?xs=xs_beta0001',
      '/xray/api/stream?xs=xs_beta0001',
    ]) {
      const response = await client.request(path);
      expect(response.status, path).toBe(403);
    }
    const forbidden = await client.request('/xray/api/stream?all=1');
    expect(forbidden.status).toBe(403);
  });

  it('serves one session with its counters, grant facts and catalog snapshot', async () => {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
    const client = createClient(fixture.baseUrl);
    await client.request(`/xray/s/${minted.code}`);

    const detail = await client.json<{
      session: { xs: string; initialize_count: number; call_count: number; boot_id: string };
      grant: { grant_id: string; scopes: string[]; auth_level: string };
      catalog: { content_hash: string; tools: { name: string }[] };
      availability: { tool: string; missing_scopes: string[] }[];
      counters: { calls: number; events: number };
    }>('/xray/api/sessions/xs_alpha002');
    expect(detail.status).toBe(200);
    expect(detail.body.session.initialize_count).toBe(2);
    expect(detail.body.session.call_count).toBe(1);
    expect(detail.body.session.boot_id).toBe('boot_test01');
    expect(detail.body.grant.grant_id).toBe('grt_alpha02');
    expect(detail.body.grant.auth_level).toBe('read_write');
    expect(detail.body.catalog.content_hash).toBe('hash_alpha');
    expect(detail.body.catalog.tools[0]?.name).toBe('load_accounts');
    expect(detail.body.availability[0]?.missing_scopes).toEqual(['transfers:write']);
    expect(detail.body.counters.calls).toBe(1);

    const catalog = await client.json<{ content_hash: string }>(
      '/xray/api/catalog?xs=xs_alpha002',
    );
    expect(catalog.status).toBe(200);
    expect(catalog.body.content_hash).toBe('hash_alpha');
  });

  it('pages the history of one session with the arguments intact', async () => {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
    const client = createClient(fixture.baseUrl);
    await client.request(`/xray/s/${minted.code}`);

    const events = await client.json<{
      data: { id: number; type: string; data: Record<string, unknown> }[];
      page: { next: string | null };
    }>('/xray/api/sessions/xs_alpha001/events?limit=500');
    expect(events.status).toBe(200);
    expect(events.body.data.map((event) => event.type)).toContain('tool.call.started');
    const call = events.body.data.find((event) => event.type === 'tool.call.started');
    expect(call?.data.arguments).toEqual({ account_id: 'acc_9f3a2b7c', limit: 25 });
    expect(String(call?.data.rationale)).toContain('grocery spending');
    // Ids are strictly increasing inside a session.
    const ids = events.body.data.map((event) => event.id);
    expect([...ids].sort((left, right) => left - right)).toEqual(ids);
  });

  it('rate-limits the pairing exchange from the SPA at the sixth failure', async () => {
    const client = createClient(fixture.baseUrl);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await client.request('/xray/api/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'BANK-ZZZZ-ZZZZ-ZZ' }),
      });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429]);
  });

  it('gives observer mode every session, with arguments hidden and the rationale masked', async () => {
    const client = createClient(fixture.baseUrl);
    const refused = await client.request('/xray/api/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(refused.status).toBe(403);

    const accepted = await client.json<{ viewer_kind: string; login_id: string | null }>(
      '/xray/api/admin',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'observer-token-for-tests' }),
      },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body.viewer_kind).toBe('admin');
    expect(accepted.body.login_id).toBeNull();

    const sessions = await client.json<{ data: { xs: string }[] }>('/xray/api/sessions');
    expect(sessions.body.data.map((row) => row.xs).sort()).toEqual([
      'xs_alpha001',
      'xs_alpha002',
      'xs_beta0001',
    ]);

    const events = await client.json<{
      data: { type: string; data: Record<string, unknown> }[];
    }>('/xray/api/sessions/xs_alpha001/events');
    const call = events.body.data.find((event) => event.type === 'tool.call.started');
    expect(call?.data.arguments).toEqual({});
    expect((call?.data.redacted_fields as string[]).includes('arguments')).toBe(true);
    expect(String(call?.data.rationale).length).toBeLessThanOrEqual(100);
    expect(String(call?.data.rationale)).toContain('The user asked');
  });

  it('answers 404 in the contract error shape for an unknown API route', async () => {
    const client = createClient(fixture.baseUrl);
    const response = await client.request('/xray/api/nothing-here');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('not_found');
  });
});

describe('the viewer cookie across a restart (A-25: the log may be gone, the viewer is not)', () => {
  it('keeps working against a new process with the same signing key', async () => {
    const temporary = createTempDb();
    // `emitServerStarted` is the production default: the marker is what stamps the boot on
    // every session of that boot (A-15).
    const first = createHarness({
      dbPath: temporary.path,
      bootId: 'boot_one',
      emitServerStarted: true,
    });
    try {
      seed(first);
      const baseUrl = await first.listen();
      const client = createClient(baseUrl);
      const minted = await first.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
      await client.request(`/xray/s/${minted.code}`);
      expect((await client.json<{ login_id: string }>('/xray/api/me')).body.login_id).toBe(
        'lgn_alpha01',
      );
      const cookie = client.cookie;
      await first.close();

      // A restart: a brand new process, the same OAUTH_SIGNING_KEY and the same log file. The
      // pairing codes are gone (they live in memory), the cookie is not.
      const second = createHarness({
        dbPath: temporary.path,
        bootId: 'boot_two',
        signingKey: TEST_SIGNING_KEY,
      });
      try {
        const secondUrl = await second.listen();
        const restarted = createClient(secondUrl);
        restarted.set(cookie);
        const me = await restarted.json<{ viewer_kind: string; login_id: string }>('/xray/api/me');
        expect(me.status).toBe(200);
        expect(me.body.login_id).toBe('lgn_alpha01');
        // And the sessions the previous boot recorded are still there.
        const sessions = await restarted.json<{ data: { xs: string; boot_id: string }[] }>(
          '/xray/api/sessions',
        );
        expect(sessions.body.data.map((row) => row.xs).sort()).toEqual([
          'xs_alpha001',
          'xs_alpha002',
        ]);
        expect(sessions.body.data[0]?.boot_id).toBe('boot_one');
      } finally {
        await second.close();
      }
    } finally {
      temporary.cleanup();
    }
  });

  it('refuses a cookie signed with a different key', async () => {
    const first = createHarness({ signingKey: 'a-different-signing-key-of-enough-length-32' });
    const second = createHarness();
    try {
      const firstUrl = await first.listen();
      const client = createClient(firstUrl);
      const minted = await first.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
      await client.request(`/xray/s/${minted.code}`);
      const cookie = client.cookie;

      const secondUrl = await second.listen();
      const stranger = createClient(secondUrl);
      stranger.set(cookie);
      const response = await stranger.request('/xray/api/me');
      expect(response.status).toBe(401);
    } finally {
      await first.close();
      await second.close();
    }
  });
});

describe('the persona card (GET /xray/api/sessions/:xs/bank, contracts v0.3)', () => {
  const summary = {
    persona: PERSONAS.per_alpha1!,
    currency: 'USD',
    as_of: '2026-09-09T10:00:00.000Z',
    accounts: [
      {
        account_id: 'acc_alpha_chk',
        name: 'Everyday Checking',
        account_type: 'checking' as const,
        currency: 'USD',
        balance_cents: 1_234_56,
        available_balance_cents: 1_200_00,
        credit_limit_cents: null,
        status: 'open' as const,
      },
    ],
    total_cash_cents: 1_234_56,
    total_available_cents: 1_200_00,
    total_credit_owed_cents: 0,
    net_position_cents: 1_234_56,
    cards: { total: 2, active: 1, locked: 1, fraud_locked: 0 },
    transfer_limit_cents: 500_000_00,
  };
  const seen: { persona_id: string; login_id: string | null; grant_id: string | null }[] = [];
  let fixture: Fixture;

  beforeEach(async () => {
    seen.length = 0;
    const harness = createHarness({
      adminToken: 'admin-token-for-tests',
      lookupPersona: async (id) => PERSONAS[id] ?? null,
      lookupBankSummary: async (session) => {
        seen.push(session);
        return session.persona_id === 'per_alpha1' ? summary : null;
      },
    });
    seed(harness);
    const baseUrl = await harness.listen();
    fixture = { harness, baseUrl };
  });

  afterEach(async () => {
    await fixture.harness.close();
  });

  it('serves the card for the viewer\'s own session, keyed on the session\'s persona and login', async () => {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
    const client = createClient(fixture.baseUrl);
    await client.request(`/xray/s/${minted.code}`);

    const card = await client.json<{
      xs: string;
      login_id: string;
      persona: { name: string };
      net_position_cents: number;
      accounts: { name: string }[];
      cards: { locked: number };
    }>('/xray/api/sessions/xs_alpha002/bank');
    expect(card.status).toBe(200);
    expect(card.body.xs).toBe('xs_alpha002');
    expect(card.body.login_id).toBe('lgn_alpha01');
    expect(card.body.persona.name).toBe('Ada Whitfield');
    expect(card.body.net_position_cents).toBe(1_234_56);
    expect(card.body.accounts[0]?.name).toBe('Everyday Checking');
    expect(card.body.cards.locked).toBe(1);
    expect(seen).toEqual([
      { persona_id: 'per_alpha1', login_id: 'lgn_alpha01', grant_id: 'grt_alpha02' },
    ]);
  });

  it('refuses a stranger\'s session before touching the bank (invariant 11)', async () => {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
    const client = createClient(fixture.baseUrl);
    await client.request(`/xray/s/${minted.code}`);

    const stranger = await client.json<{ error: string }>('/xray/api/sessions/xs_beta0001/bank');
    expect(stranger.status).toBe(403);
    expect(seen).toEqual([]);

    // An unknown `xs` is refused the same way as a stranger's: the viewer learns nothing about
    // which sessions exist (invariant 11).
    const missing = await client.json<{ error: string }>('/xray/api/sessions/xs_nowhere/bank');
    expect(missing.status).toBe(403);
  });

  it('answers 404 no_persona when the bank does not know the persona, and 401 with no cookie', async () => {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: 'lgn_beta001' });
    const client = createClient(fixture.baseUrl);
    await client.request(`/xray/s/${minted.code}`);
    const unknown = await client.json<{ error: string }>('/xray/api/sessions/xs_beta0001/bank');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe('no_persona');

    const anonymous = await createClient(fixture.baseUrl).json<{ error: string }>(
      '/xray/api/sessions/xs_alpha002/bank',
    );
    expect(anonymous.status).toBe(401);
  });

  it('answers 503 when no bank is wired, and lets an observer read any session', async () => {
    const bare = createHarness({
      adminToken: 'admin-token-for-tests',
      lookupPersona: async (id) => PERSONAS[id] ?? null,
    });
    seed(bare);
    const bareUrl = await bare.listen();
    try {
      const minted = await bare.xray.pairing.createCode({ login_id: 'lgn_alpha01' });
      const client = createClient(bareUrl);
      await client.request(`/xray/s/${minted.code}`);
      const unwired = await client.json<{ error: string }>('/xray/api/sessions/xs_alpha002/bank');
      expect(unwired.status).toBe(503);
      expect(unwired.body.error).toBe('unavailable');
    } finally {
      await bare.close();
    }

    const observer = createClient(fixture.baseUrl);
    const exchanged = await observer.request('/xray/api/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token-for-tests' }),
    });
    expect(exchanged.status).toBe(200);
    const card = await observer.json<{ persona: { name: string } }>(
      '/xray/api/sessions/xs_alpha002/bank',
    );
    expect(card.status).toBe(200);
    expect(card.body.persona.name).toBe('Ada Whitfield');
  });
});

describe('erasing history (DELETE, contracts v0.4)', () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const harness = createHarness({
      adminToken: 'admin-token-for-tests',
      lookupPersona: async (id) => PERSONAS[id] ?? null,
    });
    seed(harness);
    const baseUrl = await harness.listen();
    fixture = { harness, baseUrl };
  });

  afterEach(async () => {
    await fixture.harness.close();
  });

  /** A paired client for one login. */
  async function pairedFor(loginId: string) {
    const minted = await fixture.harness.xray.pairing.createCode({ login_id: loginId });
    const client = createClient(fixture.baseUrl);
    await client.request(`/xray/s/${minted.code}`);
    return client;
  }

  it('erases one session from the log, the replay buffer and the read model', async () => {
    const client = await pairedFor('lgn_alpha01');
    const before = await client.json<{ data: { xs: string }[] }>('/xray/api/sessions');
    expect(before.body.data.map((row) => row.xs).sort()).toEqual(['xs_alpha001', 'xs_alpha002']);

    const erased = await client.json<{ deleted: number; sessions: number; scope: string }>(
      '/xray/api/sessions/xs_alpha001',
      { method: 'DELETE' },
    );
    expect(erased.status).toBe(200);
    expect(erased.body.scope).toBe('session');
    expect(erased.body.sessions).toBe(1);
    expect(erased.body.deleted).toBeGreaterThan(0);

    const after = await client.json<{ data: { xs: string }[] }>('/xray/api/sessions');
    expect(after.body.data.map((row) => row.xs)).toEqual(['xs_alpha002']);

    // The session no longer resolves, so it is refused exactly like a stranger's: after an erase
    // the viewer cannot tell its own deleted session from one that never existed.
    const gone = await client.request('/xray/api/sessions/xs_alpha001/events');
    expect(gone.status).toBe(403);
    // The other session of the same login is untouched.
    const kept = await client.json<{ data: unknown[] }>('/xray/api/sessions/xs_alpha002/events');
    expect(kept.body.data.length).toBeGreaterThan(0);
    // The live buffer must forget it too, or the next `Last-Event-ID` replay brings it all back.
    expect(fixture.harness.xray.ring.after(0, 5000).some((event) => event.xs === 'xs_alpha001')).toBe(
      false,
    );
    expect(fixture.harness.xray.log.readSession('xs_alpha001', 0, 500)).toEqual([]);
  });

  it('erases a whole login and leaves a strangers history alone', async () => {
    const client = await pairedFor('lgn_alpha01');
    const erased = await client.json<{ deleted: number; sessions: number; scope: string }>(
      '/xray/api/events',
      { method: 'DELETE' },
    );
    expect(erased.status).toBe(200);
    expect(erased.body.scope).toBe('login');
    expect(erased.body.sessions).toBe(2);

    const mine = await client.json<{ data: unknown[] }>('/xray/api/sessions');
    expect(mine.body.data).toEqual([]);

    const stranger = await pairedFor('lgn_beta001');
    const theirs = await stranger.json<{ data: { xs: string }[] }>('/xray/api/sessions');
    expect(theirs.body.data.map((row) => row.xs)).toEqual(['xs_beta0001']);
  });

  it('leaves one `xray.events.deleted` behind, because a silent erase is worse', async () => {
    const client = await pairedFor('lgn_alpha01');
    await client.json('/xray/api/events', { method: 'DELETE' });
    fixture.harness.xray.flush();
    const record = fixture.harness.xray.ring
      .after(0, 5000)
      .find((event) => event.type === 'xray.events.deleted');
    expect(record).toBeDefined();
    expect(record?.login_id).toBe('lgn_alpha01');
    expect(record?.data).toMatchObject({ scope: 'login', sessions_deleted: 2, viewer_kind: 'pairing' });
  });

  it('refuses a stranger, an unknown session, observer mode and no cookie (invariant 11)', async () => {
    const client = await pairedFor('lgn_alpha01');
    const stranger = await client.json<{ error: string }>('/xray/api/sessions/xs_beta0001', {
      method: 'DELETE',
    });
    expect(stranger.status).toBe(403);

    // An unknown `xs` is refused the same way as a stranger's, so a viewer cannot probe which
    // sessions exist by watching the status code change.
    const missing = await client.json<{ error: string }>('/xray/api/sessions/xs_nothing', {
      method: 'DELETE',
    });
    expect(missing.status).toBe(403);

    const anonymous = await createClient(fixture.baseUrl).json<{ error: string }>(
      '/xray/api/events',
      { method: 'DELETE' },
    );
    expect(anonymous.status).toBe(401);

    const observer = createClient(fixture.baseUrl);
    await observer.request('/xray/api/admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'admin-token-for-tests' }),
    });
    const refused = await observer.json<{ error: string; message: string }>('/xray/api/events', {
      method: 'DELETE',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toContain('read-only');

    // Nothing was erased by any of the four refusals.
    const intact = await client.json<{ data: { xs: string }[] }>('/xray/api/sessions');
    expect(intact.body.data).toHaveLength(2);
  });
});
