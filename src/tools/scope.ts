/**
 * The `BankScope` a call reads and writes under (ADR-15): whose data, and on whose overlay.
 */
import { ID_PREFIXES, isId, type AuthContext, type BankScope } from '../contracts/index.js';

import { ANONYMOUS_LOGIN_ID } from './types.js';

/**
 * The overlay key for a grant that carries no `login_id`.
 *
 * Never the shared `lgn_anonymous`: copy-on-write overlays are per login (CLAUDE.md invariant 16),
 * and one shared key would put every such grant on ONE overlay for a given persona - so a card
 * one connection locked would appear locked to a stranger's connection, which is precisely what
 * the invariant exists to prevent. The authorization server always sets `login_id` today, but the
 * access-token claim is `nullable().default(null)` (src/contracts/auth.ts), so this must fail
 * closed rather than rely on that. Deriving the key from the grant gives each connection its own
 * overlay, exactly as `loginKeyOf` already does for open previews.
 */
export function overlayLoginKeyOf(auth: Pick<AuthContext, 'login_id' | 'grant_id'>): string {
  if (auth.login_id !== null && auth.login_id !== undefined) return auth.login_id;
  const suffix = auth.grant_id.startsWith(ID_PREFIXES.grant)
    ? auth.grant_id.slice(ID_PREFIXES.grant.length)
    : auth.grant_id;
  const derived = `${ID_PREFIXES.login}g${suffix}`.slice(0, 68);
  // `BankScope.login_id` must stay a well-formed `lgn_` id so the X-ray envelope still validates.
  return isId(derived, 'login') ? derived : ANONYMOUS_LOGIN_ID;
}

export function bankScopeOf(auth: AuthContext): BankScope {
  return {
    persona_id: auth.persona.id,
    login_id: overlayLoginKeyOf(auth),
    grant_id: auth.grant_id,
  };
}

/** The key the open-preview memory is bucketed by: the login when there is one (ADR-14). */
export function loginKeyOf(auth: AuthContext): string {
  return auth.login_id ?? auth.grant_id;
}
