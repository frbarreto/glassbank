/**
 * `RATE_LIMIT_LOGIN_GRANTS`: new grants per `login_id` per day (CLAUDE.md invariant 14,
 * docs/DEPLOYMENT.md section 3).
 *
 * The cap is on *new authorizations*, which is the expensive, abusable thing: every one mints a
 * grant record, a code and a token family. It is deliberately not charged for the ADR-14 step-up
 * that extends a grant the browser already holds - capping that would leave a user unable to
 * approve a write scope on a connection they already own.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { COOKIE_NAMES } from '../../contracts/index.js';

import { registerTestClient, startAuthHarness, walkToCode, type Harness } from './harness.js';

const open: Harness[] = [];

async function start(loginGrantsPerDay: number): Promise<Harness> {
  const harness = await startAuthHarness({
    rateLimits: {
      ipRegisterPerHour: 600,
      ipAuthorizePer15Min: 600,
      ipTokenPer15Min: 600,
      ipConsentPer15Min: 600,
      clientTokenPer15Min: 600,
      loginGrantsPerDay,
    },
  });
  open.push(harness);
  return harness;
}

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop();
    if (harness !== undefined) await harness.close();
  }
});

describe('the per-login daily grant cap', () => {
  it('refuses the grant past the cap and reports it as auth.rejected', async () => {
    const harness = await start(2);

    // Three different clients, so each consent is a *new* grant for the same login cookie.
    const first = await walkToCode(harness, { clientId: await registerTestClient(harness) });
    const second = await walkToCode(harness, { clientId: await registerTestClient(harness) });
    expect(first.consent.status).toBe(302);
    expect(second.consent.status).toBe(302);
    expect(harness.cookies()[COOKIE_NAMES.login]).toBeDefined();

    harness.emitter.clear();
    const third = await walkToCode(harness, { clientId: await registerTestClient(harness) });

    expect(third.consent.status).toBe(429);
    expect(third.consent.headers.get('retry-after')).toEqual(expect.any(String));
    expect(third.consentBody).toContain('Too many connections today');
    expect(third.code).toBeNull();
    expect(harness.emitter.ofType('auth.grant.created')).toHaveLength(0);

    const [rejected] = harness.emitter.ofType('auth.rejected');
    expect(rejected?.data.status).toBe(429);
    expect(rejected?.data.error).toBe('too_many_requests');
    // `rate_limited` since contracts v0.2: before that member existed the cap had to travel as
    // `invalid_grant`, which reads as a replayed code rather than as an abuse control.
    expect(rejected?.data.reason).toBe('rate_limited');
    expect(rejected?.login_id).toEqual(expect.stringMatching(/^lgn_/));
  });

  it('counts only new grants: a step-up on the same client is never capped (ADR-14)', async () => {
    const harness = await start(1);
    const clientId = await registerTestClient(harness);

    const first = await walkToCode(harness, {
      clientId,
      scopes: 'profile accounts:read cards:write',
      approve: ['profile', 'accounts:read'],
    });
    expect(first.consent.status).toBe(302);

    // The budget is spent; the step-up still has to go through.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stepUp = await walkToCode(harness, {
        clientId,
        scopes: 'profile accounts:read cards:write',
        approve: ['profile', 'accounts:read', 'cards:write'],
      });
      expect(stepUp.consent.status).toBe(302);
      expect(stepUp.code).toBeTruthy();
    }

    expect(harness.emitter.ofType('auth.grant.created')).toHaveLength(1);
    expect(harness.emitter.ofType('auth.grant.updated')).toHaveLength(3);
  });

  it('is per login, so another browser is unaffected', async () => {
    const harness = await start(1);
    await walkToCode(harness, { clientId: await registerTestClient(harness) });
    const capped = await walkToCode(harness, { clientId: await registerTestClient(harness) });
    expect(capped.consent.status).toBe(429);

    // A second browser: no cookies, so /login mints a different login_id.
    harness.clearCookies();
    const other = await walkToCode(harness, { clientId: await registerTestClient(harness) });
    expect(other.consent.status).toBe(302);
    expect(other.code).toBeTruthy();
  });

  it('lets the configured budget through untouched', async () => {
    const harness = await start(5);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const walk = await walkToCode(harness, { clientId: await registerTestClient(harness) });
      expect(walk.consent.status).toBe(302);
    }
    expect(harness.emitter.ofType('auth.grant.created')).toHaveLength(5);
  });
});
