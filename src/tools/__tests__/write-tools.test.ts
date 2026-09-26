/**
 * The two write tools: `lock_or_unlock_card` and the two-step `create_transfer`
 * (docs/TOOL_CATALOG.md section 7).
 *
 * Every rejection the bank can answer with is exercised here, because a write tool that reports a
 * refusal badly is worse than one that refuses: the model would tell the user the money moved.
 */
import { describe, expect, it } from 'vitest';

import type { Account, Payee, ToolResult } from '../../contracts/index.js';
import { createTools } from '../index.js';

import { FAKE_READ_WRITE_SCOPES, createFakeToolContext, type FakeToolContext } from './fakes.js';

const SCOPE = { persona_id: 'per_ava01', login_id: 'lgn_demo01' };

function writeContext(overrides: Record<string, unknown> = {}): FakeToolContext {
  return createFakeToolContext({ auth: { scopes: FAKE_READ_WRITE_SCOPES }, ...overrides });
}

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join('');
}

/** The checking account with the most money, so the amounts below are always affordable. */
async function fundedAccount(context: FakeToolContext): Promise<Account> {
  const page = await context.bank.listAccounts(SCOPE);
  const account = [...page.data]
    .filter((candidate) => candidate.account_type === 'checking')
    .sort((left, right) => right.available_balance_cents - left.available_balance_cents)[0];
  if (account === undefined) throw new Error('no checking account in the fake dataset');
  expect(account.available_balance_cents).toBeGreaterThan(600_000);
  return account;
}

async function payee(context: FakeToolContext, rail: 'ach' | 'wire'): Promise<Payee> {
  const page = await context.bank.listPayees(SCOPE, { is_active: true });
  const found = page.data.find((candidate) => candidate.rail === rail);
  if (found === undefined) throw new Error(`no active ${rail} payee in the fake dataset`);
  return found;
}

describe('lock_or_unlock_card', () => {
  const registry = createTools();

  it('locks an active card, appends an audit entry and carries the rationale into it', async () => {
    const context = writeContext();
    const result = await registry.call(
      'lock_or_unlock_card',
      {
        card_id: 'card_ava01_01',
        action: 'lock',
        rationale: 'The user said their card was stolen.',
      },
      context,
    );
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain('is now locked');
    expect(result.structuredContent).toMatchObject({
      card_id: 'card_ava01_01',
      status: 'locked',
      changed: true,
    });

    const overlay = context.bank.peekOverlay('per_ava01', 'lgn_demo01');
    expect(overlay?.card_status['card_ava01_01']).toBe('locked');
    expect(overlay?.audit[0]).toMatchObject({
      action: 'card.lock',
      target_id: 'card_ava01_01',
      rationale: 'The user said their card was stolen.',
    });
  });

  it('is idempotent: locking a locked card changes nothing and is not an error', async () => {
    const context = writeContext();
    await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_ava01_01', action: 'lock', rationale: 'freeze' },
      context,
    );
    const again = await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_ava01_01', action: 'lock', rationale: 'freeze again' },
      context,
    );
    expect(again.isError).toBeUndefined();
    expect(text(again)).toContain('was already locked; nothing changed');
    expect(again.structuredContent).toMatchObject({ changed: false });
  });

  it('unlocks a locked card', async () => {
    const context = writeContext();
    const result = await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_ava01_02', action: 'unlock', rationale: 'the user found it' },
      context,
    );
    expect(text(result)).toContain('is now active');
    expect(result.structuredContent).toMatchObject({ status: 'active', changed: true });
  });

  it('refuses a fraud_locked card and says who can release it', async () => {
    const context = writeContext();
    const result = await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_ava01_20', action: 'unlock', rationale: 'the user wants it back' },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('fraud_locked');
    expect(text(result)).toContain('locked by the bank');
  });

  it('refuses an unknown card', async () => {
    const context = writeContext();
    const result = await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_nope', action: 'lock', rationale: 'freeze' },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('unknown_card');
  });

  it('is refused under a read-only grant, but is still listed (ADR-13)', async () => {
    const context = createFakeToolContext();
    const result = await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_ava01_01', action: 'lock', rationale: 'freeze' },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('cards:write');
    // The bank was never asked, so the login has no overlay at all.
    expect(context.bank.peekOverlay('per_ava01', 'lgn_demo01')).toBeUndefined();
    expect(
      registry
        .listFor({ scopes: context.auth.scopes, auth_level: 'read_only' }, ['writes', 'transfers'])
        .listed.map((entry) => entry.name),
    ).toContain('lock_or_unlock_card');
  });
});

