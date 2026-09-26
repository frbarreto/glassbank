/**
 * The ADR-15 layering: immutable datasets under per-login copy-on-write overlays, both bounded.
 *
 * The isolation test is the one this design exists for (A-14, invariant 16). Glass Bank is public
 * and passwordless: two strangers pick "Ava Stone" at the same time, one of them locks a card, and
 * the other one must not notice. Everything else here is the memory story of invariant 14 - an LRU
 * that evicts, a dataset that comes back byte-identical afterwards, and an idle reset that gives a
 * shared demo identity back to the next person in its seed state.
 */
import { describe, expect, it } from 'vitest';

import { generateDataset } from '../seed.js';
import { personaForSeed } from '../personas.js';
import { AVA, HARBOR, LOGIN_A, LOGIN_B, NOAH, createHarness, scopeOf } from './harness.js';

const loginA = scopeOf(AVA, LOGIN_A);
const loginB = scopeOf(AVA, LOGIN_B);

describe('two logins on one shared persona never see each other writes', () => {
  it('a card locked under login A is still active under login B', async () => {
    const { bank } = createHarness();
    const dataset = await bank.dataset(AVA);
    const card = dataset.cards.find((candidate) => candidate.status === 'active')!;

    const locked = await bank.lockCard(loginA, card.id, 'login A locks it');
    expect(locked.ok).toBe(true);

    const seenByA = await bank.listCards(loginA);
    expect(seenByA.data.find((c) => c.id === card.id)!.status).toBe('locked');

    const seenByB = await bank.listCards(loginB);
    expect(seenByB.data.find((c) => c.id === card.id)!.status).toBe('active');

    // And the seed dataset itself was never touched.
    expect((await bank.dataset(AVA)).cards.find((c) => c.id === card.id)!.status).toBe('active');
  });

  it('a confirmed transfer changes only the balances, transfers and audit of its own login', async () => {
    const { bank } = createHarness();
    const dataset = await bank.dataset(AVA);
    const checking = dataset.accounts.find(
      (account) => account.account_type === 'checking' && account.status === 'open',
    )!;
    const payee = dataset.payees.find((candidate) => candidate.is_active)!;

    const quote = await bank.previewTransfer(loginA, {
      from_account_id: checking.id,
      to: { payee_id: payee.id },
      amount: 75_000,
      currency: 'USD',
    });
    if (!quote.ok) throw new Error(quote.reason);
    const done = await bank.confirmTransfer(loginA, {
      preview_id: quote.preview.preview_id,
      expected_total_amount: quote.preview.expected_total_amount,
    });
    expect(done.ok).toBe(true);

    const balancesA = await bank.getBalances(loginA);
    const balancesB = await bank.getBalances(loginB);
    expect(balancesB.total_cash_cents - balancesA.total_cash_cents).toBe(quote.preview.total);

    const today = { from_date: '2026-09-08', to_date: '2026-09-08' } as const;
    expect((await bank.listTransfers(loginA, today)).data.length).toBe(1);
    expect((await bank.listTransfers(loginB, today)).data.length).toBe(0);

    expect((await bank.listAuditEntries(loginA)).data.length).toBe(1);
    expect((await bank.listAuditEntries(loginB)).data.length).toBe(0);
  });

  it('keeps overlays of different personas apart on the same login', async () => {
    const { bank } = createHarness();
    const ava = await bank.dataset(AVA);
    const card = ava.cards.find((candidate) => candidate.status === 'active')!;
    await bank.lockCard(loginA, card.id);

    expect(bank.peekOverlay(AVA, LOGIN_A)?.card_status[card.id]).toBe('locked');
    expect(bank.peekOverlay(NOAH, LOGIN_A)).toBeUndefined();
  });
});

