/**
 * Web Bot Auth (block: auth, v0.10, D-29): the check records and verifies, and never gates.
 *
 * The signer here is written out by hand - the signature base as literal lines - so the verifier is
 * tested against the RFC's wording rather than against itself. RFC 9421 appendix B.2.6 pins the
 * base construction and the Ed25519 verification against a published test vector.
 */
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';
import { describe, expect, it } from 'vitest';

import { signatureCheckOf, type XrayEmitter } from '../../contracts/index.js';
import {
  ACCEPT_SIGNATURE_VALUE,
  DirectoryFetchError,
  createBotAuth,
  directoryUrlOf,
  fetchDirectoryOverNetwork,
  isFetchableAddress,
  jwkThumbprint,
  signatureBase,
  type DirectoryFetcher,
  type SignableRequest,
} from '../bot-auth.js';
import { parseDictionary } from '../structured-fields.js';

const NOW_S = 1_790_000_000;
const now = (): Date => new Date(NOW_S * 1000);

interface Emitted {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

function recorder(): { emitter: XrayEmitter; events: Emitted[] } {
  const events: Emitted[] = [];
  return {
    events,
    emitter: {
      emit: (type, data) => {
        events.push({ type, data: data as Record<string, unknown> });
      },
    },
  };
}

function keyPair(): { privateKey: KeyObject; x: string; keyid: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return { privateKey, x: jwk.x, keyid: jwkThumbprint({ crv: 'Ed25519', kty: 'OKP', x: jwk.x }) };
}

function directoryOf(...keys: { x: string }[]): string {
  return JSON.stringify({ keys: keys.map((key) => ({ kty: 'OKP', crv: 'Ed25519', x: key.x })) });
}

function fetcher(bodies: Record<string, { status?: number; body: string }>): DirectoryFetcher & {
  calls: string[];
} {
  const calls: string[] = [];
  const fetchDirectory = (async (url: URL) => {
    calls.push(url.toString());
    const answer = bodies[url.origin];
    if (!answer) throw new DirectoryFetchError('network', 'no such host');
    return { status: answer.status ?? 200, cacheControl: 'max-age=600', body: answer.body };
  }) as unknown as DirectoryFetcher & { calls: string[] };
  fetchDirectory.calls = calls;
  return fetchDirectory;
}

interface SignOptions {
  readonly key: KeyObject;
  readonly keyid: string;
  readonly agent?: string | null;
  readonly agentForm?: 'string' | 'dictionary';
  readonly created?: number;
  readonly expires?: number | null;
  readonly nonce?: string | null;
  readonly host?: string;
  readonly signedHost?: string;
  readonly coverAgent?: boolean;
  readonly path?: string;
}

/** A request signed the way the architecture draft describes, with the base written out by hand. */
function signedRequest(options: SignOptions): SignableRequest {
  const agent = options.agent === undefined ? 'https://agent.example' : options.agent;
  const created = options.created ?? NOW_S - 5;
  const expires = options.expires === undefined ? NOW_S + 60 : options.expires;
  const nonce = options.nonce === undefined ? 'bm9uY2UtMQ' : options.nonce;
  const host = options.host ?? 'glassbank.test';
  const dictionary = options.agentForm === 'dictionary';
  const agentComponent = dictionary ? '"signature-agent";key="sig1"' : '"signature-agent"';
  const components = ['"@authority"'];
  if (agent !== null && options.coverAgent !== false) components.push(agentComponent);
  let params = `created=${created}`;
  if (expires !== null) params += `;expires=${expires}`;
  params += `;keyid="${options.keyid}"`;
  if (nonce !== null) params += `;nonce="${nonce}"`;
  params += ';tag="web-bot-auth"';
  const inner = `(${components.join(' ')});${params}`;
  const lines = [`"@authority": ${options.signedHost ?? host}`];
  if (agent !== null && options.coverAgent !== false) lines.push(`${agentComponent}: "${agent}"`);
  lines.push(`"@signature-params": ${inner}`);
  const signature = sign(null, Buffer.from(lines.join('\n'), 'utf8'), options.key).toString(
    'base64',
  );
  const rawHeaders = ['Host', host, 'Accept', 'application/json'];
  if (agent !== null)
    rawHeaders.push('Signature-Agent', dictionary ? `sig1="${agent}"` : `"${agent}"`);
  rawHeaders.push('Signature-Input', `sig1=${inner}`, 'Signature', `sig1=:${signature}:`);
  return { method: 'POST', originalUrl: options.path ?? '/mcp', rawHeaders, protocol: 'https' };
}

describe('RFC 9421 appendix B.2.6 (Ed25519 test vector)', () => {
  const b26: SignableRequest = {
    method: 'POST',
    originalUrl: '/foo?param=Value&Pet=dog',
    protocol: 'https',
    rawHeaders: [
      'Host',
      'example.com',
      'Date',
      'Tue, 20 Apr 2021 02:07:55 GMT',
      'Content-Type',
      'application/json',
      'Content-Digest',
      'sha-512=:WZDPaVn/7XgHaAy8pmojAkGWoRx2UFChF41A2svX+TaPm+AbwAgBWnrIiYllu7BNNyealdVLvRwEmTHWXvJwew==:',
      'Content-Length',
      '18',
    ],
  };
  const input = parseDictionary(
    'sig-b26=("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
  ).get('sig-b26');

  it('builds the signature base the RFC prints', () => {
    expect(input?.type).toBe('inner');
    if (input?.type !== 'inner') return;
    expect(signatureBase(b26, input)).toBe(
      [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        '"@signature-params": ("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"',
      ].join('\n'),
    );
  });

  it('verifies the RFC signature with the RFC key', () => {
    if (input?.type !== 'inner') throw new Error('unparsed');
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs' },
      format: 'jwk',
    });
    const signature = Buffer.from(
      'wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==',
      'base64',
    );
    expect(verify(null, Buffer.from(signatureBase(b26, input), 'utf8'), key, signature)).toBe(true);
  });