describe('create_transfer: preview then confirm', () => {
  it('previews without moving money, then sends on confirm', async () => {
    const registry = createTools();
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    const args = {
      from_account_id: account.id,
      to: { payee_id: destination.id },
      amount: 12_500,
      currency: 'USD',
    };

    const preview = await registry.call(
      'create_transfer',
      { ...args, rationale: 'The user asked to pay the landscaper.' },
      context,
    );
    expect(preview.isError).toBeUndefined();
    expect(text(preview)).toContain('Preview only: no money has moved');
    expect(text(preview)).toContain('12500 cents ($125.00)');
    expect(text(preview)).toContain('explicit approval');
    expect(preview.structuredContent).toMatchObject({
      amount: 12_500,
      fee: 0,
      total: 12_500,
      expected_total_amount: 12_500,
      rail: 'ach',
      confirmed: false,
    });
    expect(context.bank.peekOverlay('per_ava01', 'lgn_demo01')?.transfers ?? []).toHaveLength(0);
    expect(registry.stats().openPreviews).toBe(1);

    const sent = await registry.call(
      'create_transfer',
      {
        ...args,
        confirm: true,
        expected_total_amount: 12_500,
        rationale: 'The user approved the transfer.',
      },
      context,
    );
    expect(sent.isError).toBeUndefined();
    expect(text(sent)).toContain('is completed');
    expect(sent.structuredContent).toMatchObject({
      status: 'completed',
      total: 12_500,
      confirmed: true,
    });
    const overlay = context.bank.peekOverlay('per_ava01', 'lgn_demo01');
    expect(overlay?.transfers).toHaveLength(1);
    expect(overlay?.balance_delta_cents[account.id]).toBe(-12_500);
    expect(overlay?.audit.at(-1)).toMatchObject({
      action: 'transfer.confirm',
      rationale: 'The user approved the transfer.',
    });
    expect(registry.stats().openPreviews).toBe(0);
  });

  it('charges the wire fee and shows it in the total', async () => {
    const registry = createTools();
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'wire');
    const preview = await registry.call(
      'create_transfer',
      {
        from_account_id: account.id,
        to: { payee_id: destination.id },
        amount: 20_000,
        currency: 'USD',
        rationale: 'wire it',
      },
      context,
    );
    expect(preview.structuredContent).toMatchObject({ fee: 2_500, total: 22_500, rail: 'wire' });
    expect(text(preview)).toContain('Fee: 2500 cents ($25.00)');
  });

  it('moves money between the customer own accounts over the internal rail', async () => {
    const registry = createTools();
    const context = writeContext();
    const accounts = await context.bank.listAccounts(SCOPE);
    const from = await fundedAccount(context);
    const to = accounts.data.find((candidate) => candidate.id !== from.id);
    const preview = await registry.call(
      'create_transfer',
      {
        from_account_id: from.id,
        to: { account_id: to!.id },
        amount: 5_000,
        currency: 'USD',
        rationale: 'move savings',
      },
      context,
    );
    expect(preview.structuredContent).toMatchObject({ rail: 'internal', fee: 0 });
    expect(text(preview)).toContain(`to account ${to!.id}`);
  });
});