describe('dataset LRU (MAX_MATERIALISED_PERSONAS)', () => {
  it('evicts the least recently used dataset and regenerates it byte-identically', async () => {
    const { bank, emitter } = createHarness({ config: { maxMaterialisedPersonas: 1 } });

    const before = await bank.dataset(AVA);
    const beforeJson = JSON.stringify(before);
    expect(bank.stats().materialised_datasets).toBe(1);

    await bank.dataset(NOAH);
    expect(bank.stats().materialised_datasets).toBe(1);
    const evictions = emitter
      .ofType('bank.op')
      .filter((event) => event.data.operation === 'overlay.reset');
    expect(evictions.length).toBeGreaterThanOrEqual(1);
    expect(evictions[0]!.data.error).toContain('MAX_MATERIALISED_PERSONAS');

    const after = await bank.dataset(AVA);
    expect(JSON.stringify(after)).toBe(beforeJson);
  });

  it('serves the same object while it stays cached', async () => {
    const { bank } = createHarness();
    expect(await bank.dataset(AVA)).toBe(await bank.dataset(AVA));
  });

  it('regenerates when the UTC day rolls over', async () => {
    const { bank, clock } = createHarness();
    const day1 = await bank.dataset(AVA);
    clock.set(new Date('2026-09-09T12:00:00.000Z'));
    const day2 = await bank.dataset(AVA);
    expect(day2.generated_at).toBe('2026-09-09T00:00:00.000Z');
    expect(day2).not.toEqual(day1);
    expect(day2).toEqual(
      generateDataset(day2.persona, { asOf: new Date('2026-09-09T00:00:00.000Z') }),
    );
  });
});

describe('overlay LRU and TTL (MAX_PERSONA_OVERLAYS, PERSONA_OVERLAY_TTL_HOURS)', () => {
  it('evicts the least recently used overlay, which drops that login writes', async () => {
    const { bank, emitter } = createHarness({ config: { maxPersonaOverlays: 2 } });
    const card = (await bank.dataset(AVA)).cards.find((c) => c.status === 'active')!;

    await bank.lockCard(scopeOf(AVA, 'lgn_one'), card.id);
    await bank.lockCard(scopeOf(AVA, 'lgn_two'), card.id);
    expect(bank.stats().overlays).toBe(2);

    await bank.lockCard(scopeOf(AVA, 'lgn_three'), card.id);
    expect(bank.stats().overlays).toBe(2);
    expect(bank.peekOverlay(AVA, 'lgn_one')).toBeUndefined();
    expect(bank.peekOverlay(AVA, 'lgn_three')?.card_status[card.id]).toBe('locked');

    const evicted = emitter
      .ofType('bank.op')
      .filter((event) => (event.data.error ?? '').includes('MAX_PERSONA_OVERLAYS'));
    expect(evicted).toHaveLength(1);
    expect(evicted[0]!.login_id).toBe('lgn_one');

    // The evicted login gets a fresh overlay and therefore the seed state back.
    const cards = await bank.listCards(scopeOf(AVA, 'lgn_one'));
    expect(cards.data.find((c) => c.id === card.id)!.status).toBe('active');
  });

  it('resets a shared persona overlay after the idle TTL', async () => {
    const { bank, emitter, clock } = createHarness({ config: { personaOverlayTtlHours: 1 } });
    const card = (await bank.dataset(AVA)).cards.find((c) => c.status === 'active')!;
    await bank.lockCard(loginA, card.id);
    expect((await bank.listCards(loginA)).data.find((c) => c.id === card.id)!.status).toBe('locked');

    clock.advanceHours(2);
    const cards = await bank.listCards(loginA);
    expect(cards.data.find((c) => c.id === card.id)!.status).toBe('active');
    expect((await bank.listAuditEntries(loginA)).data).toHaveLength(0);

    const resets = emitter
      .ofType('bank.op')
      .filter((event) => (event.data.error ?? '').includes('reset after ttl'));
    expect(resets).toHaveLength(1);
    expect(resets[0]!.persona_id).toBe(AVA);
  });

  it('does not TTL-reset a private generated persona', async () => {
    const { bank, clock } = createHarness({ config: { personaOverlayTtlHours: 1 } });
    const persona = await bank.personas.createDemoPersona({ seed: 'demo1234' });
    expect(persona.shared).toBe(false);
    const scope = scopeOf(persona.id, LOGIN_A);
    const card = (await bank.dataset(persona.id)).cards.find((c) => c.status === 'active')!;
    await bank.lockCard(scope, card.id);

    clock.advanceHours(5);
    const cards = await bank.listCards(scope);
    expect(cards.data.find((c) => c.id === card.id)!.status).toBe('locked');
  });

  it('drops every overlay and preview on resetOverlays (what a restart does, A-15)', async () => {
    const { bank } = createHarness();
    const dataset = await bank.dataset(AVA);
    const card = dataset.cards.find((c) => c.status === 'active')!;
    const checking = dataset.accounts.find(
      (a) => a.account_type === 'checking' && a.status === 'open',
    )!;
    const payee = dataset.payees.find((p) => p.is_active)!;
    await bank.lockCard(loginA, card.id);
    const quote = await bank.previewTransfer(loginA, {
      from_account_id: checking.id,
      to: { payee_id: payee.id },
      amount: 1_000,
      currency: 'USD',
    });
    if (!quote.ok) throw new Error(quote.reason);
    expect(bank.stats().open_previews).toBe(1);

    bank.resetOverlays();

    expect(bank.stats().overlays).toBe(0);
    expect(bank.stats().open_previews).toBe(0);
    expect((await bank.listCards(loginA)).data.find((c) => c.id === card.id)!.status).toBe('active');
    const confirmed = await bank.confirmTransfer(loginA, {
      preview_id: quote.preview.preview_id,
      expected_total_amount: quote.preview.expected_total_amount,
    });
    expect(confirmed.ok).toBe(false);
  });

  it('bounds the audit trail per overlay', async () => {
    const { bank } = createHarness({ config: { maxAuditEntriesPerOverlay: 3 } });
    const card = (await bank.dataset(AVA)).cards.find((c) => c.status === 'active')!;
    for (let index = 0; index < 6; index += 1) {
      await bank.lockCard(loginA, card.id, `attempt ${index}`);
    }
    const audit = await bank.listAuditEntries(loginA);
    expect(audit.data).toHaveLength(3);
    expect(audit.data[0]!.rationale).toBe('attempt 5');
  });
});

