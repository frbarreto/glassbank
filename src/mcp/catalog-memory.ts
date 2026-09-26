/**
 * What each grant was last shown in `tools/list` (block: mcp).
 *
 * claude.ai re-lists every 25 to 80 seconds and the X-ray event log is memory-backed, so
 * repeating the seventeen-entry tool array on every list would dominate the log for no
 * information at all. docs/XRAY_EVENT_MODEL.md section 3 therefore says: carry the full array
 * **only when `content_hash` changed for that grant**, otherwise carry `snapshot_ref`, the id of
 * the event that did.
 *
 * The comparison is per grant and not per `xs` on purpose: a grant that idles past
 * `XS_IDLE_GAP_MINUTES` gets a new session but the same catalog, and the X-ray read model
 * resolves an elided array by `content_hash` before it falls back to `snapshot_ref`, so the new
 * session still renders its tools.
 */
import { BoundedSessionMap } from './bounded-map.js';

export interface CatalogDecision {
  /** True when this listing must carry the full array. */
  readonly changed: boolean;
  /** The event that last carried the full array for this grant, when it is known. */
  readonly snapshotRef: number | null;
}

export interface CatalogMemory {
  decide(grantId: string, contentHash: string): CatalogDecision;
  /** Records the id the emitter assigned to a listing that carried the full array. */
  remember(grantId: string, contentHash: string, eventId: number | null): void;
  readonly size: number;
}

export function createCatalogMemory(capacity = 5000): CatalogMemory {
  const seen = new BoundedSessionMap<string, { hash: string; eventId: number | null }>(capacity);
  return {
    get size() {
      return seen.size;
    },
    decide(grantId, contentHash) {
      const previous = seen.get(grantId);
      if (previous === undefined || previous.hash !== contentHash) {
        return { changed: true, snapshotRef: null };
      }
      return { changed: false, snapshotRef: previous.eventId };
    },
    remember(grantId, contentHash, eventId) {
      seen.set(grantId, { hash: contentHash, eventId });
    },
  };
}