  it('computes the RFC 8037 appendix A.3 thumbprint', () => {
    expect(
      jwkThumbprint({
        crv: 'Ed25519',
        kty: 'OKP',
        x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
      }),
    ).toBe('kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });
});

describe('the check', () => {
  const agentKey = keyPair();
  const otherKey = keyPair();

  function subject(extra: Parameters<typeof createBotAuth>[0]['config'] = {}) {
    const { emitter, events } = recorder();
    const fetchDirectory = fetcher({ 'https://agent.example': { body: directoryOf(agentKey) } });
    const botAuth = createBotAuth({ config: extra, emitter, now, fetchDirectory });
    return { botAuth, events, fetchDirectory };
  }

  it('verifies a signature against the key the agent publishes, and names the agent', async () => {
    const { botAuth, events, fetchDirectory } = subject();
    const check = await botAuth.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid }),
    );
    expect(check).toMatchObject({
      present: true,
      verdict: 'verified',
      agent: 'https://agent.example',
      keyid: agentKey.keyid,
      tag: 'web-bot-auth',
      nonce_present: true,
      components: ['"@authority"', '"signature-agent"'],
      directory_url: 'https://agent.example/.well-known/http-message-signatures-directory',
      cache: 'miss',
      reason: null,
    });
    expect(fetchDirectory.calls).toEqual([
      'https://agent.example/.well-known/http-message-signatures-directory',
    ]);
    expect(events).toEqual([
      {
        type: 'auth.directory.fetched',
        data: expect.objectContaining({ outcome: 'ok', status: 200, key_count: 1, ttl_s: 600 }),
      },
    ]);
  });