describe('the persona directory', () => {
  it('lists the three shared demo identities with the ids src/auth already serves', async () => {
    const { bank } = createHarness();
    const personas = await bank.personas.list();
    expect(personas.map((persona) => persona.id)).toEqual([AVA, NOAH, HARBOR]);
    expect(personas.map((persona) => persona.name)).toEqual([
      'Ava Stone',
      'Noah Reid',
      'Harbor Supply Co.',
    ]);
    expect(personas.every((persona) => persona.shared)).toBe(true);
    expect(personas.find((persona) => persona.kind === 'business')!.id).toBe(HARBOR);
  });

  it('mints a demo persona and recovers it from its id alone (A-15)', async () => {
    const { bank } = createHarness({ randomSeed: () => 'abcd1234' });
    const minted = await bank.personas.createDemoPersona();
    expect(minted.id).toBe('per_abcd1234');
    expect(minted.shared).toBe(false);

    const fresh = createHarness().bank;
    const recovered = await fresh.personas.get('per_abcd1234');
    expect(recovered).toEqual(minted);
    expect(recovered).toEqual(personaForSeed('abcd1234'));
  });

  it('refuses an id that is not a persona id or is too short', async () => {
    const { bank } = createHarness();
    expect(await bank.personas.get('lgn_whatever')).toBeNull();
    expect(await bank.personas.get('per_ab')).toBeNull();
  });

  it('bounds how many generated personas it remembers', async () => {
    const { bank } = createHarness({ config: { maxGeneratedPersonas: 2 } });
    for (const seed of ['seed0001', 'seed0002', 'seed0003']) {
      await bank.personas.createDemoPersona({ seed });
    }
    expect(bank.stats().generated_personas).toBe(2);
  });
});

