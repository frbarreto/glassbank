/**
 * A `Map` capped by insertion count (block: mcp).
 *
 * ADR-16: every in-memory collection in this server is bounded, because the service accepts
 * passwordless logins from anyone on a single 1 GiB instance. `src/auth` has its own copy
 * (`BoundedLru`); the blocks may not import each other (docs/REPO_LAYOUT.md section 3), and
 * twenty lines of duplication is the price of that rule.
 */
export class BoundedSessionMap<K, V> {
  private readonly items = new Map<K, V>();

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new Error('a bounded map needs a capacity of at least 1');
  }

  get size(): number {
    return this.items.size;
  }

  /** Reads without changing the recency order; for tests and diagnostics. */
  peek(key: K): V | undefined {
    return this.items.get(key);
  }

  get(key: K): V | undefined {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    this.items.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.items.has(key)) this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.capacity) {
      const oldest = this.items.keys().next();
      if (oldest.done === true) break;
      this.items.delete(oldest.value);
    }
  }

  /** A snapshot of the entries, oldest first; safe to delete from while iterating. */
  entries(): [K, V][] {
    return [...this.items];
  }

  delete(key: K): void {
    this.items.delete(key);
  }

  clear(): void {
    this.items.clear();
  }
}
