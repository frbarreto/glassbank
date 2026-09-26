/**
 * Minted ids must satisfy the contract's id pattern (`idSchema` in src/contracts/events.ts).
 *
 * Regression test. The first implementation encoded ids as base64url, which begins with `-` or `_`
 * about 3% of the time, while `idSchema` requires the first character after the prefix to be
 * alphanumeric. Roughly one grant in thirty therefore produced a code JWT whose claims failed
 * validation at `/token` and came back as `invalid_grant`; the OAuth suite passed most runs and
 * failed occasionally, which is the worst possible way for a defect to present itself.
 */
import { describe, expect, it } from 'vitest';

import { ID_PREFIXES, isId } from '../../contracts/index.js';
import { createAuth } from '../index.js';
import type { AuthConfig } from '../types.js';

const config: AuthConfig = {
  nodeEnv: 'test',
  publicBaseUrl: 'http://127.0.0.1:8080',
  publicHosts: ['127.0.0.1:8080'],
  oauthSigningKey: 'test-only-signing-key-0123456789abcdefghijklmnop',
  featureFlags: ['writes', 'transfers'],
  maxDcrClients: 10,
  authDbPath: ':memory:',
  cimdEnabled: false,
  rateLimits: {
    ipRegisterPerHour: 60,
    ipAuthorizePer15Min: 300,
    ipTokenPer15Min: 300,
    ipConsentPer15Min: 60,
    clientTokenPer15Min: 120,
    loginGrantsPerDay: 20,
  },
};

describe('the id generator the auth block actually uses', () => {
  it('mints grant and login ids the contract accepts, over 3000 samples', () => {
    const auth = createAuth({ config, log: () => undefined });
    for (let sample = 0; sample < 3000; sample += 1) {
      const grantId = auth.newId(ID_PREFIXES.grant);
      const loginId = auth.newId(ID_PREFIXES.login);
      expect(isId(grantId, 'grant'), grantId).toBe(true);
      expect(isId(loginId, 'login'), loginId).toBe(true);
    }
  });

  it('rejects the base64url shapes that caused the original defect', () => {
    expect(isId(`${ID_PREFIXES.grant}-BlZlN3VZUwVD`, 'grant')).toBe(false);
    expect(isId(`${ID_PREFIXES.grant}_BlZlN3VZUwVD`, 'grant')).toBe(false);
  });
});