describe('bank.op events (invariant 13)', () => {
  it('emits one validated event per operation with masked ids', async () => {
    const { bank, emitter } = createHarness();
    const dataset = await bank.dataset(AVA);
    const card = dataset.cards.find((c) => c.status === 'active')!;
    const checking = dataset.accounts.find(
      (a) => a.account_type === 'checking' && a.status === 'open',
    )!;
    const payee = dataset.payees.find((p) => p.is_active)!;
    emitter.clear();

    await bank.listAccounts(loginA);
    await bank.listCards(loginA, { account_id: checking.id });
    await bank.listTransactions(loginA, { from_date: '2026-09-01', to_date: '2026-09-08' });
    await bank.listTransfers(loginA, { from_date: '2026-09-01', to_date: '2026-09-08' });
    await bank.listBills(loginA, { from_date: '2026-09-01', to_date: '2026-09-08' });
    await bank.listPayees(loginA);
    await bank.listStatementLines(loginA, { from_date: '2026-09-01', to_date: '2026-09-08' });
    await bank.listAuditEntries(loginA);
    await bank.listCategories();
    await bank.listCurrencies();
    await bank.getBalances(loginA);
    await bank.lockCard(loginA, card.id, 'why');
    const quote = await bank.previewTransfer(loginA, {
      from_account_id: checking.id,
      to: { payee_id: payee.id },
      amount: 5_000,
      currency: 'USD',
    });
    if (!quote.ok) throw new Error(quote.reason);
    await bank.confirmTransfer(loginA, {
      preview_id: quote.preview.preview_id,
      expected_total_amount: quote.preview.expected_total_amount,
    });

    expect(emitter.operations()).toEqual([
      'accounts.list',
      'cards.list',
      'transactions.list',
      'transfers.list',
      'bills.list',
      'payees.list',
      'statement_lines.list',
      'audit.list',
      'categories.list',
      'currencies.list',
      'balances.get',
      'card.lock',
      'transfer.preview',
      'transfer.confirm',
    ]);

    const cardsEvent = emitter
      .ofType('bank.op')
      .find((event) => event.data.operation === 'cards.list')!;
    expect(cardsEvent.data.account_id).toBe(`****${checking.id.slice(-4)}`);
    expect(cardsEvent.data.rows).toBeGreaterThan(0);
    expect(cardsEvent.data.pages).toBe(1);
    expect(cardsEvent.data.ok).toBe(true);
    expect(cardsEvent.data.latency_ms).toBeGreaterThanOrEqual(0);
    expect(cardsEvent.persona_id).toBe(AVA);
    expect(cardsEvent.login_id).toBe(LOGIN_A);

    const lockEvent = emitter
      .ofType('bank.op')
      .find((event) => event.data.operation === 'card.lock')!;
    expect(lockEvent.data.card_id).toBe(`****${card.id.slice(-4)}`);
    expect(lockEvent.data.audit_id).toMatch(/^aud_/);

    const confirmEvent = emitter
      .ofType('bank.op')
      .find((event) => event.data.operation === 'transfer.confirm')!;
    expect(confirmEvent.data.preview_id).toBe(quote.preview.preview_id);
    expect(confirmEvent.data.audit_id).toMatch(/^aud_/);
  });

  it('records a rejected write as ok=false with the contract reason', async () => {
    const { bank, emitter } = createHarness();
    const fraud = (await bank.dataset(AVA)).cards.find((c) => c.status === 'fraud_locked')!;
    emitter.clear();
    await bank.unlockCard(loginA, fraud.id);
    const event = emitter.ofType('bank.op')[0]!;
    expect(event.data.operation).toBe('card.unlock');
    expect(event.data.ok).toBe(false);
    expect(event.data.error).toBe('fraud_locked');
    expect(event.data.audit_id).toBeNull();
  });

  it('never puts a caller-supplied preview id on an event unless it is well formed', async () => {
    const { bank, emitter } = createHarness();
    emitter.clear();
    await bank.confirmTransfer(loginA, {
      preview_id: 'definitely not an id',
      expected_total_amount: 1,
    });
    const event = emitter.ofType('bank.op')[0]!;
    expect(event.data.preview_id).toBeNull();
    expect(event.data.error).toBe('unknown_preview');
  });
});
