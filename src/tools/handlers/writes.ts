/**
 * The two write tools: `lock_or_unlock_card` and `create_transfer`.
 *
 * These are the only tools that change the customer's account, so they are the only ones
 * annotated `destructiveHint: true` (claude.ai always prompts on those), gated by a feature flag
 * (`x-gated-by`), and required to leave an audit entry behind. All of the state lives in
 * `BankCore`'s per-login overlay (ADR-15); this module only chooses the words.
 *
 * `create_transfer` implements the two-step choreography of docs/TOOL_CATALOG.md section 7. The
 * published schema has no `preview_id`, so the second call is matched to the first by the
 * transfer itself (see previews.ts) and the reprice guard is `expected_total_amount`, the number
 * the model showed the user.
 */
import {
  toolError,
  toolText,
  type ToolResult,
  type TransferPreview,
  type TransferTarget,
} from '../../contracts/index.js';

import { asBoolean, asInteger, asOptionalString, asString } from '../args.js';
import { formatMoney } from '../format.js';
import type { PreviewStore } from '../previews.js';
import { bankScopeOf, loginKeyOf } from '../scope.js';
import type { ToolCallHandler } from '../types.js';

/** `{payee_id}` or `{account_id}`, exactly one, as the published `oneOf` advertises. */
function readTarget(value: unknown): TransferTarget | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const payeeId = record.payee_id;
  const accountId = record.account_id;
  if (typeof payeeId === 'string' && payeeId.length > 0 && accountId === undefined) {
    return { payee_id: payeeId };
  }
  if (typeof accountId === 'string' && accountId.length > 0 && payeeId === undefined) {
    return { account_id: accountId };
  }
  return null;
}

function describeTarget(target: TransferTarget): string {
  return 'payee_id' in target ? `payee ${target.payee_id}` : `account ${target.account_id}`;
}

function previewLines(preview: TransferPreview): string[] {
  return [
    'Preview only: no money has moved and nothing is scheduled yet.',
    `From ${preview.from_account_id} to ${describeTarget(preview.to)} over the ${preview.rail} rail.`,
    `Amount: ${formatMoney(preview.amount, preview.currency)}`,
    `Fee: ${formatMoney(preview.fee, preview.currency)}`,
    `Total: ${formatMoney(preview.total, preview.currency)}`,
    `Resulting balance on ${preview.from_account_id}: ${formatMoney(preview.resulting_balance, preview.currency)}`,
    `Limits: ${preview.policy_outlook.status} - ${preview.policy_outlook.message} (per-transfer limit ${preview.policy_outlook.per_transfer_limit_cents} cents, ${preview.policy_outlook.daily_remaining_cents} cents left today).`,
  ];
}

const lockOrUnlockCard: ToolCallHandler = async (context, args) => {
  const cardId = asString(args.card_id);
  const action = asString(args.action) === 'unlock' ? 'unlock' : 'lock';
  const result = await context.bank.lockOrUnlockCard(bankScopeOf(context.auth), {
    card_id: cardId,
    action,
    rationale: context.rationale,
  });

  if (!result.ok) {
    return toolError(`the card could not be ${action}ed (${result.reason}): ${result.message}`);
  }

  const wanted = action === 'lock' ? 'locked' : 'active';
  const text = result.changed
    ? `Card ending ${result.card.last4} (${result.card.id}) is now ${wanted}. An audit entry was appended (${result.audit_id}).`
    : `Card ending ${result.card.last4} (${result.card.id}) was already ${wanted}; nothing changed. An audit entry was appended (${result.audit_id}).`;
  return toolText(text, {
    card_id: result.card.id,
    last4: result.card.last4,
    status: result.card.status,
    changed: result.changed,
    audit_id: result.audit_id,
  });
};

