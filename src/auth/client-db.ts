/**
 * The DCR client table (block: auth).
 *
 * One SQLite file at `AUTH_DB_PATH` (`/tmp/auth.sqlite`), holding exactly what RFC 7591 gave us:
 * `client_id`, `client_name`, `redirect_uris`, `token_endpoint_auth_method` and the echoed
 * metadata. It exists for one reason (A-12): without it a restart makes every registered client
 * unknown, and the A-12 reconstruction path rebuilds it with *only* the claude.ai callback plus
 * the bare loopback URIs - which breaks every client that registered a ported loopback (the MCP
 * Inspector, Claude Code, VS Code) and loses `client_name`, so the dashboard shows
 * "unknown (reconstructed)" for a connector the user registered ten minutes ago.
 *
 * Durability is the event log's (A-25): it survives a process restart locally and on a VM, not a
 * Cloud Run instance replacement. That is enough, because reconstruction is still the fallback.
 *
 * `src/auth` is one of the three blocks allowed to import `better-sqlite3` (docs/REPO_LAYOUT.md
 * section 3). Every call is wrapped: a client table that fails must degrade to the in-memory LRU,
 * never take an OAuth endpoint down with it (invariant 5 outranks invariant 13).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import type { RegisteredClient } from './clients.js';

/** How many consecutive failures put the table into `degraded` mode and stop the writes. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** The persistence seam `createClientStore` writes through. Never throws. */
export interface ClientPersistence {
  /** True when nothing is stored (no SQLite, or too many consecutive failures). */
  readonly degraded: boolean;
  readonly path: string;
  /** The `limit` most recently seen clients, **oldest first**, ready to seed an LRU. */
  load(limit: number): RegisteredClient[];
  get(clientId: string): RegisteredClient | null;
  save(client: RegisteredClient, lastSeenAtMs: number): void;
  /** Marks a client as recently used, so pruning drops the genuinely cold rows first. */
  touch(clientId: string, lastSeenAtMs: number): void;
  /** Keeps at most `keep` rows, dropping the least recently seen. Returns how many went. */
  prune(keep: number): number;
  count(): number;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  application_type TEXT,
  grant_types TEXT NOT NULL,
  response_types TEXT NOT NULL,
  scope TEXT,
  client_id_issued_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS clients_last_seen ON clients (last_seen_at);
`;

interface Row {
  readonly client_id: string;
  readonly client_name: string | null;
  readonly redirect_uris: string;
  readonly token_endpoint_auth_method: string;
  readonly application_type: string | null;
  readonly grant_types: string;
  readonly response_types: string;
  readonly scope: string | null;
  readonly client_id_issued_at: number;
}

function parseStringArray(value: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') return null;
    out.push(item);
  }
  return out;
}

/**
 * One stored row back into a `RegisteredClient`. A row that no longer parses is dropped rather
 * than half-restored: an unparseable `redirect_uris` would otherwise widen or empty the callback
 * allowlist for that client, and the allowlist is the security boundary (A-12).
 */
function parseRow(row: Row): RegisteredClient | null {
  const redirectUris = parseStringArray(row.redirect_uris);
  const grantTypes = parseStringArray(row.grant_types);
  const responseTypes = parseStringArray(row.response_types);
  if (redirectUris === null || redirectUris.length === 0) return null;
  if (grantTypes === null || responseTypes === null) return null;
  return {
    client_id: row.client_id,
    client_name: row.client_name,
    redirect_uris: redirectUris,
    // Only public clients are ever registered, and a row that claims otherwise is not trusted
    // to change that: /register refuses anything but "none" (A-12).
    token_endpoint_auth_method: 'none',
    reconstructed: false,
    client_id_issued_at: row.client_id_issued_at,
    application_type: row.application_type,
    grant_types: grantTypes,
    response_types: responseTypes,
    scope: row.scope,
  };
}

/** A persistence that stores nothing: the fallback when SQLite cannot be opened at all. */
export function createNullClientPersistence(path = 'disabled'): ClientPersistence {
  return {
    degraded: true,
    path,
    load() {
      return [];
    },
    get() {
      return null;
    },
    save() {},
    touch() {},
    prune() {
      return 0;
    },
    count() {
      return 0;
    },
    close() {},
  };
}

export interface ClientPersistenceOptions {
  readonly path: string;
  /** Called with every swallowed failure, so the composition root can see a broken table. */
  readonly onError?: (error: unknown, operation: string) => void;
}

/** Opens (or creates) the client table. Never throws: a failure returns the null persistence. */
export function createClientPersistence(options: ClientPersistenceOptions): ClientPersistence {
  const { path } = options;
  const onError = options.onError ?? (() => {});

  let database: Database.Database;
  try {
    if (path !== ':memory:' && !path.startsWith('file:')) {
      try {
        mkdirSync(dirname(path), { recursive: true });
      } catch {
        // A directory that already exists, or one we may not create: `new Database` decides.
      }
    }
    database = new Database(path);
    // WAL so a read (an /authorize hydration) never blocks a write (a /register).
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.exec(SCHEMA);
  } catch (error) {
    onError(error, 'open');
    return createNullClientPersistence(path);
  }

  const COLUMNS =
    'client_id, client_name, redirect_uris, token_endpoint_auth_method, application_type, ' +
    'grant_types, response_types, scope, client_id_issued_at';

  const selectRecent = database.prepare(
    `SELECT ${COLUMNS} FROM clients ORDER BY last_seen_at DESC, rowid DESC LIMIT ?`,
  );
  const selectOne = database.prepare(`SELECT ${COLUMNS} FROM clients WHERE client_id = ?`);
  const upsert = database.prepare(
    'INSERT OR REPLACE INTO clients (client_id, client_name, redirect_uris, ' +
      'token_endpoint_auth_method, application_type, grant_types, response_types, scope, ' +
      'client_id_issued_at, last_seen_at) VALUES (@client_id, @client_name, @redirect_uris, ' +
      '@token_endpoint_auth_method, @application_type, @grant_types, @response_types, @scope, ' +
      '@client_id_issued_at, @last_seen_at)',
  );
  const touchOne = database.prepare('UPDATE clients SET last_seen_at = ? WHERE client_id = ?');
  const pruneTo = database.prepare(
    'DELETE FROM clients WHERE client_id NOT IN ' +
      '(SELECT client_id FROM clients ORDER BY last_seen_at DESC, rowid DESC LIMIT ?)',
  );
  const countAll = database.prepare('SELECT COUNT(*) AS n FROM clients');

  let failures = 0;
  let degraded = false;

  function guard<T>(operation: string, fallback: T, body: () => T): T {
    if (degraded) return fallback;
    try {
      const result = body();
      failures = 0;
      return result;
    } catch (error) {
      failures += 1;
      onError(error, operation);
      if (failures >= MAX_CONSECUTIVE_FAILURES) degraded = true;
      return fallback;
    }
  }

  return {
    get degraded() {
      return degraded;
    },
    path,

    load(limit: number): RegisteredClient[] {
      return guard('load', [], () => {
        const rows = selectRecent.all(Math.max(1, limit)) as Row[];
        const clients: RegisteredClient[] = [];
        // Newest first out of SQL, reversed so the caller's LRU ends up with the most recently
        // seen client as its most recently used entry.
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index];
          if (row === undefined) continue;
          const client = parseRow(row);
          if (client !== null) clients.push(client);
        }
        return clients;
      });
    },

    get(clientId: string): RegisteredClient | null {
      return guard('get', null, () => {
        const row = selectOne.get(clientId) as Row | undefined;
        return row === undefined ? null : parseRow(row);
      });
    },

    save(client: RegisteredClient, lastSeenAtMs: number): void {
      guard('save', undefined, () => {
        upsert.run({
          client_id: client.client_id,
          client_name: client.client_name,
          redirect_uris: JSON.stringify(client.redirect_uris),
          token_endpoint_auth_method: client.token_endpoint_auth_method,
          application_type: client.application_type,
          grant_types: JSON.stringify(client.grant_types),
          response_types: JSON.stringify(client.response_types),
          scope: client.scope,
          client_id_issued_at: client.client_id_issued_at,
          last_seen_at: lastSeenAtMs,
        });
      });
    },

    touch(clientId: string, lastSeenAtMs: number): void {
      guard('touch', undefined, () => {
        touchOne.run(lastSeenAtMs, clientId);
      });
    },

    prune(keep: number): number {
      return guard('prune', 0, () => {
        const result = pruneTo.run(Math.max(1, keep));
        return result.changes;
      });
    },

    count(): number {
      return guard('count', 0, () => {
        const row = countAll.get() as { n: number } | undefined;
        return row?.n ?? 0;
      });
    },

    close(): void {
      guard('close', undefined, () => {
        database.close();
      });
      degraded = true;
    },
  };
}
