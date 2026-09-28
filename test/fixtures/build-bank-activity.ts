/**
 * Builds `test/fixtures/bank-activity.json`: the account view `?fixture=1` shows (contracts
 * v0.10, D-31), so the dashboard's Account page works with no server, like the recorded timeline.
 *
 * It is the real `buildBankActivity` of `src/composition.ts` over the real seeded bank, anchored to
 * the day of the recorded session (2026-09-08), after the two writes an agent makes in the demo: a
 * card lock and a confirmed transfer, each with its rationale, so "Changed by the agent" has
 * something to show. The recorded timeline's persona (`per_a1b2`, "Ava Bennett") is a hand-made
 * stand-in, so this file keeps the seeded persona's own name and id and the page says so.
 *
 *     npx tsx test/fixtures/build-bank-activity.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createBankCore } from '../../src/bank-core/index.js';
import { buildBankActivity } from '../../src/composition.js';
import type { XrayBankActivityResponse, XrayBankSummary } from '../../src/contracts/index.js';

const NOW = new Date('2026-09-08T11:07:40.000Z');
const PERSONA_ID = 'per_ava_stone';
const LOGIN_ID = 'lgn_5d2c7a';
const GRANT_ID = 'grt_8a1e33';
const XS = 'xs_3f1c9a';

const bank = createBankCore({ emitter: { emit: () => undefined }, now: () => NOW });
const scope = { persona_id: PERSONA_ID, login_id: LOGIN_ID, grant_id: GRANT_ID };

const persona = await bank.personas.get(PERSONA_ID);
if (!persona) throw new Error(`the seed has no ${PERSONA_ID}`);

// The two writes of the demo, on this login's overlay (ADR-15).
const cards = await bank.listCards(scope, { limit: 100 });
const card = cards.data.find((candidate) => candidate.status === 'active');
if (card) {
  await bank.lockCard(
    scope,
    card.id,
    'The user reported the card missing after a trip and asked to lock it.',
  );
}
const accounts = await bank.listAccounts(scope, {});
const checking = accounts.data.find((account) => account.account_type === 'checking');
const savings = accounts.data.find((account) => account.account_type === 'savings');
if (checking && savings) {
  const preview = await bank.previewTransfer(scope, {
    from_account_id: checking.id,
    to: { account_id: savings.id },
    amount: 25_000,
    currency: 'USD',
    memo: 'Move $250 to savings',
    rationale: 'The user asked to move $250 from checking to savings.',
  });
  if (preview.ok) {
    await bank.confirmTransfer(scope, {
      preview_id: preview.preview.preview_id,
      expected_total_amount: preview.preview.expected_total_amount,
      rationale: 'The user confirmed the $250 transfer to savings.',
    });
  }
}

const balances = await bank.getBalances(scope);
const all = await bank.listCards(scope, { limit: 100 });
const summary: XrayBankSummary = {
  persona: { id: persona.id, name: persona.name, kind: persona.kind, shared: persona.shared },
  currency: balances.currency,
  as_of: balances.as_of,
  accounts: balances.accounts.map((account) => ({ ...account })),
  total_cash_cents: balances.total_cash_cents,
  total_available_cents: balances.total_available_cents,
  total_credit_owed_cents: balances.total_credit_owed_cents,
  net_position_cents: balances.net_position_cents,
  cards: {
    total: all.data.length,
    active: all.data.filter((entry) => entry.status === 'active').length,
    locked: all.data.filter((entry) => entry.status === 'locked').length,
    fraud_locked: all.data.filter((entry) => entry.status === 'fraud_locked').length,
  },
  transfer_limit_cents: persona.transfer_limit_cents,
};

const activity = await buildBankActivity(bank, scope, summary, 3, NOW);
const response: XrayBankActivityResponse = { ...activity, xs: XS, login_id: LOGIN_ID };
const target = fileURLToPath(new URL('./bank-activity.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(response, null, 2)}\n`);
console.log(
  `wrote ${target}: ${response.lines.length} lines, ${response.by_category.length} categories, ${response.audit.length} audit entries`,
);
