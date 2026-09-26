/**
 * The listing rule (ADR-13) and the availability table (docs/TOOL_CATALOG.md section 4).
 *
 * The rule itself lives in `src/contracts/scopes.ts` - `isListed`, `toolAvailability`,
 * `catalogAvailability` - and is not restated here. What this module adds is the one thing a
 * contract may not do, because contracts hold no logic and import no crypto: the `content_hash`
 * over the snapshot a grant was shown.
 *
 * The hash covers the **listed** entries plus the enabled feature flags, so it changes exactly
 * when the `tools/list` a client receives changes. That is what lets `catalog.tools_listed` carry
 * the full tool array only when it actually changed, while claude.ai re-lists every 25-80 s.
 */
import { createHash } from 'node:crypto';

import {
  TOOL_CATALOG,
  canonicalCatalogSnapshot,
  catalogAvailability,
  isListed,
  type FeatureFlag,
  type GrantView,
  type ScopedTool,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
} from '../contracts/index.js';

import type { AvailabilityTable } from './types.js';

/** A stable 16-hex-character digest of the snapshot a grant was shown. */
export function catalogContentHash(tools: readonly ScopedTool[], flags: readonly string[]): string {
  return createHash('sha256')
    .update(canonicalCatalogSnapshot(tools, flags))
    .digest('hex')
    .slice(0, 16);
}

/** The entries this grant should see, in catalogue order (deterministic, prompt-cache safe). */
export function listedFor(
  catalog: readonly ToolCatalogEntry[],
  grant: GrantView,
  flags: readonly FeatureFlag[],
): ToolCatalogEntry[] {
  return catalog.filter((tool) => isListed(tool, grant, flags));
}

/** What `tools/list` needs: the listed entries, the table for *every* entry, and the hash. */
export function snapshotFor(
  grant: GrantView,
  flags: readonly FeatureFlag[],
  catalog: readonly ToolCatalogEntry[] = TOOL_CATALOG,
): ToolCatalogSnapshot {
  const listed = listedFor(catalog, grant, flags);
  return {
    content_hash: catalogContentHash(listed, flags),
    listed,
    availability: catalogAvailability(catalog, grant, flags),
    feature_flags: [...flags],
  };
}

/** The same table in the JSON shape docs/TOOL_CATALOG.md section 4 publishes. */
export function availabilityTableFor(
  grant: GrantView,
  flags: readonly FeatureFlag[],
  catalog: readonly ToolCatalogEntry[] = TOOL_CATALOG,
): AvailabilityTable {
  const snapshot = snapshotFor(grant, flags, catalog);
  return {
    content_hash: snapshot.content_hash,
    tools: snapshot.availability,
    feature_flags: snapshot.feature_flags,
  };
}
