/**
 * The read model (block: xray).
 *
 * Everything `GET /xray/api/*` answers is derived from the event stream, never from a second
 * source of truth: one index, fed by `observe(event)` on the way in and rebuilt from the log on
 * boot. It is also the authority for **who may see what** - `matchesScope` is the single
 * predicate used by the SSE fan-out, by the replay and by every REST route, so a viewer scope
 * cannot drift between them (docs/XRAY_EVENT_MODEL.md sections 4 and 6, CLAUDE.md invariant 11).
 */
import type {
  CatalogTool,
  ClientInfo,
  Scope,
  ToolAvailability,
  XrayCatalogSnapshot,
  XrayEra,
  XrayEvent,
  XrayGrantFacts,
  XraySessionCounters,
  XrayViewerScope,
} from '../contracts/index.js';

import { BoundedLru } from './bounded.js';

/** Caps on the three indexes (ADR-16). All of them are fed by attacker-influenced traffic. */
export const MAX_SESSIONS = 2000;
export const MAX_GRANTS = 2000;
export const MAX_LOGINS = 2000;
export const MAX_CATALOG_SNAPSHOTS = 200;

/** One session row, before the persona is resolved (that lookup is async and lives in `routes`). */
export interface SessionRow {
  xs: string;
  login_id: string | null;
  grant_id: string | null;
  parent_grant_id: string | null;
  persona_id: string | null;
  client: ClientInfo | null;
  protocol_version: string | null;
  era: XrayEra | null;
  started_at: string;
  last_seen_at: string;
  initialize_count: number;
  call_count: number;
  error_count: number;
  token_expires_at: string | null;
  boot_id: string | null;
  counters: {
    events: number;
    calls: number;
    errors: number;
    protocol_errors: number;
    tables_loaded: number;
    queries: number;
    bank_operations: number;
  };
}

interface GrantRow {
  grant_id: string;
  parent_grant_id: string | null;
  login_id: string | null;
  persona_id: string | null;
  scopes: Scope[];
  auth_level: 'read_only' | 'read_write';
  client_id: string;
  client_name: string | null;
  created_at: string;
  expires_at: string | null;
  revoked: boolean;
  shared_persona: boolean;
}

interface LoginRow {
  login_id: string;
  persona_id: string | null;
  grant_ids: Set<string>;
  session_ids: Set<string>;
  last_seen_at: string;
}

interface CatalogRow {
  xs: string;
  content_hash: string;
  captured_at: string;
  event_id: number;
  tools: CatalogTool[];
  availability: ToolAvailability[];
  feature_flags: string[];
}

export interface ReadModel {
  observe(event: XrayEvent): void;
  /** The one visibility predicate: live fan-out, replay and REST all call it. */
  matchesScope(event: XrayEvent, scope: XrayViewerScope): boolean;
  session(xs: string): SessionRow | null;
  /** Sessions visible to `scope`, most recently seen first. */
  sessions(scope: XrayViewerScope): SessionRow[];
  grant(grantId: string): XrayGrantFacts | null;
  catalog(xs: string): XrayCatalogSnapshot | null;
  counters(xs: string): XraySessionCounters;
  loginOfSession(xs: string): string | null;
  loginOfGrant(grantId: string): string | null;
  grantIdsForLogin(loginId: string): string[];
  sessionIdsForLogin(loginId: string): string[];
  personaOfLogin(loginId: string): string | null;
  /** The current boot marker, stamped onto sessions so the dashboard can draw a restart. */
  readonly bootId: string | null;
  /**
   * Sets the boot every *new* session is stamped with. `createXray` calls it after the restore
   * loop, so sessions rebuilt from the previous boot keep that boot's marker (A-15).
   */
  setBootId(bootId: string): void;
  reset(): void;
  /**
   * Forgets one session (v0.4): the row, its catalog snapshot and its place in the login's set.
   * Answers false when there was no such session.
   */
  forgetSession(xs: string): boolean;
  /**
   * Forgets a whole login (v0.4): every session it owns, their catalog snapshots, its grants and
   * the login row. Answers how many sessions went, which is what the API reports.
   */
  forgetLogin(loginId: string): number;
}

export interface ReadModelOptions {
  /**
   * Resolves the full tool array of a `catalog.tools_listed` that only carried a `snapshot_ref`
   * (claude.ai re-lists every 25-80 s and the array is repeated only when the hash changed).
   */
  readonly lookupEvent?: (id: number) => XrayEvent | null;
}

function emptyCounters(): SessionRow['counters'] {
  return {
    events: 0,
    calls: 0,
    errors: 0,
    protocol_errors: 0,
    tables_loaded: 0,
    queries: 0,
    bank_operations: 0,
  };
}

