/**
 * The only mutable auth state (block: auth).
 *
 * ADR-4: verification is stateless except for three tiny sets - consumed authorization-code
 * `jti`s, rotated or revoked refresh `jti`s, and revoked `grant_id`s. Each entry is evicted at
 * the `exp` of the token it describes, so the memory is bounded by the token lifetimes and a
 * restart only reopens a replay window bounded by that same `exp` (A-11).
 *
 * Everything here is in-process: `--max-instances=1` is a correctness requirement
 * (CLAUDE.md invariant 1), and there is no second instance to share a set with.
 */

/** A `Map` capped by insertion count; the least recently used entry is dropped first (ADR-16). */
export class BoundedLru<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('a bounded LRU needs a capacity of at least 1');
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Re-insert so this key becomes the most recently used one.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }
}

/** Default cap on an `ExpiringSet`; ADR-16 wants every in-memory collection bounded. */
export const DEFAULT_EXPIRING_SET_CAPACITY = 100_000;

/** How often `add` runs a full sweep. `has` still evicts its own key on every read. */
const SWEEP_INTERVAL_MS = 5_000;

/**
 * A set of ids that expire. Eviction is lazy (on every read, plus an amortised sweep on write),
 * so no timer is needed and the SIGTERM budget of invariant 12 is never at risk.
 *
 * Two bounds beyond the expiry itself (ADR-16): a capacity, because a refresh `jti` lives for its
 * full 7-day `exp` under a read-only grant and one rotation per request would otherwise grow the
 * map without limit; and an amortised sweep, because a full map scan on every insertion is O(n)
 * on the main event loop and `has()` is the only correctness-critical eviction path.
 */
export class ExpiringSet {
  private readonly entries = new Map<string, number>();
  private lastSweptAt = 0;
  private forcedEvictionCount = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly capacity: number = DEFAULT_EXPIRING_SET_CAPACITY,
  ) {
    if (capacity < 1) throw new Error('an expiring set needs a capacity of at least 1');
  }

  get size(): number {
    this.evict();
    return this.entries.size;
  }

  /**
   * How many still-valid ids this set has been forced to forget because it was full of live
   * entries. Anything above zero means a replay window was re-opened inside a token's `exp`, so
   * it is a number an operator has to be able to see rather than a silent condition.
   */
  get forcedEvictions(): number {
    return this.forcedEvictionCount;
  }

  /** `expiresAtSeconds` is the `exp` claim of the token this id belongs to. */
  add(id: string, expiresAtSeconds: number): void {
    const currentTime = this.now().getTime();
    if (currentTime - this.lastSweptAt >= SWEEP_INTERVAL_MS) {
      this.lastSweptAt = currentTime;
      this.evict();
    }
    this.entries.delete(id);
    this.entries.set(id, expiresAtSeconds);
    if (this.entries.size > this.capacity) this.makeRoom(id);
  }

  /**
   * Frees space without ever preferring an unexpired entry to an expired one.
   *
   * The old rule dropped the OLDEST INSERTION, which is the entry that has been protecting a
   * token the longest and says nothing about whether that token is still live: pushing
   * `capacity` rotations through re-opened replay of a code, a refresh `jti` or a revoked grant
   * that was still well inside its `exp`. Expired entries go first; only if the set is genuinely
   * full of live ids is anything live dropped, and then it is the one closest to expiring anyway
   * - the smallest replay window this can possibly re-open. The id just added is never the
   * victim, because forgetting the revocation we were asked to record is the worst outcome of all.
   *
   * A whole pass costs O(n), so it removes a batch rather than one entry, which makes the cost
   * amortised O(1) per `add` and stops the overflow path from becoming a denial of service.
   */
  private makeRoom(justAdded: string): void {
    this.evict();
    if (this.entries.size <= this.capacity) return;

    const overflow = this.entries.size - this.capacity;
    // At least 1% of the capacity at a time, so the O(n) scan is not repeated on every insertion.
    const batch = Math.max(overflow, Math.ceil(this.capacity / 100));
    const candidates: { id: string; expiry: number }[] = [];
    for (const [id, expiry] of this.entries) {
      if (id === justAdded) continue;
      candidates.push({ id, expiry });
    }
    candidates.sort((left, right) => left.expiry - right.expiry);
    for (const candidate of candidates.slice(0, batch)) {
      this.entries.delete(candidate.id);
      this.forcedEvictionCount += 1;
    }
  }

  has(id: string): boolean {
    const expiry = this.entries.get(id);
    if (expiry === undefined) return false;
    if (expiry * 1000 <= this.now().getTime()) {
      this.entries.delete(id);
      return false;
    }
    return true;
  }

  evict(): number {
    const cutoff = this.now().getTime();
    let removed = 0;
    for (const [id, expiry] of this.entries) {
      if (expiry * 1000 <= cutoff) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
