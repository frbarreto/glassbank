/**
 * The DCR client table at `AUTH_DB_PATH` (A-12, docs/ARCHITECTURE.md section 5).
 *
 * The point of the table is one sentence: a restart must not turn a client the user registered
 * ten minutes ago into "unknown (reconstructed)" with only the bare loopback callback. The
 * restart is simulated the honest way - a second `createAuth` over the same file, after the first
 * has closed its handle - because that is what `npm start` does after a redeploy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OAUTH_ROUTES, RECONSTRUCTED_CLIENT_REDIRECT_URIS } from '../../contracts/index.js';
import { createClientPersistence, createNullClientPersistence } from '../client-db.js';
import { PERSISTED_CLIENT_CAPACITY_MULTIPLIER, createClientStore } from '../clients.js';

import { registerTestClient, startAuthHarness, type Harness } from './harness.js';

const directories: string[] = [];
const openHarnesses: Harness[] = [];

function tempDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'glass-bank-auth-'));
  directories.push(directory);
  return join(directory, 'auth.sqlite');
}

async function start(authDbPath: string): Promise<Harness> {
  const harness = await startAuthHarness({ authDbPath, maxDcrClients: 5 });
  openHarnesses.push(harness);
  return harness;
}

afterEach(async () => {
  while (openHarnesses.length > 0) {
    const harness = openHarnesses.pop();
    if (harness !== undefined) await harness.close();
  }
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

const LOOPBACK_WITH_PORT = 'http://127.0.0.1:7777/callback';

describe('the DCR store across a restart (A-12)', () => {
  it('keeps client_name and the registered callback when the process comes back', async () => {
    const path = tempDbPath();
    const first = await start(path);
    const clientId = await registerTestClient(first, LOOPBACK_WITH_PORT, 'Claude Code');
    expect(first.auth.clients.persistenceDegraded).toBe(false);
    await first.close();
    openHarnesses.pop();

    const second = await start(path);
    const resolved = second.auth.clients.resolve(clientId);

    expect(resolved.reconstructed).toBe(false);
    expect(resolved.client.client_name).toBe('Claude Code');
    // The ported loopback is exactly what reconstruction loses, and what breaks Claude Code.
    expect(resolved.client.redirect_uris).toEqual([LOOPBACK_WITH_PORT]);
    expect(RECONSTRUCTED_CLIENT_REDIRECT_URIS).not.toContain(LOOPBACK_WITH_PORT);
  });

  it('lets /authorize continue after a restart without emitting client.reconstructed', async () => {
    const path = tempDbPath();
    const first = await start(path);
    const clientId = await registerTestClient(first, LOOPBACK_WITH_PORT, 'Claude Code');
    await first.close();
    openHarnesses.pop();

    const second = await start(path);
    const page = await second.fetch(
      `${OAUTH_ROUTES.authorize}?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(LOOPBACK_WITH_PORT)}` +
        '&code_challenge=abcdefghijklmnopqrstuvwxyz012345&code_challenge_method=S256',
    );

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Claude Code');
    expect(second.emitter.ofType('auth.client.reconstructed')).toHaveLength(0);
  });

  it('still reconstructs a client id neither the LRU nor the table knows', async () => {
    const path = tempDbPath();
    const harness = await start(path);
    const resolved = harness.auth.clients.resolve('mcpb_never_seen');

    expect(resolved.reconstructed).toBe(true);
    expect(resolved.client.redirect_uris).toEqual(RECONSTRUCTED_CLIENT_REDIRECT_URIS);
    // And it is not written back, to either layer: /authorize resolves any id a stranger types.
    expect(harness.auth.clients.persistedSize).toBe(0);
    expect(harness.auth.clients.size).toBe(0);
  });

  it('serves a client the in-memory LRU has evicted from SQLite instead of rebuilding it', () => {
    const path = tempDbPath();
    const persistence = createClientPersistence({ path });
    let counter = 0;
    const store = createClientStore({
      capacity: 2,
      allowDevLoopback: true,
      persistence,
      newClientId: () => `mcpb_client_${(counter += 1)}`,
    });

    for (let index = 0; index < 3; index += 1) {
      const result = store.register({
        client_name: `Client ${index}`,
        redirect_uris: [`http://127.0.0.1:${7000 + index}/callback`],
      });
      expect(result.ok).toBe(true);
    }

    expect(store.size).toBe(2);
    const evicted = store.resolve('mcpb_client_1');
    expect(evicted.reconstructed).toBe(false);
    expect(evicted.client.client_name).toBe('Client 0');
    store.close();
  });

  it('keeps the table bounded at a multiple of MAX_DCR_CLIENTS (ADR-16)', () => {
    const path = tempDbPath();
    let counter = 0;
    const store = createClientStore({
      capacity: 3,
      allowDevLoopback: true,
      persistence: createClientPersistence({ path }),
      newClientId: () => `mcpb_client_${(counter += 1)}`,
    });

    for (let index = 0; index < 40; index += 1) {
      store.register({ redirect_uris: [`http://127.0.0.1:${7000 + index}/callback`] });
    }

    expect(store.persistedSize).toBe(3 * PERSISTED_CLIENT_CAPACITY_MULTIPLIER);
    expect(store.size).toBe(3);
    store.close();
  });

  it('degrades to memory when the file cannot be opened, instead of failing /register', async () => {
    // A directory, not a file: `new Database` throws, and the store has to keep working.
    const directory = mkdtempSync(join(tmpdir(), 'glass-bank-auth-'));
    directories.push(directory);
    const failures: string[] = [];
    const harness = await startAuthHarness(
      { authDbPath: directory },
      { log: (record) => failures.push(record.event) },
    );
    openHarnesses.push(harness);

    const clientId = await registerTestClient(harness);

    expect(harness.auth.clients.persistenceDegraded).toBe(true);
    expect(failures).toContain('auth.client_store_failed');
    // Memory still works, so the walk a user is in the middle of does not break.
    expect(harness.auth.clients.resolve(clientId).reconstructed).toBe(false);
  });

  it('drops a row whose redirect_uris no longer parse rather than half-restoring it', () => {
    // The callback allowlist is the security boundary (A-12); a corrupt row must not widen it.
    const path = tempDbPath();
    const persistence = createClientPersistence({ path });
    persistence.save(
      {
        client_id: 'mcpb_corrupt',
        client_name: 'Corrupt',
        redirect_uris: [] as unknown as readonly string[],
        token_endpoint_auth_method: 'none',
        reconstructed: false,
        client_id_issued_at: 1,
        application_type: null,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        scope: null,
      },
      1,
    );

    expect(persistence.count()).toBe(1);
    expect(persistence.get('mcpb_corrupt')).toBeNull();
    expect(persistence.load(10)).toEqual([]);
    persistence.close();
  });

  it('has a null persistence that stores nothing and never throws', () => {
    const persistence = createNullClientPersistence();
    expect(persistence.degraded).toBe(true);
    expect(persistence.load(10)).toEqual([]);
    expect(persistence.get('anything')).toBeNull();
    expect(persistence.prune(1)).toBe(0);
    expect(persistence.count()).toBe(0);
    persistence.save(
      {
        client_id: 'x',
        client_name: null,
        redirect_uris: ['http://127.0.0.1/callback'],
        token_endpoint_auth_method: 'none',
        reconstructed: false,
        client_id_issued_at: 1,
        application_type: null,
        grant_types: [],
        response_types: [],
        scope: null,
      },
      1,
    );
    expect(persistence.count()).toBe(0);
    persistence.close();
  });
});
