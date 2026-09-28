/**
 * Web Bot Auth: checking who signed a request (block: auth, v0.10, D-29).
 *
 * An AI agent that implements Web Bot Auth (draft-meunier-web-bot-auth-architecture) signs each
 * request with HTTP Message Signatures (RFC 9421): `Signature-Input` lists what it covered and the
 * parameters (`created`, `expires`, `keyid`, `tag="web-bot-auth"`, usually a `nonce`), `Signature`
 * carries the Ed25519 signature, and `Signature-Agent` names the agent, whose public keys live at
 * `<agent>/.well-known/http-message-signatures-directory` (draft-meunier-http-message-signatures-
 * directory). Checking that signature is the only way this server can *know* which provider is on
 * the other end; `clientInfo` and `User-Agent` are whatever the client chose to type.
 *
 * Three rules (D-29):
 *   - **record, verify, never gate.** The verdict lands on `http.request.signature` and nowhere
 *     else. No request is answered differently because of it, the same way no request is answered
 *     differently because of `clientInfo.name` (CLAUDE.md, "Never ... gating behaviour on
 *     `clientInfo.name` or `User-Agent`").
 *   - **invite, do not demand.** With `BOT_AUTH_CHALLENGE=advertise` every MCP response carries an
 *     `Accept-Signature` header (RFC 9421 section 5.1) naming what a signature should cover, so a
 *     client that can sign learns that this server would read it.
 *   - **a fetch to a third party is guarded and on the record.** The directory is fetched over
 *     https only, from a public address only (the check runs in the socket's own DNS lookup, so a
 *     rebinding answer cannot slip past it), with no redirects, a timeout, a size cap, one fetch in
 *     flight per agent, a bounded cache and an hourly budget (invariant 14); every attempt emits
 *     `auth.directory.fetched`.
 *
 * The middleware verifies before the request reaches any route, so the verdict is ready when the
 * route emits `http.request`. An unsigned request costs nothing; a signed one costs a cache lookup
 * and an Ed25519 verification, plus one directory fetch per agent per TTL.
 */
import { createHash, createPublicKey, verify as verifyEd25519, type KeyObject } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import {
  OAUTH_ROUTES,
  PUBLIC_MCP_PATH,
  setSignatureCheck,
  type BotAuthVerdict,
  type SignatureCheck,
  type XrayEmitter,
} from '../contracts/index.js';

import {
  StructuredFieldError,
  paramValue,
  parseDictionary,
  parseItemField,
  serializeInnerList,
  serializeMember,
  serializeParameters,
  type InnerList,
  type Item,
  type Member,
} from './structured-fields.js';

/** The well-known path of a key directory (directory draft, section 4). */
export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';
/** The tag every Web Bot Auth signature carries. */
export const WEB_BOT_AUTH_TAG = 'web-bot-auth';

/**
 * The `Accept-Signature` value this server sends (RFC 9421 section 5.1): cover the authority and
 * the agent's name, and carry the parameters the architecture draft requires. Parameters without
 * a value ask the signer to include them.
 */
export const ACCEPT_SIGNATURE_VALUE =
  'sig1=("@authority" "signature-agent");created;expires;keyid;nonce;tag="web-bot-auth"';

/** Clock skew tolerated on `created` and `expires`. */
export const SIGNATURE_SKEW_S = 60;
/** The directory body cap; a JWKS of a few keys is a few hundred bytes. */
export const DIRECTORY_MAX_BYTES = 64 * 1024;
/** A directory is refetched no sooner than this, whatever its `Cache-Control` says. */
export const DIRECTORY_MIN_TTL_S = 60;
/** Nor kept longer than a day (the draft's example uses `max-age=86400`). */
export const DIRECTORY_MAX_TTL_S = 86_400;
/** A key id the cached directory does not hold triggers one refetch, at most this often. */
export const UNKNOWN_KEY_REFETCH_S = 300;
/** How many nonces are remembered; each is forgotten at its signature's `expires`. */
export const MAX_REMEMBERED_NONCES = 20_000;

