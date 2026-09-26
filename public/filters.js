/**
 * The timeline filter language (block: dashboard).
 *
 * `tool:` `type:` `status:` `kind:` and `xs:` tokens, plus free text; a leading `-` negates a
 * token. `type:` matches a prefix, so `type:tool` keeps every `tool.*` event and
 * `type:tool.call.completed` keeps exactly one type. Everything else is matched against a small
 * haystack (type, tool, summary and the few data fields worth searching), never the whole
 * payload, so typing stays instant on a long session.
 *
 * Pure functions. No DOM.
 */
import { FAMILY_LABELS, familyOf, statusOf, summaryOf, toolOf } from './catalogue.js';

export const STATUS_VALUES = ['ok', 'error', 'warn', 'denied', 'running', 'notice', 'info'];

const EMPTY = {
  tools: [],
  types: [],
  kinds: [],
  statuses: [],
  sessions: [],
  text: [],
  negated: [],
  raw: '',
};

function pushToken(target, key, value, negated) {
  if (negated) {
    target.negated.push({ key, value });
    return;
  }
  target[key].push(value);
}

/** Parses the filter box into a plain object. Unknown prefixes fall through to free text. */
export function parseFilter(input) {
  const filter = {
    tools: [],
    types: [],
    kinds: [],
    statuses: [],
    sessions: [],
    text: [],
    negated: [],
    raw: String(input ?? ''),
  };
  const parts = String(input ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  for (const part of parts) {
    const negated = part.startsWith('-');
    const body = negated ? part.slice(1) : part;
    const colon = body.indexOf(':');
    const prefix = colon > 0 ? body.slice(0, colon).toLowerCase() : '';
    const value = colon > 0 ? body.slice(colon + 1) : body;
    if (!value) continue;
    switch (prefix) {
      case 'tool':
        pushToken(filter, 'tools', value, negated);
        break;
      case 'type':
        pushToken(filter, 'types', value.toLowerCase(), negated);
        break;
      case 'kind':
      case 'family':
        pushToken(filter, 'kinds', value.toLowerCase(), negated);
        break;
      case 'status':
        pushToken(filter, 'statuses', value.toLowerCase(), negated);
        break;
      case 'xs':
      case 'session':
        pushToken(filter, 'sessions', value, negated);
        break;
      default:
        pushToken(filter, 'text', body.toLowerCase(), negated);
        break;
    }
  }
  return filter;
}

export function isEmptyFilter(filter) {
  if (!filter) return true;
  return (
    filter.tools.length === 0 &&
    filter.types.length === 0 &&
    filter.kinds.length === 0 &&
    filter.statuses.length === 0 &&
    filter.sessions.length === 0 &&
    filter.text.length === 0 &&
    filter.negated.length === 0
  );
}

export const emptyFilter = () => ({ ...EMPTY, tools: [], types: [], kinds: [], statuses: [], sessions: [], text: [], negated: [] });

/** The small searchable string for one event. Deliberately not the whole payload. */
export function haystackOf(event) {
  const data = event?.data ?? {};
  const parts = [
    event?.type,
    toolOf(event),
    summaryOf(event),
    data.path,
    data.method,
    data.table,
    data.operation,
    data.sql,
    data.text,
    data.rationale,
    data.message,
    data.error,
    data.reason,
    data.rejected_reason,
    data.denied_reason,
    data.client_name,
    event?.xs,
    event?.request_id ? `#${event.request_id}` : null,
  ];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function matchesToken(event, key, value, haystack) {
  switch (key) {
    case 'tools':
      return (toolOf(event) ?? '').toLowerCase() === value.toLowerCase();
    case 'types':
      return String(event.type ?? '')
        .toLowerCase()
        .startsWith(value);
    case 'kinds':
      return familyOf(event.type) === value;
    case 'statuses':
      return statusOf(event) === value;
    case 'sessions':
      return (event.xs ?? '') === value;
    case 'text':
      return haystack.includes(value);
    default:
      return false;
  }
}

/**
 * True when the event should be shown. Positive tokens of the same key are OR-ed, different keys
 * are AND-ed, and any matching negated token hides the event.
 */
export function matchesFilter(filter, event) {
  if (!filter || isEmptyFilter(filter)) return true;
  const haystack = haystackOf(event);
  for (const { key, value } of filter.negated) {
    if (matchesToken(event, key, value, haystack)) return false;
  }
  for (const key of ['tools', 'types', 'kinds', 'statuses', 'sessions', 'text']) {
    const values = filter[key];
    if (!values.length) continue;
    if (!values.some((value) => matchesToken(event, key, value, haystack))) return false;
  }
  return true;
}

/** Human-readable chips for the active filter, so the viewer can see what is hiding rows. */
export function describeFilter(filter) {
  if (!filter || isEmptyFilter(filter)) return [];
  const chips = [];
  for (const tool of filter.tools) chips.push({ label: `tool ${tool}`, token: `tool:${tool}` });
  for (const type of filter.types) chips.push({ label: `type ${type}`, token: `type:${type}` });
  for (const kind of filter.kinds) {
    chips.push({ label: FAMILY_LABELS[kind] ?? kind, token: `kind:${kind}` });
  }
  for (const status of filter.statuses) {
    chips.push({ label: `status ${status}`, token: `status:${status}` });
  }
  for (const xs of filter.sessions) chips.push({ label: `session ${xs}`, token: `xs:${xs}` });
  for (const text of filter.text) chips.push({ label: `"${text}"`, token: text });
  for (const item of filter.negated) {
    chips.push({ label: `not ${item.value}`, token: `-${item.value}` });
  }
  return chips;
}

/** Adds or removes one token in a filter string, for the one-click chips. */
export function toggleToken(raw, token) {
  const parts = String(raw ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const index = parts.indexOf(token);
  if (index >= 0) {
    parts.splice(index, 1);
  } else {
    parts.push(token);
  }
  return parts.join(' ');
}
