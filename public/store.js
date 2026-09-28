/**
 * The event reducer (block: dashboard).
 *
 * Everything the eight panels draw is derived here from the raw event stream, so the panels stay
 * pure render functions and the whole read model is testable on plain Node
 * (public/__tests__/store.test.mjs). The reducer is append-only and idempotent per event id: a
 * `Last-Event-ID` replay that overlaps what we already have changes nothing
 * (docs/XRAY_EVENT_MODEL.md section 5).
 *
 * No DOM, no network. Pure data in, pure data out.
 */
import { emptyIdentity, foldHttpIdentity, mergeIdentity } from './identity.js';
import { callKeyOf, familyOf, statusOf, toolOf } from './catalogue.js';
import { percentile, toEpoch } from './format.js';

/** claude.ai's per-call budget, echoed on every `tool.*` event (`CLAUDE_TOOL_BUDGET_MS`). */
export const DEFAULT_BUDGET_MS = 300_000;
/** claude.ai's per-result character cap (`CLAUDE_CONTENT_CHAR_CAP`). */
export const DEFAULT_CONTENT_CAP = 150_000;
/** How many events the browser keeps. Older ones fall out of the timeline, not out of the counts. */
export const MAX_RETAINED_EVENTS = 6000;
/** `http.request` rows waiting for the `tool.call.started` that shares their JSON-RPC id. */
export const MAX_PENDING_HTTP = 500;

/**
 * Inserts `item` into `array`, which is kept ascending by `keyOf`. Appends in O(1) when the key
 * is the largest so far (the live stream), otherwise binary-searches the slot (a backfill that
 * reads the newest session first, then older ones, then the SSE replay). Returns the index.
 */
export function insertSorted(array, item, keyOf) {
  const key = keyOf(item);
  if (array.length === 0 || keyOf(array[array.length - 1]) <= key) {
    array.push(item);
    return array.length - 1;
  }
  let low = 0;
  let high = array.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (keyOf(array[middle]) <= key) low = middle + 1;
    else high = middle;
  }
  array.splice(low, 0, item);
  return low;
}

const STAMPS = Symbol('stamps');

/**
 * `target[field] = value`, unless a later event (by id) already set it. Makes "last writer wins"
 * mean the latest event rather than the latest arrival, so the fold does not depend on the order
 * the backfill and the replay deliver events in. The stamps live on a non-enumerable symbol so
 * spreads and comparisons of the read model never see them.
 */
function stamp(target, field, value, eventId) {
  let stamps = target[STAMPS];
  if (!stamps) {
    stamps = {};
    Object.defineProperty(target, STAMPS, { value: stamps, enumerable: false });
  }
  const id = typeof eventId === 'number' ? eventId : Number.POSITIVE_INFINITY;
  if (stamps[field] !== undefined && stamps[field] > id) return;
  stamps[field] = id;
  target[field] = value;
}

function emptySession(event) {
  return {
    xs: event.xs,
    login_id: event.login_id ?? null,
    grant_id: event.grant_id ?? null,
    parent_grant_id: null,
    persona_id: event.persona_id ?? null,
    persona: null,
    client: event.client ?? null,
    protocol_version: event.protocol_version ?? null,
    era: event.era ?? null,
    started_at: event.ts,
    last_seen_at: event.ts,
    initialize_count: 0,
    /**
     * `call_count` and `error_count` are the larger of what this page folded and what the server
     * reported. They must not be added: `/xray/api/sessions` counts the same `tool.call.started`
     * events the backfill then folds, so a sum double-counts every call of every session the
     * backfill reaches (measured: 9 calls reported as 18). The server number still wins for a
     * session whose history is older than the backfill window.
     */
    folded_call_count: 0,
    server_call_count: 0,
    folded_error_count: 0,
    server_error_count: 0,
    call_count: 0,
    /** Calls that failed or were denied; the same definition as `XraySessionSummary.error_count`. */
    error_count: 0,
    /** Every event with an error severity, which is a wider set than the failed calls. */
    error_events: 0,
    token_expires_at: null,
    boot_id: null,
    ended: false,
    end_reason: null,
    /** Everything below is derived, not part of `XraySessionSummary`. */
    event_count: 0,
    protocol_error_count: 0,
    queries: 0,
    tables_loaded: 0,
    bank_operations: 0,
    source: 'events',
    /** Smallest and largest event id seen for this `xs`; the boot marker is derived from them. */
    first_event_id: null,
    last_event_id: null,
    /** v0.10 (D-29): the signature verdict and the claimed names, kept apart (`identity.js`). */
    identity: emptyIdentity(),
  };
}

function emptyGrant(grantId) {
  return {
    grant_id: grantId,
    parent_grant_id: null,
    login_id: null,
    persona_id: null,
    scopes: [],
    added_scopes: [],
    auth_level: null,
    client_id: null,
    client_name: null,
    client_reconstructed: false,
    created_at: null,
    /** When the grant itself expires (`auth.grant.created`), not when the access token does. */
    expires_at: null,
    /** The latest access-token expiry seen for this grant. */
    token_expires_at: null,
    revoked: false,
    shared_persona: false,
    sessions: [],
  };
}

