/**
 * Display formatting for the X-ray dashboard (block: dashboard).
 *
 * Every string a panel puts on screen that is not verbatim event data comes from here, so the
 * language rule (English everywhere) and the number conventions (USD cents, milliseconds,
 * character counts) have exactly one home. Pure functions; no DOM, no imports.
 */

const TWO = (value) => String(value).padStart(2, '0');
const THREE = (value) => String(value).padStart(3, '0');

/** Parses an ISO-8601 timestamp to epoch milliseconds; `null` for anything unparseable. */
export function toEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `14:03:22.418` in the viewer's own time zone; the ISO string goes in a `title`. */
export function clockTime(value) {
  const epoch = toEpoch(value);
  if (epoch === null) return '--:--:--';
  const date = new Date(epoch);
  return `${TWO(date.getHours())}:${TWO(date.getMinutes())}:${TWO(date.getSeconds())}.${THREE(
    date.getMilliseconds(),
  )}`;
}

/** `14:03:22`, without the milliseconds: for spans, where two of them sit side by side. */
export function clockSeconds(value) {
  const epoch = toEpoch(value);
  if (epoch === null) return '--:--:--';
  const date = new Date(epoch);
  return `${TWO(date.getHours())}:${TWO(date.getMinutes())}:${TWO(date.getSeconds())}`;
}

/** `8 Sep, 14:03` for session headers. */
export function shortDateTime(value) {
  const epoch = toEpoch(value);
  if (epoch === null) return 'unknown';
  const date = new Date(epoch);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    date.getMonth()
  ];
  return `${date.getDate()} ${month}, ${TWO(date.getHours())}:${TWO(date.getMinutes())}`;
}

/** `6 ms`, `1.24 s`, `2 m 05 s`. Durations below a second keep whole milliseconds. */
export function duration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '-';
  const value = Number(ms);
  if (value < 1) return `${value.toFixed(value === 0 ? 0 : 2)} ms`;
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(2)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes} m ${TWO(seconds)} s`;
}

/** `300 s` - budgets are documented in seconds, so they are shown in seconds. */
export function seconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '-';
  return `${Math.round(value / 1000)} s`;
}

/** `3 s ago`, `4 min ago`, `in 12 min`. `now` is injected so tests are deterministic. */
export function relativeTime(value, now) {
  const epoch = toEpoch(value);
  if (epoch === null) return 'unknown';
  const deltaMs = epoch - now;
  const future = deltaMs > 0;
  const seconds = Math.round(Math.abs(deltaMs) / 1000);
  let text;
  if (seconds < 5) text = 'just now';
  else if (seconds < 60) text = `${seconds} s`;
  else if (seconds < 3600) text = `${Math.round(seconds / 60)} min`;
  else if (seconds < 86_400) text = `${Math.round(seconds / 3600)} h`;
  else text = `${Math.round(seconds / 86_400)} d`;
  if (text === 'just now') return text;
  return future ? `in ${text}` : `${text} ago`;
}

/** `expires in 58 min` / `expired 3 min ago` / `no expiry`. */
export function expiry(value, now) {
  const epoch = toEpoch(value);
  if (epoch === null) return 'no expiry';
  return epoch > now ? `expires ${relativeTime(value, now)}` : `expired ${relativeTime(value, now)}`;
}

/** `412 chars`, `12.3k chars`. */
export function charCount(value) {
  const count = Number(value ?? 0);
  if (!Number.isFinite(count)) return '0 chars';
  if (count < 1000) return `${count} chars`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k chars`;
  return `${(count / 1_000_000).toFixed(2)}M chars`;
}

/** `1,240` with thousands separators, for row and event counts. */
export function count(value) {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('en-US');
}

/** `1 table` / `3 tables`; irregular plurals take the third argument. */
export function plural(value, singular, pluralForm) {
  const number = Number(value ?? 0);
  return `${count(number)} ${number === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/** `12%`; `share(3, 4)` is `75%`. */
export function share(part, whole) {
  if (!whole) return '0%';
  return `${Math.round((Number(part) / Number(whole)) * 100)}%`;
}

/** Clamps a ratio into 0..1 for the width of a bar. */
export function ratio(part, whole) {
  if (!whole || !Number.isFinite(Number(whole))) return 0;
  const value = Number(part) / Number(whole);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Middle-truncates a long identifier: `grt_8a1e33...9f21`. */
export function shortId(value, keep = 14) {
  if (!value) return '-';
  const text = String(value);
  if (text.length <= keep + 4) return text;
  return `${text.slice(0, keep)}...${text.slice(-4)}`;
}

/** One-line clipping for previews; adds a real ellipsis so the clipping is visible. */
export function clip(value, max = 120) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Pretty JSON with a hard size cap, so a huge payload cannot freeze the page. */
export function prettyJson(value, maxChars = 20_000) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n… ${count(text.length - maxChars)} more characters not shown`;
}

/** Collapses SQL whitespace for the timeline row while keeping keyword casing verbatim. */
export function oneLineSql(sql) {
  return clip(String(sql ?? '').replace(/\s+/g, ' '), 96);
}

/** `snake_case` and `dotted.names` to `Sentence case` for labels the contract does not supply. */
export function humanise(value) {
  if (!value) return '';
  const text = String(value).replace(/[._]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `["a","b"]` -> `a, b`; an empty list reads as `none`. */
export function joinList(values, empty = 'none') {
  if (!Array.isArray(values) || values.length === 0) return empty;
  return values.join(', ');
}

/** Percentile over a numeric array (nearest-rank); used for the per-tool p50 and p95. */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index];
}

/**
 * USD cents to `$1,234.56` (Decision D-1: every amount is an integer of cents). Negative values
 * carry a leading minus; the currency code is printed only when it is not USD (`1,234.56 EUR`).
 */
export function money(cents, currency = 'USD') {
  const value = Number(cents);
  if (cents === null || cents === undefined || !Number.isFinite(value)) return '-';
  const rounded = Math.round(Math.abs(value));
  const units = Math.floor(rounded / 100).toLocaleString('en-US');
  const fraction = String(rounded % 100).padStart(2, '0');
  const sign = value < 0 && rounded !== 0 ? '-' : '';
  const code = String(currency ?? 'USD').toUpperCase();
  if (code === 'USD') return `${sign}$${units}.${fraction}`;
  return `${sign}${units}.${fraction} ${code}`;
}
