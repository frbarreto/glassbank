import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { loadConfig } from '../config/index.js';

const config = loadConfig({ ORIGIN_POLICY: 'log-only' });
const app = createApp(config, { bootId: 'boot_test', version: '0.1.0-test' });

let baseUrl: string;
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('GET /healthz', () => {
  it('answers 200 with the boot id, version and origin policy', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toBeTruthy();

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      boot_id: 'boot_test',
      version: '0.1.0-test',
      origin_policy: 'log-only',
    });
  });

  it('echoes an inbound request id', async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      headers: { 'x-request-id': 'req-from-the-proxy' },
    });
    expect(response.headers.get('x-request-id')).toBe('req-from-the-proxy');
  });
});

describe('placeholder dashboard', () => {
  it('serves the English "not built yet" page at /xray/', async () => {
    const response = await fetch(`${baseUrl}/xray/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('The dashboard is not built yet.');
  });

  it('serves the same placeholder without the trailing slash', async () => {
    const response = await fetch(`${baseUrl}/xray`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });
});

describe('unknown routes', () => {
  it('answers 404 with a JSON body', async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'not_found',
    });
  });
});

describe('trust proxy', () => {
  it('trusts exactly one hop, so a caller cannot pick its own req.ip', () => {
    // `true` would make Express take the leftmost X-Forwarded-For entry, which is whatever the
    // caller typed: every per-IP limit of invariant 14 was bypassable by rotating the header, and
    // the /24 provenance of invariant 11 was attacker-controlled. A fixed hop count takes the
    // entry the last trusted proxy appended instead.
    expect(app.get('trust proxy')).toBe(1);
  });

  it('keys req.ip on the entry the proxy appended, not the one the caller sent', async () => {
    const probe = express();
    probe.set('trust proxy', app.get('trust proxy') as number);
    probe.get('/ip', (request, response) => {
      response.status(200).json({ ip: request.ip });
    });
    const probeServer = probe.listen(0, '127.0.0.1');
    await new Promise((resolve) => probeServer.once('listening', resolve));
    const { port } = probeServer.address() as AddressInfo;
    try {
      const spoofed = await fetch(`http://127.0.0.1:${port}/ip`, {
        // What a caller behind one appending proxy produces: its own value first, the address the
        // proxy observed last.
        headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
      });
      expect(((await spoofed.json()) as { ip: string }).ip).toBe('198.51.100.7');
    } finally {
      await new Promise((resolve) => probeServer.close(resolve));
    }
  });
});

describe('the error handler', () => {
  it('answers 400 with the parser message for malformed JSON, never 500', async () => {
    const response = await fetch(`${baseUrl}/healthz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    // /healthz is GET-only, so this lands on the fallback parser and then the 404 - but the parse
    // error fires first and must carry its own status.
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'invalid_request',
    });
  });

  it('answers 413 for a body over the limit', async () => {
    const response = await fetch(`${baseUrl}/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1_500_000) }),
    });
    expect(response.status).toBe(413);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'payload_too_large',
    });
  });

  it('never echoes an internal error message', async () => {
    const boom = createApp(config, {
      bootId: 'boot_boom',
      version: 'x',
      xrayRouter: () => {
        throw new Error('a secret internal detail');
      },
    });
    const boomServer = boom.listen(0, '127.0.0.1');
    await new Promise((resolve) => boomServer.once('listening', resolve));
    const { port } = boomServer.address() as AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/xray`);
      expect(response.status).toBe(500);
      const body = (await response.json()) as { error_description: string };
      expect(body.error_description).toBe('Internal server error.');
      expect(body.error_description).not.toContain('secret');
    } finally {
      await new Promise((resolve) => boomServer.close(resolve));
    }
  });
});
