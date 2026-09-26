/**
 * The chain: what one call actually handed to the next (block: dashboard).
 *
 * The timeline used to be a flat list of independent blocks, which is a faithful log and a useless
 * story: nothing on screen said that `process_data` was working on the table `load_transactions`
 * had just created. This file derives that wiring from the events themselves - never from a guess
 * about what the user meant - and groups the calls into episodes so the page reads as a column of
 * connected steps.
 *
 * Three kinds of evidence, in order of strength:
 *
 * - `table`: the scratch table named in a result (`structured_content.table_name`, or the `table`
 *   of the call's `etl.load`) and consumed by a later call (`arguments.table_name`, or the `table`
 *   of its `sql.query`, `sql.rejected`, `etl.processed` or `sql.table_cleared`). This is what makes
 *   `load_* -> process_data -> execute_query -> clear_table` one visible chain.
 * - `preview`: a `create_transfer` with `confirm` falsy previews a transfer; a later
 *   `create_transfer` with `confirm` true, the same source, destination and amount confirms it.
 *   `expected_total_amount` is the model quoting the preview back, and the two `bank.op` events
 *   usually share a `preview_id`.
 * - `id`: an id in a call's arguments (`card_id`, `account_id`, `from_account_id`, `payee_id`,
 *   `to.payee_id`) that occurs verbatim in an earlier call's result. The model can only have got it
 *   from there, so the link is observed rather than inferred.
 *
 * Episodes are this dashboard's grouping and nothing more. The server never sees the conversation
 * (docs/XRAY_EVENT_MODEL.md section 1), so an episode is never evidence of what the user typed and
 * every renderer of this data has to say so.
 *
 * Pure functions over the read model of `store.js`. No DOM, no network, no clock.
 */
import { money, oneLineSql } from './format.js';

/** A call that ends a piece of work: after one of these, an unlinked call starts a new episode. */
export const CLOSING_TOOLS = new Set(['clear_table', 'lock_or_unlock_card']);

/**
 * True when this call finished something. `create_transfer` only closes when it actually moved
 * money: a preview is the opening half of a two-step write, and the confirm that follows it must
 * stay in the same episode.
 */
export function isClosingCall(call) {
  if (!call) return false;
  if (CLOSING_TOOLS.has(call.tool)) return true;
  return call.tool === 'create_transfer' && Boolean(argumentsOf(call).confirm);
}

/** Idle time after which an unlinked call is treated as the start of something new. */
export const EPISODE_GAP_MS = 45_000;

/** Argument keys whose value is an id the model can only have read out of an earlier result. */
export const ID_ARGUMENT_KEYS = ['card_id', 'account_id', 'from_account_id', 'payee_id'];

/** Child event types whose `table` field says which scratch table a call worked on. */
const CONSUMING_CHILD_TYPES = new Set([
  'sql.query',
  'sql.rejected',
  'etl.processed',
  'sql.table_cleared',
]);

/** `table` and `preview` beat `id`: they are about the data itself rather than one field of it. */
const LINK_PRIORITY = { table: 0, preview: 1, id: 2 };

/** Accepts the event array the store hands out, or an already-built `Map` of id to event. */
function indexEvents(events) {
  if (events instanceof Map) return events;
  const byId = new Map();
  for (const event of events ?? []) byId.set(event.id, event);
  return byId;
}

/** The bank, ETL, SQL, intent and auth events the reducer nested inside one call. */
export function childEventsOf(call, events) {
  const byId = indexEvents(events);
  const children = [];
  for (const id of call.child_event_ids ?? []) {
    const event = byId.get(id);
    if (event) children.push(event);
  }
  return children;
}

function argumentsOf(call) {
  const args = call.arguments;
  return args && typeof args === 'object' ? args : {};
}

/** The scratch table this call created, from its own result or from its `etl.load`. */
export function tableProduced(call, events) {
  const structured = call.structured_content;
  if (structured && typeof structured === 'object' && typeof structured.table_name === 'string') {
    return structured.table_name;
  }
  for (const event of childEventsOf(call, events)) {
    if (event.type === 'etl.load' && typeof event.data?.table === 'string') return event.data.table;
  }
  return null;
}

/** Every scratch table this call read, projected, queried or dropped. */
export function tablesConsumed(call, events) {
  const tables = [];
  const add = (value) => {
    if (typeof value === 'string' && value && !tables.includes(value)) tables.push(value);
  };
  add(argumentsOf(call).table_name);
  for (const event of childEventsOf(call, events)) {
    if (CONSUMING_CHILD_TYPES.has(event.type)) add(event.data?.table);
  }
  return tables;
}

