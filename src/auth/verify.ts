/**
 * The resource-server verifier (block: auth).
 *
 * The one function `src/mcp` needs from this block, injected by `src/app.ts` as the contract's
 * `VerifyAccessToken`. It is stateless apart from the revoked-grant set (ADR-4):
 *
 *   - the token's `typ` must be `access`; a code or a refresh token presented as a bearer is
 *     `invalid_token` and never a "wrong endpoint" hint;
 *   - `aud` must be one of the canonical MCP URLs derived from `PUBLIC_HOSTS` (A-36), so the
 *     same token keeps working when the user types the other `run.app` form;
 *   - the grant must not have been revoked.
 *
 * The raw token never appears in a return value, a log line or an error message (invariant 7).
 */
import {
  isAcceptableAudience,
  stripAccessTokenPrefix,
  type AccessTokenVerification,
  type AuthRejectionReason,
  type JwtService,
  type PublicHostConfig,
} from '../contracts/index.js';

import { isJwtError } from './jwt.js';

export interface VerifierOptions {
  readonly jwt: JwtService;
  readonly hosts: PublicHostConfig;
  readonly isGrantRevoked: (grantId: string) => boolean;
}

function rejection(reason: AuthRejectionReason, error: string): AccessTokenVerification {
  return { ok: false, reason, error, status: 401 };
}

export function createAccessTokenVerifier(options: VerifierOptions) {
  return async function verifyAccessToken(
    token: string,
    context: { readonly audience?: string; readonly now?: Date } = {},
  ): Promise<AccessTokenVerification> {
    const trimmed = token.trim();
    if (trimmed.length === 0) return rejection('no_access_token', 'invalid_token');

    let claims;
    try {
      claims = await options.jwt.verify(stripAccessTokenPrefix(trimmed), 'access');
    } catch (error) {
      if (isJwtError(error)) return rejection(error.reason, 'invalid_token');
      return rejection('malformed', 'invalid_token');
    }

    if (context.now !== undefined && claims.exp * 1000 <= context.now.getTime()) {
      return rejection('expired', 'invalid_token');
    }

    if (!isAcceptableAudience(claims.aud, options.hosts)) {
      return rejection('bad_audience', 'invalid_token');
    }
    if (context.audience !== undefined && claims.aud !== context.audience) {
      // A token minted for one listed hostname is still accepted on another listed hostname;
      // the caller only passes `audience` when it wants the stricter, single-host check.
      return rejection('bad_audience', 'invalid_token');
    }

    if (options.isGrantRevoked(claims.grant_id)) {
      return rejection('revoked_grant', 'invalid_token');
    }

    return { ok: true, claims };
  };
}
