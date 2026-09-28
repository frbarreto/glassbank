/**
 * The append-only event log (block: xray).
 *
 * One SQLite file at `XRAY_DB_PATH` (`/tmp/xray.sqlite`, memory-backed on Cloud Run, A-25) in WAL
 * mode: replay for `Last-Event-ID`, the paged history of the call inspector, the counters of the
 * read model, and the `max(id)` that keeps event ids monotonic across a restart
 * (docs/XRAY_EVENT_MODEL.md sections 2 and 5).
 *
 * `src/xray` is one of the three blocks allowed to import `better-sqlite3`
 * (docs/REPO_LAYOUT.md section 3). Every call is wrapped: a log that fails must degrade the
 * X-ray, never a tool call (CLAUDE.md invariant 13 does not outrank invariant 5).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import Database from 'better-sqlite3';

import {
  XrayEnvelopeSchema,
  XrayEventSchema,
  type XrayEvent,
} from '../contracts/index.js';

/** How many consecutive failures put the log into `degraded` mode and stop the writes. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** The scope a replay or a listing is filtered by; the JS predicate stays the authority. */
export interface LogFilter {
  readonly kind: 'all' | 'login' | 'xs';
  readonly loginId?: string | null;
  readonly xs?: string | null;
  /** Grants of the viewer's login, for the coarse SQL filter. */
  readonly grantIds?: readonly string[];
  /** Sessions of the viewer's login, for the coarse SQL filter. */
  readonly sessionIds?: readonly string[];
}

export interface EventLog {
  /** True when the log is a no-op (no SQLite, or too many failures). */
  readonly degraded: boolean;
  readonly path: string;
  append(events: readonly XrayEvent[]): void;
  maxId(): number;
  /** `xs -> max(seq)` for the most recent sessions, so `seq` continues after a restart. */
  seqByXs(limit?: number): Map<string, number>;
  readAfter(afterId: number, limit: number, filter: LogFilter): XrayEvent[];
  readLast(limit: number, filter: LogFilter): XrayEvent[];
  readSession(xs: string, afterId: number, limit: number): XrayEvent[];
  readById(id: number): XrayEvent | null;
  /**
   * v0.10 (D-32): the few fields the overview counts, extracted inside SQLite (`json_extract`) so a
   * scan never parses the raw request bodies. Rows of `OVERVIEW_TYPES` only, `ts_ms >= sinceMs`,
   * `id > afterId`, oldest first. `matchesScope` in the read model stays the authority.
   */
  readOverviewRows(sinceMs: number, afterId: number, limit: number, filter: LogFilter): OverviewRow[];
  /** The oldest timestamp the log holds for the filter, `null` when it holds nothing. */
  oldestTs(filter: LogFilter): string | null;
  /** The most recent `limit` events, oldest first: what the read model is rebuilt from. */
  recent(limit: number): XrayEvent[];
  count(): number;
  /** Deletes events older than the cutoff and returns how many rows went. */
  deleteOlderThan(cutoffMs: number): number;
  /**
   * Erases every event the filter selects and answers how many rows went (v0.4). It reuses the
   * read filter, so a viewer erases exactly the set it was allowed to read - nothing wider.
   */
  deleteMatching(filter: LogFilter): number;
  /** Deletes the oldest rows until at most `maxRows` remain; returns how many rows went. */
  trimToMaxRows(maxRows: number): number;
  /** v0.9 (D-28): the UTF-8 size of every stored envelope together. */
  storedBytes(): number;
  /**
   * v0.9 (D-28): deletes the oldest whole events until the stored envelopes fit in `maxBytes`;
   * the newest event always stays. Returns how many rows went.
   */
  trimToMaxBytes(maxBytes: number): number;
  /**
   * Gives freed pages back to the filesystem. Time-based retention alone never shrinks the file,
   * and on Cloud Run gen2 `/tmp` is memory-backed (A-25, docs/DEPLOYMENT.md), so a deleted row
   * that keeps its page is still a page of RAM.
   */
  reclaim(): void;
  /** Page size, page count and free pages: the real footprint, for `XrayStats`. */
  fileStats(): { readonly pageSize: number; readonly pageCount: number; readonly freePages: number };
  close(): void;
}

/** The event types the overview reads (v0.10, D-32). */
export const OVERVIEW_TYPES = [
  'http.request',
  'session.started',
  'session.initialized',
  'tool.call.started',
  'tool.call.completed',
  'tool.call.denied',
  'protocol.error',
] as const;

