/**
 * Pricing and policy for `create_transfer` (block: bank-core).
 *
 * `quoteTransfer` is the single place that decides what a transfer costs and whether it is
 * allowed. Both halves of the two-step choreography call it: the preview to build the numbers the
 * model shows the user, and the confirm to recompute them against the state as it is *now*. That
 * is the reprice guard - the total is never trusted from the preview, only compared against it -
 * and it is why a second transfer that drains the account is caught at confirm time rather than
 * silently overdrawing (docs/TOOL_CATALOG.md section 7).
 *
 * Every amount is an integer number of USD cents (Decision D-1).
 */
import type {
  Account,
  Payee,
  Persona,
  PolicyOutlook,
  TransferFailureReason,
  TransferRail,
  TransferTarget,
} from '../contracts/index.js';

import { BASE_CURRENCY } from './categories.js';
import { WIRE_FEE_CENTS } from './config.js';

/** The daily ceiling is a multiple of the per-transfer ceiling; both are per persona. */
export const DAILY_LIMIT_MULTIPLIER = 3;

export interface TransferQuote {
  readonly from: Account;
  readonly rail: TransferRail;
  readonly amount_cents: number;
  readonly fee_cents: number;
  readonly total_cents: number;
  readonly resulting_balance_cents: number;
  readonly to_account_id: string | null;
  readonly payee_id: string | null;
  readonly policy_outlook: PolicyOutlook;
}

export type TransferQuoteResult =
  | { readonly ok: true; readonly quote: TransferQuote }
  | { readonly ok: false; readonly reason: TransferFailureReason; readonly message: string };

export interface TransferQuoteInput {
  readonly persona: Persona;
  /** Accounts with the overlay's balance deltas already applied. */
  readonly accounts: readonly Account[];
  readonly payees: readonly Payee[];
  readonly from_account_id: string;
  readonly to: TransferTarget;
  readonly amount: number;
  readonly currency: string;
  /** Cents already moved out today on this login, for the daily ceiling. */
  readonly spent_today_cents: number;
}

function reject(reason: TransferFailureReason, message: string): TransferQuoteResult {
  return { ok: false, reason, message };
}

/** The fee this bank charges for a rail, in USD cents. Wires cost money; ACH and internal do not. */
export function feeForRail(rail: TransferRail): number {
  return rail === 'wire' ? WIRE_FEE_CENTS : 0;
}

export function quoteTransfer(input: TransferQuoteInput): TransferQuoteResult {
  const { persona, accounts, payees } = input;

  if (typeof input.amount !== 'number' || !Number.isInteger(input.amount) || input.amount <= 0) {
    return reject(
      'invalid_amount',
      'amount must be a positive whole number of cents (1000 means $10.00)',
    );
  }
  if (input.amount > Number.MAX_SAFE_INTEGER) {
    return reject('invalid_amount', 'amount is larger than this bank can represent');
  }

  const from = accounts.find((account) => account.id === input.from_account_id);
  if (from === undefined) {
    return reject('unknown_account', `no account with id ${input.from_account_id}`);
  }
  if (from.status === 'closed') {
    return reject('account_closed', `account ${from.name} is closed and cannot send money`);
  }
  if (input.currency !== from.currency) {
    return reject(
      'currency_not_supported',
      `account ${from.name} is funded in ${from.currency}; this bank only moves ${BASE_CURRENCY} (Decision D-1)`,
    );
  }

  let rail: TransferRail;
  let toAccountId: string | null = null;
  let payeeId: string | null = null;

  const target = input.to;
  if ('payee_id' in target) {
    const payee = payees.find((candidate) => candidate.id === target.payee_id);
    if (payee === undefined) {
      return reject('unknown_payee', `no saved payee with id ${target.payee_id}`);
    }
    if (!payee.is_active) {
      return reject(
        'payee_inactive',
        `payee ${payee.name} is archived and cannot receive a transfer; ask the user to confirm the beneficiary`,
      );
    }
    rail = payee.rail;
    payeeId = payee.id;
  } else {
    const destination = accounts.find((account) => account.id === target.account_id);
    if (destination === undefined) {
      return reject('unknown_account', `no account with id ${target.account_id}`);
    }
    if (destination.id === from.id) {
      return reject(
        'unknown_account',
        'the destination account must be different from the source account',
      );
    }
    if (destination.status === 'closed') {
      return reject('account_closed', `account ${destination.name} is closed and cannot receive money`);
    }
    rail = 'internal';
    toAccountId = destination.id;
  }

  const fee = feeForRail(rail);
  const total = input.amount + fee;

  if (input.amount > persona.transfer_limit_cents) {
    return reject(
      'over_limit',
      `the per-transfer limit on this account is ${persona.transfer_limit_cents} cents and the transfer is ${input.amount} cents`,
    );
  }

  const dailyLimit = persona.transfer_limit_cents * DAILY_LIMIT_MULTIPLIER;
  const dailyRemainingBefore = Math.max(0, dailyLimit - Math.max(0, input.spent_today_cents));
  if (total > dailyRemainingBefore) {
    return reject(
      'over_limit',
      `only ${dailyRemainingBefore} cents of today's ${dailyLimit} cent transfer allowance are left and this transfer needs ${total}`,
    );
  }

  if (total > from.available_balance_cents) {
    return reject(
      'insufficient_funds',
      `account ${from.name} has ${from.available_balance_cents} cents available and the transfer needs ${total} cents including a ${fee} cent fee`,
    );
  }

  const dailyRemainingAfter = dailyRemainingBefore - total;
  const policy_outlook: PolicyOutlook = {
    // `blocked` is never reported on a successful quote: a blocked transfer is returned as an
    // `over_limit` / `insufficient_funds` rejection instead, so the model cannot confirm it.
    status:
      total > persona.transfer_limit_cents / 2 || dailyRemainingAfter < dailyLimit / 5
        ? 'warning'
        : 'ok',
    message:
      `within the ${persona.transfer_limit_cents} cent per-transfer limit; ` +
      `${dailyRemainingAfter} cents of today's ${dailyLimit} cent allowance remain after this transfer`,
    per_transfer_limit_cents: persona.transfer_limit_cents,
    daily_remaining_cents: dailyRemainingAfter,
  };

  return {
    ok: true,
    quote: {
      from,
      rail,
      amount_cents: input.amount,
      fee_cents: fee,
      total_cents: total,
      resulting_balance_cents: from.balance_cents - total,
      to_account_id: toAccountId,
      payee_id: payeeId,
      policy_outlook,
    },
  };
}