  it('reads the directory once per TTL, not once per request', async () => {
    const { botAuth, fetchDirectory } = subject();
    await botAuth.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid, nonce: 'bm9uY2UtQQ' }),
    );
    const second = await botAuth.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid, nonce: 'bm9uY2UtQg' }),
    );
    expect(second).toMatchObject({ verdict: 'verified', cache: 'hit' });
    expect(fetchDirectory.calls).toHaveLength(1);
  });

  it('accepts the dictionary form of Signature-Agent with ;key', async () => {
    const { botAuth } = subject();
    const check = await botAuth.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid, agentForm: 'dictionary' }),
    );
    expect(check).toMatchObject({
      verdict: 'verified',
      agent: 'https://agent.example',
      components: ['"@authority"', '"signature-agent";key="sig1"'],
    });
  });

  it('refuses a signature made with a key other than the one named', async () => {
    const { botAuth } = subject();
    const check = await botAuth.check(
      signedRequest({ key: otherKey.privateKey, keyid: agentKey.keyid }),
    );
    expect(check).toMatchObject({ verdict: 'invalid_signature' });
  });

  it('refuses a signature over another host', async () => {
    const { botAuth } = subject();
    const check = await botAuth.check(
      signedRequest({
        key: agentKey.privateKey,
        keyid: agentKey.keyid,
        signedHost: 'elsewhere.test',
      }),
    );
    expect(check?.verdict).toBe('invalid_signature');
  });

  it('names a key the directory does not publish', async () => {
    const { botAuth } = subject();
    const check = await botAuth.check(
      signedRequest({ key: otherKey.privateKey, keyid: otherKey.keyid }),
    );
    expect(check?.verdict).toBe('unknown_key');
  });

  it('refuses an expired signature and one from the future', async () => {
    const { botAuth } = subject();
    const expired = await botAuth.check(
      signedRequest({
        key: agentKey.privateKey,
        keyid: agentKey.keyid,
        created: NOW_S - 900,
        expires: NOW_S - 600,
      }),
    );
    expect(expired?.verdict).toBe('expired');
    const future = await botAuth.check(
      signedRequest({
        key: agentKey.privateKey,
        keyid: agentKey.keyid,
        created: NOW_S + 600,
        expires: NOW_S + 900,
      }),
    );
    expect(future?.verdict).toBe('not_yet_valid');
  });

  it('refuses a nonce seen inside its validity window', async () => {
    const { botAuth } = subject();
    const signed = signedRequest({
      key: agentKey.privateKey,
      keyid: agentKey.keyid,
      nonce: 'c2FtZQ',
    });
    expect((await botAuth.check(signed))?.verdict).toBe('verified');
    expect((await botAuth.check(signed))?.verdict).toBe('replayed');
  });

  it('calls a signature that does not cover Signature-Agent malformed, since the name is not bound', async () => {
    const { botAuth } = subject();
    const check = await botAuth.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid, coverAgent: false }),
    );
    expect(check).toMatchObject({ verdict: 'malformed' });
    expect(check?.reason).toContain('Signature-Agent is not covered');
  });

  it('calls a signature without expires malformed', async () => {
    const { botAuth } = subject();
    const check = await botAuth.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid, expires: null }),
    );
    expect(check?.verdict).toBe('malformed');
  });

  it('reports an unreadable directory, on the record', async () => {
    const { emitter, events } = recorder();
    const botAuth = createBotAuth({
      config: {},
      emitter,
      now,
      fetchDirectory: fetcher({ 'https://agent.example': { status: 404, body: 'nope' } }),
    });
    const check = await botAuth.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid }),
    );
    expect(check?.verdict).toBe('directory_unreachable');
    expect(events[0]).toMatchObject({
      type: 'auth.directory.fetched',
      data: { outcome: 'http_error', status: 404 },
    });
  });

  it('spends at most the hourly fetch budget', async () => {
    const { emitter, events } = recorder();
    const botAuth = createBotAuth({
      config: { botAuthMaxFetchesPerHour: 1 },
      emitter,
      now,
      fetchDirectory: fetcher({
        'https://agent.example': { body: directoryOf(agentKey) },
        'https://second.example': { body: directoryOf(agentKey) },
      }),
    });
    await botAuth.check(signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid }));
    const second = await botAuth.check(
      signedRequest({
        key: agentKey.privateKey,
        keyid: agentKey.keyid,
        agent: 'https://second.example',
      }),
    );
    expect(second?.verdict).toBe('directory_unreachable');
    expect(events.map((event) => event.data.outcome)).toEqual(['ok', 'rate_limited']);
  });

  it('answers undefined for an unsigned request, and records without checking when verify is off', async () => {
    const { botAuth } = subject();
    expect(
      await botAuth.check({
        method: 'GET',
        originalUrl: '/mcp',
        rawHeaders: ['Host', 'glassbank.test'],
      }),
    ).toBeUndefined();
    const { botAuth: off } = subject({ botAuthVerify: false });
    const check = await off.check(
      signedRequest({ key: agentKey.privateKey, keyid: agentKey.keyid }),
    );
    expect(check).toMatchObject({ verdict: 'not_checked', agent: 'https://agent.example' });
  });

  it('calls garbage in the signature headers malformed and never throws', async () => {
    const { botAuth } = subject();
    const check = await botAuth.check({
      method: 'POST',
      originalUrl: '/mcp',
      rawHeaders: [
        'Host',
        'glassbank.test',
        'Signature-Input',
        'sig1=("@authority"',
        'Signature',
        'sig1=:AA==:',
      ],
    });
    expect(check?.verdict).toBe('malformed');
  });
});

