/**
 * In-process HTTP harness for the `auth` tests.
 *
 * A real socket, a real Express app and a real `fetch`, because the shapes under test are HTTP
 * shapes: header casing, redirect behaviour, form encoding and cookies. A mocked request object
 * would let all four drift.
 *
 * Not a `*.test.ts` file, so vitest does not collect it (see vitest.config.ts `include`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  parseXrayEvent,
  type Pairing,
  type XrayCorrelation,
  type XrayEmitter,
  type XrayEvent,
  type XrayEventType,
} from '../../contracts/index.js';
import { createAuth, type Auth } from '../index.js';
import type { AuthConfig, AuthDeps } from '../types.js';

export const TEST_SIGNING_KEY = 'test-only-signing-key-0123456789abcdefghijklmnop';

/** A second hostname, so "the PRM resource follows the request Host" is testable (A-36). */
export const SECOND_PUBLIC_HOST = 'mcp-bank.example.run.app';

export interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  json(): unknown;
}

/**
 * A stand-in for the real emitter that validates exactly the way `src/xray` does.
 *
 * `test/import-boundaries.test.ts` forbids `src/auth` - its `__tests__` included - from importing
 * `src/testing`, so `src/testing/fakes.ts` is unreachable here and the fake is local. It is not a
 * loose double: every event goes through `parseXrayEvent`, so a payload this block gets wrong
 * fails the test rather than being quietly dropped.
 */
export interface RecordingEmitter extends XrayEmitter {
  readonly events: XrayEvent[];
  readonly invalid: { type: string; error: unknown }[];
  ofType<T extends XrayEventType>(type: T): Extract<XrayEvent, { type: T }>[];
  clear(): void;
}

export function createRecordingEmitter(): RecordingEmitter {
  const events: XrayEvent[] = [];
  const invalid: { type: string; error: unknown }[] = [];
  let nextId = 1;
  return {
    events,
    invalid,
    emit(type, data, correlation?: XrayCorrelation) {
      try {
        events.push(
          parseXrayEvent({
            id: nextId,
            ts: new Date(1_760_000_000_000 + nextId).toISOString(),
            v: 1,
            type,
            data,
            ...correlation,
          }),
        );
        nextId += 1;
      } catch (error) {
        invalid.push({ type, error });
      }
    },
    ofType<T extends XrayEventType>(type: T) {
      return events.filter((event): event is Extract<XrayEvent, { type: T }> => event.type === type);
    },
    clear() {
      events.length = 0;
      invalid.length = 0;
    },
  };
}

/** A `Pairing` that mints predictable codes, so the success page is assertable. */
export function createStubPairing(): Pairing & { readonly created: string[] } {
  const created: string[] = [];
  return {
    created,
    async createCode(input) {
      // A real code's alphabet excludes 0, O, 1 and I (PAIRING_CODE_PATTERN), so the stub uses
      // characters a genuine code could actually contain.
      const code = `BANK-TEST-XRAY-${String(23 + (created.length % 7))}`;
      created.push(input.login_id);
      return {
        code,
        url: `https://example.test/xray/s/${code}`,
        expires_at: new Date(1_760_086_400_000).toISOString(),
      };
    },
    async exchange() {
      return { ok: false, reason: 'unknown_code' };
    },
    async exchangeAdminToken() {
      return { ok: false, reason: 'unknown_code' };
    },
  };
}

export interface Harness {
  readonly baseUrl: string;
  readonly host: string;
  readonly auth: Auth;
  readonly config: AuthConfig;
  readonly emitter: RecordingEmitter;
  /** `fetch` with a cookie jar, and redirects never followed (the OAuth 302 is the assertion). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /**
   * A raw `node:http` request, because `fetch` silently drops a `Host` header (it is a forbidden
   * header name in the Fetch spec) and the Host-derived URL rules of A-36 are exactly what the
   * discovery tests need to exercise.
   */
  rawGet(path: string, headers?: Record<string, string>): Promise<RawResponse>;
  cookies(): Record<string, string>;
  clearCookies(): void;
  close(): Promise<void>;
  readonly logs: { event: string; [key: string]: unknown }[];
}

