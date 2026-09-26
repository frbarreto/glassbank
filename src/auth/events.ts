/**
 * The `auth.*` X-ray producer (block: auth).
 *
 * CLAUDE.md invariant 13: a feature that does not emit its documented events is not finished.
 * This module is the one place `src/auth` talks to the injected `XrayEmitter`, so the rules that
 * make the family safe are stated once:
 *
 *   - **never a secret.** No bearer token, refresh token, authorization code, PKCE verifier,
 *     `txn` or viewer JWT, and no raw `client_id` - only its 12-character fingerprint
 *     (invariant 7). The payload builders below take a `GrantRecord` and a fingerprint, never a
 *     token, so there is nothing to forget at a call site.
 *   - **never throws.** The contract says an emitter must not throw, but an OAuth endpoint that
 *     500s because the X-ray is unhappy would break invariant 5, which outranks invariant 13.
 *     `safeEmitter` swallows anything that comes back out.
 *
 * Which half of the family lives here: `src/auth` emits what the authorization server itself
 * decides (registration, reconstruction, login, grant, token, revocation, and the AS-side
 * rejections). `auth.challenge`, `auth.verified`, `auth.stepup.requested` and the *bearer-token*
 * `auth.rejected` are emitted by the `mcp` gate, which is where they happen and which holds the
 * `xs`, request and client correlation the envelope wants. The two never emit the same event.
 */
import {
  refreshLifetimeSeconds,
  type AuthRejectionReason,
  type XrayCorrelation,
  type XrayEmitter,
  type XrayEventDataInput,
  type XrayEventType,
} from '../contracts/index.js';

import type { GrantRecord } from './types.js';

/** An emitter that drops everything: the default when the composition root injects none. */
export const NULL_EMITTER: XrayEmitter = { emit: () => {} };

/**
 * Wraps an emitter so a throw inside the X-ray can never reach an OAuth response.
 * `onError` exists so a broken emitter is still visible in the process log.
 */
export function safeEmitter(
  emitter: XrayEmitter | undefined,
  onError?: (error: unknown, type: string) => void,
): XrayEmitter {
  if (emitter === undefined) return NULL_EMITTER;
  return {
    emit<T extends XrayEventType>(
      type: T,
      data: XrayEventDataInput<T>,
      correlation?: XrayCorrelation,
    ): void {
      try {
        emitter.emit(type, data, correlation);
      } catch (error) {
        onError?.(error, type);
      }
    },
  };
}

/** The correlation fields every grant-shaped `auth.*` event carries. */
export function grantCorrelation(grant: GrantRecord): XrayCorrelation {
  return {
    login_id: grant.login_id,
    grant_id: grant.grant_id,
    persona_id: grant.persona_id,
  };
}

/** `auth.grant.created` (ADR-14: `parent_grant_id` when the browser already held a login). */
export function grantCreatedData(input: {
  readonly grant: GrantRecord;
  readonly clientFingerprint: string;
  readonly clientName: string | null;
  readonly sharedPersona: boolean;
  readonly nowMs: number;
}): XrayEventDataInput<'auth.grant.created'> {
  return {
    grant_id: input.grant.grant_id,
    parent_grant_id: input.grant.parent_grant_id,
    login_id: input.grant.login_id,
    persona_id: input.grant.persona_id,
    scopes: [...input.grant.scopes],
    auth_level: input.grant.auth_level,
    client_id: input.clientFingerprint,
    client_name: input.clientName,
    // The grant lives as long as its longest token can be refreshed (A-26).
    expires_at: new Date(
      input.nowMs + refreshLifetimeSeconds(input.grant.auth_level) * 1000,
    ).toISOString(),
    shared_persona: input.sharedPersona,
  };
}

/** `auth.grant.updated`: the SAME grant id, widened or narrowed by a re-consent (ADR-14). */
export function grantUpdatedData(input: {
  readonly grant: GrantRecord;
  readonly addedScopes: readonly string[];
  readonly clientFingerprint: string;
  readonly reason: 'step_up' | 're_consent';
}): XrayEventDataInput<'auth.grant.updated'> {
  return {
    grant_id: input.grant.grant_id,
    login_id: input.grant.login_id,
    persona_id: input.grant.persona_id,
    scopes: [...input.grant.scopes],
    added_scopes: [...input.addedScopes],
    auth_level: input.grant.auth_level,
    client_id: input.clientFingerprint,
    reason: input.reason,
  };
}

/** `auth.token.issued`: the code exchange. The token string itself never appears (invariant 7). */
export function tokenIssuedData(input: {
  readonly grant: GrantRecord;
  readonly clientFingerprint: string;
  readonly audience: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string | null;
}): XrayEventDataInput<'auth.token.issued'> {
  return {
    grant_id: input.grant.grant_id,
    login_id: input.grant.login_id,
    persona_id: input.grant.persona_id,
    scopes: [...input.grant.scopes],
    auth_level: input.grant.auth_level,
    client_id: input.clientFingerprint,
    aud: input.audience,
    expires_at: input.accessExpiresAt,
    refresh_expires_at: input.refreshExpiresAt,
  };
}

/** `auth.token.refreshed`: `rotated_jti` is the `jti` that just joined the rotated set (ADR-4). */
export function tokenRefreshedData(input: {
  readonly grant: GrantRecord;
  readonly clientFingerprint: string;
  readonly accessExpiresAt: string;
  readonly refreshExpiresAt: string | null;
  readonly rotatedJti: string | null;
}): XrayEventDataInput<'auth.token.refreshed'> {
  return {
    grant_id: input.grant.grant_id,
    login_id: input.grant.login_id,
    persona_id: input.grant.persona_id,
    scopes: [...input.grant.scopes],
    auth_level: input.grant.auth_level,
    client_id: input.clientFingerprint,
    expires_at: input.accessExpiresAt,
    refresh_expires_at: input.refreshExpiresAt,
    rotated_jti: input.rotatedJti,
  };
}

/**
 * `auth.rejected` as the authorization server means it: a browser POST that failed its `txn` or
 * CSRF check, a `/token` exchange that failed PKCE or replay, a callback URL off the allowlist.
 * The `reason` enum is the contract's; the mapping from this block's own vocabulary is here so
 * the same words are used at every call site.
 */
export function rejectedData(input: {
  readonly status: number;
  readonly error: string;
  readonly reason: AuthRejectionReason;
  readonly clientFingerprint?: string | null;
}): XrayEventDataInput<'auth.rejected'> {
  return {
    status: input.status,
    error: input.error,
    reason: input.reason,
    client_id: input.clientFingerprint ?? null,
  };
}
