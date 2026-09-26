/**
 * A tiny insertion/recency-ordered bounded map (CLAUDE.md invariant 14: every cache in this
 * system has a cap). Used for the open-preview memory and the intent classifier's per-session
 * tool history; both are small, per-process and rebuilt on demand, so an eviction is never an
 * error - it only costs the model one extra call.
 */
export class BoundedMap<V> {
  private readonly entries = new Map<string, V>();

  constructor(readonly capacity: number) {}

  get size(): number {
    return this.entries.size;
  }

  /** Reads and marks the key as most recently used. */
  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  peek(key: string): V | undefined {
    return this.entries.get(key);
  }

  /** Writes, marks as most recently used and evicts the oldest entries over the cap. */
  set(key: string, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  values(): V[] {
    return [...this.entries.values()];
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }
}
