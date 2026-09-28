/**
 * Block wiring (block: app).
 *
 * One function that builds every block and hands back the Express application plus the shutdown
 * hook. It lives next to `src/app.ts` rather than inside `src/server.ts` because three callers
 * need the identical graph and a graph that only exists inside `main()` cannot be tested:
 *
 *   - `src/server.ts`            the container entry point;
 *   - `test/e2e/*-walk.mjs`      the servers `npm run e2e` spawns through `src/server.ts`;
 *   - `src/__tests__/wiring.test.ts` the in-process assertion that the mount order holds.
 *
 * The dependency order is forced and is the only interesting thing here (docs/blocks/app.md):
 *
 *   bank-core -> (personas) -> auth -> (jwt) -> xray -> (emitter, pairing) -> etl, tools, mcp
 *
 * `auth` wants `xray.emitter` and `xray.pairing`, and `xray` wants `auth.jwt`, so the cycle is
 * broken with two forwarding objects rather than by building `auth` twice: neither block emits or
 * mints a pairing code during construction, so by the time either forwarder is called the real
 * `xray` exists. Building `auth` twice would leave two SQLite handles on `AUTH_DB_PATH` and two
 * sets of in-memory grants, which is a worse trade than four lines of indirection.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Express } from 'express';

import { createApp, newBootId, readPackageVersion } from './app.js';
import { createAuth, type Auth } from './auth/index.js';
import { createBankCore, type BankCoreHandle } from './bank-core/index.js';
import type { AppConfig } from './config/index.js';
import {
  CLAUDE_CONTENT_CHAR_CAP,
  CLAUDE_TOOL_BUDGET_MS,
  PUBLIC_LOGIN_ID,
  type BankScope,
  type Pairing,
  type PairingCode,
  type PairingExchangeResult,
  type PublicToolRegistry,
  type ToolContext,
  type ToolLimits,
  type ToolRegistry,
  type ToolResult,
  type XrayActivityCategory,
  type XrayActivityMonth,
  type XrayBankActivity,
  type XrayCorrelation,
  type XrayBankCardCounts,
  type XrayBankSummary,
  type XrayEmitter,
  type XrayEventDataInput,
  type XrayEventType,
} from './contracts/index.js';
import { createEtl, type Etl } from './etl/index.js';
import { createMcp, type McpHandler } from './mcp/index.js';
import {
  createPublicTools,
  createTools,
  overlayLoginKeyOf,
  type PublicToolsHandle,
  type ToolsHandle,
} from './tools/index.js';
import { createXray, type Xray } from './xray/index.js';

/** The SDK version reported on `server.started`; kept in step with package.json by a test. */
export const SDK_VERSION = '@modelcontextprotocol/sdk 1.30.0';

/** Where the dashboard's static files live, resolved from this file so `dist/` works too. */
export function dashboardRootFor(importMetaUrl: string): string {
  // dist/composition.js -> repository root -> public/. In the source tree it is src/ -> root.
  return resolve(dirname(fileURLToPath(importMetaUrl)), '..', 'public');
}

export interface GlassBankOptions {
  readonly bootId?: string;
  readonly version?: string;
  /** Reported on `server.started`; the deploy scripts pass the image tag. */
  readonly gitSha?: string | null;
  /** Absolute path to the dashboard's static root. Defaults to `<repo>/public`. */
  readonly dashboardRoot?: string;
  /** Silences the blocks' stdout logging in tests. */
  readonly quiet?: boolean;
}

