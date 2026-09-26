/**
 * The seventeen handlers, assembled.
 *
 * The map is keyed by the catalog name, and `createHandlers` is the only place that knows which
 * handler needs block state (the load tools need the paging knobs, `create_transfer` needs the
 * open-preview memory). Everything else is a plain function of `(ToolCallContext, args)`.
 */
import { TOOL_NAMES } from '../../contracts/index.js';

import type { PreviewStore } from '../previews.js';
import type { ToolCallHandler, ToolsLimits } from '../types.js';

import { DATABASE_HANDLERS } from './database.js';
import { createLoadHandlers } from './load.js';
import { META_HANDLERS } from './meta.js';
import { REFERENCE_HANDLERS } from './reference.js';
import { createWriteHandlers } from './writes.js';
import { XRAY_HANDLERS } from './xray.js';

export interface HandlerDeps {
  readonly limits: ToolsLimits;
  readonly previews: PreviewStore;
}

export function createHandlers(deps: HandlerDeps): Record<string, ToolCallHandler> {
  const handlers: Record<string, ToolCallHandler> = {
    ...DATABASE_HANDLERS,
    ...REFERENCE_HANDLERS,
    ...META_HANDLERS,
    ...createLoadHandlers(deps.limits),
    ...createWriteHandlers(deps.previews),
    ...XRAY_HANDLERS,
  };
  // A catalog entry with no handler would be listed and then answer "unknown tool" at runtime;
  // the catalog is frozen, so this can only ever fire while this block is being edited.
  const missing = TOOL_NAMES.filter((name) => handlers[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`no handler for ${missing.join(', ')}`);
  }
  return handlers;
}

export { DATABASE_HANDLERS, META_HANDLERS, REFERENCE_HANDLERS, XRAY_HANDLERS };
export { createLoadHandlers } from './load.js';
export { createWriteHandlers, createTransferHandler } from './writes.js';