function emptyCall(event) {
  const data = event.data ?? {};
  return {
    key: callKeyOf(event),
    event_id: event.id,
    xs: event.xs ?? null,
    login_id: event.login_id ?? null,
    grant_id: event.grant_id ?? null,
    request_id: event.request_id ?? null,
    tool: data.tool ?? toolOf(event) ?? 'unknown tool',
    started_at: event.ts,
    started_epoch: toEpoch(event.ts),
    finished_at: null,
    arguments: data.arguments ?? {},
    redacted_fields: data.redacted_fields ?? [],
    rationale: data.rationale ?? null,
    rationale_present: Boolean(data.rationale_present),
    rationale_truncated: Boolean(data.rationale_truncated),
    /** The gate's own record (`intent.declared`, cut at 1,024 chars); `rationale` stays the started-event copy. */
    rationale_declared: null,
    rationale_declared_truncated: false,
    meta: data.meta ?? null,
    required_scopes: data.required_scopes ?? [],
    budget_ms: Number(data.budget_ms ?? DEFAULT_BUDGET_MS),
    status: 'running',
    duration_ms: null,
    is_error: false,
    error: null,
    content_types: [],
    content_chars: 0,
    content_cap: DEFAULT_CONTENT_CAP,
    structured_content: null,
    text_preview: null,
    denied_reason: null,
    missing_scopes: [],
    inferred_workflow: null,
    /** Ids of the bank, ETL, SQL, intent and auth events that happened inside this call, ascending. */
    child_event_ids: [],
    /** The `completed`, `cancelled` or `denied` event that ended the call; `null` while running. */
    finished_event_id: null,
    /** `{event_id, status, duration_ms}` of the `http.request` that carried this JSON-RPC id; never a child. */
    http: null,
  };
}

/**
 * Creates the read model. `apply(event)` folds one event in; every `get*` is a selector over the
 * folded state. Nothing here reads the clock: `now` is always passed in by the caller.
 */
