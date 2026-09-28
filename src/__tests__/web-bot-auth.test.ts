/**
 * Web Bot Auth through the whole graph (block: app, contracts v0.10, D-29).
 *
 * A signed `initialize` to `/public/mcp`, from a signer whose key directory is served on loopback
 * (`BOT_AUTH_ALLOW_LOOPBACK`, development only): the answer is the same as for an unsigned request,
 * it carries the `Accept-Signature` invitation, the request's `http.request` carries the verdict
 * `verified` with the agent's name, the directory fetch is on the record, and the public session
 * list names the verified agent. A tampered copy is answered identically and recorded as
 * `invalid_signature`: the check never gates.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { XraySessionsResponse } from '../contracts/index.js';
import { jwkThumbprint } from '../auth/index.js';
import { createGlassBank } from '../composition.js';
import { loadConfig } from '../config/index.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
const keyid = jwkThumbprint({ crv: 'Ed25519', kty: 'OKP', x });

let directory: Server;
let agent: string;
let baseUrl: string;
let host: string;
let server: Server;
const glassBank = createGlassBank(
  loadConfig({
    PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
    AUTH_DB_PATH: ':memory:',
    XRAY_DB_PATH: ':memory:',
    BOT_AUTH_CHALLENGE: 'advertise',
    BOT_AUTH_ALLOW_LOOPBACK: 'true',
  }),
  { bootId: 'boot_bot_auth_test', version: '0.1.0-test', quiet: true },
);

beforeAll(async () => {
  directory = createServer((request, response) => {
    if (request.url === '/.well-known/http-message-signatures-directory') {
      response.writeHead(200, {
        'content-type': 'application/http-message-signatures-directory+json',
        'cache-control': 'max-age=300',
      });
      response.end(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => directory.listen(0, '127.0.0.1', resolve));
  agent = `http://127.0.0.1:${(directory.address() as AddressInfo).port}`;
  server = glassBank.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  baseUrl = `http://${host}`;
});

afterAll(async () => {
  await glassBank.shutdown('shutdown');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => directory.close(() => resolve()));
});

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'signed-agent', version: '1.0.0' },
  },
});

/** The headers of a Web Bot Auth signature over the authority, method, path and agent name. */
function signatureHeaders(options: { authority: string; nonce: string }): Record<string, string> {
  const created = Math.floor(Date.now() / 1000);
  const inner = `("@authority" "@method" "@path" "signature-agent");created=${created};expires=${created + 60};keyid="${keyid}";nonce="${options.nonce}";tag="web-bot-auth"`;
  const base = [
    `"@authority": ${options.authority}`,
    '"@method": POST',
    '"@path": /public/mcp',
    `"signature-agent": "${agent}"`,
    `"@signature-params": ${inner}`,
  ].join('\n');
  return {
    'signature-agent': `"${agent}"`,
    'signature-input': `sig1=${inner}`,
    signature: `sig1=:${sign(null, Buffer.from(base, 'utf8'), privateKey).toString('base64')}:`,
  };
}

async function initialize(extra: Record<string, string>): Promise<Response> {
  return fetch(`${baseUrl}/public/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'SignedAgent/1.0',
      ...extra,
    },
    body: INITIALIZE,
  });
}

function signatureOfRequest(nonce: string): Record<string, unknown> | undefined {
  glassBank.xray.flush();
  const event = glassBank.xray.ring
    .last(500)
    .find(
      (candidate) =>
        candidate.type === 'http.request' &&
        JSON.stringify(candidate.data.raw?.headers ?? []).includes(`nonce=\\"${nonce}\\"`),
    );
  return event?.type === 'http.request'
    ? (event.data.signature as Record<string, unknown>)
    : undefined;
}

describe('Web Bot Auth on the public lane (D-29)', () => {
  it('verifies a real signature, invites one, and answers as it would anyway', async () => {
    const response = await initialize(
      signatureHeaders({ authority: host, nonce: 'bm9uY2UtdmVyaWZpZWQ' }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-signature')).toContain('tag="web-bot-auth"');
    expect(signatureOfRequest('bm9uY2UtdmVyaWZpZWQ')).toMatchObject({
      present: true,
      verdict: 'verified',
      agent,
      keyid,
      challenge_sent: true,
      cache: 'miss',
    });
    const fetched = glassBank.xray.ring
      .last(500)
      .filter((event) => event.type === 'auth.directory.fetched');
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.data).toMatchObject({ outcome: 'ok', key_count: 1, ttl_s: 300 });
  });

  it('records a tampered signature as invalid and still answers it', async () => {
    const response = await initialize(
      signatureHeaders({ authority: 'someone-else.example', nonce: 'bm9uY2UtdGFtcGVyZWQ' }),
    );
    expect(response.status).toBe(200);
    expect(signatureOfRequest('bm9uY2UtdGFtcGVyZWQ')).toMatchObject({
      verdict: 'invalid_signature',
      cache: 'hit',
    });
  });

  it('names the verified agent on the public session list', async () => {
    const response = await fetch(`${baseUrl}/xray/api/sessions?lane=public`);
    const body = (await response.json()) as XraySessionsResponse;
    const identities = body.data.map((session) => session.identity);
    expect(identities).toContainEqual(
      expect.objectContaining({
        signature_verdict: 'verified',
        signed_agent: agent,
        challenged: true,
      }),
    );
  });
});