/** The knobs, all optional so a test or a half-wired tree gets the safe defaults. */
export interface BotAuthConfig {
  /** `BOT_AUTH_VERIFY`: off records the signature fields with the verdict `not_checked`. */
  readonly botAuthVerify?: boolean;
  /** `BOT_AUTH_CHALLENGE`: `advertise` adds `Accept-Signature` to MCP responses. */
  readonly botAuthChallenge?: 'off' | 'advertise';
  /** `BOT_AUTH_DIRECTORY_TTL_S`: cache lifetime when the directory sends no `max-age`. */
  readonly botAuthDirectoryTtlS?: number;
  /** `BOT_AUTH_FETCH_TIMEOUT_MS`. */
  readonly botAuthFetchTimeoutMs?: number;
  /** `BOT_AUTH_MAX_DIRECTORIES`: agents whose keys are cached at once. */
  readonly botAuthMaxDirectories?: number;
  /** `BOT_AUTH_MAX_FETCHES_PER_HOUR`: directory fetches this process may make in an hour. */
  readonly botAuthMaxFetchesPerHour?: number;
  /**
   * `BOT_AUTH_ALLOW_LOOPBACK`: accept `http://` agents and loopback addresses, for a local demo
   * signer. `loadConfig` refuses it under `NODE_ENV=production`.
   */
  readonly botAuthAllowLoopback?: boolean;
}

/** What a directory fetch answered. */
export interface DirectoryResponse {
  readonly status: number;
  readonly cacheControl: string | null;
  readonly body: string;
}

export type DirectoryOutcome =
  | 'ok'
  | 'http_error'
  | 'timeout'
  | 'too_large'
  | 'bad_json'
  | 'blocked'
  | 'network'
  | 'rate_limited';

export class DirectoryFetchError extends Error {
  constructor(
    readonly outcome: DirectoryOutcome,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'DirectoryFetchError';
  }
}

export type DirectoryFetcher = (
  url: URL,
  options: {
    readonly timeoutMs: number;
    readonly maxBytes: number;
    readonly allowLoopback: boolean;
  },
) => Promise<DirectoryResponse>;

export interface BotAuthDeps {
  readonly config: BotAuthConfig;
  readonly emitter: XrayEmitter;
  readonly now?: () => Date;
  /** Overridden in tests; the default speaks https with the guarded lookup below. */
  readonly fetchDirectory?: DirectoryFetcher;
}

/** The parts of a request the check reads. Express's `Request` satisfies it. */
export interface SignableRequest {
  readonly method: string;
  readonly originalUrl?: string;
  readonly url?: string;
  readonly rawHeaders: readonly string[];
  readonly protocol?: string;
}

export interface BotAuthStats {
  readonly checked: number;
  readonly verdicts: Readonly<Record<string, number>>;
  readonly directories: number;
  readonly fetchesThisHour: number;
}

export interface BotAuth {
  /** Mounted by the app in front of every route. Never answers; only annotates and invites. */
  readonly middleware: RequestHandler;
  /** The check itself, for tests: `undefined` when the request carries no signature header. */
  check(request: SignableRequest): Promise<SignatureCheck | undefined>;
  stats(): BotAuthStats;
}

// ---------------------------------------------------------------------------
// The address guard (invariant 14: a fetch driven by a request header must not reach inside)
// ---------------------------------------------------------------------------

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, 'ipv6');
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** True when this server may connect to `address` to fetch a directory. */
export function isFetchableAddress(address: string, allowLoopback: boolean): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (allowLoopback && LOOPBACK.check(address, type)) return true;
  // An IPv4-mapped IPv6 address is judged as the IPv4 address it carries. (`::ffff:0:0/96` is not
  // in `BLOCKED`: Node's BlockList would then match every plain IPv4 address against it.)
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return isFetchableAddress(mapped[1], allowLoopback);
  return !BLOCKED.check(address, type);
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** The socket's own lookup, filtered: the address checked is the address connected to. */
function guardedLookup(allowLoopback: boolean) {
  return (hostname: string, options: { all?: boolean }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        callback(error, options.all ? [] : '', 0);
        return;
      }
      const allowed = addresses.filter((entry) => isFetchableAddress(entry.address, allowLoopback));
      if (allowed.length === 0 || allowed.length !== addresses.length) {
        const refused = Object.assign(
          new Error(`${hostname} resolves to an address this server does not fetch from`),
          { code: 'EBLOCKED' },
        ) as NodeJS.ErrnoException;
        callback(refused, options.all ? [] : '', 0);
        return;
      }
      if (options.all) callback(null, allowed);
      else callback(null, allowed[0]?.address ?? '', allowed[0]?.family ?? 4);
    });
  };
}

