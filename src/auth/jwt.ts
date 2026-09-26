/**
 * The JWT service (block: auth).
 *
 * One HS256 key from `OAUTH_SIGNING_KEY` signs every token this service mints: authorization
 * codes, access tokens, refresh tokens, the browser `txn` state, the 30-day `login_id` cookie
 * and (through `src/app.ts` injecting this same instance into `src/xray`) the viewer cookie.
 *
 * ADR-4: every token carries `jti` and `typ`, and `verify` refuses a token whose `typ` is not
 * the one the caller expected - which is what makes "a code presented as a bearer token is
 * `invalid_token`" true rather than aspirational.
 */
import { randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import {
  JWT_CLAIMS_SCHEMAS,
  type ClaimsFor,
  type JwtService,
  type JwtType,
  type SignableClaims,
} from '../contracts/index.js';

/** Why a token was refused. Mapped onto `AuthRejectionReason` by the verifier. */
export type JwtFailureReason = 'malformed' | 'invalid_signature' | 'expired' | 'wrong_typ';

export class JwtError extends Error {
  constructor(
    readonly reason: JwtFailureReason,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

export function isJwtError(error: unknown): error is JwtError {
  return error instanceof JwtError;
}

const ALGORITHM = 'HS256';

export interface JwtServiceOptions {
  readonly signingKey: string;
  readonly now?: () => Date;
  readonly newJti?: () => string;
}

/**
 * `jose` over a symmetric key. The key never leaves this module and is never rendered into a
 * log line, an event or an error message.
 */
export function createJwtService(options: JwtServiceOptions): JwtService {
  const key = new TextEncoder().encode(options.signingKey);
  const now = options.now ?? (() => new Date());
  const newJti = options.newJti ?? (() => randomUUID());

  return {
    async sign<T extends JwtType>(typ: T, claims: SignableClaims<T>, ttlSeconds: number) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const expiresAt = issuedAt + ttlSeconds;
      const jti = newJti();
      const payload: JWTPayload = {
        ...(claims as unknown as JWTPayload),
        typ,
        jti,
        iat: issuedAt,
        exp: expiresAt,
      };
      const token = await new SignJWT(payload)
        .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
        .sign(key);
      return { token, jti, expiresAt: new Date(expiresAt * 1000).toISOString() };
    },

    async verify<T extends JwtType>(token: string, expected: T): Promise<ClaimsFor<T>> {
      let payload: JWTPayload;
      try {
        // Audience and issuer are checked by the caller against PUBLIC_HOSTS (A-36), not here:
        // one token is valid for several hostnames of the same service.
        ({ payload } = await jwtVerify(token, key, { algorithms: [ALGORITHM] }));
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === 'ERR_JWT_EXPIRED') throw new JwtError('expired', 'token expired');
        if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
          throw new JwtError('invalid_signature', 'bad signature');
        }
        throw new JwtError('malformed', 'token could not be parsed');
      }
      if (payload.typ !== expected) {
        // ADR-4: a code or a refresh token presented as a bearer is not merely the wrong token,
        // it is an invalid one.
        throw new JwtError('wrong_typ', `expected typ "${expected}"`);
      }
      const parsed = JWT_CLAIMS_SCHEMAS[expected].safeParse(payload);
      if (!parsed.success) {
        throw new JwtError('malformed', 'claims did not match the schema for this typ');
      }
      return parsed.data as ClaimsFor<T>;
    },
  };
}
