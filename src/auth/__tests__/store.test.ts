/**
 * The bounded collections and the rate limiter (ADR-4, ADR-16).
 *
 * These are the pieces that stop a passwordless public server from being a memory-exhaustion
 * target, and the consumed/rotated sets are the only auth state the design allows.
 */
import { describe, expect, it } from 'vitest';

import { createClientStore } from '../clients.js';
import { createRateLimiter, ipPrefixOf } from '../rate-limit.js';
import { BoundedLru, ExpiringSet } from '../store.js';

describe('BoundedLru', () => {
  it('drops the least recently used entry past the capacity', () => {
    const lru = new BoundedLru<string, number>(3);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.get('a'); // 'a' becomes the most recent, so 'b' is now the oldest.
    lru.set('d', 4);
    expect(lru.size).toBe(3);
    expect(lru.has('b')).toBe(false);
    expect(lru.get('a')).toBe(1);
    expect(lru.get('d')).toBe(4);
  });
});

describe('ExpiringSet', () => {
  it('forgets an entry at its exp, which is what bounds the replay window (A-11)', () => {
    let clock = 1_000_000;
    const set = new ExpiringSet(() => new Date(clock));
    set.add('jti-1', Math.floor(clock / 1000) + 600);
    expect(set.has('jti-1')).toBe(true);
    clock += 601_000;
    expect(set.has('jti-1')).toBe(false);
    expect(set.size).toBe(0);
  });

  it('stays bounded even when nothing has expired yet (ADR-16)', () => {
    // A refresh `jti` lives for its full seven-day `exp` under a read-only grant, so expiry alone
    // does not bound the set: one rotation per request would grow it for the life of the process.
    const clock = 1_000_000;
    const set = new ExpiringSet(() => new Date(clock), 3);
    const farFuture = Math.floor(clock / 1000) + 7 * 24 * 3600;
    for (const id of ['a', 'b', 'c', 'd', 'e']) set.add(id, farFuture);
    expect(set.size).toBe(3);
    // Every expiry here is identical, so the soonest-expiring rule ties and falls back to
    // insertion order: the oldest insertions went first.
    expect(set.has('a')).toBe(false);
    expect(set.has('e')).toBe(true);
  });

  it('never drops a long-lived id to make room for shorter-lived ones', () => {
    // The old rule evicted the OLDEST INSERTION, so pushing `capacity` rotations through re-opened
    // replay of a code, a refresh `jti` or a revoked grant that was still well inside its `exp`.
    const clock = 1_000_000;
    const second = Math.floor(clock / 1000);
    const set = new ExpiringSet(() => new Date(clock), 1000);
    const sevenDays = second + 7 * 24 * 3600;
    const tenMinutes = second + 600;

    set.add('jti_revoked_grant', sevenDays);
    for (let index = 0; index < 2000; index += 1) set.add(`jti_${index}`, tenMinutes);

    expect(set.has('jti_revoked_grant')).toBe(true);
    expect(set.size).toBeLessThanOrEqual(1000);
    // Forced evictions are counted, so the condition is visible instead of silent.
    expect(set.forcedEvictions).toBeGreaterThan(0);
  });

  it('never evicts the id it was just asked to remember', () => {
    // Forgetting the revocation we were asked to record is the worst outcome of all, so the new
    // entry is never the victim even when it is the soonest to expire in the whole set.
    const clock = 1_000_000;
    const second = Math.floor(clock / 1000);
    const set = new ExpiringSet(() => new Date(clock), 10);
    for (let index = 0; index < 10; index += 1) set.add(`live_${index}`, second + 7 * 24 * 3600);
    set.add('newest', second + 60);
    expect(set.has('newest')).toBe(true);
  });

  it('prefers expired entries to live ones, and counts no forced eviction then', () => {
    let clock = 1_000_000;
    const set = new ExpiringSet(() => new Date(clock), 10);
    for (let index = 0; index < 10; index += 1) set.add(`old_${index}`, Math.floor(clock / 1000) + 60);
    clock += 300_000; // every one of them is now past its exp
    set.add('fresh', Math.floor(clock / 1000) + 7 * 24 * 3600);
    expect(set.has('fresh')).toBe(true);
    expect(set.size).toBe(1);
    expect(set.forcedEvictions).toBe(0);
  });

  it('still evicts an expired entry on read after the amortised sweep window', () => {
    let clock = 1_000_000;
    const set = new ExpiringSet(() => new Date(clock));
    set.add('jti-2', Math.floor(clock / 1000) + 1);
    clock += 2_000;
    // `has` is the correctness-critical path and evicts its own key regardless of the sweep.
    expect(set.has('jti-2')).toBe(false);
  });
});

