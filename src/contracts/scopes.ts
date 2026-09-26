/**
 * Scopes, feature flags and the listing rule (block: contracts).
 *
 * Implements docs/TOOL_CATALOG.md section 2 (the ten scopes and the 401 challenge hint),
 * section 4 (the availability table) and ADR-13 (write tools stay listed under a read-only
 * grant so the 403 step-up can fire).
 *
 * This file deliberately does not import `tools.ts`: the listing rule works on the structural
 * `ScopedTool` shape that `ToolCatalogEntry` extends, which keeps the two files acyclic.
 *
 * Pure functions and constants. No I/O.
 */
import type { AuthLevel, ToolAvailability, UnavailableReason } from './events.js';

// ---------------------------------------------------------------------------
// Scopes (docs/TOOL_CATALOG.md section 2)
// ---------------------------------------------------------------------------

/** The ten scopes of v1, in the order they appear on the consent page. */
export const SCOPES = [
  'profile',
  'accounts:read',
  'transactions:read',
  'cards:read',
  'cards:write',
  'transfers:read',
  'transfers:write',
  'bills:read',
  'payees:read',
  'xray:read',
] as const;

export type Scope = (typeof SCOPES)[number];

/** `profile` is implicit in every grant, so a tool requiring it is never hidden. */
export const IMPLICIT_SCOPES: readonly Scope[] = ['profile'];

/** True for a `*:write` scope. Read scopes hide a tool; write scopes only make it unavailable. */
export function isWriteScope(scope: string): boolean {
  return scope.endsWith(':write');
}

export const WRITE_SCOPES: readonly Scope[] = SCOPES.filter(isWriteScope);
export const READ_SCOPES: readonly Scope[] = SCOPES.filter((scope) => !isWriteScope(scope));

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

/** Keeps only the known scopes, in catalogue order, without duplicates. */
export function normaliseScopes(values: readonly string[]): Scope[] {
  const seen = new Set(values);
  return SCOPES.filter((scope) => seen.has(scope));
}

/** Parses an OAuth `scope` parameter (space-separated) into known scopes. */
export function parseScopeString(value: string | null | undefined): Scope[] {
  if (!value) return [];
  return normaliseScopes(value.split(/\s+/).filter(Boolean));
}

/** Renders scopes back into an OAuth `scope` string. */
export function formatScopeString(values: readonly Scope[]): string {
  return values.join(' ');
}

/**
 * The read-only default advertised in the `WWW-Authenticate` challenge of a 401
 * (docs/TOOL_CATALOG.md section 2). Write scopes are never in the first challenge: they are
 * asked for by the 403 step-up.
 */
export const DEFAULT_CHALLENGE_SCOPES: readonly Scope[] = READ_SCOPES;

/** The same list as the single string the challenge header carries. */
export const DEFAULT_CHALLENGE_SCOPE_STRING = formatScopeString(DEFAULT_CHALLENGE_SCOPES);

/** Reads pre-checked on the consent page; writes are opt-in (docs/TOOL_CATALOG.md section 2). */
export const CONSENT_PRECHECKED_SCOPES: readonly Scope[] = READ_SCOPES;

/** `read_only` unless a `*:write` scope was granted (docs/ARCHITECTURE.md section 5). */
export function authLevelForScopes(granted: readonly string[]): AuthLevel {
  return granted.some(isWriteScope) ? 'read_write' : 'read_only';
}

// ---------------------------------------------------------------------------
// Feature flags (ADR-12, Decision D-3)
// ---------------------------------------------------------------------------

/** `FEATURE_FLAGS` is semicolon-separated because `--set-env-vars` splits on commas. */
export const FEATURE_FLAGS = ['writes', 'transfers'] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

/** Both flags are on by default (Decision D-3). */
export const DEFAULT_FEATURE_FLAGS: readonly FeatureFlag[] = FEATURE_FLAGS;

export function isFeatureFlag(value: unknown): value is FeatureFlag {
  return typeof value === 'string' && (FEATURE_FLAGS as readonly string[]).includes(value);
}

/** Keeps only known flags from a parsed `FEATURE_FLAGS` value. */
export function normaliseFeatureFlags(values: readonly string[]): FeatureFlag[] {
  const seen = new Set(values);
  return FEATURE_FLAGS.filter((flag) => seen.has(flag));
}

// ---------------------------------------------------------------------------
// The listing rule (ADR-13)
// ---------------------------------------------------------------------------

/**
 * The part of a catalog entry the listing rule needs. `ToolCatalogEntry` extends it, so
 * `src/contracts/tools.ts` can stay the only place that knows about descriptions and schemas.
 */
export interface ScopedTool {
  readonly name: string;
  /** Every scope a successful call needs, read and write together. */
  readonly requiredScopes: readonly Scope[];
  /** `x-gated-by`: the tool is hidden unless every one of these flags is on. */
  readonly featureFlags: readonly FeatureFlag[];
}

/** What a grant offers the listing rule. */
export interface GrantView {
  readonly scopes: readonly string[];
  readonly auth_level?: AuthLevel;
}

/** The scopes of `tool` that `granted` does not cover. `profile` is always implicit. */
export function missingScopesFor(tool: ScopedTool, granted: readonly string[]): Scope[] {
  const held = new Set<string>([...granted, ...IMPLICIT_SCOPES]);
  return tool.requiredScopes.filter((scope) => !held.has(scope));
}

