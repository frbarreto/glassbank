/**
 * Local shapes for the `mcp` block.
 *
 * `src/mcp` may import `src/contracts` and `src/tools` only (docs/REPO_LAYOUT.md section 3), so
 * it cannot reference `AppConfig` from `src/config` and it cannot reference `BankCore`,
 * `ScratchDb` or `Pairing` implementations either. Everything it needs from the outside is
 * re-declared here and injected by `src/app.ts`.
 */
import type {
  AuthContext,
  FeatureFlag,
  OAuthClient,
  Persona,
  ToolContext,
  XrayEmitter,
} from '../contracts/index.js';

/** Exactly the configuration `createMcp` needs. A structural subset of `AppConfig`. */
export interface McpConfig {
  /** Fallback canonical base URL when the request `Host` is not listed (A-36). */
  readonly publicBaseUrl: string;
  readonly publicHosts: readonly string[];
  /** CLAUDE.md invariant 10. Phase 0 runs `log-only`; `allowlist` is switched on at T0.5. */
  readonly originPolicy: 'log-only' | 'allowlist';
  readonly featureFlags: readonly string[];
  /** `XS_IDLE_GAP_MINUTES`: silence longer than this starts a new X-ray session (A-27). */
  readonly xsIdleGapMinutes: number;
  /** `RATE_LIMIT_GRANT_TOOL_CALLS`, per grant per minute. */
  readonly grantToolCallsPerMin: number;
}

/**
 * One structured stdout line per `/mcp` request.
 *
 * This is **not** the observability path any more - the `XrayEmitter` is (CLAUDE.md invariant
 * 13). It survives for one job the contract's `http.request` event deliberately does not do:
 * recording the raw JSON-RPC facts of a request (`rpc_methods`, `client_info`,
 * `client_capabilities`, `initialize_protocol_version`) so that
 * `docs/observations/claude-ai.md` can be filled from a real connection's container log without
 * a dashboard viewer being attached.
 */
export interface McpLogRecord {
  readonly event: string;
  readonly [key: string]: unknown;
}

export type McpLogger = (record: McpLogRecord) => void;

/** Kept so an older call site that named the T0.3 spike type still compiles. */
export type SpikeLogRecord = McpLogRecord;
export type SpikeLogger = McpLogger;

/**
 * The part of a `ToolContext` this block can build on its own.
 *
 * `src/mcp` owns the protocol and the authenticated caller; it does not own `BankCore`,
 * `ScratchDb`, `Pairing` or the deployment limits, and may not import the blocks that do. So it
 * builds this half and `src/app.ts` completes it (`ToolContextFactory`).
 */
export interface ToolContextBase {
  readonly auth: AuthContext;
  /**
   * The emitter already correlated to this request: `xs`, `login_id`, `grant_id`, `persona_id`,
   * `request_id`, `client`, `protocol_version` and `era` are filled in, so a handler emits
   * `bank.op` or `sql.query` without repeating any of it.
   */
  readonly xray: XrayEmitter;
  readonly featureFlags: readonly FeatureFlag[];
  readonly now: () => Date;
  readonly requestId: string | null;
  readonly publicBaseUrl: string;
}

/**
 * What the transport hands a `ToolPort` for one call. `auth` is `null` on the public lane, whose
 * caller is anonymous (D-26); `grantId` and `xs` are then the visitor's pseudo grant and session.
 */
export interface ToolCallBase extends Omit<ToolContextBase, 'auth'> {
  readonly auth: AuthContext | null;
  readonly grantId: string;
  readonly xs: string | null;
}

/**
 * How `src/app.ts` turns the half `mcp` knows into the whole thing `src/tools` needs:
 *
 * ```ts
 * toolContext: (base) => ({
 *   ...base,
 *   bank,
 *   scratch: scratchFor(base.auth.grant_id),
 *   pairing: xray.pairing,
 *   limits,
 * })
 * ```
 */
export type ToolContextFactory = (base: ToolContextBase) => ToolContext | Promise<ToolContext>;

/** Resolves the `sub` claim into the persona every handler sees. `bankCore.personas.get` in app. */
export type PersonaLookup = (personaId: string) => Promise<Persona | null>;

/** Resolves an OAuth `client_id` into the view `AuthContext` carries. `auth.lookupClient` in app. */
export type ClientLookup = (clientId: string) => OAuthClient;