/** The default fetcher: GET over https (http only with `allowLoopback`), no redirects, capped. */
export const fetchDirectoryOverNetwork: DirectoryFetcher = (url, options) =>
  new Promise<DirectoryResponse>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    if (!secure && !(options.allowLoopback && url.protocol === 'http:')) {
      reject(
        new DirectoryFetchError('blocked', `only https directories are fetched (${url.protocol})`),
      );
      return;
    }
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) !== 0 && !isFetchableAddress(literal, options.allowLoopback)) {
      reject(new DirectoryFetchError('blocked', `${literal} is not a public address`));
      return;
    }
    const client = secure ? https : http;
    const request = client.request(
      url,
      {
        method: 'GET',
        headers: {
          accept: `${DIRECTORY_MEDIA_TYPE}, application/json;q=0.9`,
          'user-agent': 'GlassBank-WebBotAuth/1.0 (+https://glassbank-mcp.abovethefog.app/)',
        },
        lookup: guardedLookup(options.allowLoopback) as never,
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            reject(
              new DirectoryFetchError(
                'too_large',
                `the directory is over ${options.maxBytes} bytes`,
                status,
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const header = response.headers['cache-control'];
          resolve({
            status,
            cacheControl: typeof header === 'string' ? header : null,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', (error) => {
          reject(new DirectoryFetchError('network', error.message, status));
        });
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        reject(new DirectoryFetchError('timeout', `no answer within ${options.timeoutMs} ms`));
      } else if (error.code === 'EBLOCKED') {
        reject(new DirectoryFetchError('blocked', error.message));
      } else {
        reject(new DirectoryFetchError('network', error.message));
      }
    });
    request.end();
  });

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function base64url(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 7638 thumbprint of an Ed25519 JWK (RFC 8037 appendix A.3): the draft's `keyid`. */
export function jwkThumbprint(jwk: {
  readonly crv: string;
  readonly kty: string;
  readonly x: string;
}): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return base64url(createHash('sha256').update(canonical, 'utf8').digest());
}

interface DirectoryEntry {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

/** Ed25519 keys of a JWKS, by thumbprint and by `kid`; anything else in the set is ignored. */
function keysOf(body: string, nowS: number): Map<string, KeyObject> {
  const parsed: unknown = JSON.parse(body);
  const list =
    parsed !== null && typeof parsed === 'object' && 'keys' in parsed
      ? (parsed as { keys: unknown }).keys
      : null;
  // One draft example shows `keys` as a single object rather than an array; read both.
  const candidates = Array.isArray(list)
    ? list
    : list !== null && typeof list === 'object'
      ? [list]
      : [];
  const keys = new Map<string, KeyObject>();
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const jwk = candidate as Record<string, unknown>;
    if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') continue;
    if (typeof jwk.nbf === 'number' && jwk.nbf > nowS + SIGNATURE_SKEW_S) continue;
    if (typeof jwk.exp === 'number' && jwk.exp < nowS - SIGNATURE_SKEW_S) continue;
    try {
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
      keys.set(jwkThumbprint({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }), key);
      if (typeof jwk.kid === 'string' && jwk.kid.length > 0) keys.set(jwk.kid, key);
    } catch {
      // A key Node cannot import is a key nobody can have signed with.
    }
  }
  return keys;
}

