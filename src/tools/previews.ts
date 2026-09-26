/**
 * The open-preview memory of `create_transfer`.
 *
 * `create_transfer` is one tool called twice (docs/TOOL_CATALOG.md section 7): once for a preview,
 * once with `confirm: true`. Its published schema has no `preview_id` parameter - the model is
 * asked for the *number* it showed the user (`expected_total_amount`), not for an id it could
 * copy wrongly - so the server has to remember which preview the second call belongs to.
 *
 * The key is the transfer itself: source account, destination, amount and currency. That is
 * deliberately the strongest part of the guard. A confirm for a different amount, or to a
 * different payee, finds no preview and is refused, so the approval the user gave for one
 * transfer can never be spent on another.
 *
 * Keyed by login, not by grant: a step-up re-issues tokens for the same login (ADR-14) and a
 * reconnect may arrive on a second grant, and bank-core binds the preview to the login too.
 */
import type { TransferTarget } from '../contracts/index.js';

import { BoundedMap } from './bounded.js';

export interface OpenPreview {
  readonly preview_id: string;
  readonly total: number;
  readonly expires_at: string;
}

export interface PreviewKeyInput {
  readonly login_key: string;
  readonly from_account_id: string;
  readonly to: TransferTarget;
  readonly amount: number;
  readonly currency: string;
}

/** A stable, collision-free string for one intended transfer. */
export function previewKey(input: PreviewKeyInput): string {
  const destination =
    'payee_id' in input.to ? `payee:${input.to.payee_id}` : `account:${input.to.account_id}`;
  return [
    input.login_key,
    input.from_account_id,
    destination,
    String(input.amount),
    input.currency,
  ].join('|');
}

export interface PreviewStore {
  remember(input: PreviewKeyInput, preview: OpenPreview): void;
  /** The open preview for this exact transfer, or `undefined` when there is none or it expired. */
  find(input: PreviewKeyInput, now: Date): OpenPreview | undefined;
  forget(input: PreviewKeyInput): void;
  size(): number;
  clear(): void;
}

export function createPreviewStore(capacity: number): PreviewStore {
  const previews = new BoundedMap<OpenPreview>(Math.max(1, capacity));

  return {
    remember(input, preview) {
      previews.set(previewKey(input), preview);
    },
    find(input, now) {
      const key = previewKey(input);
      const found = previews.get(key);
      if (found === undefined) return undefined;
      if (new Date(found.expires_at).getTime() <= now.getTime()) {
        previews.delete(key);
        return undefined;
      }
      return found;
    },
    forget(input) {
      previews.delete(previewKey(input));
    },
    size() {
      return previews.size;
    },
    clear() {
      previews.clear();
    },
  };
}
