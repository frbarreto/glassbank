/**
 * Behaviour of the fakes. `test/contracts/fakes.test.ts` asserts that they satisfy the
 * interfaces; this file asserts that they behave the way a block author will assume, in
 * particular the ADR-15 copy-on-write isolation and the ADR-9 guard rules.
 */
import { describe, expect, it } from 'vitest';

import { ScratchDbError, isScratchDbError } from '../../contracts/index.js';
import {
  FAKE_NOW,
  advertisedColumns,
  bankScopeOf,
  createFakeAuthContext,
  createFakeBankCore,
  createFakePairing,
  createFakeScratchDb,
  createFakeXrayEmitter,
  flattenRow,
  paginate,
} from '../fakes.js';

const AVA = { persona_id: 'per_ava01', login_id: 'lgn_one' };
const AVA_OTHER_LOGIN = { persona_id: 'per_ava01', login_id: 'lgn_two' };

describe('createFakeBankCore', () => {
  it('is deterministic: the same options give the same dataset', async () => {
    const first = await createFakeBankCore().dataset('per_ava01');
    const second = await createFakeBankCore().dataset('per_ava01');
    expect(first.accounts).toEqual(second.accounts);
    expect(first.transactions).toEqual(second.transactions);
  });

  it('paginates with Ramp cursor envelope', async () => {
    const bank = createFakeBankCore();
    const first = await bank.listAccounts(AVA, { limit: 8 });
    expect(first.data).toHaveLength(8);
    expect(first.page.next).toBe('8');
    const second = await bank.listAccounts(AVA, { limit: 8, cursor: first.page.next });
    expect(second.data).toHaveLength(8);
    const third = await bank.listAccounts(AVA, { limit: 8, cursor: second.page.next });
    expect(third.data).toHaveLength(4);
    expect(third.page.next).toBeNull();
  });

  it('applies the ""-means-null enum rule and the inclusive date range', async () => {
    const bank = createFakeBankCore();
    const all = await bank.listCards(AVA, { status: '' });
    const active = await bank.listCards(AVA, { status: 'active' });
    expect(all.data.length).toBeGreaterThan(active.data.length);

    const dataset = await bank.dataset('per_ava01');
    const oldest = dataset.transactions
      .map((transaction) => transaction.date)
      .sort()
      .at(0) as string;
    const onlyOldest = await bank.listTransactions(AVA, {
      from_date: oldest,
      to_date: oldest,
    });
    expect(onlyOldest.data.length).toBeGreaterThan(0);
    expect(onlyOldest.data.every((transaction) => transaction.date === oldest)).toBe(true);
  });

  it('sorts transactions by amount descending (Ramp order_by_amount_desc)', async () => {
    const bank = createFakeBankCore();
    const page = await bank.listTransactions(AVA, {
      from_date: '2000-01-01',
      to_date: '2100-01-01',
    });
    const magnitudes = page.data.map((transaction) => Math.abs(transaction.amount_cents));
    expect([...magnitudes].sort((left, right) => right - left)).toEqual(magnitudes);
  });

  it('keeps writes private to the login (ADR-15 copy-on-write)', async () => {
    const bank = createFakeBankCore();
    const before = await bank.listCards(AVA);
    const target = before.data.find((card) => card.status === 'active');
    expect(target).toBeDefined();

    const result = await bank.lockOrUnlockCard(AVA, {
      card_id: (target as { id: string }).id,
      action: 'lock',
    });
    expect(result.ok).toBe(true);

    const mine = await bank.listCards(AVA, { account_id: undefined });
    expect(mine.data.find((card) => card.id === target?.id)?.status).toBe('locked');

    const theirs = await bank.listCards(AVA_OTHER_LOGIN);
    expect(theirs.data.find((card) => card.id === target?.id)?.status).toBe('active');

    const seed = await bank.dataset('per_ava01');
    expect(seed.cards.find((card) => card.id === target?.id)?.status).toBe('active');
  });

  it('appends an audit entry for every write and reports it', async () => {
    const bank = createFakeBankCore();
    const cards = await bank.listCards(AVA, { status: 'active' });
    const result = await bank.lockOrUnlockCard(AVA, {
      card_id: cards.data[0]?.id ?? '',
      action: 'lock',
      rationale: 'the user lost the card',
    });
    expect(result.ok).toBe(true);
    const audit = await bank.listAuditEntries(AVA);
    expect(audit.data).toHaveLength(1);
    expect(audit.data[0]?.action).toBe('card.lock');
    expect(audit.data[0]?.rationale).toBe('the user lost the card');
    expect(result.ok && result.audit_id).toBe(audit.data[0]?.id);
  });

  it('refuses to unlock a fraud-locked card', async () => {
    const bank = createFakeBankCore();
    const cards = await bank.listCards(AVA, { status: 'fraud_locked' });
    const result = await bank.lockOrUnlockCard(AVA, {
      card_id: cards.data[0]?.id ?? '',
      action: 'unlock',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('fraud_locked');
  });

  it('reports an unknown card instead of throwing', async () => {
    const bank = createFakeBankCore();
    const result = await bank.lockOrUnlockCard(AVA, { card_id: 'card_missing', action: 'lock' });
    expect(result.ok === false && result.reason).toBe('unknown_card');
  });

  it('previews then confirms a transfer, moving money only on the confirm', async () => {
    const bank = createFakeBankCore();
    const accounts = await bank.listAccounts(AVA, { account_type: 'checking' });
    const payees = await bank.listPayees(AVA);
    const from = accounts.data[0];
    const payee = payees.data.find((candidate) => candidate.rail === 'ach');
    expect(from && payee).toBeTruthy();

    const preview = await bank.previewTransfer(AVA, {
      from_account_id: from?.id ?? '',
      to: { payee_id: payee?.id ?? '' },
      amount: 10_000,
      currency: 'USD',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.total).toBe(preview.preview.amount + preview.preview.fee);
    expect(preview.preview.expected_total_amount).toBe(preview.preview.total);
    expect(preview.preview.preview_id).toMatch(/^prv_/);

    const unchanged = await bank.listAccounts(AVA, { account_id: from?.id });
    expect(unchanged.data[0]?.balance_cents).toBe(from?.balance_cents);

    const confirmed = await bank.confirmTransfer(AVA, {
      preview_id: preview.preview.preview_id,
      expected_total_amount: preview.preview.expected_total_amount,
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.transfer.status).toBe('completed');
    expect(confirmed.transfer.audit_id).toBe(confirmed.audit_id);

    const after = await bank.listAccounts(AVA, { account_id: from?.id });
    expect(after.data[0]?.balance_cents).toBe((from?.balance_cents ?? 0) - preview.preview.total);
    const otherLogin = await bank.listAccounts(AVA_OTHER_LOGIN, { account_id: from?.id });
    expect(otherLogin.data[0]?.balance_cents).toBe(from?.balance_cents);
  });

  it('rejects a confirm whose expected_total_amount no longer matches (reprice guard)', async () => {
    const bank = createFakeBankCore();
    const accounts = await bank.listAccounts(AVA, { account_type: 'checking' });
    const payees = await bank.listPayees(AVA);
    const preview = await bank.previewTransfer(AVA, {
      from_account_id: accounts.data[0]?.id ?? '',
      to: { payee_id: payees.data[0]?.id ?? '' },
      amount: 10_000,
      currency: 'USD',
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const mismatch = await bank.confirmTransfer(AVA, {
      preview_id: preview.preview.preview_id,
      expected_total_amount: preview.preview.total + 1,
    });
    expect(mismatch.ok === false && mismatch.reason).toBe('repriced');

    bank.repriceNextConfirm(500);
    const repriced = await bank.confirmTransfer(AVA, {
      preview_id: preview.preview.preview_id,
      expected_total_amount: preview.preview.total,
    });
    expect(repriced.ok === false && repriced.reason).toBe('repriced');
    expect(repriced.ok === false && repriced.preview?.total).toBe(preview.preview.total + 500);
  });

  it('rejects an amount over the persona per-transfer limit and an unknown preview', async () => {
    const bank = createFakeBankCore();
    const accounts = await bank.listAccounts(AVA, { account_type: 'checking' });
    const payees = await bank.listPayees(AVA);
    const overLimit = await bank.previewTransfer(AVA, {
      from_account_id: accounts.data[0]?.id ?? '',
      to: { payee_id: payees.data[0]?.id ?? '' },
      amount: 99_999_999,
      currency: 'USD',
    });
    expect(overLimit.ok === false && overLimit.reason).toBe('over_limit');

    const unknown = await bank.confirmTransfer(AVA, {
      preview_id: 'prv_nope',
      expected_total_amount: 1,
    });
    expect(unknown.ok === false && unknown.reason).toBe('unknown_preview');
  });

  it('refuses an archived payee and a foreign currency', async () => {
    const bank = createFakeBankCore();
    const accounts = await bank.listAccounts(AVA, { account_type: 'checking' });
    const archived = await bank.listPayees(AVA, { is_active: false });
    expect(archived.data.length).toBeGreaterThan(0);
    const inactive = await bank.previewTransfer(AVA, {
      from_account_id: accounts.data[0]?.id ?? '',
      to: { payee_id: archived.data[0]?.id ?? '' },
      amount: 1000,
      currency: 'USD',
    });
    expect(inactive.ok === false && inactive.reason).toBe('payee_inactive');

    const active = await bank.listPayees(AVA);
    const wrongCurrency = await bank.previewTransfer(AVA, {
      from_account_id: accounts.data[0]?.id ?? '',
      to: { payee_id: active.data[0]?.id ?? '' },
      amount: 1000,
      currency: 'EUR',
    });
    expect(wrongCurrency.ok === false && wrongCurrency.reason).toBe('currency_not_supported');
  });

  it('mints a demo persona whose dataset regenerates deterministically', async () => {
    const bank = createFakeBankCore();
    const persona = await bank.personas.createDemoPersona({ seed: 'zeta9' });
    expect(persona.id).toBe('per_zeta9');
    expect(persona.shared).toBe(false);
    const dataset = await bank.dataset(persona.id);
    expect(dataset.accounts).toHaveLength(20);
    expect(await bank.personas.get('per_zeta9')).toEqual(persona);
    // Only the seeded personas are offered on the login page.
    expect((await bank.personas.list()).every((entry) => entry.shared)).toBe(true);
  });

  it('drops every overlay on resetOverlays, the way a restart does (A-15)', async () => {
    const bank = createFakeBankCore();
    const cards = await bank.listCards(AVA, { status: 'active' });
    await bank.lockOrUnlockCard(AVA, { card_id: cards.data[0]?.id ?? '', action: 'lock' });
    expect(bank.peekOverlay('per_ava01', 'lgn_one')?.card_status).not.toEqual({});
    bank.resetOverlays();
    expect(bank.peekOverlay('per_ava01', 'lgn_one')).toBeUndefined();
    const afterRestart = await bank.listCards(AVA);
    expect(afterRestart.data.find((card) => card.id === cards.data[0]?.id)?.status).toBe('active');
  });
});

describe('createFakeScratchDb', () => {
  async function loadedDatabase() {
    const scratch = createFakeScratchDb();
    const loaded = await scratch.load({
      source_tool: 'load_transactions',
      rows: [
        { id: 't1', amount_cents: -100, merchant: { name: 'Northline' } },
        { id: 't2', amount_cents: -250, merchant: { name: 'Harbor' }, tags: ['x'] },
      ],
    });
    await scratch.process({
      table_name: loaded.table_name,
      cols: ['id', 'amount_cents', 'merchant__name'],
    });
    return { scratch, table: loaded.table_name };
  }

  it('flattens nested keys with a double underscore and unions the keys of every row', () => {
    expect(flattenRow({ a: 1, b: { c: 2, d: { e: 3 } }, f: [1, 2] })).toEqual({
      a: 1,
      b__c: 2,
      b__d__e: 3,
      f: '[1,2]',
    });
    expect(advertisedColumns([{ a: 1 }, { b: 2 }])).toEqual(['a', 'b']);
  });

  it('names the table after the tool when the caller does not', async () => {
    const scratch = createFakeScratchDb();
    const loaded = await scratch.load({ source_tool: 'load_cards', rows: [{ id: 'c1' }] });
    expect(loaded.table_name).toMatch(/^load_cards_\d{8}$/);
  });

  it('rejects a column that was not advertised', async () => {
    const scratch = createFakeScratchDb();
    const loaded = await scratch.load({ source_tool: 'load_cards', rows: [{ id: 'c1' }] });
    await expect(
      scratch.process({ table_name: loaded.table_name, cols: ['nope'] }),
    ).rejects.toBeInstanceOf(ScratchDbError);
    await expect(scratch.process({ table_name: 'ghost', cols: ['id'] })).rejects.toSatisfy(
      (error: unknown) => isScratchDbError(error) && error.reason === 'unknown_table',
    );
  });

  it('rejects every statement the ADR-9 denylist names', async () => {
    const { scratch, table } = await loadedDatabase();
    const cases: [string, string][] = [
      ["ATTACH DATABASE '/tmp/x.db' AS leak", 'denylist'],
      ['DETACH DATABASE leak', 'denylist'],
      ['PRAGMA table_info("t")', 'denylist'],
      ['VACUUM', 'denylist'],
      ['DELETE FROM "t"', 'denylist'],
      ['UPDATE "t" SET a = 1', 'denylist'],
      ['INSERT INTO "t" VALUES (1)', 'denylist'],
      ['DROP TABLE "t"', 'denylist'],
    ];
    for (const [sql, reason] of cases) {
      await expect(scratch.query({ table_name: table, sql }), sql).rejects.toSatisfy(
        (error: unknown) => isScratchDbError(error) && error.reason === reason,
      );
    }
  });

  it('rejects multi-statement input and anything that is not a SELECT', async () => {
    const { scratch, table } = await loadedDatabase();
    await expect(scratch.query({ table_name: table, sql: 'SELECT 1; SELECT 2' })).rejects.toSatisfy(
      (error: unknown) => isScratchDbError(error) && error.reason === 'multi_statement',
    );
    await expect(scratch.query({ table_name: table, sql: 'EXPLAIN SELECT 1' })).rejects.toSatisfy(
      (error: unknown) => isScratchDbError(error) && error.reason === 'not_readonly',
    );
    // A trailing semicolon on a single statement is fine.
    await expect(
      scratch.query({ table_name: table, sql: `SELECT "id" FROM "${table}";` }),
    ).resolves.toBeTruthy();
    // WITH is allowed: window functions and CTEs are encouraged.
    await expect(
      scratch.query({ table_name: table, sql: `WITH x AS (SELECT 1) SELECT * FROM x` }),
    ).resolves.toBeTruthy();
  });

  it('caps the result set and flags it', async () => {
    const scratch = createFakeScratchDb({ maxQueryRows: 2 });
    const loaded = await scratch.load({
      source_tool: 'load_transactions',
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
    });
    await scratch.process({ table_name: loaded.table_name, cols: ['id'] });
    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT "id" FROM "${loaded.table_name}"`,
    });
    expect(result.rows_returned).toBe(2);
    expect(result.capped).toBe(true);
  });

  it('enforces the per-grant table cap', async () => {
    const scratch = createFakeScratchDb({ maxTables: 2 });
    await scratch.load({ source_tool: 'load_cards', rows: [{ id: 1 }] });
    await scratch.load({ source_tool: 'load_cards', rows: [{ id: 2 }] });
    await expect(scratch.load({ source_tool: 'load_cards', rows: [{ id: 3 }] })).rejects.toSatisfy(
      (error: unknown) => isScratchDbError(error) && error.reason === 'grant_cap',
    );
  });

  it('reproduces the timeout path and the worker teardown (ADR-9)', async () => {
    const { scratch, table } = await loadedDatabase();
    scratch.failNextWith('timeout', 'the query exceeded QUERY_TIMEOUT_MS (2000 ms)');
    const bomb =
      'WITH RECURSIVE bomb(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM bomb) SELECT count(*) FROM bomb';
    await expect(scratch.query({ table_name: table, sql: bomb })).rejects.toSatisfy(
      (error: unknown) => isScratchDbError(error) && error.reason === 'timeout',
    );
    expect(scratch.executedSql).toContain(bomb);
    await scratch.terminate('timeout');
    expect(scratch.terminations).toEqual(['timeout']);
    expect(scratch.tableNames()).toEqual([]);
  });

  it('errors when a table is cleared twice', async () => {
    const { scratch, table } = await loadedDatabase();
    await scratch.clear(table);
    await expect(scratch.clear(table)).rejects.toSatisfy(
      (error: unknown) => isScratchDbError(error) && error.reason === 'unknown_table',
    );
  });
});

describe('createFakeXrayEmitter', () => {
  it('assigns monotonic ids and a per-xs seq, and validates the payload', () => {
    const emitter = createFakeXrayEmitter({ correlation: { xs: 'xs_one' } });
    emitter.emit('etl.load', {
      table: 't',
      rows: 2,
      columns_advertised: ['a'],
      source_tool: 'load_cards',
      duration_ms: 3,
    });
    emitter.emit('sql.table_cleared', { table: 't' }, { xs: 'xs_two' });
    emitter.emit('sql.table_cleared', { table: 'u' });
    expect(emitter.events.map((event) => event.id)).toEqual([1, 2, 3]);
    expect(emitter.events.map((event) => event.seq)).toEqual([1, 1, 2]);
    expect(emitter.types()).toEqual(['etl.load', 'sql.table_cleared', 'sql.table_cleared']);
    expect(emitter.ofType('sql.table_cleared')).toHaveLength(2);
    expect(emitter.lastOfType('sql.table_cleared')?.data.table).toBe('u');
    expect(emitter.lastOfType('server.started')).toBeUndefined();
    emitter.clear();
    expect(emitter.events).toEqual([]);
  });

  it('fails loudly on a malformed payload, so a block bug surfaces in its own test', () => {
    const emitter = createFakeXrayEmitter();
    expect(() =>
      emitter.emit('sql.query', {
        table: null,
        sql: 'SELECT 1',
        rows_returned: -1,
        capped: false,
        duration_ms: 1,
      }),
    ).toThrow();
  });

  it('uses the injected clock', () => {
    const emitter = createFakeXrayEmitter({ now: () => new Date('2030-01-01T00:00:00.000Z') });
    emitter.emit('catalog.prompts_listed', { count: 0 });
    expect(emitter.events[0]?.ts).toBe('2030-01-01T00:00:00.000Z');
    expect(FAKE_NOW.toISOString()).toBe('2026-09-08T12:00:00.000Z');
  });
});

describe('createFakePairing', () => {
  it('mints well-formed, distinct codes bound to the login', async () => {
    const pairing = createFakePairing();
    const first = await pairing.createCode({ login_id: 'lgn_one' });
    const second = await pairing.createCode({ login_id: 'lgn_two' });
    expect(first.code).not.toBe(second.code);
    expect(pairing.issued).toHaveLength(2);
    expect((await pairing.exchange(first.code)).ok).toBe(true);
    // Multi-use within the TTL (ADR-10): a reload must keep working.
    expect((await pairing.exchange(first.code)).ok).toBe(true);
  });

  it('reports expiry and rate limits failures per IP prefix', async () => {
    const pairing = createFakePairing({ maxFailures: 2 });
    const code = await pairing.createCode({ login_id: 'lgn_one' });
    pairing.expireNext();
    expect(await pairing.exchange(code.code, { remote_ip_prefix: '10.0.0.0/24' })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(
      (await pairing.exchange('BANK-AAAA-AAAA-AA', { remote_ip_prefix: '10.0.0.0/24' })).ok,
    ).toBe(false);
    expect(await pairing.exchange(code.code, { remote_ip_prefix: '10.0.0.0/24' })).toEqual({
      ok: false,
      reason: 'rate_limited',
    });
    // A different caller is unaffected.
    expect((await pairing.exchange(code.code, { remote_ip_prefix: '10.0.1.0/24' })).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('paginate clamps the limit and tolerates a broken cursor', () => {
    const rows = [1, 2, 3];
    expect(paginate(rows, { limit: 0 }).data).toEqual([1]);
    expect(paginate(rows, { cursor: 'nonsense' }).data).toEqual(rows);
    expect(paginate(rows).page.next).toBeNull();
  });

  it('bankScopeOf turns an AuthContext into a BankScope', () => {
    const auth = createFakeAuthContext();
    expect(bankScopeOf(auth)).toEqual({
      persona_id: auth.persona.id,
      login_id: auth.login_id,
      grant_id: auth.grant_id,
    });
    expect(bankScopeOf(createFakeAuthContext({ login_id: null })).login_id).toBe('lgn_anonymous');
  });
});