function ttlOf(cacheControl: string | null, fallbackS: number): number {
  const match = /max-age\s*=\s*(\d+)/i.exec(cacheControl ?? '');
  const requested = match?.[1] ? Number.parseInt(match[1], 10) : fallbackS;
  return Math.min(DIRECTORY_MAX_TTL_S, Math.max(DIRECTORY_MIN_TTL_S, requested));
}

// ---------------------------------------------------------------------------
// The signature base (RFC 9421 section 2.5)
// ---------------------------------------------------------------------------

class Unsupported extends Error {}
class MissingComponent extends Error {}

interface RequestFacts {
  readonly method: string;
  readonly scheme: string;
  readonly authority: string;
  readonly target: string;
  readonly headers: ReadonlyMap<string, readonly string[]>;
}

function headerMap(rawHeaders: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    const values = map.get(name) ?? [];
    values.push(String(rawHeaders[index + 1]));
    map.set(name, values);
  }
  return map;
}

/** RFC 9421 section 2.1: each value trimmed, several lines joined with ", ". */
function fieldValue(headers: ReadonlyMap<string, readonly string[]>, name: string): string | null {
  const values = headers.get(name);
  if (!values || values.length === 0) return null;
  return values.map((value) => value.trim()).join(', ');
}

function factsOf(
  request: SignableRequest,
  headers: ReadonlyMap<string, readonly string[]>,
): RequestFacts {
  const scheme =
    request.protocol === 'https' ? 'https' : request.protocol === 'http' ? 'http' : 'https';
  const host = (fieldValue(headers, 'host') ?? '').split(',')[0]?.trim().toLowerCase() ?? '';
  const defaultPort = scheme === 'https' ? ':443' : ':80';
  return {
    method: request.method.toUpperCase(),
    scheme,
    authority: host.endsWith(defaultPort) ? host.slice(0, -defaultPort.length) : host,
    target: request.originalUrl ?? request.url ?? '/',
    headers,
  };
}

function componentName(item: Item): string {
  if (item.bare.kind !== 'string')
    throw new StructuredFieldError('a covered component is not a string');
  return item.bare.value;
}

/** How the component is named on its line of the base: the identifier with its parameters. */
function componentIdentifier(item: Item): string {
  return `"${componentName(item)}"${serializeParameters(item.params)}`;
}

function componentValue(item: Item, facts: RequestFacts): string {
  const name = componentName(item);
  const target = facts.target;
  const queryAt = target.indexOf('?');
  if (name.startsWith('@')) {
    if (item.params.size > 0) throw new Unsupported(`component parameters on ${name}`);
    switch (name) {
      case '@method':
        return facts.method;
      case '@authority':
        return facts.authority;
      case '@scheme':
        return facts.scheme;
      case '@target-uri':
        return `${facts.scheme}://${facts.authority}${target}`;
      case '@request-target':
        return target;
      case '@path':
        return (queryAt < 0 ? target : target.slice(0, queryAt)) || '/';
      case '@query':
        return queryAt < 0 ? '?' : target.slice(queryAt);
      default:
        throw new Unsupported(`the derived component ${name}`);
    }
  }
  for (const key of item.params.keys()) {
    if (key !== 'key') throw new Unsupported(`the ;${key} parameter on "${name}"`);
  }
  const value = fieldValue(facts.headers, name);
  if (value === null)
    throw new MissingComponent(`the signature covers "${name}", which the request does not carry`);
  const key = item.params.get('key');
  if (!key) return value;
  if (key.kind !== 'string') throw new StructuredFieldError(`;key on "${name}" is not a string`);
  const member = parseDictionary(value).get(key.value);
  if (!member) throw new MissingComponent(`"${name}" has no member named ${key.value}`);
  return serializeMember(member);
}

