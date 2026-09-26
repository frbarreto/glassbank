/**
 * The overlay key a call reads and writes under (ADR-15, CLAUDE.md invariant 16).
 *
 * Glass Bank is public and passwordless: several strangers use the same shared persona at the
 * same time, and one of them locking a card must not be visible to the others. That property
 * rests entirely on the `login_id` in `BankScope` being per connection.
 */
import { describe, expect, it } from 'vitest';

import { isId } from '../../contracts/index.js';
import { createTools } from '../index.js';
import { bankScopeOf, loginKeyOf, overlayLoginKeyOf } from '../scope.js';
import { ANONYMOUS_LOGIN_ID } from '../types.js';

import { FAKE_READ_WRITE_SCOPES, createFakeAuthContext, createFakeToolContext } from './fakes.js';

describe('bankScopeOf', () => {
  it('uses the login when the grant has one', () => {
    const auth = createFakeAuthContext({ login_id: 'lgn_real01', grant_id: 'grt_one0001' });
    expect(bankScopeOf(auth).login_id).toBe('lgn_real01');
  });

  it('derives a DISTINCT key per grant when login_id is null, never a shared one', () => {
    // The access-token claim is `nullable().default(null)` (src/contracts/auth.ts). A single
    // shared fallback would put every such grant on ONE copy-on-write overlay per persona - the
    // exact thing invariant 16 exists to prevent.
    const one = bankScopeOf(createFakeAuthContext({ login_id: null, grant_id: 'grt_anon0001' }));
    const two = bankScopeOf(createFakeAuthContext({ login_id: null, grant_id: 'grt_anon0002' }));

    expect(one.login_id).not.toBe(two.login_id);
    expect(one.login_id).not.toBe(ANONYMOUS_LOGIN_ID);
    expect(two.login_id).not.toBe(ANONYMOUS_LOGIN_ID);
    // And it stays a well-formed `lgn_` id, so the X-ray envelope still validates.
    expect(isId(one.login_id, 'login')).toBe(true);
    expect(isId(two.login_id, 'login')).toBe(true);
  });

  it('is stable for the same grant', () => {
    const auth = createFakeAuthContext({ login_id: null, grant_id: 'grt_anon0003' });
    expect(overlayLoginKeyOf(auth)).toBe(overlayLoginKeyOf(auth));
  });

  it('falls back to the anonymous id only when the grant id cannot make a valid one', () => {
    // Defence in depth: a grant id carrying a character the `lgn_` pattern forbids would produce
    // an id the X-ray envelope rejects, so the shared bucket is the last resort, not the default.
    const auth = createFakeAuthContext({ login_id: null, grant_id: 'grt_bad.id' });
    expect(overlayLoginKeyOf(auth)).toBe(ANONYMOUS_LOGIN_ID);
    // A degenerate-but-valid grant id still gets its own key rather than the shared one.
    const bare = createFakeAuthContext({ login_id: null, grant_id: 'grt_' });
    expect(overlayLoginKeyOf(bare)).not.toBe(ANONYMOUS_LOGIN_ID);
  });

  it('buckets open previews per connection too (ADR-14)', () => {
    expect(loginKeyOf(createFakeAuthContext({ login_id: 'lgn_x1' }))).toBe('lgn_x1');
    expect(loginKeyOf(createFakeAuthContext({ login_id: null, grant_id: 'grt_y2' }))).toBe('grt_y2');
  });
});

describe('two login-less grants on one shared persona', () => {
  it('do not see each other card locks', async () => {
    const registry = createTools();
    // One fake bank, two connections: the overlay key is the only thing keeping them apart.
    const first = createFakeToolContext({
      auth: { scopes: FAKE_READ_WRITE_SCOPES, login_id: null, grant_id: 'grt_anon0011' },
    });
    const second = createFakeToolContext({
      auth: { scopes: FAKE_READ_WRITE_SCOPES, login_id: null, grant_id: 'grt_anon0012' },
    });
    const shared = first.bank;
    const secondOnSharedBank = { ...second, bank: shared };

    const locked = await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_ava01_01', action: 'lock', rationale: 'the first connection locks it' },
      first,
    );
    expect(locked.isError).toBeUndefined();

    const seenByFirst = await shared.listCards(bankScopeOf(first.auth));
    expect(seenByFirst.data.find((card) => card.id === 'card_ava01_01')?.status).toBe('locked');

    const seenBySecond = await shared.listCards(bankScopeOf(secondOnSharedBank.auth));
    expect(seenBySecond.data.find((card) => card.id === 'card_ava01_01')?.status).toBe('active');
  });
});
