/**
 * The `tools` block: the seventeen handlers, the registry and the intent layer.
 *
 * `createTools(deps)` is the whole public surface. It returns the contract's `ToolRegistry`, so
 * `src/mcp` takes it as-is; everything a handler touches - the bank, the scratch database, the
 * X-ray emitter, the pairing service, the clock, the caps - arrives per request on `ToolContext`
 * and is injected by `src/app.ts`. This block imports `src/contracts` and nothing else, which is
 * why it can be tested against fakes alone (docs/REPO_LAYOUT.md section 3).
 *
 * What it does *not* do, on purpose: no HTTP, no transport, no SQL, no bank logic, no persona
 * generation, no redaction. Those belong to `mcp`, `etl`, `bank-core` and `xray`.
 */
export { createTools, TOOLS_LIMIT_DEFAULTS } from './registry.js';

export {
  availabilityTableFor,
  catalogContentHash,
  listedFor,
  snapshotFor,
} from './availability.js';

export {
  correlationOf,
  describeToolCall,
  emitIntent,
  readRationale,
  stripRationale,
  type RationaleFacts,
  type ToolCallDescription,
} from './rationale.js';

export {
  classifyIntent,
  createIntentClassifier,
  type IntentClassifier,
  type IntentInference,
} from './intent.js';

export {
  createHandlers,
  createLoadHandlers,
  createTransferHandler,
  createWriteHandlers,
  DATABASE_HANDLERS,
  META_HANDLERS,
  REFERENCE_HANDLERS,
  XRAY_HANDLERS,
  type HandlerDeps,
} from './handlers/index.js';

export {
  describeFailure,
  describeScratchError,
  RELOAD_AFTER_TEARDOWN,
  TOO_MANY_PAGES_MESSAGE,
} from './errors.js';

export { collectPages, normaliseDate, parseDateRange, withoutPersonaId } from './rows.js';
export { bankScopeOf, loginKeyOf, overlayLoginKeyOf } from './scope.js';
export { formatMoney } from './format.js';
export { createPreviewStore, previewKey, type OpenPreview, type PreviewStore } from './previews.js';

export { ANONYMOUS_LOGIN_ID } from './types.js';
export type {
  AvailabilityTable,
  ToolCallContext,
  ToolCallHandler,
  ToolsDeps,
  ToolsHandle,
  ToolsLimits,
  ToolsStats,
} from './types.js';