describe('create_transfer: every refusal', () => {
  const registry = createTools();

  it('refuses a confirm with no preview open', async () => {
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    const result = await registry.call(
      'create_transfer',
      {
        from_account_id: account.id,
        to: { payee_id: destination.id },
        amount: 1_000,
        currency: 'USD',
        confirm: true,
        expected_total_amount: 1_000,
        rationale: 'send it',
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no open preview matches this transfer');
  });

  it('refuses a confirm without expected_total_amount', async () => {
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    const result = await registry.call(
      'create_transfer',
      {
        from_account_id: account.id,
        to: { payee_id: destination.id },
        amount: 1_000,
        currency: 'USD',
        confirm: true,
        rationale: 'send it',
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('expected_total_amount is required');
  });

  it('will not let an approval for one transfer pay for another', async () => {
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    await registry.call(
      'create_transfer',
      {
        from_account_id: account.id,
        to: { payee_id: destination.id },
        amount: 1_000,
        currency: 'USD',
        rationale: 'preview the small one',
      },
      context,
    );
    const result = await registry.call(
      'create_transfer',
      {
        from_account_id: account.id,
        to: { payee_id: destination.id },
        amount: 90_000,
        currency: 'USD',
        confirm: true,
        expected_total_amount: 90_000,
        rationale: 'sneak a bigger one through',
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no open preview matches this transfer');
    expect(context.bank.peekOverlay('per_ava01', 'lgn_demo01')?.transfers ?? []).toHaveLength(0);
  });

  it('refuses a confirm whose expected total does not match the preview (reprice guard)', async () => {
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    const args = {
      from_account_id: account.id,
      to: { payee_id: destination.id },
      amount: 7_000,
      currency: 'USD',
    };
    await registry.call('create_transfer', { ...args, rationale: 'preview' }, context);
    const result = await registry.call(
      'create_transfer',
      { ...args, confirm: true, expected_total_amount: 6_000, rationale: 'confirm' },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('does not match the preview total');
    expect(context.bank.peekOverlay('per_ava01', 'lgn_demo01')?.transfers ?? []).toHaveLength(0);
  });

  it('shows the new total when the transfer repriced, and sends once it is approved again', async () => {
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    const args = {
      from_account_id: account.id,
      to: { payee_id: destination.id },
      amount: 8_000,
      currency: 'USD',
    };
    await registry.call('create_transfer', { ...args, rationale: 'preview' }, context);
    context.bank.repriceNextConfirm(750);

    const repriced = await registry.call(
      'create_transfer',
      { ...args, confirm: true, expected_total_amount: 8_000, rationale: 'confirm' },
      context,
    );
    expect(repriced.isError).toBe(true);
    expect(text(repriced)).toContain('The total is now 8750 cents');
    expect(text(repriced)).toContain('only if they approve it');

    const sent = await registry.call(
      'create_transfer',
      { ...args, confirm: true, expected_total_amount: 8_750, rationale: 'user approved 8750' },
      context,
    );
    expect(sent.isError).toBeUndefined();
    expect(sent.structuredContent).toMatchObject({ confirmed: true });
  });

  it.each([
    [
      'insufficient_funds',
      (account: Account) => ({ from_account_id: account.id, amount: 499_999 }),
      'insufficient_funds',
    ],
    [
      'over_limit',
      (account: Account) => ({ from_account_id: account.id, amount: 900_000 }),
      'over_limit',
    ],
  ])('refuses %s at the preview step', async (_name, build, reason) => {
    const context = writeContext();
    const page = await context.bank.listAccounts(SCOPE);
    const poorest = [...page.data]
      .filter((candidate) => candidate.account_type !== 'credit_card')
      .sort((left, right) => left.available_balance_cents - right.available_balance_cents)[0];
    const destination = await payee(context, 'ach');
    const result = await registry.call(
      'create_transfer',
      {
        ...build(poorest!),
        to: { payee_id: destination.id },
        currency: 'USD',
        rationale: 'try it',
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain(reason);
    expect(text(result)).toContain('the transfer was rejected');
  });

  it('refuses an unknown account, an unknown payee, an archived payee and a foreign currency', async () => {
    const context = writeContext();
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    const base = { amount: 1_000, currency: 'USD', rationale: 'try it' };

    expect(
      text(
        await registry.call(
          'create_transfer',
          { ...base, from_account_id: 'acc_nope', to: { payee_id: destination.id } },
          context,
        ),
      ),
    ).toContain('unknown_account');

    expect(
      text(
        await registry.call(
          'create_transfer',
          { ...base, from_account_id: account.id, to: { payee_id: 'pay_nope' } },
          context,
        ),
      ),
    ).toContain('unknown_payee');

    const archived = (await context.bank.listPayees(SCOPE, { is_active: false })).data[0];
    expect(
      text(
        await registry.call(
          'create_transfer',
          { ...base, from_account_id: account.id, to: { payee_id: archived!.id } },
          context,
        ),
      ),
    ).toContain('payee_inactive');

    expect(
      text(
        await registry.call(
          'create_transfer',
          {
            ...base,
            currency: 'EUR',
            from_account_id: account.id,
            to: { payee_id: destination.id },
          },
          context,
        ),
      ),
    ).toContain('currency_not_supported');
  });

  it('rejects a malformed amount and a malformed destination before the bank is asked', async () => {
    const context = writeContext();
    const account = await fundedAccount(context);

    const badAmount = await registry.call(
      'create_transfer',
      {
        from_account_id: account.id,
        to: { payee_id: 'pay_ava01_02' },
        amount: 12.5,
        currency: 'USD',
        rationale: 'half a cent',
      },
      context,
    );
    expect(badAmount.isError).toBe(true);
    expect(text(badAmount)).toContain('did not match its schema');

    // `to` with neither key cannot get past the union in the lenient schema, so the handler's own
    // guard is checked directly: it is the second line, not the only one.
    const handler = registry.handlers.create_transfer;
    const direct = await handler!(
      { ...context, tool: 'create_transfer', rationale: null, rationale_truncated: false },
      { from_account_id: account.id, to: {}, amount: 1_000, currency: 'USD', confirm: false },
    );
    expect(direct.isError).toBe(true);
    expect(text(direct)).toContain('exactly one of');
  });

  it('forgets a preview once it has expired, instead of sending an approval the user has moved on from', async () => {
    let clock = new Date('2026-09-08T12:00:00.000Z');
    const context = createFakeToolContext({
      auth: { scopes: FAKE_READ_WRITE_SCOPES },
      now: () => clock,
    });
    const account = await fundedAccount(context);
    const destination = await payee(context, 'ach');
    const args = {
      from_account_id: account.id,
      to: { payee_id: destination.id },
      amount: 3_000,
      currency: 'USD',
    };
    await registry.call('create_transfer', { ...args, rationale: 'preview' }, context);

    // The bank gives a preview 15 minutes (docs/TOOL_CATALOG.md section 7); a confirm after that
    // has to start again, so the user approves a total that is still true.
    clock = new Date('2026-09-08T12:16:00.000Z');
    const late = await registry.call(
      'create_transfer',
      { ...args, confirm: true, expected_total_amount: 3_000, rationale: 'confirm late' },
      context,
    );
    expect(late.isError).toBe(true);
    expect(text(late)).toContain('no open preview matches this transfer');
    expect(context.bank.peekOverlay('per_ava01', 'lgn_demo01')?.transfers ?? []).toHaveLength(0);
  });

  it('keeps the open-preview memory bounded', async () => {
    const bounded = createTools({ limits: { maxOpenPreviews: 1 } });
    const context = writeContext();
    const account = await fundedAccount(context);
    const first = await payee(context, 'ach');
    const second = await payee(context, 'wire');
    const base = { from_account_id: account.id, currency: 'USD', amount: 2_000 };

    await bounded.call(
      'create_transfer',
      { ...base, to: { payee_id: first.id }, rationale: 'first' },
      context,
    );
    await bounded.call(
      'create_transfer',
      { ...base, to: { payee_id: second.id }, rationale: 'second' },
      context,
    );
    expect(bounded.stats().openPreviews).toBe(1);

    const evicted = await bounded.call(
      'create_transfer',
      {
        ...base,
        to: { payee_id: first.id },
        confirm: true,
        expected_total_amount: 2_000,
        rationale: 'confirm the first',
      },
      context,
    );
    expect(evicted.isError).toBe(true);
    expect(text(evicted)).toContain('no open preview matches this transfer');
  });

  it('is refused under a read-only grant and moves nothing', async () => {
    const context = createFakeToolContext();
    const result = await registry.call(
      'create_transfer',
      {
        from_account_id: 'acc_ava01_01',
        to: { payee_id: 'pay_ava01_02' },
        amount: 1_000,
        currency: 'USD',
        rationale: 'send it',
      },
      context,
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('transfers:write');
    expect(context.xray.lastOfType('tool.call.denied')?.data.missing_scopes).toEqual([
      'transfers:write',
    ]);
  });
});
