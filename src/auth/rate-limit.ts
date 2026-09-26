/**
 * The app-level rate limiter (block: auth).
 *
 * ADR-16: the SDK auth router's per-IP `express-rate-limit` defaults are wrong in both
 * directions behind Cloud Run (without `trust proxy` every caller shares the proxy IP; with it
 * every claude.ai user shares Anthropic's `160.79.104.0/21` egress), so the limits live here
 * with the knob names of docs/DEPLOYMENT.md section 3 and values sized for a shared `/21`.
 *
 * A fixed window over a bounded map: no dependency, no timer, and eviction on every sweep.
 */
import type { Request } from 'express';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the current window ends; the value of `Retry-After` on a 429. */
  readonly retryAfterSeconds: number;
}

export interface RateLimiter {
  hit(key: string): RateLimitDecision;
  reset(): void;
}

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => Date;
  /** Bound on tracked keys, so the limiter itself cannot be the memory-exhaustion target. */
  readonly maxKeys?: number;
}

interface Window {
  count: number;
  startedAt: number;
}

/** How often the expired-window scan runs, at most. */
const SWEEP_INTERVAL_MS = 5_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => new Date());
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, Window>();

  // A full scan of the map on every hit is O(n) on the main event loop, and the number of tracked
  // keys is attacker-influenced, so the scan is amortised. Correctness does not depend on it:
  // `hit` re-reads the window's own `startedAt` and starts a new window when it has elapsed.
  let lastSweptAt = 0;

  function sweep(currentTime: number): void {
    if (currentTime - lastSweptAt >= SWEEP_INTERVAL_MS) {
      lastSweptAt = currentTime;
      for (const [key, window] of windows) {
        if (currentTime - window.startedAt >= options.windowMs) windows.delete(key);
      }
    }
    // The capacity bound is not amortised: it is what keeps the map from being the target.
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done === true) break;
      windows.delete(oldest.value);
    }
  }

  return {
    hit(key: string): RateLimitDecision {
      const currentTime = now().getTime();
      sweep(currentTime);
      const existing = windows.get(key);
      const window =
        existing === undefined || currentTime - existing.startedAt >= options.windowMs
          ? { count: 0, startedAt: currentTime }
          : existing;
      window.count += 1;
      windows.set(key, window);
      const elapsed = currentTime - window.startedAt;
      const retryAfterSeconds = Math.max(1, Math.ceil((options.windowMs - elapsed) / 1000));
      return {
        allowed: window.count <= options.limit,
        remaining: Math.max(0, options.limit - window.count),
        retryAfterSeconds,
      };
    },

    reset() {
      windows.clear();
      lastSweptAt = 0;
    },
  };
}

/**
 * The client address, honouring Express `trust proxy` (invariant 12). Falls back to a literal so
 * a missing address groups together rather than escaping the limit entirely.
 */
export function clientIpOf(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

/** Only the `/24` prefix of an IPv4 address is ever logged or stored (invariant 11). */
export function ipPrefixOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const octets = plain.split('.');
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  // IPv6 (and the ::1 loopback): keep the first three hextets only.
  const hextets = plain.split(':').filter(Boolean);
  if (hextets.length === 0) return null;
  return `${hextets.slice(0, 3).join(':')}::/48`;
}