export async function startAuthHarness(
  overrides: Partial<AuthConfig> = {},
  depsOverrides: Partial<Omit<AuthDeps, 'config'>> = {},
): Promise<Harness> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  const baseUrl = `http://${host}`;

  const config: AuthConfig = {
    nodeEnv: 'test',
    publicBaseUrl: baseUrl,
    publicHosts: [host, SECOND_PUBLIC_HOST],
    oauthSigningKey: TEST_SIGNING_KEY,
    featureFlags: ['writes', 'transfers'],
    maxDcrClients: 50,
    // In-process SQLite: the DCR table is exercised for real without leaving a file behind.
    // `__tests__/persistence.test.ts` uses a temporary file where a restart has to be simulated.
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
    ...overrides,
  };

  const logs: { event: string; [key: string]: unknown }[] = [];
  const emitter = createRecordingEmitter();
  const auth = createAuth({
    config,
    emitter,
    log: (record) => logs.push(record),
    ...depsOverrides,
  });

  const app = express();
  app.set('trust proxy', true);
  app.use(auth.router);
  server.on('request', app);

  const jar = new Map<string, string>();

  return {
    baseUrl,
    host,
    auth,
    config,
    emitter,
    logs,
    cookies: () => Object.fromEntries(jar),
    async rawGet(path: string, headers: Record<string, string> = {}) {
      return await new Promise<RawResponse>((resolve, reject) => {
        const call = httpRequest(
          { host: '127.0.0.1', port, path, method: 'GET', headers },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8');
              resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                body,
                json: () => JSON.parse(body) as unknown,
              });
            });
          },
        );
        call.on('error', reject);
        call.end();
      });
    },
    clearCookies: () => jar.clear(),
    async fetch(path: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      if (jar.size > 0) {
        headers.set(
          'cookie',
          [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '),
        );
      }
      const response = await fetch(new URL(path, baseUrl), {
        ...init,
        headers,
        redirect: 'manual',
      });
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        if (pair === undefined) continue;
        const index = pair.indexOf('=');
        if (index === -1) continue;
        jar.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim()));
      }
      return response;
    },
    async close() {
      auth.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Reads a hidden form field out of a rendered page. */
export function hiddenField(html: string, name: string): string {
  const pattern = new RegExp(`name="${name}"\\s+value="([^"]*)"`);
  const match = pattern.exec(html);
  if (match?.[1] === undefined) throw new Error(`no hidden field "${name}" in the page`);
  return match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

export function formBody(fields: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params.toString();
}

export const FORM_HEADERS = { 'content-type': 'application/x-www-form-urlencoded' };

/** PKCE S256 over an ASCII verifier (RFC 7636); the same computation `/token` checks against. */
export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export interface WalkOptions {
  /** The `scope` parameter of `/authorize`. */
  readonly scopes?: string;
  /** The boxes ticked on the consent page. Defaults to every requested read scope plus profile. */
  readonly approve?: readonly string[];
  readonly clientId?: string;
  readonly redirectUri?: string;
  /** The `choice` radio: a persona id, or `__new__`. */
  readonly choice?: string;
  /** Sends the hidden field our own consent form renders, so `/consent` answers the success page. */
  readonly showSuccess?: boolean;
  readonly decision?: 'approve' | 'deny';
}

export interface WalkResult {
  readonly clientId: string;
  readonly verifier: string;
  readonly state: string;
  readonly redirectUri: string;
  readonly loginHtml: string;
  readonly consentHtml: string;
  /** The response to `POST /consent`: a 302 by default, the success page with `showSuccess`. */
  readonly consent: Response;
  readonly consentBody: string;
  /** Where the browser is sent next, from the `Location` header or from the page's own link. */
  readonly callbackUrl: string | null;
  readonly code: string | null;
}

const DEFAULT_WALK_SCOPES =
  'profile accounts:read transactions:read cards:read transfers:read bills:read payees:read xray:read';

/**
 * DCR -> `/authorize` -> `/login` -> `/consent`, driven by parsing the rendered forms, exactly the
 * way `test/e2e/oauth-walk.mjs` and a real browser do it.
 */
export async function walkToCode(
  harness: Harness,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const clientId = options.clientId ?? (await registerTestClient(harness, options.redirectUri));
  const redirectUri = options.redirectUri ?? DEFAULT_REDIRECT_URI;
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(8).toString('hex');
  const scopes = options.scopes ?? DEFAULT_WALK_SCOPES;

  const authorizeUrl =
    `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}` +
    `&code_challenge=${challengeFor(verifier)}&code_challenge_method=S256` +
    `&scope=${encodeURIComponent(scopes)}&resource=${encodeURIComponent(`${harness.baseUrl}/mcp`)}`;

  const loginPage = await harness.fetch(authorizeUrl);
  const loginHtml = await loginPage.text();

  const consentPage = await harness.fetch('/login', {
    method: 'POST',
    headers: FORM_HEADERS,
    body: formBody({
      txn: hiddenField(loginHtml, 'txn'),
      csrf: hiddenField(loginHtml, 'csrf'),
      choice: options.choice ?? 'per_ava_stone',
    }),
  });
  const consentHtml = await consentPage.text();

  const approve =
    options.approve ??
    scopes.split(' ').filter((scope) => scope === 'profile' || scope.endsWith(':read'));

  const fields: Record<string, string | string[]> = {
    txn: hiddenField(consentHtml, 'txn'),
    csrf: hiddenField(consentHtml, 'csrf'),
    scope: [...approve],
    decision: options.decision ?? 'approve',
  };
  if (options.showSuccess === true) fields.show_success = '1';

  const consent = await harness.fetch('/consent', {
    method: 'POST',
    headers: FORM_HEADERS,
    body: formBody(fields),
  });
  const consentBody = await consent.text();

  const location = consent.headers.get('location');
  const fromPage = /<a class="button" id="continue" href="([^"]*)"/.exec(consentBody)?.[1] ?? null;
  const callbackUrl =
    location ?? (fromPage === null ? null : fromPage.replace(/&amp;/g, '&').replace(/&#39;/g, "'"));
  const code = callbackUrl === null ? null : new URL(callbackUrl).searchParams.get('code');

  return {
    clientId,
    verifier,
    state,
    redirectUri,
    loginHtml,
    consentHtml,
    consent,
    consentBody,
    callbackUrl,
    code,
  };
}

export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:7777/callback';

/** One `/register` call, returning the minted `client_id`. */
export async function registerTestClient(
  harness: Harness,
  redirectUri: string = DEFAULT_REDIRECT_URI,
  clientName = 'Test MCP client',
): Promise<string> {
  const response = await harness.fetch('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    }),
  });
  const body = (await response.json()) as { client_id: string };
  return body.client_id;
}
