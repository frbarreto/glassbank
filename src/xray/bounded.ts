/**
 * Bounded collections (block: xray).
 *
 * ADR-16 wants every in-memory collection bounded, and the X-ray indexes are all fed by traffic a
 * stranger controls. `src/auth` has the same class; the blocks may not import each other
 * (docs/REPO_LAYOUT.md section 3), so each owns its copy.
 */

/** A `Map` capped by insertion count; the least recently used entry is dropped first. */
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
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Reads without promoting the key: for a scope check on the hot fan-out path. */
  peek(key: K): V | undefined {
    return this.entries.get(key);
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

  clear(): void {
    this.entries.clear();
  }

  keys(): IterableIterator<K> {
    return this.entries.keys();
  }

  values(): IterableIterator<V> {
    return this.entries.values();
  }

  entriesInOrder(): [K, V][] {
    return [...this.entries.entries()];
  }
}
