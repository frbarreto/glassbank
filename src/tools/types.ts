/**
 * Local shapes for the `tools` block.
 *
 * The public contract of a handler is `(ToolContext, args) => Promise<ToolResult>`
 * (`src/contracts/tools.ts`). Two things a handler needs are not on `ToolContext` because they
 * are properties of the *call* rather than of the connection: the tool's own name and the
 * `rationale` the registry stripped off the arguments (ADR-8). `ToolCallContext` adds exactly
 * those two, and nothing else, so every handler stays a pure function of what it is given.
 */
import type {
  FeatureFlag,
  GrantView,
  ToolAvailability,
  ToolCatalogEntry,
  ToolContext,
  ToolRegistry,
  ToolResult,
} from '../contracts/index.js';

/**
 * `BankScope.login_id` is required, but a grant minted before the login cookie existed carries
 * `login_id: null` (`AuthContext`). Those grants share one overlay under this id, which is what
 * `bankScopeOf` in `src/testing/fakes.ts` does too, and it keeps the value a well-formed `lgn_`
 * id so the X-ray envelope still validates.
 */
export const ANONYMOUS_LOGIN_ID = 'lgn_anonymous';

/** What a handler is given: the injected `ToolContext` plus the facts about this call. */
export interface ToolCallContext extends ToolContext {
  /** The tool being called, so a shared handler can name itself in its messages. */
  readonly tool: string;
  /** The model-authored rationale, truncated to 1024 characters; `null` when absent or empty. */
  readonly rationale: string | null;
  /** True when the incoming value was longer than `RATIONALE_MAX_LENGTH` and was cut. */
  readonly rationale_truncated: boolean;
}

/** A handler: a pure function of its call context and its validated arguments. */
export type ToolCallHandler = (
  context: ToolCallContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/** The knobs this block owns. Everything else it needs comes from `ToolContext.limits`. */
export interface ToolsLimits {
  /** Open `create_transfer` previews remembered across calls, LRU-evicted (see previews.ts). */
  readonly maxOpenPreviews: number;
  /** Sessions the intent classifier keeps a tool history for, LRU-evicted. */
  readonly maxIntentSessions: number;
  /** How many recent tool names the classifier looks at. */
  readonly intentHistoryLength: number;
  /** Rows requested per `BankCore` page. */
  readonly loadPageSize: number;
  /** Ramp's `CLIENT_MAX_PAGES`: the loop stops here and tells the model to filter. */
  readonly maxPagesPerLoad: number;
}

export interface ToolsDeps {
  /**
   * The block's own knobs. Everything else a handler needs - the bank, the scratch database, the
   * emitter, the clock, the caps - arrives per request on `ToolContext`, which is what keeps the
   * whole block testable with no wiring at all.
   */
  readonly limits?: Partial<ToolsLimits>;
}

/** The availability table of docs/TOOL_CATALOG.md section 4, in its documented JSON shape. */
export interface AvailabilityTable {
  readonly content_hash: string;
  readonly tools: readonly ToolAvailability[];
  readonly feature_flags: readonly FeatureFlag[];
}

export interface ToolsStats {
  readonly openPreviews: number;
  readonly intentSessions: number;
  readonly calls: number;
  readonly denied: number;
  readonly errors: number;
}

/**
 * What `createTools` returns. It *is* the contract's `ToolRegistry` (so `src/mcp` can take it
 * directly) and carries the block's own handles beside it.
 */
export interface ToolsHandle extends ToolRegistry {
  /** Self-reference, so `const { registry } = createTools(...)` reads naturally in app. */
  readonly registry: ToolRegistry;
  readonly catalog: readonly ToolCatalogEntry[];
  readonly handlers: Readonly<Record<string, ToolCallHandler>>;
  availabilityFor(grant: GrantView, flags?: readonly FeatureFlag[]): AvailabilityTable;
  stats(): ToolsStats;
  /** Drops the remembered previews and the classifier history (tests, and SIGTERM if wanted). */
  reset(): void;
}