/** The exact bytes the signer signed: one line per component, then `@signature-params`. */
export function signatureBase(request: SignableRequest, signatureInput: InnerList): string {
  const facts = factsOf(request, headerMap(request.rawHeaders));
  const lines = signatureInput.items.map(
    (item) => `${componentIdentifier(item)}: ${componentValue(item, facts)}`,
  );
  lines.push(`"@signature-params": ${serializeInnerList(signatureInput)}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/** The agent's name from `Signature-Agent`: an sf-string, or a dictionary member per label. */
function agentOf(raw: string | null, label: string | null): string | null {
  if (raw === null) return null;
  try {
    const item = parseItemField(raw);
    if (item.bare.kind === 'string' || item.bare.kind === 'token') return item.bare.value;
  } catch {
    // Not a single item: the dictionary form of the newer drafts.
  }
  try {
    const members = parseDictionary(raw);
    const member: Member | undefined =
      (label ? members.get(label) : undefined) ?? members.values().next().value;
    if (
      member?.type === 'item' &&
      (member.bare.kind === 'string' || member.bare.kind === 'token')
    ) {
      return member.bare.value;
    }
  } catch {
    // Unreadable either way; the caller reports it.
  }
  return raw.trim().replace(/^"|"$/g, '') || null;
}

/** The directory URL an agent name points at, or `null` when it is not a usable origin. */
export function directoryUrlOf(agent: string, allowLoopback: boolean): URL | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(agent) ? agent : `https://${agent}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  return new URL(DIRECTORY_PATH, url.origin);
}

/**
 * Everything a check reports except its verdict. Spelled out rather than `Omit`-ed from
 * `SignatureCheck`, whose open schema carries an index signature that `Omit` would flatten.
 */
interface Draft {
  present: boolean;
  label: string | null;
  agent: string | null;
  keyid: string | null;
  tag: string | null;
  alg: string | null;
  created: number | null;
  expires: number | null;
  nonce_present: boolean;
  components: string[];
  directory_url: string | null;
  cache: 'hit' | 'miss' | 'none';
  challenge_sent: boolean;
  duration_ms: number | null;
}

function emptyDraft(): Draft {
  return {
    present: true,
    label: null,
    agent: null,
    keyid: null,
    tag: null,
    alg: null,
    created: null,
    expires: null,
    nonce_present: false,
    components: [],
    directory_url: null,
    cache: 'none',
    challenge_sent: false,
    duration_ms: null,
  };
}

const VERDICT_RANK: Record<BotAuthVerdict, number> = {
  verified: 0,
  invalid_signature: 1,
  unknown_key: 2,
  replayed: 3,
  expired: 4,
  not_yet_valid: 5,
  directory_unreachable: 6,
  unsupported: 7,
  malformed: 8,
  not_checked: 9,
  unsigned: 10,
};

/** Lower is stronger evidence; the read model keeps a session's strongest verdict. */
export function verdictRank(verdict: BotAuthVerdict): number {
  return VERDICT_RANK[verdict];
}

export function createBotAuth(deps: BotAuthDeps): BotAuth {
  const now = deps.now ?? (() => new Date());
  const config = {
    verify: deps.config.botAuthVerify ?? true,
    challenge: deps.config.botAuthChallenge ?? 'off',
    ttlS: deps.config.botAuthDirectoryTtlS ?? 3600,
    timeoutMs: deps.config.botAuthFetchTimeoutMs ?? 3000,
    maxDirectories: deps.config.botAuthMaxDirectories ?? 100,
    maxFetchesPerHour: deps.config.botAuthMaxFetchesPerHour ?? 60,
    allowLoopback: deps.config.botAuthAllowLoopback ?? false,
  };
  const fetchDirectory = deps.fetchDirectory ?? fetchDirectoryOverNetwork;
  const directories = new Map<string, DirectoryEntry>();
  const inFlight = new Map<string, Promise<DirectoryEntry | DirectoryFetchError>>();
  const fetchTimes: number[] = [];
  const nonces = new Map<string, number>();
  const verdicts: Record<string, number> = {};
  let checked = 0;

  function spendFetch(nowMs: number): boolean {
    while (fetchTimes.length > 0 && (fetchTimes[0] ?? 0) <= nowMs - 3_600_000) fetchTimes.shift();
    if (fetchTimes.length >= config.maxFetchesPerHour) return false;
    fetchTimes.push(nowMs);
    return true;
  }

  function remember(origin: string, entry: DirectoryEntry): void {
    directories.delete(origin);
    directories.set(origin, entry);
    while (directories.size > config.maxDirectories) {
      const oldest = directories.keys().next().value;
      if (oldest === undefined) break;
      directories.delete(oldest);
    }
  }

  async function fetchKeys(agent: string, url: URL): Promise<DirectoryEntry | DirectoryFetchError> {
    const started = now().getTime();
    const report = (
      outcome: DirectoryOutcome,
      extra: {
        status?: number | null;
        keyCount?: number;
        ttlS?: number | null;
        error?: string | null;
      },
    ): void => {
      deps.emitter.emit('auth.directory.fetched', {
        agent,
        url: url.toString(),
        outcome,
        status: extra.status ?? null,
        key_count: extra.keyCount ?? 0,
        duration_ms: Math.max(0, now().getTime() - started),
        ttl_s: extra.ttlS ?? null,
        error: extra.error ?? null,
      });
    };
    if (!spendFetch(started)) {
      const error = new DirectoryFetchError(
        'rate_limited',
        `this server already fetched ${config.maxFetchesPerHour} directories in the last hour`,
      );
      report('rate_limited', { error: error.message });
      return error;
    }
    try {
      const response = await fetchDirectory(url, {
        timeoutMs: config.timeoutMs,
        maxBytes: DIRECTORY_MAX_BYTES,
        allowLoopback: config.allowLoopback,
      });
      if (response.status !== 200) {
        const error = new DirectoryFetchError(
          'http_error',
          `the directory answered ${response.status}`,
          response.status,
        );
        report('http_error', { status: response.status, error: error.message });
        return error;
      }
      let keys: Map<string, KeyObject>;
      try {
        keys = keysOf(response.body, Math.floor(now().getTime() / 1000));
      } catch {
        const error = new DirectoryFetchError(
          'bad_json',
          'the directory is not a JSON Web Key Set',
          200,
        );
        report('bad_json', { status: 200, error: error.message });
        return error;
      }
      const ttlS = ttlOf(response.cacheControl, config.ttlS);
      const fetchedAt = now().getTime();
      const entry: DirectoryEntry = { keys, fetchedAt, expiresAt: fetchedAt + ttlS * 1000 };
      remember(url.origin, entry);
      // Thumbprint and `kid` may name the same key twice; count keys, not names.
      report('ok', { status: 200, keyCount: new Set(keys.values()).size, ttlS });
      return entry;
    } catch (error) {
      const failure =
        error instanceof DirectoryFetchError
          ? error
          : new DirectoryFetchError(
              'network',
              error instanceof Error ? error.message : String(error),
            );
      report(failure.outcome, { status: failure.status, error: failure.message });
      return failure;
    }
  }

  /** Cached keys, or one fetch shared by every request that needs them at the same moment. */
  async function keysFor(
    agent: string,
    url: URL,
    keyid: string,
  ): Promise<{ entry: DirectoryEntry | DirectoryFetchError; cache: 'hit' | 'miss' }> {
    const nowMs = now().getTime();
    const cached = directories.get(url.origin);
    const fresh = cached !== undefined && cached.expiresAt > nowMs;
    const rotated =
      fresh && !cached.keys.has(keyid) && nowMs - cached.fetchedAt > UNKNOWN_KEY_REFETCH_S * 1000;
    if (fresh && !rotated) return { entry: cached, cache: 'hit' };
    const pending = inFlight.get(url.origin);
    if (pending) return { entry: await pending, cache: 'miss' };
    const promise = fetchKeys(agent, url).finally(() => inFlight.delete(url.origin));
    inFlight.set(url.origin, promise);
    const entry = await promise;
    // A failed refetch still leaves the keys we had; they are no less valid than a minute ago.
    if (entry instanceof DirectoryFetchError && fresh) return { entry: cached, cache: 'hit' };
    return { entry, cache: 'miss' };
  }

  function forgetExpiredNonces(nowS: number): void {
    if (nonces.size < MAX_REMEMBERED_NONCES) return;
    for (const [key, expires] of nonces) {
      if (expires < nowS) nonces.delete(key);
    }
    while (nonces.size >= MAX_REMEMBERED_NONCES) {
      const oldest = nonces.keys().next().value;
      if (oldest === undefined) break;
      nonces.delete(oldest);
    }
  }

  async function verifyDraft(
    request: SignableRequest,
    headers: Map<string, string[]>,
    draft: Draft,
  ): Promise<SignatureCheck> {
    const done = (verdict: BotAuthVerdict, reason: string | null): SignatureCheck => ({
      ...draft,
      verdict,
      reason,
    });

    const inputRaw = fieldValue(headers, 'signature-input');
    const signatureRaw = fieldValue(headers, 'signature');
    if (inputRaw === null)
      return done('malformed', 'a Signature header arrived without Signature-Input');
    if (signatureRaw === null)
      return done('malformed', 'Signature-Input arrived without a Signature header');

    let inputs: Map<string, Member>;
    let signatures: Map<string, Member>;
    try {
      inputs = parseDictionary(inputRaw);
      signatures = parseDictionary(signatureRaw);
    } catch (error) {
      return done(
        'malformed',
        `the signature headers are not valid structured fields (${(error as Error).message})`,
      );
    }

    // The first signature tagged for Web Bot Auth; otherwise the first signature of any kind.
    let label: string | null = null;
    for (const [name, member] of inputs) {
      if (member.type === 'inner' && paramValue(member.params, 'tag') === WEB_BOT_AUTH_TAG) {
        label = name;
        break;
      }
    }
    label ??= inputs.keys().next().value ?? null;
    const input = label === null ? undefined : inputs.get(label);
    draft.label = label;
    if (!input || input.type !== 'inner')
      return done('malformed', 'Signature-Input holds no signature parameters');

    const text = (key: string): string | null => {
      const value = paramValue(input.params, key);
      return typeof value === 'string' ? value : null;
    };
    const integer = (key: string): number | null => {
      const value = paramValue(input.params, key);
      return typeof value === 'number' ? Math.trunc(value) : null;
    };
    draft.keyid = text('keyid');
    draft.tag = text('tag');
    draft.alg = text('alg');
    draft.created = integer('created');
    draft.expires = integer('expires');
    draft.nonce_present = text('nonce') !== null;
    try {
      draft.components = input.items.map((item) => componentIdentifier(item));
    } catch (error) {
      return done('malformed', (error as Error).message);
    }
    const agentRaw = fieldValue(headers, 'signature-agent');
    draft.agent = agentOf(agentRaw, label);

    const names = input.items.map((item) => (item.bare.kind === 'string' ? item.bare.value : ''));
    if (new Set(draft.components).size !== draft.components.length) {
      return done('malformed', 'Signature-Input lists a component twice');
    }
    const signature = signatures.get(label ?? '');
    if (!signature || signature.type !== 'item' || signature.bare.kind !== 'bytes') {
      return done('malformed', `Signature has no byte sequence named ${label ?? '(none)'}`);
    }
    if (draft.keyid === null) return done('malformed', 'the signature parameters carry no keyid');
    if (!names.includes('@authority') && !names.includes('@target-uri')) {
      return done(
        'malformed',
        'the signature covers neither @authority nor @target-uri, as Web Bot Auth requires',
      );
    }
    if (agentRaw !== null && !names.includes('signature-agent')) {
      return done(
        'malformed',
        'Signature-Agent is not covered by the signature, so the agent name is not bound to it',
      );
    }
    if (draft.alg !== null && draft.alg.toLowerCase() !== 'ed25519') {
      return done('unsupported', `the algorithm ${draft.alg} (this server checks ed25519)`);
    }

    const nowS = Math.floor(now().getTime() / 1000);
    if (draft.expires === null)
      return done('malformed', 'the signature parameters carry no expires');
    if (draft.created !== null && draft.created > nowS + SIGNATURE_SKEW_S) {
      return done('not_yet_valid', `created ${draft.created - nowS} s in the future`);
    }
    if (draft.expires <= nowS - SIGNATURE_SKEW_S) {
      return done('expired', `expired ${nowS - draft.expires} s ago`);
    }

    let base: string;
    try {
      base = signatureBase(request, input);
    } catch (error) {
      if (error instanceof Unsupported)
        return done('unsupported', `the signature covers ${error.message}`);
      if (error instanceof MissingComponent) return done('invalid_signature', error.message);
      return done('malformed', (error as Error).message);
    }

    if (draft.agent === null) {
      return done(
        'unknown_key',
        'no Signature-Agent header, so there is no directory to look the key up in',
      );
    }
    const directory = directoryUrlOf(draft.agent, config.allowLoopback);
    if (directory === null) {
      return done('directory_unreachable', `Signature-Agent ${draft.agent} is not an https origin`);
    }
    draft.directory_url = directory.toString();

    const { entry, cache } = await keysFor(draft.agent, directory, draft.keyid);
    draft.cache = cache;
    if (entry instanceof DirectoryFetchError) {
      return done('directory_unreachable', `the key directory could not be read: ${entry.message}`);
    }
    const key = entry.keys.get(draft.keyid);
    if (!key)
      return done('unknown_key', `the directory of ${draft.agent} publishes no key ${draft.keyid}`);

    let valid: boolean;
    try {
      valid = verifyEd25519(null, Buffer.from(base, 'utf8'), key, signature.bare.value);
    } catch {
      // A key or signature Node refuses to read is a signature that does not verify.
      valid = false;
    }
    if (!valid)
      return done(
        'invalid_signature',
        'the Ed25519 signature does not match the signed components',
      );

    const nonce = text('nonce');
    if (nonce !== null) {
      const nonceKey = `${draft.keyid}\u0000${nonce}`;
      const seen = nonces.get(nonceKey);
      if (seen !== undefined && seen >= nowS)
        return done('replayed', 'this nonce was already used inside its validity window');
      forgetExpiredNonces(nowS);
      nonces.set(nonceKey, draft.expires);
    }
    return done('verified', null);
  }

  async function check(request: SignableRequest): Promise<SignatureCheck | undefined> {
    const headers = headerMap(request.rawHeaders);
    if (!headers.has('signature') && !headers.has('signature-input')) return undefined;
    const started = now().getTime();
    const draft = emptyDraft();
    let result: SignatureCheck;
    if (!config.verify) {
      result = {
        ...draft,
        agent: agentOf(fieldValue(headers, 'signature-agent'), null),
        verdict: 'not_checked',
        reason: 'BOT_AUTH_VERIFY is off',
      };
    } else {
      try {
        result = await verifyDraft(request, headers, draft);
      } catch (error) {
        result = {
          ...draft,
          verdict: 'not_checked',
          reason: `the check failed: ${(error as Error).message}`,
        };
      }
    }
    checked += 1;
    verdicts[result.verdict] = (verdicts[result.verdict] ?? 0) + 1;
    return { ...result, duration_ms: Math.max(0, now().getTime() - started) };
  }

  const challengePaths = [OAUTH_ROUTES.mcp, PUBLIC_MCP_PATH];
  const invites = (path: string): boolean =>
    config.challenge === 'advertise' &&
    challengePaths.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

  const middleware: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
    const invited = invites(request.path);
    if (invited) response.setHeader('Accept-Signature', ACCEPT_SIGNATURE_VALUE);
    void check(request)
      .then((result) => {
        if (result) setSignatureCheck(request, { ...result, challenge_sent: invited });
        else if (invited) {
          setSignatureCheck(request, {
            ...emptyDraft(),
            present: false,
            verdict: 'unsigned',
            reason: 'the request carried no signature',
            challenge_sent: true,
            duration_ms: 0,
          });
        }
      })
      .catch(() => undefined)
      .finally(() => next());
  };

  return {
    middleware,
    check,
    stats: () => ({
      checked,
      verdicts: { ...verdicts },
      directories: directories.size,
      fetchesThisHour: fetchTimes.filter((time) => time > now().getTime() - 3_600_000).length,
    }),
  };
}