/** True when every feature flag the tool is gated by is on. */
export function flagsEnabledFor(tool: ScopedTool, enabledFlags: readonly string[]): boolean {
  const on = new Set(enabledFlags);
  return tool.featureFlags.every((flag) => on.has(flag));
}

/**
 * ADR-13: a tool is listed when every **read** scope it needs is granted and its feature flag
 * is on. A missing **write** scope never hides a tool - that is what makes the 403 step-up
 * reachable, and what keeps clients that cache `tools/list` working after the step-up.
 */
export function isListed(
  tool: ScopedTool,
  grant: GrantView,
  enabledFlags: readonly string[],
): boolean {
  if (!flagsEnabledFor(tool, enabledFlags)) return false;
  return missingScopesFor(tool, grant.scopes).every(isWriteScope);
}

/** True when a call would succeed right now: every scope granted and every flag on. */
export function isAvailable(
  tool: ScopedTool,
  grant: GrantView,
  enabledFlags: readonly string[],
): boolean {
  if (!flagsEnabledFor(tool, enabledFlags)) return false;
  return missingScopesFor(tool, grant.scopes).length === 0;
}

/**
 * One row of the availability table (docs/TOOL_CATALOG.md section 4). A tool disabled by a
 * feature flag reports `disabled_for_deployment` and an empty `missing_scopes`: the flag
 * decision comes first and the scope question is moot, exactly as the documented example shows.
 */
export function toolAvailability(
  tool: ScopedTool,
  grant: GrantView,
  enabledFlags: readonly string[],
): ToolAvailability {
  if (!flagsEnabledFor(tool, enabledFlags)) {
    return {
      tool: tool.name,
      listed: false,
      available: false,
      unavailable_reasons: ['disabled_for_deployment'],
      missing_scopes: [],
    };
  }
  const missing = missingScopesFor(tool, grant.scopes);
  const reasons: UnavailableReason[] = missing.length > 0 ? ['missing_scopes'] : [];
  return {
    tool: tool.name,
    listed: missing.every(isWriteScope),
    available: missing.length === 0,
    unavailable_reasons: reasons,
    missing_scopes: [...missing],
  };
}

/** The availability table for the whole catalog, listed entries and hidden ones alike. */
export function catalogAvailability(
  tools: readonly ScopedTool[],
  grant: GrantView,
  enabledFlags: readonly string[],
): ToolAvailability[] {
  return tools.map((tool) => toolAvailability(tool, grant, enabledFlags));
}

/** The names a `tools/list` should return, in catalogue order (deterministic, prompt-cache safe). */
export function listedToolNames(
  tools: readonly ScopedTool[],
  grant: GrantView,
  enabledFlags: readonly string[],
): string[] {
  return tools.filter((tool) => isListed(tool, grant, enabledFlags)).map((tool) => tool.name);
}

/**
 * The `scope` value for the 403 `insufficient_scope` challenge: every still-needed **write**
 * scope of the whole catalog, not only the one tool's, because Claude does not carry earlier
 * step-up scopes forward (docs/TOOL_CATALOG.md section 2).
 */
export function stepUpScopes(tools: readonly ScopedTool[], grant: GrantView): Scope[] {
  const held = new Set<string>([...grant.scopes, ...IMPLICIT_SCOPES]);
  const needed = new Set<Scope>();
  for (const tool of tools) {
    for (const scope of tool.requiredScopes) {
      if (isWriteScope(scope) && !held.has(scope)) needed.add(scope);
    }
  }
  return SCOPES.filter((scope) => needed.has(scope));
}

/** `scopes_supported` in the AS metadata: write scopes appear only when `writes` is on. */
export function supportedScopes(enabledFlags: readonly string[]): Scope[] {
  const on = new Set(enabledFlags);
  return SCOPES.filter((scope) => !isWriteScope(scope) || on.has('writes'));
}

/**
 * Ramp's `scope_to_tools_mapping`: which tools each scope unlocks. Built from the catalog by
 * `buildScopeToTools`; `SCOPE_TO_TOOLS` in `tools.ts` is the materialised version for the
 * 17-tool catalog. Tools requiring several scopes appear under each of them.
 */
export function buildScopeToTools(tools: readonly ScopedTool[]): Record<Scope, string[]> {
  const map = Object.fromEntries(SCOPES.map((scope) => [scope, [] as string[]])) as Record<
    Scope,
    string[]
  >;
  for (const tool of tools) {
    for (const scope of tool.requiredScopes) {
      map[scope].push(tool.name);
    }
  }
  return map;
}

/**
 * A stable, canonical rendering of the catalog snapshot. `src/tools` hashes it into
 * `content_hash`; keeping the serialisation here means the dashboard and the server agree on
 * what "the catalog changed" means. Pure string building, no hashing (no crypto in contracts).
 */
export function canonicalCatalogSnapshot(
  tools: readonly ScopedTool[],
  enabledFlags: readonly string[],
): string {
  const body = tools.map((tool) => ({
    name: tool.name,
    scopes: [...tool.requiredScopes],
    flags: [...tool.featureFlags],
  }));
  return JSON.stringify({ v: 1, flags: [...enabledFlags].sort(), tools: body });
}
