/**
 * The uncategorised remainder of an event (block: dashboard, contracts v0.9, D-28).
 *
 * The server keeps every field it is given, whether or not the contract names it. Whatever an
 * event carries outside `ENVELOPE_KEYS` and its type's `DATA_KEYS` is returned here, verbatim, so
 * the inspector can show it under its own heading instead of burying it in the raw envelope. An
 * event type the dashboard does not know yet has all of its `data` unmapped.
 */
import { DATA_KEYS, ENVELOPE_KEYS } from './contract-keys.js';

const ENVELOPE = new Set(ENVELOPE_KEYS);

/** `{ envelope, data }` of the fields the contract does not name, or `null` when there are none. */
export function unmappedOf(event) {
  if (event === null || typeof event !== 'object') return null;
  const known = new Set(DATA_KEYS[event.type] ?? []);
  const envelope = Object.fromEntries(Object.entries(event).filter(([key]) => !ENVELOPE.has(key)));
  const data =
    event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)
      ? Object.fromEntries(Object.entries(event.data).filter(([key]) => !known.has(key)))
      : {};
  const any = Object.keys(envelope).length > 0 || Object.keys(data).length > 0;
  return any ? { envelope, data } : null;
}

/** How many unmapped fields an event carries, envelope and data together. */
export function unmappedCount(event) {
  const found = unmappedOf(event);
  return found === null ? 0 : Object.keys(found.envelope).length + Object.keys(found.data).length;
}