describe('the middleware', () => {
  /** A real server on an ephemeral port: the header is set on the wire, not on a mock. */
  async function call(
    challenge: 'off' | 'advertise',
    method: string,
    path: string,
  ): Promise<{ status: number; acceptSignature: string | null; check: unknown }> {
    const botAuth = createBotAuth({
      config: { botAuthChallenge: challenge },
      emitter: recorder().emitter,
      now,
    });
    const app = express();
    app.use(botAuth.middleware);
    app.use((req, res) => {
      res.json({ check: signatureCheckOf(req) ?? null });
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : '{}',
      });
      const body = (await response.json()) as { check: unknown };
      return {
        status: response.status,
        acceptSignature: response.headers.get('accept-signature'),
        check: body.check,
      };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('invites a signature on the MCP endpoints only, and changes no answer', async () => {
    const invited = await call('advertise', 'POST', '/mcp');
    expect(invited.status).toBe(200);
    expect(invited.acceptSignature).toBe(ACCEPT_SIGNATURE_VALUE);
    expect(invited.check).toMatchObject({
      present: false,
      verdict: 'unsigned',
      challenge_sent: true,
    });

    const publicLane = await call('advertise', 'POST', '/public/mcp');
    expect(publicLane.acceptSignature).toBe(ACCEPT_SIGNATURE_VALUE);

    const elsewhere = await call('advertise', 'GET', '/health');
    expect(elsewhere.acceptSignature).toBeNull();
    expect(elsewhere.check).toBeNull();
  });

  it('sends nothing and records nothing for an unsigned request when the challenge is off', async () => {
    const response = await call('off', 'POST', '/mcp');
    expect(response.acceptSignature).toBeNull();
    expect(response.check).toBeNull();
  });
});

describe('the fetch guard (invariant 14)', () => {
  it('fetches only from public addresses', () => {
    expect(isFetchableAddress('8.8.8.8', false)).toBe(true);
    expect(isFetchableAddress('2606:4700::1111', false)).toBe(true);
    for (const address of [
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
    ]) {
      expect(isFetchableAddress(address, false), address).toBe(false);
    }
    expect(isFetchableAddress('127.0.0.1', true)).toBe(true);
    expect(isFetchableAddress('10.1.2.3', true)).toBe(false);
  });

  it('derives the directory from the agent origin, https only', () => {
    expect(directoryUrlOf('https://chatgpt.com', false)?.toString()).toBe(
      'https://chatgpt.com/.well-known/http-message-signatures-directory',
    );
    expect(directoryUrlOf('signer.example/some/path', false)?.toString()).toBe(
      'https://signer.example/.well-known/http-message-signatures-directory',
    );
    expect(directoryUrlOf('http://127.0.0.1:9999', false)).toBeNull();
    expect(directoryUrlOf('http://127.0.0.1:9999', true)?.toString()).toBe(
      'http://127.0.0.1:9999/.well-known/http-message-signatures-directory',
    );
    expect(directoryUrlOf('https://user:pw@evil.example', false)).toBeNull();
  });

  it('refuses plain http and private literals before opening a socket', async () => {
    await expect(
      fetchDirectoryOverNetwork(new URL('http://agent.example/x'), {
        timeoutMs: 500,
        maxBytes: 100,
        allowLoopback: false,
      }),
    ).rejects.toMatchObject({ outcome: 'blocked' });
    await expect(
      fetchDirectoryOverNetwork(new URL('https://169.254.169.254/x'), {
        timeoutMs: 500,
        maxBytes: 100,
        allowLoopback: false,
      }),
    ).rejects.toMatchObject({ outcome: 'blocked' });
  });
});