/** Everything a later call could have copied an id out of: the text and the structured result. */
function resultText(call) {
  const parts = [];
  if (typeof call.text_preview === 'string') parts.push(call.text_preview);
  if (call.structured_content !== null && call.structured_content !== undefined) {
    try {
      parts.push(JSON.stringify(call.structured_content));
    } catch {
      // A result that will not serialise cannot be searched; the other half still can.
    }
  }
  return parts.join('\n');
}

/** The id-shaped arguments of one call, as `{key, value}`; `to.payee_id` is reported as `to.payee_id`. */
export function idArgumentsOf(call) {
  const args = argumentsOf(call);
  const found = [];
  for (const key of ID_ARGUMENT_KEYS) {
    if (typeof args[key] === 'string' && args[key]) found.push({ key, value: args[key] });
  }
  const to = args.to;
  if (to && typeof to === 'object' && typeof to.payee_id === 'string' && to.payee_id) {
    found.push({ key: 'to.payee_id', value: to.payee_id });
  }
  return found;
}

/** `create_transfer` shape: what the transfer is, ignoring whether it is a preview or a confirm. */
function transferShape(call) {
  const args = argumentsOf(call);
  let destination = null;
  if (args.to && typeof args.to === 'object') {
    destination = args.to.payee_id ?? args.to.account_id ?? JSON.stringify(args.to);
  } else if (typeof args.to === 'string') {
    destination = args.to;
  }
  return {
    from: args.from_account_id ?? null,
    destination: destination ?? null,
    amount: args.amount ?? null,
    currency: args.currency ?? 'USD',
    confirm: Boolean(args.confirm),
    expected: args.expected_total_amount ?? null,
  };
}

function previewIdOf(call, byId) {
  for (const event of childEventsOf(call, byId)) {
    if (event.type === 'bank.op' && typeof event.data?.preview_id === 'string') {
      return event.data.preview_id;
    }
  }
  return null;
}

/**
 * `from_request_id` travels with the link because a connector names its source as `from #N`, the
 * JSON-RPC id: the per-episode step number it used to print is gone, and the id is now the only
 * number a call has.
 */
function link(from, to, kind, label, detail) {
  return { from: from.key, to: to.key, from_request_id: from.request_id, kind, label, detail };
}

/**
 * Every observed hand-off between the calls, in `to` order. A call can have more than one incoming
 * link (a confirm that both names a preview and quotes a payee id); duplicates of the same pair are
 * collapsed onto the strongest kind.
 */
export function buildLinks(calls, events) {
  const byId = indexEvents(events);
  const ordered = [...calls];
  const facts = ordered.map((call) => ({
    call,
    produced: tableProduced(call, byId),
    consumed: tablesConsumed(call, byId),
    result: resultText(call),
  }));

  const links = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const call = ordered[index];
    const here = facts[index];

    // `table`: the nearest earlier call that touched the same scratch table, whether it created it
    // or worked on it. Walking back to the *nearest* one is what turns a load with four consumers
    // into a chain rather than a star.
    for (const table of here.consumed) {
      for (let back = index - 1; back >= 0; back -= 1) {
        const earlier = facts[back];
        if (earlier.produced !== table && !earlier.consumed.includes(table)) continue;
        links.push(
          link(
            earlier.call,
            call,
            'table',
            `table ${table}`,
            `${call.tool} works on the scratch table ${table}, which ${earlier.call.tool} ${
              earlier.produced === table ? 'created' : 'last worked on'
            } at ${earlier.call.started_at}.`,
          ),
        );
        break;
      }
    }

    // `preview`: a confirmed transfer against the preview of the same transfer.
    const shape = transferShape(call);
    if (call.tool === 'create_transfer' && shape.confirm) {
      for (let back = index - 1; back >= 0; back -= 1) {
        const earlier = ordered[back];
        if (earlier.tool !== 'create_transfer') continue;
        const previous = transferShape(earlier);
        if (previous.confirm) continue;
        if (
          previous.from !== shape.from ||
          previous.destination !== shape.destination ||
          previous.amount !== shape.amount
        ) {
          continue;
        }
        const previewId = previewIdOf(earlier, byId);
        const quoted =
          shape.expected === null || shape.expected === undefined
            ? 'The confirm repeats the same source, destination and amount.'
            : `The confirm carries expected_total_amount ${money(
                shape.expected,
                shape.currency,
              )}, which is the preview's total quoted back.`;
        links.push(
          link(
            earlier,
            call,
            'preview',
            `preview ${money(shape.amount, shape.currency)}`,
            `${quoted}${previewId ? ` Both calls name preview ${previewId}.` : ''}`,
          ),
        );
        break;
      }
    }

    // `id`: an argument that occurs verbatim in an earlier result.
    for (const { key, value } of idArgumentsOf(call)) {
      for (let back = index - 1; back >= 0; back -= 1) {
        if (!facts[back].result.includes(value)) continue;
        links.push(
          link(
            ordered[back],
            call,
            'id',
            `${key} ${value}`,
            `${value} was passed as ${key}; it appears verbatim in what ${ordered[back].tool} returned at ${ordered[back].started_at}.`,
          ),
        );
        break;
      }
    }
  }

  return dedupeLinks(links);
}

