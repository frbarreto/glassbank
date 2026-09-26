/**
 * The `rationale` rule of ADR-8 / A-06.
 *
 * The published JSON schema says `rationale` is required; the lenient server-side schema says it
 * is optional and truncated. So by the time a call reaches this block it may carry a good
 * rationale, an over-long one, an empty one, one of the wrong type, or none at all - and in every
 * case the tool must still run. This module is the one place that decides which of those it was,
 * strips the value off the arguments the handler sees, and emits `intent.declared` or
 * `intent.missing`.
 *
 * Pure functions plus one emit. No I/O.
 */
import {
  RATIONALE_MAX_LENGTH,
  isRationaleMissing,
  isRationaleTruncated,
  missingScopesFor,
  rationaleMissingReason,
  type AuthContext,
  type Scope,
  type ToolCatalogEntry,
  type XrayCorrelation,
  type XrayEmitter,
  CLAUDE_TOOL_BUDGET_MS,
} from '../contracts/index.js';

/** Everything the registry, the events and the handler need to know about one `rationale`. */
export interface RationaleFacts {
  /** The value as the server keeps it: truncated to 1024 characters, or `null` when unusable. */
  readonly value: string | null;
  readonly present: boolean;
  readonly truncated: boolean;
  /** Why it was unusable; `null` when it was usable. */
  readonly missing_reason: 'absent' | 'empty' | 'wrong_type' | null;
}

/**
 * Reads the raw `rationale` argument. Never throws and never rejects a call: that is the whole
 * point of A-06 (Ramp answers HTTP 422; we run the tool and report `intent.missing`).
 */
export function readRationale(raw: unknown): RationaleFacts {
  const truncated = isRationaleTruncated(raw);
  if (isRationaleMissing(raw)) {
    return { value: null, present: false, truncated, missing_reason: rationaleMissingReason(raw) };
  }
  return {
    value: (raw as string).slice(0, RATIONALE_MAX_LENGTH),
    present: true,
    truncated,
    missing_reason: null,
  };
}

/** The arguments a handler sees: everything except `rationale`, which is on the context instead. */
export function stripRationale(args: Record<string, unknown>): Record<string, unknown> {
  const { rationale: _rationale, ...rest } = args;
  return rest;
}

/** The correlation every event this block emits carries, derived from the verified caller. */
export function correlationOf(auth: AuthContext, requestId: string | null): XrayCorrelation {
  return {
    xs: auth.xs,
    login_id: auth.login_id,
    grant_id: auth.grant_id,
    persona_id: auth.persona.id,
    client: auth.client,
    request_id: requestId,
  };
}

/**
 * `intent.declared` when the model told us why, `intent.missing` when it did not. Both carry the
 * tool name so the dashboard's intent panel can line them up with the call.
 */
export function emitIntent(
  xray: XrayEmitter,
  tool: string,
  facts: RationaleFacts,
  correlation: XrayCorrelation,
): void {
  if (facts.present && facts.value !== null) {
    xray.emit(
      'intent.declared',
      {
        text: facts.value,
        source: 'rationale',
        model_authored: true,
        tool,
        truncated: facts.truncated,
      },
      correlation,
    );
    return;
  }
  xray.emit('intent.missing', { tool, reason: facts.missing_reason ?? 'absent' }, correlation);
}

/**
 * The `tool.call.started` payload fields this block owns (docs/blocks/tools.md "Events owned").
 * `src/mcp` emits the event itself - it knows the era, the protocol version and `_meta` - but the
 * rationale bookkeeping and the required scopes are ours, so it takes them from here instead of
 * re-deriving them. `arguments` stays verbatim, `rationale` included, exactly as
 * `test/fixtures/events.jsonl` records it; the X-ray emitter applies the per-tool deny-list.
 */
export interface ToolCallDescription {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
  readonly rationale: string | null;
  readonly rationale_present: boolean;
  readonly rationale_truncated: boolean;
  readonly required_scopes: readonly Scope[];
  readonly missing_scopes: readonly Scope[];
  readonly budget_ms: number;
}

export function describeToolCall(
  entry: ToolCatalogEntry,
  args: Record<string, unknown>,
  options: { readonly grantedScopes?: readonly string[]; readonly budgetMs?: number } = {},
): ToolCallDescription {
  const facts = readRationale(args.rationale);
  return {
    tool: entry.name,
    arguments: args,
    rationale: facts.value,
    rationale_present: facts.present,
    rationale_truncated: facts.truncated,
    required_scopes: entry.requiredScopes,
    missing_scopes:
      options.grantedScopes === undefined ? [] : missingScopesFor(entry, options.grantedScopes),
    budget_ms: options.budgetMs ?? CLAUDE_TOOL_BUDGET_MS,
  };
}