export function createReadModel(options: ReadModelOptions = {}): ReadModel {
  const sessions = new BoundedLru<string, SessionRow>(MAX_SESSIONS);
  const grants = new BoundedLru<string, GrantRow>(MAX_GRANTS);
  const logins = new BoundedLru<string, LoginRow>(MAX_LOGINS);
  const catalogsByXs = new BoundedLru<string, CatalogRow>(MAX_SESSIONS);
  const toolsByHash = new BoundedLru<string, CatalogTool[]>(MAX_CATALOG_SNAPSHOTS);
  const reconstructedClients = new BoundedLru<string, true>(MAX_GRANTS);
  let bootId: string | null = null;

  function loginRow(loginId: string): LoginRow {
    const existing = logins.get(loginId);
    if (existing) return existing;
    const created: LoginRow = {
      login_id: loginId,
      persona_id: null,
      grant_ids: new Set(),
      session_ids: new Set(),
      last_seen_at: '',
    };
    logins.set(loginId, created);
    return created;
  }

  function touchSession(event: XrayEvent): SessionRow | null {
    if (!event.xs) return null;
    const existing = sessions.get(event.xs);
    const row: SessionRow =
      existing ??
      ({
        xs: event.xs,
        login_id: null,
        grant_id: null,
        parent_grant_id: null,
        persona_id: null,
        client: null,
        protocol_version: null,
        era: null,
        started_at: event.ts,
        last_seen_at: event.ts,
        initialize_count: 0,
        call_count: 0,
        error_count: 0,
        token_expires_at: null,
        boot_id: bootId,
        counters: emptyCounters(),
      } satisfies SessionRow);

    if (event.ts > row.last_seen_at) row.last_seen_at = event.ts;
    if (event.ts < row.started_at) row.started_at = event.ts;
    if (event.login_id) row.login_id = event.login_id;
    if (event.grant_id) row.grant_id = event.grant_id;
    if (event.persona_id) row.persona_id = event.persona_id;
    if (event.client) row.client = event.client;
    if (event.protocol_version) row.protocol_version = event.protocol_version;
    if (event.era) row.era = event.era;
    if (row.boot_id === null) row.boot_id = bootId;
    row.counters.events += 1;

    // The grant may name a parent and a login the envelope does not carry.
    if (row.grant_id) {
      const grant = grants.peek(row.grant_id);
      if (grant) {
        row.parent_grant_id = grant.parent_grant_id;
        if (!row.login_id && grant.login_id) row.login_id = grant.login_id;
        if (!row.persona_id && grant.persona_id) row.persona_id = grant.persona_id;
      }
    }

    sessions.set(row.xs, row);
    if (row.login_id) {
      const login = loginRow(row.login_id);
      login.session_ids.add(row.xs);
      if (row.grant_id) login.grant_ids.add(row.grant_id);
      if (!login.persona_id && row.persona_id) login.persona_id = row.persona_id;
      if (event.ts > login.last_seen_at) login.last_seen_at = event.ts;
    }
    return row;
  }

  function rememberGrant(row: GrantRow): void {
    grants.set(row.grant_id, row);
    if (row.login_id) {
      const login = loginRow(row.login_id);
      login.grant_ids.add(row.grant_id);
      if (!login.persona_id && row.persona_id) login.persona_id = row.persona_id;
    }
  }

  return {
    get bootId() {
      return bootId;
    },

    setBootId(value) {
      bootId = value;
    },

    observe(event) {
      switch (event.type) {
        case 'server.started':
          bootId = event.data.boot_id;
          break;
        case 'auth.grant.created': {
          const existing = grants.peek(event.data.grant_id);
          rememberGrant({
            grant_id: event.data.grant_id,
            parent_grant_id: event.data.parent_grant_id,
            login_id: event.data.login_id,
            persona_id: event.data.persona_id,
            scopes: event.data.scopes as Scope[],
            auth_level: event.data.auth_level,
            client_id: event.data.client_id,
            client_name: event.data.client_name,
            created_at: existing?.created_at ?? event.ts,
            expires_at: event.data.expires_at,
            revoked: false,
            shared_persona: event.data.shared_persona,
          });
          break;
        }
        case 'auth.grant.updated': {
          const existing = grants.peek(event.data.grant_id);
          rememberGrant({
            grant_id: event.data.grant_id,
            parent_grant_id: existing?.parent_grant_id ?? null,
            login_id: event.data.login_id,
            persona_id: event.data.persona_id,
            scopes: event.data.scopes as Scope[],
            auth_level: event.data.auth_level,
            client_id: event.data.client_id,
            client_name: existing?.client_name ?? null,
            created_at: existing?.created_at ?? event.ts,
            expires_at: existing?.expires_at ?? null,
            revoked: existing?.revoked ?? false,
            shared_persona: existing?.shared_persona ?? false,
          });
          break;
        }
        case 'auth.token.issued':
        case 'auth.token.refreshed': {
          const existing = grants.peek(event.data.grant_id);
          rememberGrant({
            grant_id: event.data.grant_id,
            parent_grant_id: existing?.parent_grant_id ?? null,
            login_id: event.data.login_id ?? existing?.login_id ?? null,
            persona_id: event.data.persona_id,
            scopes: event.data.scopes as Scope[],
            auth_level: event.data.auth_level,
            client_id: event.data.client_id,
            client_name: existing?.client_name ?? null,
            created_at: existing?.created_at ?? event.ts,
            expires_at: event.data.expires_at,
            revoked: existing?.revoked ?? false,
            shared_persona: existing?.shared_persona ?? false,
          });
          break;
        }
        case 'auth.token.revoked': {
          if (event.data.grant_id) {
            const existing = grants.peek(event.data.grant_id);
            if (existing) existing.revoked = true;
          }
          break;
        }
        case 'auth.client.reconstructed':
          reconstructedClients.set(event.data.client_id, true);
          break;
        case 'auth.login.created': {
          const login = loginRow(event.data.login_id);
          login.persona_id = event.data.persona_id;
          break;
        }
        default:
          break;
      }

      const row = touchSession(event);
      if (!row) return;

      switch (event.type) {
        case 'session.initialized':
          row.initialize_count = event.data.initialize_count;
          break;
        case 'tool.call.started':
          row.call_count += 1;
          row.counters.calls += 1;
          break;
        case 'tool.call.completed':
          if (event.data.is_error) {
            row.error_count += 1;
            row.counters.errors += 1;
          }
          break;
        case 'tool.call.denied':
          row.error_count += 1;
          row.counters.errors += 1;
          break;
        case 'protocol.error':
          row.error_count += 1;
          row.counters.errors += 1;
          row.counters.protocol_errors += 1;
          break;
        case 'etl.load':
          row.counters.tables_loaded += 1;
          break;
        case 'sql.query':
          row.counters.queries += 1;
          break;
        case 'bank.op':
          row.counters.bank_operations += 1;
          break;
        case 'auth.token.issued':
        case 'auth.token.refreshed':
          row.token_expires_at = event.data.expires_at;
          break;
        case 'catalog.tools_listed': {
          const tools = event.data.tools ?? null;
          if (tools && tools.length > 0) toolsByHash.set(event.data.content_hash, [...tools]);
          const resolved =
            tools ??
            toolsByHash.peek(event.data.content_hash) ??
            resolveSnapshotRef(event.data.snapshot_ref);
          catalogsByXs.set(row.xs, {
            xs: row.xs,
            content_hash: event.data.content_hash,
            captured_at: event.ts,
            event_id: event.id,
            tools: resolved ? [...resolved] : [],
            availability: [...event.data.availability],
            feature_flags: [...event.data.feature_flags],
          });
          break;
        }
        case 'catalog.availability': {
          const existing = catalogsByXs.peek(row.xs);
          if (existing) {
            existing.availability = [...event.data.availability];
            existing.feature_flags = [...event.data.feature_flags];
            if (existing.content_hash !== event.data.content_hash) {
              existing.content_hash = event.data.content_hash;
              existing.tools = toolsByHash.peek(event.data.content_hash) ?? existing.tools;
            }
          } else {
            catalogsByXs.set(row.xs, {
              xs: row.xs,
              content_hash: event.data.content_hash,
              captured_at: event.ts,
              event_id: event.id,
              tools: toolsByHash.peek(event.data.content_hash) ?? [],
              availability: [...event.data.availability],
              feature_flags: [...event.data.feature_flags],
            });
          }
          break;
        }
        default:
          break;
      }
    },

    matchesScope(event, scope) {
      if (scope.filter === 'all') return true;
      if (scope.filter === 'xs') return scope.xs !== null && event.xs === scope.xs;
      const loginId = scope.login_id;
      if (!loginId) return false;
      if (event.login_id === loginId) return true;
      if (event.xs) {
        const row = sessions.peek(event.xs);
        if (row?.login_id === loginId) return true;
      }
      if (event.grant_id) {
        const grant = grants.peek(event.grant_id);
        if (grant?.login_id === loginId) return true;
      }
      return false;
    },

    session(xs) {
      return sessions.peek(xs) ?? null;
    },

    sessions(scope) {
      const rows: SessionRow[] = [];
      for (const row of sessions.values()) {
        if (scope.filter === 'all') {
          rows.push(row);
        } else if (scope.filter === 'xs') {
          if (row.xs === scope.xs) rows.push(row);
        } else if (scope.login_id && row.login_id === scope.login_id) {
          rows.push(row);
        }
      }
      // Grouped by login, newest login first, newest session first inside it: the Sessions panel
      // shows one human's history together even in observer mode, where several logins are visible
      // at once (docs/XRAY_EVENT_MODEL.md section 7, panel 1).
      const newestPerLogin = new Map<string, string>();
      for (const row of rows) {
        const key = row.login_id ?? '';
        const current = newestPerLogin.get(key) ?? '';
        if (row.last_seen_at > current) newestPerLogin.set(key, row.last_seen_at);
      }
      return rows.sort((left, right) => {
        const leftKey = left.login_id ?? '';
        const rightKey = right.login_id ?? '';
        if (leftKey !== rightKey) {
          const byRecency = (newestPerLogin.get(rightKey) ?? '').localeCompare(
            newestPerLogin.get(leftKey) ?? '',
          );
          if (byRecency !== 0) return byRecency;
          return leftKey.localeCompare(rightKey);
        }
        return right.last_seen_at.localeCompare(left.last_seen_at);
      });
    },

    grant(grantId) {
      const row = grants.peek(grantId);
      if (!row) return null;
      return {
        grant_id: row.grant_id,
        parent_grant_id: row.parent_grant_id,
        login_id: row.login_id,
        scopes: row.scopes,
        auth_level: row.auth_level,
        client_id: row.client_id,
        client_name: row.client_name,
        client_reconstructed: reconstructedClients.peek(row.client_id) === true,
        created_at: row.created_at,
        expires_at: row.expires_at,
        revoked: row.revoked,
      };
    },

    catalog(xs) {
      const row = catalogsByXs.peek(xs);
      if (!row) return null;
      return {
        xs: row.xs,
        content_hash: row.content_hash,
        captured_at: row.captured_at,
        event_id: row.event_id,
        tools: row.tools,
        availability: row.availability,
        feature_flags: row.feature_flags,
      };
    },

    counters(xs) {
      const row = sessions.peek(xs);
      return row ? { ...row.counters } : emptyCounters();
    },

    loginOfSession(xs) {
      return sessions.peek(xs)?.login_id ?? null;
    },

    loginOfGrant(grantId) {
      return grants.peek(grantId)?.login_id ?? null;
    },

    grantIdsForLogin(loginId) {
      return [...(logins.peek(loginId)?.grant_ids ?? [])];
    },

    sessionIdsForLogin(loginId) {
      return [...(logins.peek(loginId)?.session_ids ?? [])];
    },

    personaOfLogin(loginId) {
      return logins.peek(loginId)?.persona_id ?? null;
    },

    forgetSession(xs) {
      const row = sessions.peek(xs);
      if (!row) return false;
      sessions.delete(xs);
      catalogsByXs.delete(xs);
      if (row.login_id !== null) logins.peek(row.login_id)?.session_ids.delete(xs);
      return true;
    },

    forgetLogin(loginId) {
      const login = logins.peek(loginId);
      // The session rows are the authority, not the login's set: a session whose `login_id` was
      // learned late is in `sessions` before it is in `login.session_ids`.
      const owned = new Set(login?.session_ids ?? []);
      for (const row of [...sessions.values()]) {
        if (row.login_id === loginId) owned.add(row.xs);
      }
      for (const xs of owned) {
        sessions.delete(xs);
        catalogsByXs.delete(xs);
      }
      for (const grantId of login?.grant_ids ?? []) grants.delete(grantId);
      for (const grant of [...grants.values()]) {
        if (grant.login_id === loginId) grants.delete(grant.grant_id);
      }
      logins.delete(loginId);
      return owned.size;
    },

    reset() {
      sessions.clear();
      grants.clear();
      logins.clear();
      catalogsByXs.clear();
      toolsByHash.clear();
      reconstructedClients.clear();
      bootId = null;
    },
  };

  function resolveSnapshotRef(id: number | null): CatalogTool[] | null {
    if (id === null || !options.lookupEvent) return null;
    const event = options.lookupEvent(id);
    if (!event || event.type !== 'catalog.tools_listed') return null;
    return event.data.tools ? [...event.data.tools] : null;
  }
}