/** One link per (from, to) pair, keeping the strongest kind. */
function dedupeLinks(links) {
  const best = new Map();
  for (const candidate of links) {
    const key = `${candidate.from}\u0000${candidate.to}`;
    const existing = best.get(key);
    if (!existing || LINK_PRIORITY[candidate.kind] < LINK_PRIORITY[existing.kind]) {
      best.set(key, candidate);
    }
  }
  return [...best.values()];
}

/** When the call finished, in epoch ms; its start when it never did. */
function finishedEpoch(call) {
  const finished = call.finished_at ? Date.parse(call.finished_at) : NaN;
  if (Number.isFinite(finished)) return finished;
  const started = call.started_epoch ?? Date.parse(call.started_at);
  const duration = Number(call.duration_ms);
  if (Number.isFinite(started) && Number.isFinite(duration)) return started + duration;
  return Number.isFinite(started) ? started : null;
}

function startEpoch(call) {
  const started = call.started_epoch ?? Date.parse(call.started_at);
  return Number.isFinite(started) ? started : null;
}

/**
 * The `intent.inferred` in force at each call: the latest one the server emitted at or before the
 * call started. It is the server's classification of the tool sequence, never the model's own words.
 */
function workflowIndex(events) {
  const list = [];
  for (const event of events instanceof Map ? events.values() : (events ?? [])) {
    if (event.type !== 'intent.inferred') continue;
    list.push({
      id: event.id,
      workflow: event.data?.workflow ?? null,
      confidence: Number(event.data?.confidence ?? 0),
      tools: event.data?.tools ?? [],
    });
  }
  list.sort((a, b) => a.id - b.id);
  return list;
}

function workflowAt(index, eventId) {
  let found = null;
  for (const entry of index) {
    if (entry.id > eventId) break;
    found = entry;
  }
  return found;
}

/** Why this call opened an episode instead of extending the one before it. */
function boundaryReason({ workflowChanged, gapMs, previousClosing, first }) {
  if (first) return 'first';
  if (workflowChanged) return 'workflow';
  if (previousClosing) return 'closed';
  if (gapMs !== null && gapMs > EPISODE_GAP_MS) return 'gap';
  return 'unlinked';
}

/**
 * Groups the calls into episodes. A call that is linked to something already in the current episode
 * always extends it, whatever the gap. An unlinked call opens a new episode when the inferred
 * workflow changed, when more than `EPISODE_GAP_MS` passed since the previous call finished, or
 * when the previous call was a closing tool; otherwise it extends the current one too.
 *
 * This grouping belongs to the dashboard. It is derived from tool arguments, results and clocks -
 * never from the conversation, which the server does not see.
 */
