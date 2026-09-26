/**
 * The fakes must satisfy the contract interfaces, so a Phase 1 block can be built and tested
 * against `src/testing/fakes.ts` alone (docs/REPO_LAYOUT.md section 4, point 4).
 *
 * The assignments below are the contract test: they fail to compile if a fake drifts from its
 * interface. The runtime assertions check that the values coming back also match the documented
 * shapes, which a structural type check alone cannot see.
 */
import { describe, expect, it } from 'vitest';

import type {
  AuthContext,
  BankCore,
  Pairing,
  ScratchDb,
  ToolContext,
  XrayEmitter,
} from '../../src/contracts/index.js';
import {
  PAIRING_CODE_PATTERN,
  TOOL_CATALOG,
  catalogAvailability,
  idPattern,
  isScratchDbError,
} from '../../src/contracts/index.js';
import {
  FAKE_PERSONAS,
  FAKE_READ_WRITE_SCOPES,
  bankScopeOf,
  createFakeAuthContext,
  createFakeBankCore,
  createFakePairing,
  createFakeScratchDb,
  createFakeToolContext,
  createFakeXrayEmitter,
} from '../../src/testing/fakes.js';

describe('the fakes satisfy the contract interfaces', () => {
  it('createFakeBankCore is a BankCore', async () => {
    const bank: BankCore = createFakeBankCore();
    const scope = { persona_id: 'per_ava01', login_id: 'lgn_test01' };

    const dataset = await bank.dataset(scope.persona_id);
    expect(dataset.persona.id).toBe('per_ava01');
    expect(dataset.accounts).toHaveLength(20);
    expect(dataset.cards).toHaveLength(20);
    expect(dataset.transactions).toHaveLength(20);
    expect(dataset.transfers).toHaveLength(20);
    expect(dataset.payees).toHaveLength(20);
    expect(dataset.bills).toHaveLength(20);

    const overlay = await bank.overlay(scope.persona_id, scope.login_id);
    expect(overlay.login_id).toBe('lgn_test01');
    expect(overlay.transfers).toEqual([]);

    const accounts = await bank.listAccounts(scope);
    expect(accounts.page.next).toBeNull();
    expect(accounts.data).toHaveLength(20);
    for (const account of accounts.data) {
      expect(account.id).toMatch(idPattern('account'));
      expect(Number.isInteger(account.balance_cents)).toBe(true);
      expect(account.currency).toBe('USD');
      expect(account.account_number_last4).toMatch(/^\d{4}$/);
    }

    const cards = await bank.listCards(scope);
    for (const card of cards.data) {
      expect(card.id).toMatch(idPattern('card'));
      expect(['active', 'locked', 'fraud_locked']).toContain(card.status);
    }

    const transactions = await bank.listTransactions(scope, {
      from_date: '2000-01-01',
      to_date: '2100-01-01',
    });
    expect(transactions.data).toHaveLength(20);
    for (const transaction of transactions.data) {
      expect(transaction.id).toMatch(idPattern('transaction'));
      expect(transaction.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    const transfers = await bank.listTransfers(scope, {
      from_date: '2000-01-01',
      to_date: '2100-01-01',
    });
    expect(transfers.data[0]?.id).toMatch(idPattern('transfer'));

    const bills = await bank.listBills(scope, { from_date: '2000-01-01', to_date: '2100-01-01' });
    expect(bills.data[0]?.id).toMatch(idPattern('bill'));

    const payees = await bank.listPayees(scope);
    expect(payees.data[0]?.id).toMatch(idPattern('payee'));
    expect(payees.data[0]?.account_number_masked).toMatch(/^\*{4}\d{4}$/);

    const statement = await bank.listStatementLines(scope, {
      from_date: '2000-01-01',
      to_date: '2100-01-01',
    });
    expect(new Set(statement.data.map((line) => line.source))).toEqual(
      new Set(['transaction', 'transfer', 'bill']),
    );

    expect((await bank.listCategories()).length).toBeGreaterThan(0);
    expect((await bank.listCurrencies())[0]?.code).toBe('USD');
    expect((await bank.listAuditEntries(scope)).data).toEqual([]);
    expect((await bank.personas.list()).length).toBe(FAKE_PERSONAS.length);
    expect(await bank.personas.get('per_missing')).toBeNull();
  });

  it('createFakeScratchDb is a ScratchDb', async () => {
    const scratch: ScratchDb = createFakeScratchDb({ grantId: 'grt_test01' });
    expect(scratch.grantId).toBe('grt_test01');

    const loaded = await scratch.load({
      source_tool: 'load_accounts',
      rows: [
        { id: 'acc_1', balance: { cents: 100 } },
        { id: 'acc_2', tags: ['a', 'b'] },
      ],
    });
    expect(loaded.rows).toBe(2);
    expect(loaded.columns_advertised).toEqual(['id', 'balance__cents', 'tags']);

    const processed = await scratch.process({
      table_name: loaded.table_name,
      cols: ['id', 'balance__cents'],
    });
    expect(processed.columns_selected).toEqual(['id', 'balance__cents']);

    const result = await scratch.query({
      table_name: loaded.table_name,
      sql: `SELECT "id" FROM "${loaded.table_name}"`,
    });
    expect(result.rows_returned).toBe(2);
    expect(result.capped).toBe(false);
    expect(result.columns).toEqual(['id', 'balance__cents']);

    const tables = await scratch.listTables();
    expect(tables[0]?.processed).toBe(true);

    await scratch.clear(loaded.table_name);
    expect(await scratch.listTables()).toEqual([]);
    await scratch.terminate('shutdown');
  });

  it('createFakeXrayEmitter is an XrayEmitter', () => {
    const emitter: XrayEmitter = createFakeXrayEmitter({ correlation: { xs: 'xs_test01' } });
    emitter.emit('server.started', { boot_id: 'boot_test01', version: '0.1.0' });
    emitter.emit('sql.query', {
      table: 't',
      sql: 'SELECT 1',
      rows_returned: 1,
      capped: false,
      duration_ms: 1,
    });
    const recorded = (emitter as ReturnType<typeof createFakeXrayEmitter>).events;
    expect(recorded).toHaveLength(2);
    expect(recorded.map((event) => event.id)).toEqual([1, 2]);
    expect(recorded.map((event) => event.seq)).toEqual([1, 2]);
    expect(recorded[0]?.v).toBe(1);
  });

  it('createFakeAuthContext is an AuthContext', () => {
    const auth: AuthContext = createFakeAuthContext();
    expect(auth.persona.id).toMatch(idPattern('persona'));
    expect(auth.grant_id).toMatch(idPattern('grant'));
    expect(auth.login_id).toMatch(idPattern('login'));
    expect(auth.xs).toMatch(idPattern('session'));
    expect(auth.boot_id).toMatch(idPattern('boot'));
    expect(auth.auth_level).toBe('read_only');

    const elevated = createFakeAuthContext({ scopes: FAKE_READ_WRITE_SCOPES });
    expect(elevated.auth_level).toBe('read_write');
  });

  it('createFakePairing is a Pairing', async () => {
    const pairing: Pairing = createFakePairing({ publicBaseUrl: 'https://bank.example.com' });
    const minted = await pairing.createCode({ login_id: 'lgn_test01' });
    expect(minted.code).toMatch(PAIRING_CODE_PATTERN);
    expect(minted.url).toBe(`https://bank.example.com/xray/s/${minted.code}`);

    const exchanged = await pairing.exchange(minted.code);
    expect(exchanged).toEqual({
      ok: true,
      login_id: 'lgn_test01',
      viewer_kind: 'pairing',
      expires_at: minted.expires_at,
    });
    expect(await pairing.exchange('BANK-AAAA-AAAA-AA')).toEqual({
      ok: false,
      reason: 'unknown_code',
    });
    const admin = await pairing.exchangeAdminToken('admin-token-for-tests');
    expect(admin.ok).toBe(true);
  });

  it('createFakeToolContext is a ToolContext with everything wired', async () => {
    const context: ToolContext = createFakeToolContext();
    expect(context.auth.persona.name).toBe('Ava Bennett');
    expect(context.limits.maxQueryRows).toBe(100);
    expect(context.limits.budgetMs).toBe(300_000);
    expect(context.featureFlags).toEqual(['writes', 'transfers']);
    expect(context.publicBaseUrl).toMatch(/^https:\/\//);
    expect(context.now()).toBeInstanceOf(Date);

    // A handler can reach the bank, the scratch database, the emitter and pairing from here.
    const accounts = await context.bank.listAccounts(bankScopeOf(context.auth), { limit: 5 });
    expect(accounts.data).toHaveLength(5);
    expect(accounts.page.next).toBe('5');
    context.xray.emit('intent.missing', { tool: 'load_accounts', reason: 'absent' });
    expect((context.xray as ReturnType<typeof createFakeXrayEmitter>).events).toHaveLength(1);

    const availability = catalogAvailability(
      TOOL_CATALOG,
      { scopes: context.auth.scopes },
      context.featureFlags,
    );
    expect(availability).toHaveLength(17);
  });

  it('rejects a scratch query with a typed error the contract exposes', async () => {
    const scratch = createFakeScratchDb();
    scratch.failNextWith('timeout', 'the query exceeded QUERY_TIMEOUT_MS');
    await expect(scratch.query({ table_name: 'nope', sql: 'SELECT 1' })).rejects.toSatisfy(
      (error: unknown) => isScratchDbError(error) && error.reason === 'timeout',
    );
  });
});