/** Everything the composition root built, so a caller can shut it down or assert on it. */
export interface GlassBank {
  readonly app: Express;
  readonly bootId: string;
  readonly version: string;
  readonly bankCore: BankCoreHandle;
  readonly auth: Auth;
  readonly xray: Xray;
  readonly etl: Etl;
  readonly tools: ToolsHandle;
  /** The six public tools of `/public/mcp` (D-26), built even when the lane is switched off. */
  readonly publicTools: PublicToolsHandle;
  readonly mcp: McpHandler;
  /**
   * The SIGTERM path, in the order the events have to happen (docs/blocks/mcp.md, xray.md):
   * `mcp` closes its sessions and cancels in-flight calls, `xray` flushes those events and closes
   * the log, then `etl` SIGKILLs its runners and `auth` releases its SQLite handle. Measured well
   * inside the 10 s budget of CLAUDE.md invariant 12.
   */
  shutdown(reason?: 'sigterm' | 'sigint' | 'shutdown'): Promise<void>;
}

/** Reads the version out of package.json next to the entry point; never fatal. */
function versionFor(): string {
  return readPackageVersion();
}

/**
 * An emitter that forwards to whatever `resolve` returns at call time. Used only for the two
 * blocks constructed before `xray` exists; a call before then is dropped rather than thrown, the
 * same contract every producer already has with the real emitter (invariant 5 outranks 13).
 */
function forwardingEmitter(resolveEmitter: () => XrayEmitter | null): XrayEmitter {
  return {
    emit<T extends XrayEventType>(
      type: T,
      data: XrayEventDataInput<T>,
      correlation?: XrayCorrelation,
    ): number | void {
      return resolveEmitter()?.emit(type, data, correlation);
    },
  };
}

/**
 * Merges the correlation a producer supplied over the one ambient in the request.
 *
 * `bank-core` is a process-wide singleton: it holds every overlay, so it cannot be rebuilt per
 * request, and the emitter it was constructed with is the only one it has. What it knows about a
 * call is `{persona_id, login_id}` from the `BankScope`; what it cannot know is the X-ray session
 * the call belongs to. Without the `xs`, a `bank.op` is filtered out of
 * `GET /xray/api/sessions/:xs/events` and lands nowhere on the timeline - the one event that says
 * what the bank actually did would be missing from exactly the view built to show it.
 *
 * So the ambient half travels through an `AsyncLocalStorage` opened around every `registry.call`
 * (see `createGlassBank`), and the producer's own non-null fields win over it.
 */
function mergeCorrelation(
  ambient: XrayCorrelation | undefined,
  own: XrayCorrelation | undefined,
): XrayCorrelation | undefined {
  if (ambient === undefined) return own;
  if (own === undefined) return ambient;
  const merged: Record<string, unknown> = { ...ambient };
  for (const [key, value] of Object.entries(own)) {
    if (value !== null && value !== undefined) merged[key] = value;
  }
  return merged as XrayCorrelation;
}

/** The same trick for `Pairing`: the consent success page mints a code long after boot. */
function forwardingPairing(resolvePairing: () => Pairing | null): Pairing {
  const missing = (): never => {
    throw new Error('the pairing service is not wired yet');
  };
  return {
    createCode: (input): Promise<PairingCode> =>
      (resolvePairing() ?? missing()).createCode(input),
    exchange: (code, context): Promise<PairingExchangeResult> =>
      (resolvePairing() ?? missing()).exchange(code, context),
    exchangeAdminToken: (token): Promise<PairingExchangeResult> =>
      (resolvePairing() ?? missing()).exchangeAdminToken(token),
  };
}