describe('createRateLimiter', () => {
  it('allows exactly `limit` calls per window and then refuses', () => {
    let clock = 0;
    const limiter = createRateLimiter({ limit: 3, windowMs: 60_000, now: () => new Date(clock) });
    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(true);
    expect(limiter.hit('ip').allowed).toBe(true);
    const refused = limiter.hit('ip');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    clock += 60_001;
    expect(limiter.hit('ip').allowed).toBe(true);
  });

  it('keeps callers apart', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: () => new Date(0) });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('b').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
  });

  it('does not 429 the 30 consecutive registrations infra/smoke.sh makes (A-43)', () => {
    const limiter = createRateLimiter({ limit: 60, windowMs: 3_600_000, now: () => new Date(0) });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(limiter.hit('160.79.104.1').allowed, `attempt ${attempt}`).toBe(true);
    }
  });
});

describe('ipPrefixOf (invariant 11: only the /24 is ever stored)', () => {
  it('keeps three octets of an IPv4 address', () => {
    expect(ipPrefixOf('160.79.104.37')).toBe('160.79.104.0/24');
    expect(ipPrefixOf('::ffff:127.0.0.1')).toBe('127.0.0.0/24');
  });

  it('keeps three hextets of an IPv6 address', () => {
    expect(ipPrefixOf('2001:db8:1234:5678::1')).toBe('2001:db8:1234::/48');
  });
});

describe('the DCR client store', () => {
  it('reconstructs an unknown client id with exactly the claude.ai callback plus loopback (A-12)', () => {
    const store = createClientStore({ capacity: 10, allowDevLoopback: false });
    const { client, reconstructed } = store.resolve('mcpb_never_registered');
    expect(reconstructed).toBe(true);
    expect(client.reconstructed).toBe(true);
    expect(client.token_endpoint_auth_method).toBe('none');
    expect(client.redirect_uris).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'http://localhost/callback',
      'http://127.0.0.1/callback',
    ]);
  });

  it('refuses the Inspector loopback path in production and accepts it elsewhere (A-13)', () => {
    const production = createClientStore({ capacity: 10, allowDevLoopback: false });
    const development = createClientStore({ capacity: 10, allowDevLoopback: true });
    const metadata = { redirect_uris: ['http://127.0.0.1:6276/oauth/callback'] };
    expect(production.register(metadata).ok).toBe(false);
    expect(development.register(metadata).ok).toBe(true);
  });

  it('does not let /authorize reconstructions evict a real registration', () => {
    // `resolve()` is reached from /authorize for any `client_id` a stranger types. Writing the
    // reconstruction back into the same LRU let an unauthenticated caller evict genuine
    // registrations; the evicted client is then rebuilt with only the reconstructed URIs, so a
    // client that registered a ported loopback (the Inspector, Claude Code) hard-fails at
    // /authorize with "Unrecognised callback URL".
    const store = createClientStore({ capacity: 2, allowDevLoopback: true });
    const registered = store.register({
      redirect_uris: ['http://127.0.0.1:6274/oauth/callback'],
      token_endpoint_auth_method: 'none',
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;

    for (let index = 0; index < 20; index += 1) {
      store.resolve(`attacker_${index}`);
    }

    const resolved = store.resolve(registered.client.client_id);
    expect(resolved.reconstructed).toBe(false);
    expect(resolved.client.redirect_uris).toEqual(['http://127.0.0.1:6274/oauth/callback']);
    expect(store.size).toBe(1);
  });

  it('refuses an unbounded redirect_uris array and an absurdly long URI (ADR-16)', () => {
    const store = createClientStore({ capacity: 10, allowDevLoopback: true });
    const many = store.register({
      redirect_uris: Array.from({ length: 40 }, (_, i) => `http://127.0.0.1:${7000 + i}/callback`),
    });
    expect(many.ok).toBe(false);
    const long = store.register({
      redirect_uris: [`http://127.0.0.1:6274/oauth/callback?padding=${'x'.repeat(2000)}`],
    });
    expect(long.ok).toBe(false);
  });

  it('de-duplicates the callbacks it stores', () => {
    const store = createClientStore({ capacity: 10, allowDevLoopback: true });
    const result = store.register({
      redirect_uris: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.ai/api/mcp/auth_callback',
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.client.redirect_uris).toHaveLength(1);
  });

  it('stays bounded (MAX_DCR_CLIENTS, ADR-16)', () => {
    const store = createClientStore({ capacity: 5, allowDevLoopback: false });
    for (let index = 0; index < 20; index += 1) {
      store.register({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] });
    }
    expect(store.size).toBe(5);
  });
});
