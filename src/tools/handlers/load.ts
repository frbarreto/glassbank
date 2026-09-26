/**
 * The seven `load_*` tools.
 *
 * They all do the same three things and differ only in which `BankCore` list they read: page
 * through the bank, store the rows in the caller's own scratch database, and return Ramp's
 * instruction string with the advertised columns. **A load tool never returns rows** - that is
 * the point of the ETL pattern (docs/TOOL_CATALOG.md section 6), and it is what keeps a full year
 * of transactions far below claude.ai's 150,000-character cap.
 */
import {
  NO_DATA_FOUND,
  loadResultText,
  toolError,
  toolText,
  type Account,
  type Bill,
  type Card,
  type ListQuery,
  type Page,
  type Payee,
  type StatementLine,
  type ToolResult,
  type Transaction,
  type Transfer,
} from '../../contracts/index.js';

import { asBoolean, asEnum, asOptionalString, asString, asStringArray } from '../args.js';
import { TOO_MANY_PAGES_MESSAGE } from '../errors.js';
import { collectPages, parseDateRange, withoutPersonaId } from '../rows.js';
import { bankScopeOf } from '../scope.js';
import type { ToolCallContext, ToolCallHandler, ToolsLimits } from '../types.js';

/**
 * Pages the bank, stores what came back and answers with Ramp's instruction string. `No data
 * found` is returned without creating a table: an empty table would only consume the per-grant
 * table budget and give the model something useless to query.
 */
async function runLoad<T extends object>(
  context: ToolCallContext,
  limits: ToolsLimits,
  fetchPage: (query: ListQuery) => Promise<Page<T>>,
): Promise<ToolResult> {
  const collected = await collectPages(fetchPage, {
    pageSize: limits.loadPageSize,
    maxPages: limits.maxPagesPerLoad,
  });
  if (!collected.ok) return toolError(TOO_MANY_PAGES_MESSAGE);

  const rows = collected.rows.map(withoutPersonaId);
  if (rows.length === 0) return toolText(NO_DATA_FOUND);

  const loaded = await context.scratch.load({ source_tool: context.tool, rows });
  return toolText(
    loadResultText({ table_name: loaded.table_name, columns: loaded.columns_advertised }),
    {
      table_name: loaded.table_name,
      rows: loaded.rows,
      columns: [...loaded.columns_advertised],
      pages: collected.pages,
    },
  );
}

export function createLoadHandlers(limits: ToolsLimits): Record<string, ToolCallHandler> {
  const loadAccounts: ToolCallHandler = async (context, args) => {
    const scope = bankScopeOf(context.auth);
    const accountId = asOptionalString(args.account_id);
    const accountType = asEnum(args.account_type, ['checking', 'savings', 'credit_card'] as const);
    return runLoad<Account>(context, limits, (query) =>
      context.bank.listAccounts(scope, {
        ...query,
        ...(accountId === undefined ? {} : { account_id: accountId }),
        account_type: accountType,
      }),
    );
  };

  const loadTransactions: ToolCallHandler = async (context, args) => {
    const range = parseDateRange(asString(args.from_date), asString(args.to_date));
    if (!range.ok) return toolError(range.message);
    const scope = bankScopeOf(context.auth);
    const accountId = asOptionalString(args.account_id);
    const cardId = asOptionalString(args.card_id);
    const status = asEnum(args.status, ['pending', 'posted', 'declined'] as const);
    return runLoad<Transaction>(context, limits, (query) =>
      context.bank.listTransactions(scope, {
        ...query,
        from_date: range.from_date,
        to_date: range.to_date,
        ...(accountId === undefined ? {} : { account_id: accountId }),
        ...(cardId === undefined ? {} : { card_id: cardId }),
        category_ids: asStringArray(args.category_ids),
        status,
      }),
    );
  };

  const loadCards: ToolCallHandler = async (context, args) => {
    const scope = bankScopeOf(context.auth);
    const accountId = asOptionalString(args.account_id);
    const status = asEnum(args.status, ['active', 'locked', 'fraud_locked'] as const);
    return runLoad<Card>(context, limits, (query) =>
      context.bank.listCards(scope, {
        ...query,
        ...(accountId === undefined ? {} : { account_id: accountId }),
        status,
      }),
    );
  };

  const loadTransfers: ToolCallHandler = async (context, args) => {
    const range = parseDateRange(asString(args.from_date), asString(args.to_date));
    if (!range.ok) return toolError(range.message);
    const scope = bankScopeOf(context.auth);
    const direction = asEnum(args.direction, ['outgoing', 'incoming'] as const);
    const status = asEnum(args.status, ['scheduled', 'completed', 'failed'] as const);
    return runLoad<Transfer>(context, limits, (query) =>
      context.bank.listTransfers(scope, {
        ...query,
        from_date: range.from_date,
        to_date: range.to_date,
        direction,
        status,
      }),
    );
  };

  const loadBills: ToolCallHandler = async (context, args) => {
    const range = parseDateRange(asString(args.from_date), asString(args.to_date));
    if (!range.ok) return toolError(range.message);
    const scope = bankScopeOf(context.auth);
    const paymentStatus = asEnum(args.payment_status, ['open', 'paid', 'overdue'] as const);
    return runLoad<Bill>(context, limits, (query) =>
      context.bank.listBills(scope, {
        ...query,
        from_date: range.from_date,
        to_date: range.to_date,
        payment_status: paymentStatus,
      }),
    );
  };

  const loadPayees: ToolCallHandler = async (context, args) => {
    const scope = bankScopeOf(context.auth);
    const name = asOptionalString(args.name);
    // Ramp's `load_vendors` default, kept: "Usually search for only active vendors."
    const isActive = asBoolean(args.is_active, true);
    return runLoad<Payee>(context, limits, (query) =>
      context.bank.listPayees(scope, {
        ...query,
        ...(name === undefined ? {} : { name }),
        is_active: isActive,
      }),
    );
  };

  const loadStatementLines: ToolCallHandler = async (context, args) => {
    const range = parseDateRange(asString(args.from_date), asString(args.to_date));
    if (!range.ok) return toolError(range.message);
    const scope = bankScopeOf(context.auth);
    return runLoad<StatementLine>(context, limits, (query) =>
      context.bank.listStatementLines(scope, {
        ...query,
        from_date: range.from_date,
        to_date: range.to_date,
      }),
    );
  };

  return {
    load_accounts: loadAccounts,
    load_transactions: loadTransactions,
    load_cards: loadCards,
    load_transfers: loadTransfers,
    load_bills: loadBills,
    load_payees: loadPayees,
    load_statement_lines: loadStatementLines,
  };
}