export function createGlassBank(config: AppConfig, options: GlassBankOptions = {}): GlassBank {
  const bootId = options.bootId ?? newBootId();
  const version = options.version ?? versionFor();
  const quiet = options.quiet === true;

  // Resolved once the real block exists; see the header comment for why this is not a rebuild.
  let xray: Xray | null = null;
  const lazyEmitter = forwardingEmitter(() => (xray === null ? null : xray.emitter));
  const lazyPairing = forwardingPairing(() => (xray === null ? null : xray.pairing));

  /** The correlation of the tool call currently running, for the one block that cannot be told. */
  const ambientCorrelation = new AsyncLocalStorage<XrayCorrelation>();
  /**
   * Set while the dashboard itself reads the bank (the persona card). Those reads are not part of
   * any session and must not show up as `bank.op` events the model never caused, so the emitter
   * drops them; invariant 13 is about what the tools do, not about the observer observing.
   */
  const silentReads = new AsyncLocalStorage<boolean>();
  const bankEmitter: XrayEmitter = {
    emit(type, data, correlation) {
      if (silentReads.getStore() === true) return;
      return lazyEmitter.emit(
        type,
        data,
        mergeCorrelation(ambientCorrelation.getStore(), correlation),
      );
    },
  };

  // 1. bank-core: no dependencies but the emitter and the three cap knobs.
  const bankCore = createBankCore({
    emitter: bankEmitter,
    config: {
      maxMaterialisedPersonas: config.maxMaterialisedPersonas,
      maxPersonaOverlays: config.maxPersonaOverlays,
      personaOverlayTtlHours: config.personaOverlayTtlHours,
    },
  });

  // 2. auth: the persona directory now comes from bank-core, so a `per_` id minted at the login
  //    page is the same identity the tools read (the spike directory is no longer used).
  const auth = createAuth({
    config,
    personas: bankCore.personas,
    emitter: lazyEmitter,
    pairing: lazyPairing,
    ...(quiet ? { log: () => undefined } : {}),
  });

  /**
   * The persona card behind a session (`GET /xray/api/sessions/:xs/bank`, contracts v0.3): the
   * numbers the tools return to the model, on the same overlay - `overlayLoginKeyOf` is the tools'
   * own rule for a grant that carries no `login_id`. Read silently (see `silentReads`).
   */
  async function lookupBankSummary(session: {
    readonly persona_id: string;
    readonly login_id: string | null;
    readonly grant_id: string | null;
  }): Promise<XrayBankSummary | null> {
    const persona = await bankCore.personas.get(session.persona_id);
    if (persona === null) return null;
    const loginKey =
      session.login_id ??
      (session.grant_id === null
        ? null
        : overlayLoginKeyOf({ login_id: null, grant_id: session.grant_id }));
    if (loginKey === null) return null;
    const scope: BankScope = { persona_id: persona.id, login_id: loginKey, grant_id: session.grant_id };
    return silentReads.run(true, async () => {
      const balances = await bankCore.getBalances(scope);
      const cards: { -readonly [K in keyof XrayBankCardCounts]: number } = {
        total: 0,
        active: 0,
        locked: 0,
        fraud_locked: 0,
      };
      let cursor: string | null = null;
      // A persona holds a handful of cards; the bound only guards against a runaway cursor.
      for (let page = 0; page < 20; page += 1) {
        const result = await bankCore.listCards(scope, { limit: 100, cursor });
        for (const card of result.data) {
          cards.total += 1;
          cards[card.status] += 1;
        }
        cursor = result.page.next;
        if (cursor === null) break;
      }
      return {
        persona: { id: persona.id, name: persona.name, kind: persona.kind, shared: persona.shared },
        currency: balances.currency,
        as_of: balances.as_of,
        accounts: balances.accounts.map((account) => ({
          account_id: account.account_id,
          name: account.name,
          account_type: account.account_type,
          currency: account.currency,
          balance_cents: account.balance_cents,
          available_balance_cents: account.available_balance_cents,
          credit_limit_cents: account.credit_limit_cents,
          status: account.status,
        })),
        total_cash_cents: balances.total_cash_cents,
        total_available_cents: balances.total_available_cents,
        total_credit_owed_cents: balances.total_credit_owed_cents,
        net_position_cents: balances.net_position_cents,
        cards,
        transfer_limit_cents: persona.transfer_limit_cents,
      };
    });
  }

  /**
   * The account view behind a session (`GET /xray/api/sessions/:xs/bank/activity`, v0.10, D-31):
   * what `load_statement_lines`, `load_cards`, `load_bills`, `load_transfers` and the audit trail
   * would give the model, on the same overlay, summed for a reader. Read silently like the persona
   * card, so opening the page never shows up as a `bank.op` the model did not cause.
   */
  async function lookupBankActivity(
    session: { readonly persona_id: string; readonly login_id: string | null; readonly grant_id: string | null },
    options: { readonly months: number },
  ): Promise<XrayBankActivity | null> {
    const summary = await lookupBankSummary(session);
    if (summary === null) return null;
    const loginKey =
      session.login_id ?? overlayLoginKeyOf({ login_id: null, grant_id: session.grant_id ?? '' });
    const scope: BankScope = { persona_id: summary.persona.id, login_id: loginKey, grant_id: session.grant_id };
    return silentReads.run(true, () => buildBankActivity(bankCore, scope, summary, options.months, new Date()));
  }

  // 3. xray: needs `auth.jwt` for the viewer cookie, so `jose` stays inside its two owning blocks.
  xray = createXray({
    config,
    jwt: auth.jwt,
    bootId,
    version,
    gitSha: options.gitSha ?? null,
    sdk: SDK_VERSION,
    nodeVersion: process.version,
    lookupPersona: (personaId) => bankCore.personas.get(personaId),
    lookupBankSummary,
    lookupBankActivity,
    ...(quiet ? { onError: () => undefined } : {}),
  });

  // 4. etl: one manager for the whole process; a `ScratchDb` is taken per grant, per request.
  const etl = createEtl({
    xray: xray.emitter,
    limits: {
      maxTablesPerGrant: config.maxTablesPerGrant,
      maxScratchDbs: config.maxScratchDbs,
      maxQueryRows: config.maxQueryRows,
      tableTtlMinutes: config.tableTtlMinutes,
      queryTimeoutMs: config.queryTimeoutMs,
      maxConcurrentEtlOps: config.maxConcurrentEtlOps,
      etlWorkerPoolSize: config.etlWorkerPoolSize,
      maxQueryTimeouts: config.maxQueryTimeouts,
    },
  });

  // 5. tools: the real 17-tool registry. Everything it touches arrives on the `ToolContext`.
  const tools = createTools();

  /**
   * The registry `mcp` dispatches through, wrapped so that everything a handler causes - including
   * the `bank.op` a `BankCore` method emits from inside the singleton - is stamped with the X-ray
   * session, grant and request the call belongs to. `AsyncLocalStorage` survives every `await` in
   * the handler, and the store is read only by `bankEmitter` above.
   */
  const correlatedRegistry: ToolRegistry = {
    catalog: tools.catalog,
    listFor: (grant, flags) => tools.listFor(grant, flags),
    call: (name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> =>
      ambientCorrelation.run(
        {
          xs: context.auth.xs ?? undefined,
          login_id: context.auth.login_id ?? undefined,
          grant_id: context.auth.grant_id,
          persona_id: context.auth.persona.id,
          request_id: context.requestId ?? undefined,
        },
        () => tools.call(name, args, context),
      ),
  };

  // 5b. the public lane's tools (D-26). Same ambient correlation, so the `bank.op` a public read
  //     emits from inside bank-core lands in the visitor's session under `PUBLIC_LOGIN_ID`.
  const publicTools = createPublicTools();
  const correlatedPublicRegistry: PublicToolRegistry = {
    catalog: publicTools.catalog,
    list: () => publicTools.list(),
    call: (name, args, context) =>
      ambientCorrelation.run(
        {
          xs: context.xs ?? undefined,
          login_id: PUBLIC_LOGIN_ID,
          grant_id: context.grantId,
          request_id: context.requestId ?? undefined,
        },
        () => publicTools.call(name, args, context),
      ),
  };

  /** The caps every handler must respect, from the env knobs plus claude.ai's two budgets. */
  const toolLimits: ToolLimits = {
    maxTablesPerGrant: config.maxTablesPerGrant,
    maxQueryRows: config.maxQueryRows,
    tableTtlMinutes: config.tableTtlMinutes,
    queryTimeoutMs: config.queryTimeoutMs,
    maxConcurrentEtlOps: config.maxConcurrentEtlOps,
    contentCharCap: CLAUDE_CONTENT_CHAR_CAP,
    budgetMs: CLAUDE_TOOL_BUDGET_MS,
  };

  // 6. mcp: the transport plus the bearer gate. It knows half the `ToolContext`; the other half
  //    (bank, scratch, pairing, limits) is completed here, because `src/mcp` may not import them.
  const mcp = createMcp({
    config: {
      publicBaseUrl: config.publicBaseUrl,
      publicHosts: config.publicHosts,
      originPolicy: config.originPolicy,
      featureFlags: config.featureFlags,
      xsIdleGapMinutes: config.xsIdleGapMinutes,
      grantToolCallsPerMin: config.rateLimits.grantToolCallsPerMin,
    },
    verifyAccessToken: auth.verifyAccessToken,
    lookupPersona: (personaId) => bankCore.personas.get(personaId),
    lookupClient: auth.lookupClient,
    bootId,
    xray: xray.emitter,
    registry: correlatedRegistry,
    toolContext: (base) => ({
      ...base,
      bank: bankCore,
      scratch: etl.forGrant(base.auth.grant_id, {
        xs: base.auth.xs ?? undefined,
        login_id: base.auth.login_id ?? undefined,
        persona_id: base.auth.persona.id,
        grant_id: base.auth.grant_id,
        request_id: base.requestId ?? undefined,
      }),
      pairing: xray === null ? lazyPairing : xray.pairing,
      limits: toolLimits,
    }),
    ...(config.publicMcp
      ? {
          publicLane: {
            registry: correlatedPublicRegistry,
            info: bankCore.publicInfo,
            ipToolCallsPerMin: config.rateLimits.publicIpToolCallsPerMin,
            toolCallsPerMin: config.rateLimits.publicToolCallsPerMin,
          },
        }
      : {}),
    captureSkipPaths: config.xrayCaptureSkipPaths,
    ...(quiet ? { log: () => undefined } : {}),
  });

  // 7. the Express app. `createApp` owns the mount order: auth at the root, /mcp, then /xray
  //    (the JSON API and the SSE stream) with the dashboard's static files behind it.
  const app = createApp(config, {
    bootId,
    version,
    authRouter: auth.router,
    mcpRouter: mcp,
    ...(mcp.publicLane === null ? {} : { publicMcpRouter: mcp.publicLane }),
    httpObserver: mcp.httpObserver,
    botAuth: auth.botAuth.middleware,
    xrayRouter: xray.router,
    dashboardRoot: options.dashboardRoot ?? dashboardRootFor(import.meta.url),
  });

  const liveXray = xray;
  let stopped = false;

  return {
    app,
    bootId,
    version,
    bankCore,
    auth,
    xray: liveXray,
    etl,
    tools,
    publicTools,
    mcp,
    async shutdown(reason = 'shutdown'): Promise<void> {
      if (stopped) return;
      stopped = true;
      // Order matters: these two are synchronous, and reversing them loses the events.
      mcp.shutdown('server_stopping');
      liveXray.shutdown(reason);
      await etl.shutdown();
      auth.close();
    },
  };
}

// ---------------------------------------------------------------------------
// The account view (v0.10, D-31)
// ---------------------------------------------------------------------------

/** Statement lines kept in the answer; the sums cover the whole window. */
export const ACTIVITY_LINES_CAP = 500;
/** Pages of 500 read per list, a guard against a runaway cursor, not a real limit. */
const ACTIVITY_MAX_PAGES = 40;

async function readAll<T>(
  read: (cursor: string | null) => Promise<{ readonly data: readonly T[]; readonly page: { readonly next: string | null } }>,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < ACTIVITY_MAX_PAGES; page += 1) {
    const result = await read(cursor);
    rows.push(...result.data);
    cursor = result.page.next;
    if (cursor === null) break;
  }
  return rows;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The first day of the month `monthsBack` months before `date`, in UTC. */
function monthStart(date: Date, monthsBack: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - monthsBack, 1));
}

