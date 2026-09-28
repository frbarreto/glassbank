/**
 * Test harness for the `xray` block.
 *
 * The block dependency rules (docs/REPO_LAYOUT.md section 3, enforced by
 * test/import-boundaries.test.ts) forbid `src/xray` - its tests included - from importing
 * `src/testing` or `src/auth`, so everything a test needs is built here from `src/contracts`
 * alone: a real HS256 `JwtService` over `jose` (which `src/xray` is allowed to import, because it
 * signs the viewer cookie with the same key), an Express app with the router mounted where
 * `src/app.ts` mounts it, and a tiny HTTP client that keeps cookies.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import type { Express } from 'express';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import {
  JWT_CLAIMS_SCHEMAS,
  type ClaimsFor,
  type JwtService,
  type JwtType,
  type SignableClaims,
} from '../../contracts/index.js';

import { createXray, type Xray, type XrayDeps } from '../index.js';
import type { XrayConfig } from '../types.js';

export const TEST_SIGNING_KEY = 'test-only-signing-key-at-least-32-characters-long';

/** The same contract `src/auth` implements, over `jose`, for the tests of this block. */
export function createTestJwtService(signingKey = TEST_SIGNING_KEY, now = () => new Date()): JwtService {
  const key = new TextEncoder().encode(signingKey);
  return {
    async sign<T extends JwtType>(typ: T, claims: SignableClaims<T>, ttlSeconds: number) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const expiresAt = issuedAt + ttlSeconds;
      const jti = randomUUID();
      const token = await new SignJWT({
        ...(claims as unknown as JWTPayload),
        typ,
        jti,
        iat: issuedAt,
        exp: expiresAt,
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .sign(key);
      return { token, jti, expiresAt: new Date(expiresAt * 1000).toISOString() };
    },
    async verify<T extends JwtType>(token: string, expected: T): Promise<ClaimsFor<T>> {
      const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] });
      if (payload.typ !== expected) throw new Error(`expected typ "${expected}"`);
      const parsed = JWT_CLAIMS_SCHEMAS[expected].safeParse(payload);
      if (!parsed.success) throw new Error('claims did not match the schema for this typ');
      return parsed.data as ClaimsFor<T>;
    },
  };
}

export interface HarnessOptions {
  /** `:memory:` unless a test needs a file that survives a simulated restart. */
  readonly dbPath?: string;
  readonly adminToken?: string | undefined;
  readonly now?: () => Date;
  readonly signingKey?: string;
  readonly bootId?: string;
  readonly heartbeatMs?: number;
  readonly emitServerStarted?: boolean;
  readonly lookupPersona?: XrayDeps['lookupPersona'];
  readonly lookupBankSummary?: XrayDeps['lookupBankSummary'];
  readonly lookupBankActivity?: XrayDeps['lookupBankActivity'];
  readonly pairFailuresPerMinute?: number;
  readonly maxStreamsPerLogin?: number;
  readonly maxStreams?: number;
  readonly maxPublicStreams?: number;
  readonly maxLogRows?: number;
}

export interface Harness {
  readonly xray: Xray;
  readonly app: Express;
  readonly config: XrayConfig;
  readonly errors: { error: unknown; where: string }[];
  /** Starts a real HTTP server and returns its base URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
}

export const TEST_BASE_URL = 'https://bank.example.test';

export function createHarness(options: HarnessOptions = {}): Harness {
  const config: XrayConfig = {
    publicBaseUrl: TEST_BASE_URL,
    xrayDbPath: options.dbPath ?? ':memory:',
    xrayRetentionHours: 72,
    xrayMaxLogRows: options.maxLogRows ?? 200_000,
    xrayAdminToken: options.adminToken,
    rateLimits: { ipPairFailuresPerMin: options.pairFailuresPerMinute ?? 5 },
    xrayMaxStreamsPerLogin: options.maxStreamsPerLogin ?? 4,
    xrayMaxStreams: options.maxStreams ?? 64,
    xrayMaxPublicStreams: options.maxPublicStreams ?? 16,
  };
  const errors: { error: unknown; where: string }[] = [];
  const xray = createXray({
    config,
    jwt: createTestJwtService(options.signingKey ?? TEST_SIGNING_KEY, options.now),
    bootId: options.bootId ?? 'boot_test01',
    version: '0.1.0-test',
    now: options.now,
    lookupPersona: options.lookupPersona,
    lookupBankSummary: options.lookupBankSummary,
    lookupBankActivity: options.lookupBankActivity,
    onError: (error, where) => errors.push({ error, where }),
    emitServerStarted: options.emitServerStarted ?? false,
    heartbeatMs: options.heartbeatMs ?? 0,
    retentionIntervalMs: 0,
  });

  const app = express();
  // `trust proxy` and the mount point mirror src/app.ts exactly.
  app.set('trust proxy', 1);
  app.use('/xray', xray.router);

  let server: Server | null = null;

  return {
    xray,
    app,
    config,
    errors,
    async listen() {
      return await new Promise<string>((resolve, reject) => {
        server = app.listen(0, '127.0.0.1');
        server.once('listening', () => {
          const address = server?.address();
          if (address === null || typeof address !== 'object') {
            reject(new Error('the test server did not report a port'));
            return;
          }
          resolve(`http://127.0.0.1:${address.port}`);
        });
        server.once('error', reject);
      });
    },
    async close() {
      xray.shutdown('shutdown');
      if (server) {
        const active = server;
        server = null;
        await new Promise<void>((resolve) => {
          active.closeAllConnections?.();
          active.close(() => resolve());
        });
      }
    },
  };
}

/** A temporary directory for a test that needs a real SQLite file. */
export function createTempDb(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'glass-bank-xray-'));
  return {
    path: join(directory, 'xray.sqlite'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/** Extracts one cookie value from a `set-cookie` header list. */
export function cookieFrom(headers: Headers, name: string): string | null {
  const values = headers.getSetCookie();
  for (const value of values) {
    const [pair] = value.split(';');
    if (!pair) continue;
    const index = pair.indexOf('=');
    if (index === -1) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return null;
}

/** Reads a `text/event-stream` body frame by frame, with a deadline. */
export async function readFrames(
  response: Response,
  options: { readonly until: (frames: string[]) => boolean; readonly timeoutMs?: number },
): Promise<string[]> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('the response had no body');
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = '';
  const deadline = Date.now() + (options.timeoutMs ?? 4000);
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        frames.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
      if (options.until(frames)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

/** The parsed `id:` and `data:` of every `event: xray` frame in the list. */
export function parseFrames(frames: readonly string[]): { id: number | null; data: unknown }[] {
  const parsed: { id: number | null; data: unknown }[] = [];
  for (const frame of frames) {
    const lines = frame.split('\n');
    if (!lines.some((line) => line.startsWith('event: xray'))) continue;
    const idLine = lines.find((line) => line.startsWith('id: '));
    const dataLine = lines.find((line) => line.startsWith('data: '));
    if (!dataLine) continue;
    parsed.push({
      id: idLine ? Number.parseInt(idLine.slice(4), 10) : null,
      data: JSON.parse(dataLine.slice(6)) as unknown,
    });
  }
  return parsed;
}