/** One event as the overview sees it: the envelope's correlation and a handful of data fields. */
export interface OverviewRow {
  readonly id: number;
  readonly ts: string;
  readonly type: string;
  readonly xs: string | null;
  readonly login_id: string | null;
  readonly grant_id: string | null;
  readonly request_id: string | null;
  readonly client_name: string | null;
  readonly client_version: string | null;
  readonly tool: string | null;
  readonly duration_ms: number | null;
  readonly is_error: boolean | null;
  readonly status: number | null;
  readonly rate_limited: boolean | null;
  readonly user_agent: string | null;
  readonly anthropic_egress: boolean | null;
  readonly sig_present: boolean | null;
  readonly sig_verdict: string | null;
  readonly sig_agent: string | null;
  readonly rationale_present: boolean | null;
  readonly denied_reason: string | null;
  readonly error_message: string | null;
  /** `tool.call.started` only: the arguments object as stored. */
  readonly arguments: Record<string, unknown> | null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asFlag(value: unknown): boolean | null {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

/** The same row, read from an event in memory (the ring, when the log is degraded). */
export function overviewRowOf(event: XrayEvent): OverviewRow {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const signature = (data.signature ?? null) as Record<string, unknown> | null;
  const error = (data.error ?? null) as Record<string, unknown> | null;
  const args = data.arguments;
  return {
    id: event.id,
    ts: event.ts,
    type: event.type,
    xs: event.xs ?? null,
    login_id: event.login_id ?? null,
    grant_id: event.grant_id ?? null,
    request_id: event.request_id ?? null,
    client_name: asText(event.client?.name),
    client_version: asText(event.client?.version),
    tool: asText(data.tool),
    duration_ms: asNumber(data.duration_ms),
    is_error: asFlag(data.is_error),
    status: asNumber(data.status),
    rate_limited: asFlag(data.rate_limited),
    user_agent: asText(data.user_agent),
    anthropic_egress: asFlag(data.anthropic_egress),
    sig_present: asFlag(signature?.present),
    sig_verdict: asText(signature?.verdict),
    sig_agent: asText(signature?.agent),
    rationale_present: asFlag(data.rationale_present),
    denied_reason: asText(data.denied_reason),
    error_message:
      event.type === 'protocol.error' ? asText(data.message) : asText(error?.message),
    arguments:
      event.type === 'tool.call.started' && args !== null && typeof args === 'object' && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : null,
  };
}

const OVERVIEW_COLUMNS = `id, ts, type, xs, login_id, grant_id,
  json_extract(envelope, '$.request_id') AS request_id,
  json_extract(envelope, '$.client.name') AS client_name,
  json_extract(envelope, '$.client.version') AS client_version,
  json_extract(envelope, '$.data.tool') AS tool,
  json_extract(envelope, '$.data.duration_ms') AS duration_ms,
  json_extract(envelope, '$.data.is_error') AS is_error,
  json_extract(envelope, '$.data.status') AS status,
  json_extract(envelope, '$.data.rate_limited') AS rate_limited,
  json_extract(envelope, '$.data.user_agent') AS user_agent,
  json_extract(envelope, '$.data.anthropic_egress') AS anthropic_egress,
  json_extract(envelope, '$.data.signature.present') AS sig_present,
  json_extract(envelope, '$.data.signature.verdict') AS sig_verdict,
  json_extract(envelope, '$.data.signature.agent') AS sig_agent,
  json_extract(envelope, '$.data.rationale_present') AS rationale_present,
  json_extract(envelope, '$.data.denied_reason') AS denied_reason,
  CASE type
    WHEN 'protocol.error' THEN json_extract(envelope, '$.data.message')
    WHEN 'tool.call.completed' THEN json_extract(envelope, '$.data.error.message')
  END AS error_message,
  CASE type WHEN 'tool.call.started' THEN json_extract(envelope, '$.data.arguments') END AS arguments`;

function overviewRowFromSql(row: Record<string, unknown>): OverviewRow {
  let args: Record<string, unknown> | null = null;
  if (typeof row.arguments === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.arguments);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = null;
    }
  }
  return {
    id: Number(row.id),
    ts: String(row.ts),
    type: String(row.type),
    xs: asText(row.xs),
    login_id: asText(row.login_id),
    grant_id: asText(row.grant_id),
    request_id: row.request_id === null || row.request_id === undefined ? null : String(row.request_id),
    client_name: asText(row.client_name),
    client_version: asText(row.client_version),
    tool: asText(row.tool),
    duration_ms: asNumber(row.duration_ms),
    is_error: asFlag(row.is_error),
    status: asNumber(row.status),
    rate_limited: asFlag(row.rate_limited),
    user_agent: asText(row.user_agent),
    anthropic_egress: asFlag(row.anthropic_egress),
    sig_present: asFlag(row.sig_present),
    sig_verdict: asText(row.sig_verdict),
    sig_agent: asText(row.sig_agent),
    rationale_present: asFlag(row.rationale_present),
    denied_reason: asText(row.denied_reason),
    error_message: asText(row.error_message),
    arguments: args,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  ts_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  xs TEXT,
  login_id TEXT,
  grant_id TEXT,
  seq INTEGER,
  envelope TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_xs_id ON events (xs, id);
CREATE INDEX IF NOT EXISTS events_login_id ON events (login_id, id);
CREATE INDEX IF NOT EXISTS events_grant_id ON events (grant_id, id);
CREATE INDEX IF NOT EXISTS events_ts_ms ON events (ts_ms);
`;

interface Row {
  readonly envelope: string;
}

/** Parses one stored row. The strict schema first, the forward-compatible envelope as fallback. */
function parseRow(row: Row): XrayEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(row.envelope);
  } catch {
    return null;
  }
  const strict = XrayEventSchema.safeParse(value);
  if (strict.success) return strict.data;
  const lenient = XrayEnvelopeSchema.safeParse(value);
  return lenient.success ? (lenient.data as unknown as XrayEvent) : null;
}

/** A log that stores nothing: the fallback when SQLite cannot be opened at all. */
export function createNullEventLog(path = 'disabled'): EventLog {
  return {
    degraded: true,
    path,
    append() {},
    maxId() {
      return 0;
    },
    seqByXs() {
      return new Map();
    },
    readAfter() {
      return [];
    },
    readLast() {
      return [];
    },
    readSession() {
      return [];
    },
    readById() {
      return null;
    },
    readOverviewRows() {
      return [];
    },
    oldestTs() {
      return null;
    },
    recent() {
      return [];
    },
    count() {
      return 0;
    },
    deleteOlderThan() {
      return 0;
    },
    deleteMatching() {
      return 0;
    },
    trimToMaxRows() {
      return 0;
    },
    storedBytes() {
      return 0;
    },
    trimToMaxBytes() {
      return 0;
    },
    reclaim() {},
    fileStats() {
      return { pageSize: 0, pageCount: 0, freePages: 0 };
    },
    close() {},
  };
}

export interface EventLogOptions {
  readonly path: string;
  /** Called with every swallowed failure, so the composition root can see a broken log. */
  readonly onError?: (error: unknown, operation: string) => void;
}

/** Bounds every `IN (...)` list the coarse SQL filter builds. */
const MAX_IN_LIST = 400;

/** Opens (or creates) the WAL event log. Never throws: a failure returns the null log. */
export function createEventLog(options: EventLogOptions): EventLog {
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
    // INCREMENTAL auto-vacuum must be set before the first table exists, so it goes first: it is
    // what makes `reclaim()` able to hand pages back without a full VACUUM. On a pre-existing file
    // created without it this is a no-op and `reclaim()` falls back to VACUUM.
    database.pragma('auto_vacuum = INCREMENTAL');
    // WAL keeps a reader (a replay) from blocking the writer (a producer).
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.exec(SCHEMA);
  } catch (error) {
    onError(error, 'open');
    return createNullEventLog(path);
  }

  const insert = database.prepare(
    'INSERT OR REPLACE INTO events (id, ts, ts_ms, type, xs, login_id, grant_id, seq, envelope) ' +
      'VALUES (@id, @ts, @ts_ms, @type, @xs, @login_id, @grant_id, @seq, @envelope)',
  );
  /** Recounted from the table after a delete; kept current on append in between. */
  const sumBytes = database.prepare(
    'SELECT COALESCE(SUM(length(CAST(envelope AS BLOB))), 0) AS value FROM events',
  );
  let totalBytes = (sumBytes.get() as { value: number } | undefined)?.value ?? 0;
  const recount = (): void => {
    totalBytes = (sumBytes.get() as { value: number } | undefined)?.value ?? 0;
  };

  const insertMany = database.transaction((events: readonly XrayEvent[]) => {
    for (const event of events) {
      const envelope = JSON.stringify(event);
      totalBytes += Buffer.byteLength(envelope);
      insert.run({
        id: event.id,
        ts: event.ts,
        ts_ms: Date.parse(event.ts) || 0,
        type: event.type,
        xs: event.xs,
        login_id: event.login_id,
        grant_id: event.grant_id,
        seq: event.seq,
        envelope,
      });
    }
  });

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

  /** The coarse SQL filter. `matchesScope` in the read model remains the authority. */
  function whereFor(filter: LogFilter): { sql: string; parameters: unknown[] } {
    if (filter.kind === 'xs') {
      return { sql: ' AND xs = ?', parameters: [filter.xs ?? ''] };
    }
    if (filter.kind === 'login') {
      const sessions = (filter.sessionIds ?? []).slice(0, MAX_IN_LIST);
      const grants = (filter.grantIds ?? []).slice(0, MAX_IN_LIST);
      const clauses = ['login_id = ?'];
      const parameters: unknown[] = [filter.loginId ?? ''];
      if (sessions.length > 0) {
        clauses.push(`xs IN (${sessions.map(() => '?').join(',')})`);
        parameters.push(...sessions);
      }
      if (grants.length > 0) {
        clauses.push(`grant_id IN (${grants.map(() => '?').join(',')})`);
        parameters.push(...grants);
      }
      return { sql: ` AND (${clauses.join(' OR ')})`, parameters };
    }
    return { sql: '', parameters: [] };
  }

  function query(sql: string, parameters: readonly unknown[]): XrayEvent[] {
    const rows = database.prepare(sql).all(...parameters) as Row[];
    const events: XrayEvent[] = [];
    for (const row of rows) {
      const event = parseRow(row);
      if (event) events.push(event);
    }
    return events;
  }

  return {
    get degraded() {
      return degraded;
    },
    path,

    append(events) {
      if (events.length === 0) return;
      guard('append', undefined, () => insertMany(events));
    },

    maxId() {
      return guard('maxId', 0, () => {
        const row = database.prepare('SELECT MAX(id) AS value FROM events').get() as
          | { value: number | null }
          | undefined;
        return row?.value ?? 0;
      });
    },

    seqByXs(limit = 2000) {
      return guard('seqByXs', new Map<string, number>(), () => {
        const rows = database
          .prepare(
            'SELECT xs, MAX(seq) AS seq, MAX(id) AS last_id FROM events ' +
              'WHERE xs IS NOT NULL GROUP BY xs ORDER BY last_id DESC LIMIT ?',
          )
          .all(limit) as { xs: string; seq: number | null }[];
        const result = new Map<string, number>();
        for (const row of rows) result.set(row.xs, row.seq ?? 0);
        return result;
      });
    },

    readAfter(afterId, limit, filter) {
      return guard('readAfter', [], () => {
        const where = whereFor(filter);
        return query(
          `SELECT envelope FROM events WHERE id > ?${where.sql} ORDER BY id ASC LIMIT ?`,
          [afterId, ...where.parameters, limit],
        );
      });
    },

    readLast(limit, filter) {
      return guard('readLast', [], () => {
        const where = whereFor(filter);
        const events = query(
          `SELECT envelope FROM events WHERE 1 = 1${where.sql} ORDER BY id DESC LIMIT ?`,
          [...where.parameters, limit],
        );
        return events.reverse();
      });
    },

    readSession(xs, afterId, limit) {
      return guard('readSession', [], () =>
        query('SELECT envelope FROM events WHERE xs = ? AND id > ? ORDER BY id ASC LIMIT ?', [
          xs,
          afterId,
          limit,
        ]),
      );
    },

    readById(id) {
      return guard('readById', null, () => {
        const row = database.prepare('SELECT envelope FROM events WHERE id = ?').get(id) as
          | Row
          | undefined;
        return row ? parseRow(row) : null;
      });
    },

    readOverviewRows(sinceMs, afterId, limit, filter) {
      return guard('readOverviewRows', [], () => {
        const where = whereFor(filter);
        const types = OVERVIEW_TYPES.map(() => '?').join(',');
        const rows = database
          .prepare(
            `SELECT ${OVERVIEW_COLUMNS} FROM events WHERE ts_ms >= ? AND id > ? AND type IN (${types})${where.sql} ORDER BY id ASC LIMIT ?`,
          )
          .all(sinceMs, afterId, ...OVERVIEW_TYPES, ...where.parameters, limit) as Record<string, unknown>[];
        return rows.map(overviewRowFromSql);
      });
    },

    oldestTs(filter) {
      return guard('oldestTs', null, () => {
        const where = whereFor(filter);
        const row = database
          .prepare(`SELECT MIN(ts) AS value FROM events WHERE 1 = 1${where.sql}`)
          .get(...where.parameters) as { value: string | null } | undefined;
        return row?.value ?? null;
      });
    },

    recent(limit) {
      return guard('recent', [], () =>
        query('SELECT envelope FROM events ORDER BY id DESC LIMIT ?', [limit]).reverse(),
      );
    },

    count() {
      return guard('count', 0, () => {
        const row = database.prepare('SELECT COUNT(*) AS value FROM events').get() as
          | { value: number }
          | undefined;
        return row?.value ?? 0;
      });
    },

    deleteOlderThan(cutoffMs) {
      return guard('deleteOlderThan', 0, () => {
        const result = database.prepare('DELETE FROM events WHERE ts_ms < ?').run(cutoffMs);
        if (result.changes > 0) recount();
        if (result.changes > 0) recount();
        if (result.changes > 0) recount();
        return result.changes;
      });
    },

    deleteMatching(filter) {
      return guard('deleteMatching', 0, () => {
        // `kind: 'all'` produces no WHERE at all, which would erase the whole log including other
        // logins' events. No caller needs that, so it is refused here rather than trusted.
        if (filter.kind === 'all') return 0;
        const { sql, parameters } = whereFor(filter);
        if (sql === '') return 0;
        const result = database.prepare(`DELETE FROM events WHERE 1 = 1${sql}`).run(...parameters);
        return result.changes;
      });
    },

    trimToMaxRows(maxRows) {
      return guard('trimToMaxRows', 0, () => {
        if (maxRows < 0) return 0;
        // Retention was time-only, so one busy hour could hold far more than the instance has
        // memory for long before the 72-hour cutoff came round (invariant 14: every cap is real).
        const result = database
          .prepare(
            'DELETE FROM events WHERE id <= ' +
              '(SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)',
          )
          .run(maxRows);
        return result.changes;
      });
    },

    storedBytes() {
      return totalBytes;
    },

    trimToMaxBytes(maxBytes) {
      return guard('trimToMaxBytes', 0, () => {
        if (totalBytes <= maxBytes) return 0;
        // Newest first, adding sizes until the budget is spent: everything older than the last
        // row that fits goes, whole. The newest row stays even when it alone is over the budget.
        let kept = 0;
        let cutoff: number | null = null;
        const rows = database
          .prepare('SELECT id, length(CAST(envelope AS BLOB)) AS bytes FROM events ORDER BY id DESC')
          .iterate() as IterableIterator<{ id: number; bytes: number }>;
        for (const row of rows) {
          if (kept > 0 && kept + row.bytes > maxBytes) {
            cutoff = row.id;
            break;
          }
          kept += row.bytes;
        }
        if (cutoff === null) return 0;
        const result = database.prepare('DELETE FROM events WHERE id <= ?').run(cutoff);
        if (result.changes > 0) recount();
        return result.changes;
      });
    },

    reclaim() {
      guard('reclaim', undefined, () => {
        const [pages] = database.pragma('freelist_count') as [{ freelist_count: number }];
        if ((pages?.freelist_count ?? 0) === 0) return;
        const [mode] = database.pragma('auto_vacuum') as [{ auto_vacuum: number }];
        if ((mode?.auto_vacuum ?? 0) === 2) database.pragma('incremental_vacuum');
        else database.exec('VACUUM');
        // The vacuum itself lands in the WAL, so the checkpoint comes AFTER it: without this the
        // main database shrinks to a few pages while the write-ahead log still holds every freed
        // page - and on Cloud Run gen2 that whole directory is RAM (A-25).
        database.pragma('wal_checkpoint(TRUNCATE)');
      });
    },

    fileStats() {
      return guard('fileStats', { pageSize: 0, pageCount: 0, freePages: 0 }, () => {
        const [size] = database.pragma('page_size') as [{ page_size: number }];
        const [count] = database.pragma('page_count') as [{ page_count: number }];
        const [free] = database.pragma('freelist_count') as [{ freelist_count: number }];
        return {
          pageSize: size?.page_size ?? 0,
          pageCount: count?.page_count ?? 0,
          freePages: free?.freelist_count ?? 0,
        };
      });
    },

    close() {
      guard('close', undefined, () => {
        database.close();
      });
      degraded = true;
    },
  };
}
