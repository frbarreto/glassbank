/**
 * Pairing codes (ADR-10, A-24, CLAUDE.md invariants 11 and 14).
 *
 * The code is bound to the login, not to the grant; it is multi-use inside its 24 hours; and the
 * exchange is rate-limited per IP at five failures a minute, which is what makes a 50-bit code
 * non-enumerable inside its TTL.
 */
import { describe, expect, it } from 'vitest';

import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_PATTERN,
  PAIRING_CODE_TTL_HOURS,
  type XrayEvent,
} from '../../contracts/index.js';

import { shortHash } from '../redaction.js';
import { createHarness } from './harness.js';

function pairingEvents(harness: ReturnType<typeof createHarness>): XrayEvent[] {
  return harness.xray.ring.last(200).filter((event) => event.type.startsWith('xray.pairing.'));
}

describe('minting', () => {
  it('mints BANK-XXXX-XXXX-XX from the 32-character alphabet', async () => {
    const harness = createHarness();
    try {
      for (let index = 0; index < 25; index += 1) {
        const minted = await harness.xray.pairing.createCode({ login_id: 'lgn_mint01' });
        expect(minted.code).toMatch(PAIRING_CODE_PATTERN);
        const characters = minted.code.replace(/^BANK-/, '').replace(/-/g, '');
        expect(characters).toHaveLength(10);
        for (const character of characters) {
          expect(PAIRING_CODE_ALPHABET).toContain(character);
        }
        expect(minted.code).not.toMatch(/[01OI]/);
      }
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('builds the link from PUBLIC_BASE_URL and expires in 24 hours (A-36)', async () => {
    const clock = new Date('2026-09-08T12:00:00.000Z');
    const harness = createHarness({ now: () => clock });
    try {
      const minted = await harness.xray.pairing.createCode({ login_id: 'lgn_link01' });
      expect(minted.url).toBe(`https://bank.example.test/xray/s/${minted.code}`);
      expect(minted.expires_at).toBe(
        new Date(clock.getTime() + PAIRING_CODE_TTL_HOURS * 3_600_000).toISOString(),
      );
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('never lets the plaintext code into the event log', async () => {
    const harness = createHarness();
    try {
      const minted = await harness.xray.pairing.createCode({ login_id: 'lgn_hash01' });
      const created = pairingEvents(harness).find((event) => event.type === 'xray.pairing.created');
      if (created?.type !== 'xray.pairing.created') throw new Error('no pairing.created');
      expect(created.data.code).toBe(shortHash(minted.code));
      expect(JSON.stringify(harness.xray.ring.last(200))).not.toContain(minted.code);
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });
});

describe('exchange', () => {
  it('returns the login the code was bound to, and works a second time inside the TTL', async () => {
    const harness = createHarness();
    try {
      const minted = await harness.xray.pairing.createCode({ login_id: 'lgn_multi1' });
      const first = await harness.xray.pairing.exchange(minted.code, {
        remote_ip_prefix: '203.0.113.0/24',
      });
      expect(first).toMatchObject({ ok: true, login_id: 'lgn_multi1', viewer_kind: 'pairing' });
      // A reload, or a second device: the same code still works (ADR-10).
      const second = await harness.xray.pairing.exchange(minted.code, {
        remote_ip_prefix: '198.51.100.0/24',
      });
      expect(second).toMatchObject({ ok: true, login_id: 'lgn_multi1' });
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('refuses a code past its TTL', async () => {
    let clock = new Date('2026-09-08T12:00:00.000Z');
    const harness = createHarness({ now: () => clock });
    try {
      const minted = await harness.xray.pairing.createCode({ login_id: 'lgn_ttl001' });
      clock = new Date(clock.getTime() + 25 * 3_600_000);
      expect(await harness.xray.pairing.exchange(minted.code)).toEqual({
        ok: false,
        reason: 'expired',
      });
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('rejects a malformed code without touching the store', async () => {
    const harness = createHarness();
    try {
      expect(await harness.xray.pairing.exchange('not-a-code')).toEqual({
        ok: false,
        reason: 'malformed',
      });
      const rejected = pairingEvents(harness).find(
        (event) => event.type === 'xray.pairing.rejected',
      );
      if (rejected?.type !== 'xray.pairing.rejected') throw new Error('no pairing.rejected');
      expect(rejected.data.reason).toBe('malformed');
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('rate-limits the sixth wrong code in a minute from one address', async () => {
    let clock = new Date('2026-09-08T12:00:00.000Z');
    const harness = createHarness({ now: () => clock });
    try {
      const wrong = 'BANK-ZZZZ-ZZZZ-ZZ';
      const reasons: string[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await harness.xray.pairing.exchange(wrong, {
          remote_ip_prefix: '203.0.113.0/24',
        });
        reasons.push(result.ok ? 'ok' : result.reason);
      }
      expect(reasons).toEqual([
        'unknown_code',
        'unknown_code',
        'unknown_code',
        'unknown_code',
        'unknown_code',
        'rate_limited',
      ]);

      // A locked-out address cannot even use a valid code: the limit is checked first, so an
      // enumerator learns nothing from the answer.
      const minted = await harness.xray.pairing.createCode({ login_id: 'lgn_rate01' });
      expect(
        await harness.xray.pairing.exchange(minted.code, { remote_ip_prefix: '203.0.113.0/24' }),
      ).toEqual({ ok: false, reason: 'rate_limited' });

      // Another address is unaffected.
      expect(
        await harness.xray.pairing.exchange(minted.code, { remote_ip_prefix: '198.51.100.0/24' }),
      ).toMatchObject({ ok: true, login_id: 'lgn_rate01' });

      // And the window is one minute, not forever.
      clock = new Date(clock.getTime() + 61_000);
      expect(
        await harness.xray.pairing.exchange(minted.code, { remote_ip_prefix: '203.0.113.0/24' }),
      ).toMatchObject({ ok: true, login_id: 'lgn_rate01' });
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });
});

describe('the admin token (Decision D-5)', () => {
  it('accepts the configured token and refuses everything else', async () => {
    const harness = createHarness({ adminToken: 'observer-token-for-tests' });
    try {
      expect(await harness.xray.pairing.exchangeAdminToken('observer-token-for-tests')).toMatchObject(
        { ok: true, viewer_kind: 'admin' },
      );
      expect(await harness.xray.pairing.exchangeAdminToken('wrong')).toEqual({
        ok: false,
        reason: 'unknown_code',
      });
      expect(await harness.xray.pairing.exchangeAdminToken('')).toEqual({
        ok: false,
        reason: 'unknown_code',
      });
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });

  it('refuses every token when XRAY_ADMIN_TOKEN is not configured', async () => {
    const harness = createHarness({ adminToken: undefined });
    try {
      expect(await harness.xray.pairing.exchangeAdminToken('anything')).toEqual({
        ok: false,
        reason: 'unknown_code',
      });
    } finally {
      harness.xray.shutdown('shutdown');
    }
  });
});
