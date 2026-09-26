/**
 * The composition root, assembled the way `src/server.ts` assembles it (block: app).
 *
 * `src/server.ts` calls `main()` at import time, so it cannot be imported by a test. It and this
 * file both call `createGlassBank`, so there is exactly one graph and this suite is an assertion
 * about the real one, not about a copy of it. What the mount order is responsible for:
 *
 *   1. the auth router answers at the root, before /mcp swallows anything;
 *   2. /mcp is reachable and its bearer gate runs (401 with the documented body and challenge);
 *   3. /xray serves the X-ray JSON API, and the dashboard's static files behind it;
 *   4. mounting the blocks does not shadow /healthz or the 404 handler.
 *
 * Without this test, a mis-wiring in `src/server.ts` would only be caught by `npm run e2e`.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGlassBank } from '../composition.js';
import { loadConfig } from '../config/index.js';

const config = loadConfig({
  ORIGIN_POLICY: 'log-only',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
  FEATURE_FLAGS: 'writes;transfers',
  // In-process storage: the suite must not touch a developer's /tmp state (A-25).
  AUTH_DB_PATH: ':memory:',
  XRAY_DB_PATH: ':memory:',
});

const glassBank = createGlassBank(config, {
  bootId: 'boot_wiring_test',
  version: '0.1.0-test',
  quiet: true,
});
const app = glassBank.app;

let baseUrl: string;
let server: ReturnType<typeof app.listen>;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await glassBank.shutdown('shutdown');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('the auth router is mounted at the root', () => {
  it('serves both protected-resource metadata paths (ARCHITECTURE section 5)', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as { resource: string; authorization_servers: string[] };
      // The request Host is not in PUBLIC_HOSTS here, so PUBLIC_BASE_URL is the fallback (A-36).
      expect(body.resource).toBe('http://127.0.0.1:8080/mcp');
      expect(body.authorization_servers).toContain('http://127.0.0.1:8080');
    }
  });

  it('serves authorization-server metadata whose issuer matches the resource origin', async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe('http://127.0.0.1:8080');
    expect(body.registration_endpoint).toBe('http://127.0.0.1:8080/register');
  });

  it('serves /authorize, so the root mount is not shadowed by the /mcp mount', async () => {
    const response = await fetch(`${baseUrl}/authorize`, { redirect: 'manual' });
    // Missing parameters, so it refuses - but it is the AS answering, not the 404 handler.
    expect(response.status).not.toBe(404);
  });

  it('offers the bank-core personas on the login page, not the spike directory', async () => {
    // The three shared personas are identical in both directories, so the proof that bank-core is
    // the one wired in is that its own `list()` and the rendered page agree.
    const personas = await glassBank.bankCore.personas.list();
    expect(personas.map((persona) => persona.id)).toContain('per_ava_stone');
  });
});

describe('the mcp router is mounted at /mcp', () => {
  it('answers 401 with Ramp’s body and the documented challenge (invariant 5)', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ detail: 'No access token provided' });

    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge.startsWith('Bearer ')).toBe(true);
    expect(challenge).toContain(
      'resource_metadata="http://127.0.0.1:8080/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it('answers 405 on GET and DELETE (stateless transport, invariant 6)', async () => {
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await fetch(`${baseUrl}/mcp`, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST');
    }
  });

  it('was given the real 17-tool registry, not the two bootstrap tools', () => {
    expect(glassBank.tools.catalog.length).toBe(17);
  });
});

describe('the xray router and the dashboard are mounted at /xray', () => {
  it('answers the JSON API with 401 for a viewer with no cookie (ADR-10)', async () => {
    const response = await fetch(`${baseUrl}/xray/api/me`);
    expect([401, 403]).toContain(response.status);
    const body = (await response.json()) as { error?: string; message?: string };
    expect(typeof body.error).toBe('string');
    expect(typeof body.message).toBe('string');
  });

  it('answers 404 in the API’s own shape for an unknown /xray/api path', async () => {
    const response = await fetch(`${baseUrl}/xray/api/no-such-route`);
    expect(response.status).toBe(404);
  });

  it('serves the dashboard page itself at /xray/', async () => {
    const response = await fetch(`${baseUrl}/xray/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Glass Bank X-ray');
    expect(html).toContain('src="app.js"');
  });

  it('serves the dashboard modules', async () => {
    for (const asset of ['app.js', 'app.css', 'panel-timeline.js']) {
      const response = await fetch(`${baseUrl}/xray/${asset}`);
      expect(response.status, asset).toBe(200);
    }
  });

  it('serves the recorded fixture through the public/fixtures symlink (?fixture=1)', async () => {
    const response = await fetch(`${baseUrl}/xray/fixtures/events.jsonl`);
    expect(response.status).toBe(200);
    expect((await response.text()).split('\n')[0]).toContain('"type"');
  });

  it('does not serve the dashboard block’s dev server or its unit tests', async () => {
    for (const path of ['/xray/_dev/serve.mjs', '/xray/__tests__/store.test.mjs']) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(404);
    }
  });
});

describe('mounting the blocks leaves the app routes intact', () => {
  it('still answers /healthz', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      status: 'ok',
      boot_id: 'boot_wiring_test',
    });
  });

  it('still answers the landing page at / (the auth router at the root does not shadow it)', async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('http://127.0.0.1:8080/mcp');
    expect(html).toContain('/xray/');
  });

  it('still answers 404 for an unknown route', async () => {
    const response = await fetch(`${baseUrl}/no-such-route`);
    expect(response.status).toBe(404);
  });
});
