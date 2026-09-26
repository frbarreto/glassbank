/**
 * Pairing codes (block: xray).
 *
 * The contract's `Pairing`, implemented for real: `BANK-XXXX-XXXX-XX`, ten characters from a
 * 32-character alphabet without `0`, `O`, `1` or `I` - 50 bits (ADR-10, A-24). The code is bound
 * to the **login**, never to a grant, so a step-up, a reconnect or a re-added connector all stay
 * visible to the same viewer, and it is **multi-use inside its 24 hours**, so a reload or a
 * second device works from the link that was shown in chat.
 *
 * Only the hash of a code is kept, here and in the event log: `xray.pairing.created.code` is
 * documented as hashed, and a stolen process dump must not hand out working links.
 *
 * `src/tools` receives this object through `ToolContext.pairing`, which is what backs
 * `xray_get_session_link`.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';

import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_HOURS,
  formatPairingCode,
  isPairingCode,
  pairingUrl,
  type Pairing,
  type PairingCode,
  type PairingExchangeResult,
  type XrayEmitter,
} from '../contracts/index.js';

import { BoundedLru } from './bounded.js';
import { createFailureLimiter, type FailureLimiter } from './rate-limit.js';
import { shortHash } from './redaction.js';

/** Live codes kept in memory (ADR-16); a restart loses them, the viewer cookie survives it. */
export const MAX_PAIRING_CODES = 10_000;

const ONE_MINUTE_MS = 60_000;

export interface PairingOptions {
  readonly emitter: XrayEmitter;
  readonly publicBaseUrl: string;
  readonly adminToken?: string | undefined;
  readonly now?: () => Date;
  /** Failed exchanges per IP prefix per minute (invariant 14). */
  readonly maxFailuresPerMinute?: number;
  /** Test seam: returns `PAIRING_CODE_LENGTH` characters of the alphabet. */
  readonly mintCharacters?: () => string;
  readonly capacity?: number;
}

export interface XrayPairing extends Pairing {
  /** Exposed for the routes, which rate-limit the admin exchange on the same window. */
  readonly limiter: FailureLimiter;
  /** Test and diagnostics hook: how many codes are live. */
  readonly size: number;
}

interface CodeRecord {
  readonly login_id: string;
  readonly expires_at: string;
  readonly created_at: string;
}

/**
 * `randomInt` with an alphabet length of 32 divides 2^32 evenly, so there is no modulo bias -
 * and `randomInt` rejects out-of-range draws anyway.
 */
function mintDefault(): string {
  let characters = '';
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    characters += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return characters;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function createPairing(options: PairingOptions): XrayPairing {
  const now = options.now ?? (() => new Date());
  const mint = options.mintCharacters ?? mintDefault;
  const codes = new BoundedLru<string, CodeRecord>(options.capacity ?? MAX_PAIRING_CODES);
  const limiter = createFailureLimiter({
    limit: options.maxFailuresPerMinute ?? 5,
    windowMs: ONE_MINUTE_MS,
    now,
  });

  function keyOf(context?: { readonly remote_ip_prefix?: string | null }): string {
    return context?.remote_ip_prefix ?? 'unknown';
  }

  function reject(
    key: string,
    reason: 'unknown_code' | 'expired' | 'rate_limited' | 'malformed',
    code: string | null,
    countFailure: boolean,
  ): PairingExchangeResult {
    if (countFailure) limiter.recordFailure(key);
    options.emitter.emit('xray.pairing.rejected', {
      code: code === null ? null : shortHash(code),
      reason,
    });
    return { ok: false, reason };
  }

  return {
    limiter,

    get size() {
      return codes.size;
    },

    async createCode(input): Promise<PairingCode> {
      const ttlHours = input.ttl_hours ?? PAIRING_CODE_TTL_HOURS;
      const code = formatPairingCode(mint());
      const expiresAt = new Date(now().getTime() + ttlHours * 3_600_000).toISOString();
      codes.set(shortHash(code), {
        login_id: input.login_id,
        expires_at: expiresAt,
        created_at: now().toISOString(),
      });
      options.emitter.emit(
        'xray.pairing.created',
        { code: shortHash(code), login_id: input.login_id, expires_at: expiresAt },
        { login_id: input.login_id },
      );
      return { code, url: pairingUrl(options.publicBaseUrl, code), expires_at: expiresAt };
    },

    async exchange(code, context): Promise<PairingExchangeResult> {
      const key = keyOf(context);
      // The limit is checked before the lookup, so a locked-out enumerator learns nothing about
      // whether the code existed.
      if (limiter.isLimited(key)) return reject(key, 'rate_limited', null, false);
      if (typeof code !== 'string' || !isPairingCode(code.trim().toUpperCase())) {
        return reject(key, 'malformed', null, true);
      }
      const normalised = code.trim().toUpperCase();
      const hash = shortHash(normalised);
      const record = codes.get(hash);
      if (!record) return reject(key, 'unknown_code', normalised, true);
      if (new Date(record.expires_at).getTime() <= now().getTime()) {
        codes.delete(hash);
        return reject(key, 'expired', normalised, true);
      }
      // Multi-use inside the TTL (ADR-10): the record stays.
      return {
        ok: true,
        login_id: record.login_id,
        viewer_kind: 'pairing',
        expires_at: record.expires_at,
      };
    },

    async exchangeAdminToken(token): Promise<PairingExchangeResult> {
      const configured = options.adminToken;
      if (!configured || typeof token !== 'string' || token === '') {
        options.emitter.emit('xray.pairing.rejected', { code: null, reason: 'unknown_code' });
        return { ok: false, reason: 'unknown_code' };
      }
      if (!constantTimeEquals(token, configured)) {
        options.emitter.emit('xray.pairing.rejected', { code: null, reason: 'unknown_code' });
        return { ok: false, reason: 'unknown_code' };
      }
      return {
        ok: true,
        // Observer mode is not bound to a login; the contract's success shape still wants the
        // field, and `''` is what `src/testing/fakes.ts` returns.
        login_id: '',
        viewer_kind: 'admin',
        expires_at: new Date(now().getTime() + PAIRING_CODE_TTL_HOURS * 3_600_000).toISOString(),
      };
    },
  };
}