export function createTransferHandler(previews: PreviewStore): ToolCallHandler {
  return async (context, args): Promise<ToolResult> => {
    const fromAccountId = asString(args.from_account_id);
    const target = readTarget(args.to);
    if (target === null) {
      return toolError(
        'to must be exactly one of {"payee_id": "pay_..."} (a saved payee from load_payees) or {"account_id": "acc_..."} (another account of the same customer)',
      );
    }
    const amount = asInteger(args.amount);
    if (amount === null || amount <= 0) {
      return toolError(
        'amount must be a positive integer in the smallest denomination: 1000 means 1000 cents or $10.00',
      );
    }
    const currency = asString(args.currency).toUpperCase();
    const memo = asOptionalString(args.memo);
    const confirm = asBoolean(args.confirm, false);
    const scope = bankScopeOf(context.auth);
    const key = {
      login_key: loginKeyOf(context.auth),
      from_account_id: fromAccountId,
      to: target,
      amount,
      currency,
    };

    if (!confirm) {
      const quoted = await context.bank.previewTransfer(scope, {
        from_account_id: fromAccountId,
        to: target,
        amount,
        currency,
        memo: memo ?? null,
        rationale: context.rationale,
      });
      if (!quoted.ok) {
        return toolError(`the transfer was rejected (${quoted.reason}): ${quoted.message}`);
      }
      const preview = quoted.preview;
      if (preview.policy_outlook.status === 'blocked') {
        // A blocked outlook must never come back as a confirmable preview.
        return toolError(
          `the transfer is blocked by the customer's limits: ${preview.policy_outlook.message}`,
        );
      }
      previews.remember(key, {
        preview_id: preview.preview_id,
        total: preview.total,
        expires_at: preview.expires_at,
      });
      const lines = [
        ...previewLines(preview),
        `Show this to the user and ask for explicit approval. To send it, call create_transfer again with the same arguments plus confirm set to true and expected_total_amount set to ${preview.expected_total_amount}.`,
        `The preview expires at ${preview.expires_at}.`,
      ];
      return toolText(lines.join('\n'), {
        preview_id: preview.preview_id,
        from_account_id: preview.from_account_id,
        to: preview.to,
        amount: preview.amount,
        fee: preview.fee,
        total: preview.total,
        resulting_balance: preview.resulting_balance,
        currency: preview.currency,
        rail: preview.rail,
        policy_outlook: preview.policy_outlook,
        expected_total_amount: preview.expected_total_amount,
        expires_at: preview.expires_at,
        confirmed: false,
      });
    }

    const expectedTotal = asInteger(args.expected_total_amount);
    if (expectedTotal === null || expectedTotal <= 0) {
      return toolError(
        'expected_total_amount is required when confirm is true: copy the total from the preview you showed the user, so the user cannot approve one number and pay another',
      );
    }
    const open = previews.find(key, context.now());
    if (open === undefined) {
      return toolError(
        'no open preview matches this transfer: call create_transfer without confirm first, show the preview to the user, and then confirm with the expected_total_amount it returned',
      );
    }

    const confirmed = await context.bank.confirmTransfer(scope, {
      preview_id: open.preview_id,
      expected_total_amount: expectedTotal,
      rationale: context.rationale,
    });
    if (!confirmed.ok) {
      if (confirmed.reason === 'repriced' && confirmed.preview !== undefined) {
        // The user approved a number that is no longer true. Keep the new quote so a second
        // confirm can succeed once the user has approved the new total.
        previews.remember(key, {
          preview_id: confirmed.preview.preview_id,
          total: confirmed.preview.total,
          expires_at: confirmed.preview.expires_at,
        });
        return toolError(
          `${confirmed.message}. The total is now ${confirmed.preview.total} cents: show the new total to the user, and confirm again with expected_total_amount set to ${confirmed.preview.expected_total_amount} only if they approve it`,
        );
      }
      if (confirmed.reason === 'unknown_preview' || confirmed.reason === 'expired_preview') {
        previews.forget(key);
      }
      return toolError(`the transfer was not sent (${confirmed.reason}): ${confirmed.message}`);
    }

    previews.forget(key);
    const transfer = confirmed.transfer;
    const lines = [
      `Transfer ${transfer.id} is ${transfer.status}.`,
      `Sent ${formatMoney(transfer.amount_cents, transfer.currency)} from ${transfer.from_account_id} to ${describeTarget(target)} over the ${transfer.rail} rail.`,
      `Fee: ${formatMoney(transfer.fee_cents, transfer.currency)}. Total taken from the account: ${formatMoney(transfer.total_cents, transfer.currency)}.`,
      `An audit entry was appended (${confirmed.audit_id}).`,
    ];
    return toolText(lines.join('\n'), {
      transfer_id: transfer.id,
      status: transfer.status,
      from_account_id: transfer.from_account_id,
      to_account_id: transfer.to_account_id,
      payee_id: transfer.payee_id,
      amount: transfer.amount_cents,
      fee: transfer.fee_cents,
      total: transfer.total_cents,
      currency: transfer.currency,
      rail: transfer.rail,
      audit_id: confirmed.audit_id,
      confirmed: true,
    });
  };
}

export function createWriteHandlers(previews: PreviewStore): Record<string, ToolCallHandler> {
  return {
    lock_or_unlock_card: lockOrUnlockCard,
    create_transfer: createTransferHandler(previews),
  };
}