export function buildEpisodes(calls, links, events) {
  const byId = indexEvents(events);
  const workflows = workflowIndex(byId);
  const incoming = new Map();
  for (const item of links) {
    const list = incoming.get(item.to) ?? [];
    list.push(item);
    incoming.set(item.to, list);
  }

  const episodes = [];
  let current = null;
  let previous = null;
  let previousWorkflow = null;

  for (const call of calls) {
    const flow = workflowAt(workflows, call.event_id);
    const linksIn = (incoming.get(call.key) ?? []).filter(
      (item) => current && current.keys.has(item.from),
    );
    const gapMs =
      previous === null
        ? null
        : (() => {
            const from = finishedEpoch(previous);
            const to = startEpoch(call);
            return from === null || to === null ? null : to - from;
          })();
    const workflowChanged = (flow?.workflow ?? null) !== (previousWorkflow?.workflow ?? null);
    const previousClosing = isClosingCall(previous);
    const opens =
      current === null ||
      (linksIn.length === 0 &&
        (workflowChanged || (gapMs !== null && gapMs > EPISODE_GAP_MS) || previousClosing));

    if (opens) {
      current = {
        index: episodes.length + 1,
        calls: [],
        keys: new Set(),
        links: [],
        workflow: flow?.workflow ?? null,
        confidence: flow?.confidence ?? null,
        workflow_tools: flow?.tools ?? [],
        rationale: null,
        rationale_call_key: null,
        boundary: boundaryReason({
          workflowChanged,
          gapMs,
          previousClosing,
          first: previous === null,
        }),
        gap_ms: gapMs,
        started_at: call.started_at,
        ended_at: call.finished_at ?? call.started_at,
        duration_ms: 0,
        failures: 0,
        event_id: call.event_id,
      };
      episodes.push(current);
    }

    current.calls.push(call);
    current.keys.add(call.key);
    if (current.rationale === null && call.rationale_present && call.rationale) {
      current.rationale = call.rationale;
      current.rationale_call_key = call.key;
    }
    // A later `intent.inferred` describes the sequence the episode is still building.
    if (flow && (current.workflow === null || flow.id >= (current.workflow_event_id ?? 0))) {
      current.workflow = flow.workflow;
      current.confidence = flow.confidence;
      current.workflow_tools = flow.tools;
      current.workflow_event_id = flow.id;
    }
    if (call.status === 'error' || call.status === 'denied') current.failures += 1;
    current.ended_at = call.finished_at ?? call.started_at;
    const from = startEpoch(current.calls[0]);
    const to = finishedEpoch(call);
    current.duration_ms = from === null || to === null ? null : Math.max(0, to - from);

    previous = call;
    previousWorkflow = flow;
  }

  // Which episode each call landed in, so a link can say whether it crosses one. A call whose only
  // source is in an earlier episode is still connected - it just did not pull that call in with it.
  const episodeOfCall = new Map();
  for (const episode of episodes) {
    for (const call of episode.calls) episodeOfCall.set(call.key, episode.index);
  }
  for (const item of links) {
    item.from_episode = episodeOfCall.get(item.from) ?? null;
    item.to_episode = episodeOfCall.get(item.to) ?? null;
    item.crosses_episode = item.from_episode !== item.to_episode;
  }
  for (const episode of episodes) {
    episode.links = links.filter((item) => item.to_episode === episode.index);
    delete episode.keys;
  }
  return episodes;
}

/**
 * The threads inside one episode: each an unbroken chain of calls that pass the same artefact along.
 *
 * An episode can hold several pieces of work running at once - three `load_*` calls followed by
 * three `process_data`, three `execute_query` and three `clear_table`, interleaved in time. Drawn
 * as one column those read as badly as the flat list did, because the connector jumps between three
 * different tables. A call joins the thread of whatever it is linked to; a call linked to nothing
 * starts its own. A thread of one call is exactly that: a call that started and ended on its own.
 */
export function threadsOf(episode, incoming, events) {
  const byId = indexEvents(events);
  const owner = new Map();
  const threads = [];
  for (const call of episode.calls) {
    const linksIn = (incoming.get(call.key) ?? []).filter(
      (item) => item.from_episode === episode.index,
    );
    let thread = null;
    for (const item of linksIn) {
      const candidate = owner.get(item.from);
      if (candidate) {
        thread = candidate;
        break;
      }
    }
    if (!thread) {
      const table = tableProduced(call, byId) ?? tablesConsumed(call, byId)[0] ?? null;
      thread = {
        index: threads.length + 1,
        calls: [],
        label: table ? `table ${table}` : null,
        kind: table ? 'table' : null,
        detail: table
          ? `Every call in this thread names the scratch table ${table}.`
          : null,
      };
      threads.push(thread);
    }
    if (thread.label === null && linksIn.length) {
      thread.label = linksIn[0].label;
      thread.kind = linksIn[0].kind;
      thread.detail = linksIn[0].detail;
    }
    thread.calls.push(call);
    owner.set(call.key, thread);
  }
  return threads;
}

/** The incoming links of each call, keyed by call key; the panel draws one connector per entry. */
export function incomingLinks(links) {
  const map = new Map();
  for (const item of links) {
    const list = map.get(item.to) ?? [];
    list.push(item);
    map.set(item.to, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => LINK_PRIORITY[a.kind] - LINK_PRIORITY[b.kind]);
  }
  return map;
}

/** `buildLinks` and `buildEpisodes` in one pass, which is how the panel uses them. */
export function buildChain(calls, events) {
  const links = buildLinks(calls, events);
  return { links, episodes: buildEpisodes(calls, links, events) };
}

// ---------------------------------------------------------------------------
// What one step shows on its `in` and `out` lines
// ---------------------------------------------------------------------------