export function createStore() {
  const state = {
    events: [],
    byId: new Map(),
    sessions: new Map(),
    grants: new Map(),
    logins: new Map(),
    calls: new Map(),
    callOrder: [],
    catalogs: new Map(),
    /** `content_hash` -> `{tools, event_id, xs}` of the latest full listing, whichever session sent it. */
    catalogsByHash: new Map(),
    /** Call key -> the `http.request` that arrived before its call; bounded by `MAX_PENDING_HTTP`. */
    pendingHttp: new Map(),
    boots: [],
    unknownTypes: new Map(),
    toolDurations: new Map(),
    counters: {
      events: 0,
      applied: 0,
      duplicates: 0,
      calls: 0,
      errors: 0,
      protocol_errors: 0,
      denied: 0,
      queries: 0,
      rejected_sql: 0,
      tables_loaded: 0,
      bank_operations: 0,
      http_requests: 0,
      http_errors: 0,
      viewer_connects: 0,
      dropped_events: 0,
      initializes: 0,
      unknown: 0,
      /** `tool.call.started` events that reused a JSON-RPC id inside one `xs` (invariant 6 keys everything on it). */
      id_collisions: 0,
    },
    lastEventId: 0,
    lastEventTs: null,
    firstEventTs: null,
  };

  function sessionFor(event) {
    if (!event.xs) return null;
    let session = state.sessions.get(event.xs);
    if (!session) {
      session = emptySession(event);
      state.sessions.set(event.xs, session);
    }
    return session;
  }

  function grantFor(grantId) {
    if (!grantId) return null;
    let grant = state.grants.get(grantId);
    if (!grant) {
      grant = emptyGrant(grantId);
      state.grants.set(grantId, grant);
    }
    return grant;
  }

  function noteLogin(loginId, grantId) {
    if (!loginId) return;
    let login = state.logins.get(loginId);
    if (!login) {
      login = { login_id: loginId, grant_ids: [], persona_id: null, shared_persona: false };
      state.logins.set(loginId, login);
    }
    if (grantId && !login.grant_ids.includes(grantId)) login.grant_ids.push(grantId);
  }

  function attachChild(event) {
    // An `http.request` hangs on `call.http`; it is never one of the children.
    if (familyOf(event.type) === 'http') return null;
    const key = callKeyOf(event);
    if (!key) return null;
    const call = state.calls.get(key);
    if (!call) return null;
    if (event.type !== 'tool.call.started' && !call.child_event_ids.includes(event.id)) {
      insertSorted(call.child_event_ids, event.id, (id) => id);
    }
    return call;
  }

  function recordDuration(tool, ms) {
    if (!tool || !Number.isFinite(Number(ms))) return;
    const list = state.toolDurations.get(tool) ?? [];
    list.push(Number(ms));
    state.toolDurations.set(tool, list);
  }

  /** What a call keeps of the HTTP request that carried it: one line of facts, not the envelope. */
  function httpFactsOf(event) {
    const data = event.data ?? {};
    return { event_id: event.id, status: data.status ?? null, duration_ms: data.duration_ms ?? null };
  }

  /** Parks an `http.request` whose call has not started yet; at the cap the oldest stops waiting. */
  function parkHttp(key, event) {
    state.pendingHttp.delete(key);
    state.pendingHttp.set(key, event);
    if (state.pendingHttp.size > MAX_PENDING_HTTP) {
      state.pendingHttp.delete(state.pendingHttp.keys().next().value);
    }
  }

  /**
   * Gives a call the `http.request` parked under its key. Both events that open a call claim it:
   * `tool.call.started`, and `tool.call.denied` when the gate refused the call before it started
   * (the 403 step-up and the 429 rate limit never produce a `tool.call.started`).
   */
  function claimParkedHttp(call) {
    const parked = state.pendingHttp.get(call.key);
    if (!parked) return;
    call.http = httpFactsOf(parked);
    state.pendingHttp.delete(call.key);
  }

  /**
   * The tool array a listing stands for, in the order `src/xray/read-model.ts` resolves it: the
   * event's own array, the latest full listing with the same `content_hash` (any session), the
   * listing `snapshot_ref` names if it is still retained, then this session's previous catalog.
   */
  function resolveCatalogTools(event, previous) {
    const data = event.data ?? {};
    if (Array.isArray(data.tools) && data.tools.length) {
      return { tools: data.tools, event_id: event.id, resolved_from: 'event' };
    }
    const byHash = data.content_hash ? state.catalogsByHash.get(data.content_hash) : null;
    if (byHash) return { tools: byHash.tools, event_id: byHash.event_id, resolved_from: 'hash' };
    const snapshot = typeof data.snapshot_ref === 'number' ? state.byId.get(data.snapshot_ref) : null;
    const snapshotTools = snapshot?.type === 'catalog.tools_listed' ? snapshot.data?.tools : null;
    if (Array.isArray(snapshotTools) && snapshotTools.length) {
      return { tools: snapshotTools, event_id: snapshot.id, resolved_from: 'snapshot_ref' };
    }
    if (previous?.tools?.length) {
      return { tools: previous.tools, event_id: previous.event_id, resolved_from: 'previous' };
    }
    return { tools: [], event_id: event.id, resolved_from: 'none' };
  }

  function applyCatalog(event) {
    const data = event.data ?? {};
    const xs = event.xs ?? 'no-session';
    const previous = state.catalogs.get(xs);
    const full = Array.isArray(data.tools) && data.tools.length > 0;
    if (full && data.content_hash) {
      const known = state.catalogsByHash.get(data.content_hash);
      if (!known || !(known.event_id > event.id)) {
        state.catalogsByHash.set(data.content_hash, { tools: data.tools, event_id: event.id, xs });
      }
    }
    const resolved = resolveCatalogTools(event, previous);
    const availability =
      Array.isArray(data.availability) && data.availability.length
        ? data.availability
        : previous?.availability ?? [];
    state.catalogs.set(xs, {
      xs,
      content_hash: data.content_hash ?? previous?.content_hash ?? null,
      captured_at: event.ts,
      /** The event the tool array came from; this one only when it carried the array itself. */
      event_id: resolved.event_id,
      tools: resolved.tools,
      resolved_from: resolved.resolved_from,
      availability,
      feature_flags: data.feature_flags ?? previous?.feature_flags ?? [],
      count: data.count ?? previous?.count ?? resolved.tools.length,
      snapshot_ref: data.snapshot_ref ?? null,
      repeated: !full,
      source: data.source ?? 'tools_list',
      list_count: (previous?.list_count ?? 0) + (event.type === 'catalog.tools_listed' ? 1 : 0),
    });
  }

  /** The server boot an event ran under: the latest `server.started` at or before its id. */
  function bootFor(eventId) {
    if (typeof eventId !== 'number') return null;
    for (let index = state.boots.length - 1; index >= 0; index -= 1) {
      if (state.boots[index].event_id <= eventId) return state.boots[index];
    }
    return null;
  }

  function refreshBoot(session) {
    session.boot_id = bootFor(session.last_event_id)?.boot_id ?? null;
  }

  /** Folds one event into the read model. Safe to call twice with the same event. */
  function apply(rawEvent) {
    const event = rawEvent;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') return false;
    if (typeof event.id === 'number' && state.byId.has(event.id)) {
      state.counters.duplicates += 1;
      return false;
    }

    // `state.events` stays ascending by id whatever order the events arrive in, so the timeline
    // and every "latest" fact below read chronologically; an event with no numeric id goes last.
    const eventKey = (candidate) =>
      typeof candidate.id === 'number' ? candidate.id : Number.POSITIVE_INFINITY;
    const insertedAt = insertSorted(state.events, event, eventKey);
    if (typeof event.id === 'number') state.byId.set(event.id, event);
    state.counters.events += 1;
    state.counters.applied += 1;
    if (typeof event.id !== 'number' || event.id > state.lastEventId) {
      if (typeof event.id === 'number') state.lastEventId = event.id;
      state.lastEventTs = event.ts;
    }
    if (insertedAt === 0 || !state.firstEventTs) state.firstEventTs = event.ts;

    if (state.events.length > MAX_RETAINED_EVENTS) {
      const dropped = state.events.splice(0, state.events.length - MAX_RETAINED_EVENTS);
      for (const old of dropped) state.byId.delete(old.id);
    }

    const data = event.data ?? {};
    const family = familyOf(event.type);
    const status = statusOf(event);
    const session = sessionFor(event);

    if (session) {
      session.event_count += 1;
      if (typeof event.id === 'number') {
        if (session.first_event_id === null || event.id < session.first_event_id) {
          session.first_event_id = event.id;
        }
        if (session.last_event_id === null || event.id > session.last_event_id) {
          session.last_event_id = event.id;
        }
      }
      if (!session.last_seen_at || event.ts > session.last_seen_at) session.last_seen_at = event.ts;
      if (!session.started_at || event.ts < session.started_at) session.started_at = event.ts;
      if (event.login_id) stamp(session, 'login_id', event.login_id, event.id);
      if (event.grant_id) stamp(session, 'grant_id', event.grant_id, event.id);
      if (event.persona_id) stamp(session, 'persona_id', event.persona_id, event.id);
      if (event.client) stamp(session, 'client', event.client, event.id);
      if (event.protocol_version) {
        stamp(session, 'protocol_version', event.protocol_version, event.id);
      }
      if (event.era) stamp(session, 'era', event.era, event.id);
      refreshBoot(session);
      if (status === 'error') session.error_events += 1;
    }

    noteLogin(event.login_id, event.grant_id);
    if (event.grant_id) {
      const grant = grantFor(event.grant_id);
      if (event.login_id) stamp(grant, 'login_id', event.login_id, event.id);
      if (event.persona_id) stamp(grant, 'persona_id', event.persona_id, event.id);
      if (event.xs && !grant.sessions.includes(event.xs)) grant.sessions.push(event.xs);
    }

    if (!Object.prototype.hasOwnProperty.call(TYPE_HANDLED, event.type)) {
      state.counters.unknown += 1;
      state.unknownTypes.set(event.type, (state.unknownTypes.get(event.type) ?? 0) + 1);
    }

    switch (event.type) {
      case 'server.started':
        insertSorted(
          state.boots,
          {
            boot_id: data.boot_id ?? null,
            ts: event.ts,
            event_id: event.id,
            version: data.version ?? null,
            git_sha: data.git_sha ?? null,
            sdk: data.sdk ?? null,
            node_version: data.node_version ?? null,
            restored_max_id: data.restored_max_id ?? null,
          },
          (boot) => boot.event_id,
        );
        // A restart marker that arrives after the events it precedes still has to claim them.
        for (const candidate of state.sessions.values()) refreshBoot(candidate);
        break;
      case 'http.request': {
        state.counters.http_requests += 1;
        if (session) foldHttpIdentity(session.identity, data);
        if (Number(data.status ?? 0) >= 400) state.counters.http_errors += 1;
        const key = callKeyOf(event);
        if (key) {
          const call = state.calls.get(key);
          if (call) call.http = httpFactsOf(event);
          else parkHttp(key, event);
        }
        break;
      }
      case 'auth.grant.created': {
        const grant = grantFor(data.grant_id ?? event.grant_id);
        if (grant) {
          grant.parent_grant_id = data.parent_grant_id ?? null;
          if (data.login_id) stamp(grant, 'login_id', data.login_id, event.id);
          if (data.persona_id) stamp(grant, 'persona_id', data.persona_id, event.id);
          stamp(grant, 'scopes', data.scopes ?? [], event.id);
          if (data.auth_level) stamp(grant, 'auth_level', data.auth_level, event.id);
          if (data.client_id) stamp(grant, 'client_id', data.client_id, event.id);
          if (data.client_name) stamp(grant, 'client_name', data.client_name, event.id);
          grant.created_at = event.ts;
          grant.expires_at = data.expires_at ?? null;
          grant.shared_persona = Boolean(data.shared_persona);
          noteLogin(grant.login_id, grant.grant_id);
          const login = state.logins.get(grant.login_id);
          if (login) {
            login.persona_id = grant.persona_id ?? login.persona_id;
            login.shared_persona = login.shared_persona || grant.shared_persona;
          }
        }
        break;
      }
      case 'auth.grant.updated': {
        const grant = grantFor(data.grant_id ?? event.grant_id);
        if (grant) {
          if (data.scopes) stamp(grant, 'scopes', data.scopes, event.id);
          grant.added_scopes = [...new Set([...grant.added_scopes, ...(data.added_scopes ?? [])])].sort();
          if (data.auth_level) stamp(grant, 'auth_level', data.auth_level, event.id);
          if (data.login_id) stamp(grant, 'login_id', data.login_id, event.id);
          noteLogin(grant.login_id, grant.grant_id);
        }
        break;
      }
      case 'auth.client.reconstructed': {
        const grant = grantFor(event.grant_id);
        if (grant) {
          grant.client_reconstructed = true;
          if (data.client_name) stamp(grant, 'client_name', data.client_name, event.id);
        }
        break;
      }
      case 'auth.verified': {
        const grant = grantFor(data.grant_id ?? event.grant_id);
        if (grant) {
          if (data.scopes) stamp(grant, 'scopes', data.scopes, event.id);
          if (data.auth_level) stamp(grant, 'auth_level', data.auth_level, event.id);
          if (data.client_id) stamp(grant, 'client_id', data.client_id, event.id);
          if (data.client_name) stamp(grant, 'client_name', data.client_name, event.id);
          if (data.login_id) stamp(grant, 'login_id', data.login_id, event.id);
          if (data.persona_id) stamp(grant, 'persona_id', data.persona_id, event.id);
          if (data.expires_at) stamp(grant, 'token_expires_at', data.expires_at, event.id);
        }
        if (session && data.expires_at) {
          stamp(session, 'token_expires_at', data.expires_at, event.id);
        }
        break;
      }
      case 'auth.token.issued':
      case 'auth.token.refreshed': {
        const grant = grantFor(data.grant_id ?? event.grant_id);
        if (grant) {
          if (data.scopes) stamp(grant, 'scopes', data.scopes, event.id);
          if (data.auth_level) stamp(grant, 'auth_level', data.auth_level, event.id);
          if (data.expires_at) stamp(grant, 'token_expires_at', data.expires_at, event.id);
        }
        // A token applies to the sessions of its grant that were already running when it was
        // issued; a session that starts later learns its expiry from its own `auth.verified`.
        for (const candidate of state.sessions.values()) {
          if (candidate.grant_id !== (data.grant_id ?? event.grant_id) || !data.expires_at) continue;
          if (candidate.first_event_id !== null && candidate.first_event_id > event.id) continue;
          stamp(candidate, 'token_expires_at', data.expires_at, event.id);
        }
        break;
      }
      case 'auth.token.revoked': {
        const grant = grantFor(data.grant_id ?? event.grant_id);
        if (grant) grant.revoked = true;
        break;
      }
      case 'auth.login.created': {
        noteLogin(data.login_id, event.grant_id);
        const login = state.logins.get(data.login_id);
        if (login) {
          login.persona_id = data.persona_id ?? login.persona_id;
          login.shared_persona = login.shared_persona || Boolean(data.shared_persona);
        }
        break;
      }
      case 'auth.stepup.requested':
        attachChild(event);
        break;
      case 'session.started':
        if (session) {
          session.started_at = event.ts;
          session.start_reason = data.reason ?? null;
          session.idle_ms = data.idle_ms ?? null;
        }
        break;
      case 'session.initialized':
        state.counters.initializes += 1;
        if (session) {
          session.initialize_count = Math.max(
            session.initialize_count + (data.initialize_count === undefined ? 1 : 0),
            Number(data.initialize_count ?? 0),
          );
          if (data.protocol_version_negotiated) {
            stamp(session, 'protocol_version', data.protocol_version_negotiated, event.id);
          }
          stamp(session, 'protocol_version_requested', data.protocol_version_requested ?? null, event.id);
          if (data.client) stamp(session, 'client', data.client, event.id);
          stamp(session, 'client_capabilities', data.client_capabilities ?? {}, event.id);
          stamp(session, 'server_capabilities', data.server_capabilities ?? {}, event.id);
          stamp(session, 'instructions_sent', data.instructions_sent !== false, event.id);
        }
        break;
      case 'session.ended':
        if (session) {
          session.ended = true;
          session.end_reason = data.reason ?? null;
          session.duration_ms = data.duration_ms ?? null;
        }
        break;
      case 'catalog.tools_listed':
      case 'catalog.availability':
        applyCatalog(event);
        if (event.type === 'catalog.availability') attachChild(event);
        break;
      case 'tool.call.started': {
        const key = callKeyOf(event);
        const existing = key ? state.calls.get(key) : null;
        const collision = Boolean(existing) && existing.event_id !== event.id;
        if (collision) state.counters.id_collisions += 1;
        state.counters.calls += 1;
        if (session) {
          session.folded_call_count += 1;
          session.call_count = Math.max(session.folded_call_count, session.server_call_count);
        }
        // Two calls sharing one JSON-RPC id inside one xs: the newer keeps the key (invariant 6
        // nests children on it) and the counter says a call was hidden.
        if (collision && existing.event_id > event.id) break;
        if (collision) state.callOrder = state.callOrder.filter((candidate) => candidate !== key);
        const call = emptyCall(event);
        claimParkedHttp(call);
        state.calls.set(call.key, call);
        insertSorted(state.callOrder, call.key, (candidate) => state.calls.get(candidate)?.event_id ?? 0);
        break;
      }
      case 'tool.call.completed': {
        const call = attachChild(event) ?? null;
        if (call) {
          call.finished_at = event.ts;
          call.duration_ms = Number(data.duration_ms ?? 0);
          call.budget_ms = Number(data.budget_ms ?? call.budget_ms);
          call.is_error = Boolean(data.is_error);
          call.error = data.error ?? null;
          call.content_types = data.content_types ?? [];
          call.content_chars = Number(data.content_chars ?? 0);
          call.content_cap = Number(data.content_cap ?? DEFAULT_CONTENT_CAP);
          call.structured_content = data.structured_content ?? null;
          call.text_preview = data.text_preview ?? null;
          call.status = data.is_error ? 'error' : 'ok';
          if (data.is_error && session) {
            session.folded_error_count += 1;
            session.error_count = Math.max(session.folded_error_count, session.server_error_count);
          }
          call.child_event_ids = call.child_event_ids.filter((id) => id !== event.id);
          call.completed_event_id = event.id;
          call.finished_event_id = event.id;
        }
        recordDuration(data.tool, data.duration_ms);
        if (data.is_error) state.counters.errors += 1;
        break;
      }
      case 'tool.call.cancelled': {
        const call = attachChild(event);
        if (call) {
          call.status = 'cancelled';
          call.duration_ms = Number(data.duration_ms ?? 0);
          call.finished_at = event.ts;
          call.finished_event_id = event.id;
          call.cancel_reason = data.reason ?? null;
        }
        break;
      }
      case 'tool.call.denied': {
        state.counters.denied += 1;
        if (session) {
          session.folded_error_count += 1;
          session.error_count = Math.max(session.folded_error_count, session.server_error_count);
        }
        let call = attachChild(event);
        if (!call) {
          call = emptyCall(event);
          call.status = 'denied';
          claimParkedHttp(call);
          state.calls.set(call.key, call);
          insertSorted(state.callOrder, call.key, (key) => state.calls.get(key)?.event_id ?? 0);
        }
        call.status = 'denied';
        call.denied_reason = data.denied_reason ?? null;
        call.missing_scopes = data.missing_scopes ?? [];
        call.required_scopes = data.required_scopes ?? call.required_scopes;
        call.finished_at = event.ts;
        call.finished_event_id = event.id;
        break;
      }
      case 'protocol.error':
        state.counters.protocol_errors += 1;
        if (session) session.protocol_error_count += 1;
        break;
      case 'bank.op': {
        state.counters.bank_operations += 1;
        if (session) session.bank_operations += 1;
        attachChild(event);
        break;
      }
      case 'etl.load':
      case 'etl.processed': {
        if (event.type === 'etl.load') {
          state.counters.tables_loaded += 1;
          if (session) session.tables_loaded += 1;
        }
        attachChild(event);
        break;
      }
      case 'etl.table_evicted':
      case 'etl.limit_reached':
      case 'etl.worker_terminated':
        attachChild(event);
        break;
      case 'sql.query':
        state.counters.queries += 1;
        if (session) session.queries += 1;
        attachChild(event);
        break;
      case 'sql.rejected':
        state.counters.rejected_sql += 1;
        attachChild(event);
        break;
      case 'sql.table_cleared':
        attachChild(event);
        break;
      case 'intent.declared':
      case 'intent.missing': {
        const call = attachChild(event);
        if (call && event.type === 'intent.declared') {
          // The gate keeps 1,024 chars, the started event up to 8,192: `rationale` stays the latter.
          call.rationale_declared = data.text ?? null;
          call.rationale_declared_truncated = Boolean(data.truncated);
          call.rationale_present = true;
        }
        break;
      }
      case 'intent.inferred': {
        if (session) stamp(session, 'inferred_workflow', data, event.id);
        attachChild(event);
        break;
      }
      case 'xray.viewer.connected':
        state.counters.viewer_connects += 1;
        break;
      case 'xray.dropped':
        state.counters.dropped_events += Number(data.dropped_count ?? 0);
        break;
      default:
        if (family === 'tool' || family === 'sql' || family === 'etl' || family === 'bank') {
          attachChild(event);
        }
        break;
    }

    return true;
  }

  /** Merges `GET /xray/api/sessions` rows so sessions older than the replay window still show. */
  function mergeServerSessions(rows) {
    for (const row of rows ?? []) {
      if (!row || !row.xs) continue;
      const existing = state.sessions.get(row.xs);
      if (!existing) {
        state.sessions.set(row.xs, {
          ...emptySession({ xs: row.xs, ts: row.started_at }),
          ...row,
          // Seeded here too, or the first folded call would replace the server's total with 1.
          server_call_count: row.call_count ?? 0,
          server_error_count: row.error_count ?? 0,
          folded_call_count: 0,
          folded_error_count: 0,
          event_count: 0,
          error_events: 0,
          protocol_error_count: 0,
          queries: 0,
          tables_loaded: 0,
          bank_operations: 0,
          ended: false,
          end_reason: null,
          source: 'api',
          identity: mergeIdentity(null, row.identity),
        });
        noteLogin(row.login_id, row.grant_id);
        continue;
      }
      existing.persona = row.persona ?? existing.persona;
      existing.identity = mergeIdentity(existing.identity, row.identity);
      existing.parent_grant_id = row.parent_grant_id ?? existing.parent_grant_id;
      existing.token_expires_at = existing.token_expires_at ?? row.token_expires_at ?? null;
      existing.boot_id = existing.boot_id ?? row.boot_id ?? null;
      existing.server_call_count = Math.max(existing.server_call_count, row.call_count ?? 0);
      existing.server_error_count = Math.max(existing.server_error_count, row.error_count ?? 0);
      existing.call_count = Math.max(existing.folded_call_count, existing.server_call_count);
      existing.error_count = Math.max(existing.folded_error_count, existing.server_error_count);
      existing.initialize_count = Math.max(existing.initialize_count, row.initialize_count ?? 0);
      if (row.started_at && row.started_at < existing.started_at) existing.started_at = row.started_at;
      if (row.last_seen_at && row.last_seen_at > existing.last_seen_at) {
        existing.last_seen_at = row.last_seen_at;
      }
    }
  }

  /** Sessions newest first, each with its grant and login attached. */
  function getSessions() {
    return [...state.sessions.values()]
      .map((session) => ({
        ...session,
        grant: session.grant_id ? state.grants.get(session.grant_id) ?? null : null,
      }))
      .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
  }

  /** Sessions grouped by login and then by grant, which is how the Sessions panel draws them. */
  function getLoginGroups() {
    const sessions = getSessions();
    const groups = new Map();
    for (const session of sessions) {
      const loginId = session.login_id ?? 'unknown-login';
      let group = groups.get(loginId);
      if (!group) {
        const login = state.logins.get(loginId);
        group = {
          login_id: session.login_id ?? null,
          persona_id: login?.persona_id ?? session.persona_id ?? null,
          shared_persona: Boolean(login?.shared_persona),
          grants: new Map(),
          last_seen_at: session.last_seen_at,
        };
        groups.set(loginId, group);
      }
      if (session.last_seen_at > group.last_seen_at) group.last_seen_at = session.last_seen_at;
      const grantId = session.grant_id ?? 'unknown-grant';
      let grantGroup = group.grants.get(grantId);
      if (!grantGroup) {
        grantGroup = {
          grant_id: session.grant_id ?? null,
          grant: session.grant ?? null,
          sessions: [],
        };
        group.grants.set(grantId, grantGroup);
      }
      grantGroup.sessions.push(session);
    }
    return [...groups.values()]
      .map((group) => ({ ...group, grants: [...group.grants.values()] }))
      .sort((a, b) => String(b.last_seen_at).localeCompare(String(a.last_seen_at)));
  }

  function getSession(xs) {
    const session = state.sessions.get(xs);
    if (!session) return null;
    return { ...session, grant: session.grant_id ? state.grants.get(session.grant_id) ?? null : null };
  }

  /** Every retained event ascending by id, optionally for one session. */
  function getEvents({ xs = null } = {}) {
    if (!xs) return state.events;
    return state.events.filter((event) => event.xs === xs);
  }

  /** Calls in start order (the id of their first event), optionally for one session. */
  function getCalls({ xs = null } = {}) {
    const calls = state.callOrder.map((key) => state.calls.get(key)).filter(Boolean);
    return xs ? calls.filter((call) => call.xs === xs) : calls;
  }

  function getCall(key) {
    return state.calls.get(key) ?? null;
  }

  /** The call with no completion yet, newest first; feeds the "now" strip. */
  function getInFlightCalls() {
    return getCalls().filter((call) => call.status === 'running').reverse();
  }

  function getCatalog(xs) {
    return state.catalogs.get(xs) ?? null;
  }

  /** The latest full listing with this `content_hash`, from whichever session sent it. */
  function getCatalogByHash(hash) {
    return state.catalogsByHash.get(hash) ?? null;
  }

  function getBoots() {
    return state.boots;
  }

  function getGrant(grantId) {
    return state.grants.get(grantId) ?? null;
  }

  /** p50 and p95 per tool, computed in the browser (panel 8 of section 7). */
  function getToolStats({ xs = null } = {}) {
    const rows = new Map();
    for (const call of getCalls({ xs })) {
      let row = rows.get(call.tool);
      if (!row) {
        row = { tool: call.tool, calls: 0, errors: 0, durations: [] };
        rows.set(call.tool, row);
      }
      row.calls += 1;
      if (call.status === 'error' || call.status === 'denied') row.errors += 1;
      if (call.duration_ms !== null && call.duration_ms !== undefined) {
        row.durations.push(call.duration_ms);
      }
    }
    return [...rows.values()]
      .map((row) => ({
        tool: row.tool,
        calls: row.calls,
        errors: row.errors,
        p50: percentile(row.durations, 50),
        p95: percentile(row.durations, 95),
        max: row.durations.length ? Math.max(...row.durations) : null,
      }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  }

  /** Every tool name seen, for the filter dropdown. */
  function getToolNames() {
    const names = new Set();
    for (const call of getCalls()) names.add(call.tool);
    for (const catalog of state.catalogs.values()) {
      for (const tool of catalog.tools ?? []) names.add(tool.name);
    }
    return [...names].sort();
  }

  function getCounters({ xs = null } = {}) {
    if (!xs) return { ...state.counters, failed_calls: state.counters.errors + state.counters.denied };
    const session = state.sessions.get(xs);
    return {
      ...state.counters,
      events: session?.event_count ?? 0,
      failed_calls: session?.error_count ?? 0,
      calls: session?.call_count ?? 0,
      errors: session?.error_count ?? 0,
      error_events: session?.error_events ?? 0,
      protocol_errors: session?.protocol_error_count ?? 0,
      queries: session?.queries ?? 0,
      tables_loaded: session?.tables_loaded ?? 0,
      bank_operations: session?.bank_operations ?? 0,
    };
  }

  function getUnknownTypes() {
    return [...state.unknownTypes.entries()].map(([type, times]) => ({ type, count: times }));
  }

  /**
   * Forgets every event this page folded, without touching the server. The "hide what is on
   * screen" control uses it, and so does a successful erase. `lastEventId` deliberately survives:
   * it is the SSE cursor, and resetting it would make the next reconnect replay exactly the events
   * the viewer just asked to stop seeing.
   */
  function clear() {
    state.events = [];
    state.byId.clear();
    state.sessions.clear();
    state.grants.clear();
    state.logins.clear();
    state.calls.clear();
    state.callOrder = [];
    state.catalogs.clear();
    state.catalogsByHash.clear();
    state.pendingHttp.clear();
    state.boots = [];
    state.unknownTypes.clear();
    state.toolDurations.clear();
    for (const key of Object.keys(state.counters)) state.counters[key] = 0;
    state.lastEventTs = null;
    state.firstEventTs = null;
  }

  return {
    state,
    apply,
    clear,
    mergeServerSessions,
    getSessions,
    getLoginGroups,
    getSession,
    getEvents,
    getEventById: (id) => state.byId.get(id) ?? null,
    getCalls,
    getCall,
    getInFlightCalls,
    getCatalog,
    getCatalogByHash,
    getBoots,
    getGrant,
    getToolStats,
    getToolNames,
    getCounters,
    getUnknownTypes,
    get lastEventId() {
      return state.lastEventId;
    },
    get lastEventTs() {
      return state.lastEventTs;
    },
    get size() {
      return state.events.length;
    },
  };
}

/** The event types the reducer has an explicit branch for; anything else is counted as unknown. */
const TYPE_HANDLED = {
  'server.started': 1,
  'server.stopping': 1,
  'http.request': 1,
  'auth.challenge': 1,
  'auth.verified': 1,
  'auth.rejected': 1,
  'auth.client.registered': 1,
  'auth.client.reconstructed': 1,
  'auth.grant.created': 1,
  'auth.grant.updated': 1,
  'auth.token.issued': 1,
  'auth.token.refreshed': 1,
  'auth.token.revoked': 1,
  'auth.stepup.requested': 1,
  'auth.login.created': 1,
  'session.started': 1,
  'session.initialized': 1,
  'session.ended': 1,
  'session.rejected': 1,
  'catalog.tools_listed': 1,
  'catalog.resources_listed': 1,
  'catalog.prompts_listed': 1,
  'catalog.availability': 1,
  'tool.call.started': 1,
  'tool.call.completed': 1,
  'tool.call.cancelled': 1,
  'tool.call.denied': 1,
  'protocol.error': 1,
  'bank.op': 1,
  'etl.load': 1,
  'etl.processed': 1,
  'etl.table_evicted': 1,
  'etl.limit_reached': 1,
  'etl.worker_terminated': 1,
  'sql.query': 1,
  'sql.table_cleared': 1,
  'sql.rejected': 1,
  'intent.declared': 1,
  'intent.inferred': 1,
  'intent.missing': 1,
  'xray.pairing.created': 1,
  'xray.pairing.rejected': 1,
  'xray.viewer.connected': 1,
  'xray.viewer.disconnected': 1,
  'xray.dropped': 1,
};
