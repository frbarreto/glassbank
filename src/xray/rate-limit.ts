/**
 * The pairing-exchange rate limiter (block: xray).
 *
 * Invariant 14 caps failed pairing exchanges per IP (`RATE_LIMIT_IP_PAIR_FAILURES`, 5/minute).
 * A fixed window over a bounded map, counting **failures only**: a viewer who reloads the
 * dashboard with a good code is never locked out, and an enumerator gets five tries a minute
 * against a 50-bit code (ADR-10).
 *
 * `src/auth` has the same shape; the blocks may not import each other, so each owns its copy.
 */

interface Window {
  count: number;
  startedAt: number;
}

export interface FailureLimiter {
  /** How many failures the key has recorded inside the current window. */
  failures(key: string): number;
  /** True when the key is already at or over the limit. */
  isLimited(key: string): boolean;
  /** Records one failure and returns the new count. */
  recordFailure(key: string): number;
  reset(): void;
}

export interface FailureLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => Date;
  readonly maxKeys?: number;
}

const SWEEP_INTERVAL_MS = 5_000;

export function createFailureLimiter(options: FailureLimiterOptions): FailureLimiter {
  const now = options.now ?? (() => new Date());
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, Window>();
  let lastSweptAt = 0;

  function sweep(currentTime: number): void {
    if (currentTime - lastSweptAt >= SWEEP_INTERVAL_MS) {
      lastSweptAt = currentTime;
      for (const [key, window] of windows) {
        if (currentTime - window.startedAt >= options.windowMs) windows.delete(key);
      }
    }
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }

  function current(key: string, currentTime: number): Window | null {
    const window = windows.get(key);
    if (window === undefined) return null;
    if (currentTime - window.startedAt >= options.windowMs) {
      windows.delete(key);
      return null;
    }
    return window;
  }

  return {
    failures(key) {
      return current(key, now().getTime())?.count ?? 0;
    },
    isLimited(key) {
      return (current(key, now().getTime())?.count ?? 0) >= options.limit;
    },
    recordFailure(key) {
      const currentTime = now().getTime();
      sweep(currentTime);
      const window = current(key, currentTime) ?? { count: 0, startedAt: currentTime };
      window.count += 1;
      windows.set(key, window);
      return window.count;
    },
    reset() {
      windows.clear();
      lastSweptAt = 0;
    },
  };
}
