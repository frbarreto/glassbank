/**
 * A bounded least-recently-used map (block: bank-core).
 *
 * Invariant 14 and ADR-16: every map in this block is capped, because anyone can log in without a
 * password and each persona costs a ~2,000-row dataset. `Map` in JavaScript iterates in insertion
 * order, so "touch on read" is a delete followed by a set and the oldest key is always the first
 * one the iterator yields; that is the whole implementation.
 *
 * `onEvict` is how `bank-core` turns an eviction into a `bank.op` event - a cap that silently
 * drops state and never says so is exactly what invariant 13 forbids.
 */
export interface BoundedLruOptions<K, V> {
  readonly maxEntries: number;
  /** Called for each entry dropped to stay under the cap, oldest first. */
  readonly onEvict?: (key: K, value: V) => void;
}

export class BoundedLru<K, V> {
  private readonly entries = new Map<K, V>();
  private readonly maxEntries: number;
  private readonly onEvict: ((key: K, value: V) => void) | undefined;

  constructor(options: BoundedLruOptions<K, V>) {
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries));
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Reads and marks the entry most-recently-used. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Reads without changing the recency order; for assertions and diagnostics. */
  peek(key: K): V | undefined {
    return this.entries.get(key);
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** Inserts or replaces, marks most-recently-used, then evicts down to the cap. */
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.evictToCap();
  }

  delete(key: K): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries[Symbol.iterator]();
  }

  private evictToCap(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      const key = oldest.value;
      const value = this.entries.get(key) as V;
      this.entries.delete(key);
      this.onEvict?.(key, value);
    }
  }
}
