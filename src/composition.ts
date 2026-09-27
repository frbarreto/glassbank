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
