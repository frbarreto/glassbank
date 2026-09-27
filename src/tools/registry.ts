/**
 * The registry: the listing rule, the dispatch, and everything that has to happen around a call.
 *
 * Order matters and is the contract of this file:
 *   1. unknown tool           -> throws, so the transport can answer `-32601` (a protocol error,
 *                                not a tool error: the tool does not exist, so it cannot fail).
 *   2. rationale              -> read, stripped, and reported as `intent.declared` or
 *                                `intent.missing` *before* anything else, so the model's stated
 *                                intent is captured even for a call that is about to be refused.
 *   3. feature flag and scope -> defence in depth. The bearer gate in `src/mcp` already answered
 *                                `403 insufficient_scope` for these (ADR-13), so reaching this
 *                                point means the gate was bypassed; `tool.call.denied` records it.
 *   4. lenient validation     -> ADR-8. A missing `rationale` is never a validation error here.
 *   5. the handler            -> wrapped, so every failure leaves as `isError: true` with Ramp's
 *                                wording (A-08) instead of a stack trace or a protocol code.
 *   6. the classifier         -> `intent.inferred`, always labelled as inferred.
 */
import {
  DEFAULT_FEATURE_FLAGS,
  TOOL_CATALOG,
  flagsEnabledFor,
  getTool,
  missingScopesFor,
  toolError,
  type FeatureFlag,
  type GrantView,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
  type ToolContext,
  type ToolResult,
  type XrayCorrelation,
} from '../contracts/index.js';

import { availabilityTableFor, snapshotFor } from './availability.js';
import { createHandlers } from './handlers/index.js';
import { createIntentClassifier } from './intent.js';
import { createPreviewStore } from './previews.js';
import { correlationOf, emitIntent, readRationale, stripRationale } from './rationale.js';
import { describeFailure } from './errors.js';
import type {
  AvailabilityTable,
  ToolCallContext,
  ToolCallHandler,
  ToolsDeps,
  ToolsHandle,
  ToolsLimits,
} from './types.js';

/** Ramp's `CLIENT_MAX_PAGES`; the page size is ours (A-23: pages are big, the ceiling is a knob). */
export const TOOLS_LIMIT_DEFAULTS: ToolsLimits = {
  maxOpenPreviews: 200,
  maxIntentSessions: 500,
  intentHistoryLength: 8,
  loadPageSize: 500,
  maxPagesPerLoad: 100,
};

/** The tool error for arguments the lenient schema refused; shared with `public.ts`. */
export function validationMessage(
  name: string,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string {
  const detail = issues
    .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
    .join('; ');
  return `the arguments for ${name} did not match its schema: ${detail}`;
}

export function createTools(deps: ToolsDeps = {}): ToolsHandle {
  const limits: ToolsLimits = { ...TOOLS_LIMIT_DEFAULTS, ...deps.limits };
  const previews = createPreviewStore(limits.maxOpenPreviews);
  const classifier = createIntentClassifier({
    maxSessions: limits.maxIntentSessions,
    historyLength: limits.intentHistoryLength,
  });
  const handlers = createHandlers({ limits, previews });
  let calls = 0;
  let denied = 0;
  let errors = 0;

  function deny(
    context: ToolContext,
    entry: ToolCatalogEntry,
    reason: 'insufficient_scope' | 'feature_flag',
    missing: readonly string[],
    correlation: XrayCorrelation,
    message: string,
  ): ToolResult {
    denied += 1;
    context.xray.emit(
      'tool.call.denied',
      {
        tool: entry.name,
        denied_reason: reason,
        required_scopes: [...entry.requiredScopes],
        missing_scopes: [...missing],
        status: 403,
      },
      correlation,
    );
    return toolError(message);
  }

  const registry: ToolsHandle = {
    catalog: TOOL_CATALOG,

    get registry() {
      return registry;
    },

    handlers: handlers as Readonly<Record<string, ToolCallHandler>>,

    listFor(grant: GrantView, flags: readonly FeatureFlag[]): ToolCatalogSnapshot {
      return snapshotFor(grant, flags);
    },

    /** The feature flags default to `DEFAULT_FEATURE_FLAGS` (both on, Decision D-3). */
    availabilityFor(grant: GrantView, flags?: readonly FeatureFlag[]): AvailabilityTable {
      return availabilityTableFor(grant, flags ?? DEFAULT_FEATURE_FLAGS);
    },

    async call(
      name: string,
      args: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolResult> {
      const entry = getTool(name);
      if (entry === undefined) {
        // A missing tool is the caller's `-32601`; the transport raises it, not this registry.
        throw new Error(`unknown tool: ${name}`);
      }
      calls += 1;
      const correlation = correlationOf(context.auth, context.requestId);
      const facts = readRationale(args.rationale);
      emitIntent(context.xray, entry.name, facts, correlation);

      const flags = context.featureFlags;
      if (!flagsEnabledFor(entry, flags)) {
        return deny(
          context,
          entry,
          'feature_flag',
          [],
          correlation,
          `${entry.name} is disabled on this deployment (it needs the ${entry.featureFlags.join(' and ')} feature flag)`,
        );
      }
      const missing = missingScopesFor(entry, context.auth.scopes);
      if (missing.length > 0) {
        return deny(
          context,
          entry,
          'insufficient_scope',
          missing,
          correlation,
          `${entry.name} needs the ${missing.join(' ')} scope, and this connection was not authorized for it: ask the user to reconnect and approve it`,
        );
      }

      const parsed = entry.lenientInputSchema.safeParse(args);
      if (!parsed.success) {
        errors += 1;
        return toolError(validationMessage(entry.name, parsed.error.issues));
      }

      const callContext: ToolCallContext = {
        ...context,
        tool: entry.name,
        rationale: facts.value,
        rationale_truncated: facts.truncated,
      };
      const handler = handlers[entry.name];
      if (handler === undefined) {
        throw new Error(`unknown tool: ${name}`);
      }

      let result: ToolResult;
      try {
        result = await handler(callContext, stripRationale(parsed.data as Record<string, unknown>));
      } catch (error) {
        result = toolError(describeFailure(error, context.limits));
      }
      if (result.isError === true) errors += 1;

      const inference = classifier.observe(
        context.auth.xs ?? context.auth.grant_id,
        entry.name,
        facts.value,
      );
      if (inference !== null) {
        context.xray.emit(
          'intent.inferred',
          {
            workflow: inference.workflow,
            confidence: inference.confidence,
            source: 'classifier',
            model_authored: false,
            tools: [...inference.tools],
          },
          correlation,
        );
      }
      return result;
    },

    stats() {
      return {
        openPreviews: previews.size(),
        intentSessions: classifier.size(),
        calls,
        denied,
        errors,
      };
    },

    reset() {
      previews.clear();
      classifier.reset();
      calls = 0;
      denied = 0;
      errors = 0;
    },
  };

  return registry;
}
