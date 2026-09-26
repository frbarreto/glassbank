/**
 * The two tools this block can answer on its own (block: mcp).
 *
 * `src/tools` (L3) owns the tool surface and is injected as a `ToolRegistry`. Until `src/app.ts`
 * injects it, `createMcp` still has to answer something, and two of the seventeen tools need
 * nothing but the authenticated caller: `get_current_user` reads `AuthContext`, and
 * `get_tool_availability` is `catalogAvailability` over the frozen catalog. Both are therefore
 * answered here, from `ToolContextBase` alone - no `BankCore`, no `ScratchDb`, no `Pairing`.
 *
 * This is deliberately **not** a `ToolRegistry`: it takes the half-context this block owns, so
 * nothing here pretends to have the blocks it cannot import. Everything else answers a
 * clearly-marked tool error rather than a fake result. The whole file is deleted at I1, when
 * `toolPortFor(registry, toolContext)` in `index.ts` takes over.
 *
 * This is what replaced the T0.3 `createSpikeRegistry`, which spoke a private `SpikeToolRegistry`
 * interface of its own; the block now consumes the contract's `ToolRegistry` (ADR-8, L4).
 */
import { createHash } from 'node:crypto';

import {
  TOOL_CATALOG,
  canonicalCatalogSnapshot,
  catalogAvailability,
  formatScopeString,
  isListed,
  toolError,
  toolText,
  type FeatureFlag,
  type GrantView,
  type Scope,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
  type ToolResult,
} from '../contracts/index.js';

import type { ToolContextBase } from './types.js';

/** Tools answered without `src/tools`. Everything else is listed but not dispatchable yet. */
export const BOOTSTRAP_TOOLS: readonly string[] = ['get_current_user', 'get_tool_availability'];

export const NOT_IMPLEMENTED_MESSAGE =
  'this tool is listed but its handler is not wired into this deployment yet; only get_current_user and get_tool_availability answer until the tools block is injected';

/** `catalog.tools_listed.content_hash`: a stable digest of the snapshot a grant was shown. */
export function catalogContentHash(
  tools: readonly ToolCatalogEntry[],
  flags: readonly string[],
): string {
  return createHash('sha256')
    .update(canonicalCatalogSnapshot(tools, flags))
    .digest('hex')
    .slice(0, 16);
}

/** ADR-13's listing rule over the frozen catalog; identical to what `src/tools` must produce. */
export function bootstrapListFor(
  grant: GrantView,
  flags: readonly FeatureFlag[],
): ToolCatalogSnapshot {
  const listed = TOOL_CATALOG.filter((tool) => isListed(tool, grant, flags));
  return {
    content_hash: catalogContentHash(listed, flags),
    listed,
    availability: catalogAvailability(TOOL_CATALOG, grant, flags),
    feature_flags: flags,
  };
}

export function bootstrapCall(
  name: string,
  _args: Record<string, unknown>,
  context: ToolContextBase,
): ToolResult {
  switch (name) {
    case 'get_current_user':
      return getCurrentUser(context);
    case 'get_tool_availability':
      return getToolAvailability(context);
    default:
      return toolError(NOT_IMPLEMENTED_MESSAGE);
  }
}

function getCurrentUser(context: ToolContextBase): ToolResult {
  const { auth } = context;
  const structured = {
    persona_id: auth.persona.id,
    persona_name: auth.persona.name,
    persona_kind: auth.persona.kind,
    shared_persona: auth.persona.shared,
    login_id: auth.login_id,
    grant_id: auth.grant_id,
    scopes: [...auth.scopes],
    auth_level: auth.auth_level,
    token_expires_at: auth.token_expires_at,
    xray_session_id: auth.xs,
    boot_id: auth.boot_id,
  };
  const lines = [
    `You are connected to Glass Bank as ${auth.persona.name} (${auth.persona.id}), a ${auth.persona.kind} customer.`,
    auth.persona.shared
      ? 'This is one of the shared demo customers: its data is the same for everyone, and any change you make is visible only to this connection.'
      : 'This is a generated demo customer. Keep its id to come back to it later from the sign-in page.',
    `Authorization level: ${auth.auth_level}. Scopes: ${formatScopeString(auth.scopes as Scope[])}.`,
    `The access token expires at ${auth.token_expires_at}.`,
    `X-ray session: ${auth.xs ?? 'not started'}. Server boot id: ${auth.boot_id} (a different boot id means the server restarted and in-memory changes were lost).`,
  ];
  return toolText(lines.join('\n'), structured);
}

function getToolAvailability(context: ToolContextBase): ToolResult {
  const grant: GrantView = { scopes: context.auth.scopes, auth_level: context.auth.auth_level };
  const availability = catalogAvailability(TOOL_CATALOG, grant, context.featureFlags);
  const lines = availability.map((row) => {
    if (row.available) return `${row.tool}: available`;
    const reasons = row.unavailable_reasons.join(', ');
    const missing =
      row.missing_scopes.length > 0 ? ` (still needs ${row.missing_scopes.join(' ')})` : '';
    return `${row.tool}: ${row.listed ? 'listed but unavailable' : 'hidden'} - ${reasons}${missing}`;
  });
  return toolText(
    `Tool availability for this connection (${context.auth.auth_level}):\n${lines.join('\n')}`,
    { availability },
  );
}