/** Argument keys whose value is a date, so the pair can be collapsed into a range. */
const DATE_KEYS = ['from_date', 'to_date'];
/** Argument keys printed as money rather than as a bare integer of cents (Decision D-1). */
const MONEY_KEYS = new Set(['amount', 'expected_total_amount', 'amount_cents']);

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function compactValue(key, value, currency) {
  if (MONEY_KEYS.has(key)) return money(value, currency);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * The arguments worth putting on one line: `rationale` is left out unless `withRationale` asks for
 * it, and then it keeps the position the model wrote it in and is marked `rationale: true`; empty
 * values are dropped, a date pair is collapsed into a range and SQL is clipped to a single line.
 */
export function describeIn(call, { withRationale = false } = {}) {
  const args = argumentsOf(call);
  const currency = typeof args.currency === 'string' ? args.currency : 'USD';
  const parts = [];

  if (call.status === 'denied' && !call.rationale_present && Object.keys(args).length === 0) {
    return [{ key: null, value: 'the gate answered before the arguments were read', muted: true }];
  }

  const from = args.from_date;
  const to = args.to_date;
  if (!isEmptyValue(from) || !isEmptyValue(to)) {
    parts.push({ key: 'dates', value: `${from ?? 'any'} to ${to ?? 'any'}` });
  }

  for (const [key, value] of Object.entries(args)) {
    if (key === 'rationale') {
      if (withRationale && typeof value === 'string' && value.length) {
        parts.push({ key, value, rationale: true });
      }
      continue;
    }
    if (DATE_KEYS.includes(key)) continue;
    if (isEmptyValue(value)) continue;
    if (key === 'query' || key === 'sql') {
      parts.push({ key, value: oneLineSql(value), sql: true, full: String(value) });
      continue;
    }
    // `{to: {payee_id: ...}}` reads better flattened than as JSON; anything richer stays as JSON.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      if (entries.length === 1) {
        parts.push({ key: `${key}.${entries[0][0]}`, value: compactValue(key, entries[0][1], currency) });
        continue;
      }
    }
    parts.push({ key, value: compactValue(key, value, currency) });
  }

  if (parts.length === 0) {
    parts.push({
      key: null,
      value: typeof args.rationale === 'string' ? 'a rationale and nothing else' : 'no arguments',
      muted: true,
    });
  }
  return parts;
}

/** What came back, in as few words as carry the fact. */
export function describeOut(call, events, options = {}) {
  const byId = indexEvents(events);
  const status = options.status ?? call.status;
  if (status === 'running') {
    return [
      {
        value: options.frozen ? 'the result is beyond the pause point' : 'still running',
        muted: true,
      },
    ];
  }
  if (status === 'denied') {
    const missing = (call.missing_scopes ?? []).join(', ');
    return [
      { value: 'denied before it ran', tone: 'denied' },
      missing ? { value: `missing ${missing}`, muted: true } : null,
    ].filter(Boolean);
  }
  if (status === 'cancelled') {
    return [{ value: `cancelled: ${call.cancel_reason ?? 'no reason given'}`, tone: 'warn' }];
  }

  const parts = [];
  const table = tableProduced(call, byId);
  for (const event of childEventsOf(call, byId)) {
    const data = event.data ?? {};
    if (event.type === 'etl.load') {
      parts.push({ value: `table ${data.table}`, mono: true });
      parts.push({ value: `${data.rows} rows`, muted: true });
    }
    if (event.type === 'etl.processed') {
      parts.push({ value: `${(data.columns_selected ?? []).length} columns kept`, muted: true });
    }
    if (event.type === 'sql.query') {
      parts.push({ value: `${data.rows_returned} rows` });
      if (data.capped) parts.push({ value: 'the 100-row cap bit', tone: 'warn' });
    }
    if (event.type === 'sql.rejected') {
      parts.push({ value: `SQL rejected: ${data.rejected_reason}`, tone: 'error' });
    }
    if (event.type === 'sql.table_cleared') {
      parts.push({ value: `table ${data.table} dropped`, mono: true });
    }
    if (event.type === 'bank.op' && data.audit_id) {
      parts.push({ value: `audit ${data.audit_id}`, mono: true });
    }
    if (event.type === 'bank.op' && data.preview_id && !data.audit_id) {
      parts.push({ value: `preview ${data.preview_id}`, mono: true });
    }
  }
  if (parts.length === 0 && table) parts.push({ value: `table ${table}`, mono: true });

  if (status === 'error' && call.error) {
    parts.push({ value: call.error.message, tone: 'error' });
  }
  if (parts.length === 0) {
    parts.push({ value: call.text_preview ? String(call.text_preview) : 'no result recorded', muted: !call.text_preview });
  }
  return parts;
}