/**
 * Sums the persona's money for the account view. Pure over `BankCore` reads; the caller holds the
 * silent scope. Internal transfers between the persona's own accounts are left out of money in
 * and out (they move money, they do not spend it); declined transactions, failed transfers and
 * unpaid bills are left out too, because no money moved.
 */
export async function buildBankActivity(
  bank: BankCoreHandle,
  scope: BankScope,
  summary: XrayBankSummary,
  requestedMonths: number,
  now: Date,
): Promise<XrayBankActivity> {
  const months = [1, 3, 6, 12].includes(requestedMonths) ? requestedMonths : 3;
  const today = isoDay(now);
  const yearStart = isoDay(monthStart(now, 11));
  const windowStart = isoDay(monthStart(now, months - 1));
  const thisMonth = today.slice(0, 7);

  const [lines, transfers, bills, cards, audit, categories, monthTransactions, payees] = await Promise.all([
    readAll((cursor) =>
      bank.listStatementLines(scope, { from_date: yearStart, to_date: today, limit: 500, cursor }),
    ),
    readAll((cursor) => bank.listTransfers(scope, { from_date: yearStart, to_date: today, limit: 500, cursor })),
    readAll((cursor) =>
      bank.listBills(scope, { from_date: isoDay(monthStart(now, 2)), to_date: isoDay(monthStart(now, -2)), limit: 500, cursor }),
    ),
    readAll((cursor) => bank.listCards(scope, { limit: 100, cursor })),
    readAll((cursor) => bank.listAuditEntries(scope, { limit: 500, cursor })),
    bank.listCategories(),
    readAll((cursor) =>
      bank.listTransactions(scope, { from_date: `${thisMonth}-01`, to_date: today, limit: 500, cursor }),
    ),
    readAll((cursor) => bank.listPayees(scope, { limit: 500, cursor })),
  ]);

  const accountNames = new Map(summary.accounts.map((account) => [account.account_id, account.name]));
  const lineById = new Map(lines.map((line) => [line.id, line]));
  const payeeNames = new Map(payees.map((payee) => [payee.id, payee.name]));
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const internal = new Set(transfers.filter((transfer) => transfer.to_account_id !== null).map((t) => t.id));

  /** True when the line moved money out of or into the persona, as opposed to between its accounts. */
  const moved = (line: (typeof lines)[number]): boolean => {
    if (line.source === 'transaction') return line.status !== 'declined';
    if (line.source === 'transfer') return line.status === 'completed' && !internal.has(line.id);
    return line.status === 'paid';
  };

  const byMonth = new Map<string, { money_in_cents: number; money_out_cents: number; lines: number }>();
  for (let back = 11; back >= 0; back -= 1) {
    byMonth.set(isoDay(monthStart(now, back)).slice(0, 7), { money_in_cents: 0, money_out_cents: 0, lines: 0 });
  }
  const byCategory = new Map<string, { spent: number; count: number }>();
  let windowTotal = 0;
  for (const line of lines) {
    const bucket = byMonth.get(line.date.slice(0, 7));
    if (bucket && moved(line)) {
      if (line.amount_cents >= 0) bucket.money_in_cents += line.amount_cents;
      else bucket.money_out_cents += -line.amount_cents;
      bucket.lines += 1;
    }
    if (line.date >= windowStart) {
      windowTotal += 1;
      if (line.source === 'transaction' && line.status !== 'declined') {
        const key = line.category_id ?? '';
        const entry = byCategory.get(key) ?? { spent: 0, count: 0 };
        entry.spent += -line.amount_cents;
        entry.count += 1;
        byCategory.set(key, entry);
      }
    }
  }

  const cardSpend = new Map<string, number>();
  for (const transaction of monthTransactions) {
    if (transaction.card_id === null || transaction.status === 'declined' || transaction.amount_cents >= 0) continue;
    cardSpend.set(transaction.card_id, (cardSpend.get(transaction.card_id) ?? 0) - transaction.amount_cents);
  }

  const byMonthList: XrayActivityMonth[] = [...byMonth.entries()].map(([month, entry]) => ({ month, ...entry }));
  const current = byMonth.get(thisMonth) ?? { money_in_cents: 0, money_out_cents: 0 };
  const byCategoryList: XrayActivityCategory[] = [...byCategory.entries()]
    .filter(([, entry]) => entry.spent > 0)
    .map(([id, entry]) => ({
      category_id: id === '' ? null : id,
      name: id === '' ? 'Uncategorised' : (categoryNames.get(id) ?? `Category ${id}`),
      spent_cents: entry.spent,
      count: entry.count,
    }))
    .sort((left, right) => right.spent_cents - left.spent_cents);

  return {
    ...summary,
    months,
    from_date: windowStart,
    to_date: today,
    month_to_date: { money_in_cents: current.money_in_cents, money_out_cents: current.money_out_cents },
    by_month: byMonthList,
    by_category: byCategoryList,
    lines: lines
      .filter((line) => line.date >= windowStart)
      .slice(0, ACTIVITY_LINES_CAP)
      .map((line) => ({
        id: line.id,
        source: line.source,
        date: line.date,
        account_id: line.account_id,
        account_name: accountNames.get(line.account_id) ?? null,
        description: line.description,
        counterparty: line.counterparty,
        amount_cents: line.amount_cents,
        status: line.status,
        category_id: line.category_id,
        category_name: line.category_id === null ? null : (categoryNames.get(line.category_id) ?? null),
      })),
    lines_total: windowTotal,
    lines_cap: ACTIVITY_LINES_CAP,
    card_list: cards.map((card) => ({
      id: card.id,
      account_id: card.account_id,
      cardholder_name: card.cardholder_name,
      brand: card.brand,
      last4: card.last4,
      status: card.status,
      spending_limit_cents: card.spending_limit_cents,
      spent_this_month_cents: cardSpend.get(card.id) ?? 0,
      expires_on: card.expires_on,
    })),
    bills: bills
      .map((bill) => ({
        id: bill.id,
        payee_name: payeeNames.get(bill.payee_id) ?? lineById.get(bill.id)?.counterparty ?? bill.payee_id,
        account_id: bill.account_id,
        amount_cents: bill.amount_cents,
        due_date: bill.due_date,
        status: bill.status,
        paid_at: bill.paid_at,
      }))
      .sort((left, right) => left.due_date.localeCompare(right.due_date)),
    transfers: transfers
      .filter((transfer) => transfer.scheduled_for >= windowStart || transfer.created_at.slice(0, 10) >= windowStart)
      .slice(0, 100)
      .map((transfer) => ({
        id: transfer.id,
        direction: transfer.direction,
        rail: transfer.rail,
        from_account_id: transfer.from_account_id,
        counterparty:
          lineById.get(transfer.id)?.counterparty ??
          (transfer.to_account_id ? (accountNames.get(transfer.to_account_id) ?? 'Internal transfer') : 'Payee'),
        amount_cents: transfer.amount_cents,
        fee_cents: transfer.fee_cents,
        status: transfer.status,
        memo: transfer.memo,
        scheduled_for: transfer.scheduled_for,
        created_at: transfer.created_at,
        audit_id: transfer.audit_id,
      })),
    audit: audit.map((entry) => ({
      id: entry.id,
      action: entry.action,
      target_type: entry.target_type,
      target_id: entry.target_id,
      summary: entry.summary,
      rationale: entry.rationale,
      grant_id: entry.grant_id,
      created_at: entry.created_at,
    })),
  };
}
