/**
 * The redaction pipeline (block: xray).
 *
 * Implements docs/XRAY_EVENT_MODEL.md section 3 verbatim. Every event passes through
 * `redactEventData` on its way into the ring buffer and the log; nothing else in the process is
 * allowed to write an event without it (CLAUDE.md invariant 11, "don't bypass the redaction
 * pipeline").
 *
 * The default is **verbatim**. All the bank data is fake and the brief asks the dashboard to show
 * "with which arguments", so this is a deny-list, never an allow-list:
 *
 *   - tokens, codes, verifiers and viewer JWTs never enter the log, by key name and by pattern;
 *   - account and card numbers are masked to the last four;
 *   - tool arguments are stored as the model wrote them except the per-tool deny-list from
 *     `src/contracts/tools.ts` plus `GLOBAL_REDACTION_PATTERNS`;
 *   - `remote_ip` is reduced to a `/24` prefix and the `anthropic_egress` flag;
 *   - `rationale` and SQL are stored verbatim (they are the product);
 *   - results are truncated to a 2 KB preview;
 *   - observer mode (`applyObserverRedaction`, applied at read time) hides arguments entirely and
 *     masks the rationale to 80 characters.
 *
 * Pure functions, no I/O: this file is what the unit tests of `__tests__/redaction.test.ts`
 * pin down.
 */
import { createHash } from 'node:crypto';

import {
  ANTHROPIC_EGRESS_CIDR,
  GLOBAL_REDACTION_PATTERNS,
  OBSERVER_RATIONALE_PREVIEW_CHARS,
  REDACTED_PLACEHOLDER,
  RESULT_PREVIEW_BYTES,
  getTool,
  type XrayEvent,
  type XrayEventType,
} from '../contracts/index.js';

// ---------------------------------------------------------------------------
// Limits. A producer is never trusted to be small: a pathological payload would otherwise sit on
// the main event loop inside JSON.stringify (the emitter must never block a producer).
// ---------------------------------------------------------------------------

/** Longest string kept in any field but a result preview. */
export const MAX_STRING_CHARS = 16_384;
/** Longest `rationale` kept; longer text sets `rationale_truncated`. */
export const MAX_RATIONALE_CHARS = 8192;
/** Deepest object graph walked; anything below is replaced by a marker. */
export const MAX_DEPTH = 12;
/** Longest array kept; the tail is replaced by one marker string. */
export const MAX_ARRAY_ITEMS = 500;
/** Most object keys kept per object. */
export const MAX_OBJECT_KEYS = 200;
/**
 * Total characters one walk may keep. The per-string, per-array, per-key and per-depth caps each
 * bound one dimension and multiply together: 200 keys x 16,384 characters is a 3.3 MB event, and
 * `tool.call.started` copies arguments out of a body `src/mcp/index.ts` allows to be 4 MB. At the
 * shipped per-grant rate limit that fills the 10,000-event ring with tens of gigabytes in minutes,
 * so the walk needs a budget over the whole payload and not only over each part of it.
 */
export const MAX_EVENT_CHARS = 64_000;

const TRUNCATION_SUFFIX = '…[truncated]';
const DEPTH_MARKER = '[depth limit]';
const BUDGET_MARKER = '[event size limit]';

/**
 * Keys whose value never reaches the log, at any depth, in any event. Matched case-insensitively
 * after `-` and spaces are folded to `_` (`Set-Cookie` and `set cookie` both hit `set_cookie`).
 */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'bearer',
  'authorization',
  'proxy_authorization',
  'code_verifier',
  'client_secret',
  'secret',
  'password',
  'passphrase',
  'api_key',
  'apikey',
  'private_key',
  'cookie',
  'set_cookie',
  'jwt',
  'viewer_token',
  'viewer_jwt',
  'session_token',
  'txn',
  'txn_token',
  'pairing_code',
  'authorization_code',
  'credential',
  'credentials',
  'cvv',
  'cvc',
  'pin',
]);

/**
 * Fragments that make a key sensitive wherever they appear in its folded name.
 *
 * `SENSITIVE_KEYS` is an exact match, so `token_value`, `refresh_token_2` or `my_api_key` carried
 * their value verbatim into the log. None of this server's own secrets were exposed - every token
 * it mints is a JWT and is caught by the `eyJ` pattern - but a third-party credential a model
 * pastes into a tool argument was stored as written. Substrings keep the verbatim-arguments
 * promise of invariant 11 for ordinary fields while closing the near-miss names.
 */
export const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'token',
  'secret',
  'password',
  'passphrase',
  'verifier',
  'credential',
  'api_key',
  'apikey',
  'private_key',
  'cookie',
  'jwt',
  'bearer',
];

/**
 * Folded key names that contain a sensitive fragment but carry no secret. OAuth metadata is the
 * whole list: `token_endpoint_auth_method` is the string `none`, and the dashboard's client panel
 * displays it (`public/catalogue.js`). Exact names only, so a near-miss around one of these is
 * still caught by the fragments above.
 */
export const SENSITIVE_KEY_EXCEPTIONS: ReadonlySet<string> = new Set([
  'token_type',
  'token_endpoint',
  'token_endpoint_auth_method',
  'token_endpoint_auth_methods_supported',
]);

/** True when a folded key name is sensitive by exact match or by fragment. */
export function isSensitiveKey(folded: string): boolean {
  if (SENSITIVE_KEYS.has(folded)) return true;
  if (SENSITIVE_KEY_EXCEPTIONS.has(folded)) return false;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => folded.includes(fragment));
}

/** Keys whose value is masked to its last four characters rather than removed. */
export const MASKED_NUMBER_KEYS: ReadonlySet<string> = new Set([
  'account_number',
  'card_number',
  'routing_number',
  'iban',
  'swift',
  'pan',
]);

/**
 * Keys that carry an identifier which *may* be a bare number. `acc_9f3a` keeps its correlation
 * value; a raw digit run is masked. bank-core masks these before it emits (`bank.op`), so this is
 * defence in depth.
 */
export const IDENTIFIER_KEYS: ReadonlySet<string> = new Set(['account_id', 'card_id']);

/**
 * A bare 13-19 digit run (a PAN typed into a free-text field) is masked wherever it appears -
 * but only when it passes the Luhn checksum, so a 13-digit epoch-millisecond string or an order
 * number is left alone. Every real card number passes Luhn; a random long number passes about one
 * time in ten.
 */
const CARD_NUMBER_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;

/** The Luhn checksum, over the digits only. */
export function passesLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function looksLikeCardNumber(candidate: string): boolean {
  return passesLuhn(candidate.replace(/[\s-]/g, ''));
}

/** Global copies of the contract patterns: `String.replaceAll` needs the `g` flag. */
const GLOBAL_PATTERNS: readonly RegExp[] = GLOBAL_REDACTION_PATTERNS.map((pattern) =>
  pattern.flags.includes('g') ? pattern : new RegExp(pattern.source, `${pattern.flags}g`),
);

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Folds a key to the form the deny-lists are written in. */
export function normaliseKey(key: string): string {
  return key.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/** A short, stable, one-way hash. Used for pairing codes; never reversible. */
export function shortHash(value: string, length = 16): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/** `****1234`: the last four characters of a number, and nothing else. */
export function maskToLastFour(value: string): string {
  const compact = value.replace(/[\s-]/g, '');
  if (compact.length <= 4) return '****';
  return `****${compact.slice(-4)}`;
}

/** Masks a value that looks like a bare account or card number; leaves prefixed ids alone. */
export function maskNumberLike(value: string): string {
  if (/^\*{2,}/.test(value)) return value;
  const compact = value.replace(/[\s-]/g, '');
  // Six digits or more with nothing else: an account or card number, not an `acc_`-prefixed id.
  return /^\d{6,}$/.test(compact) ? maskToLastFour(compact) : value;
}

/** Only the `/24` prefix of a caller's address is ever stored (invariant 11). */
export function ipPrefixOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const trimmed = address.trim();
  if (trimmed === '') return null;
  // Already reduced by a producer.
  if (/\/\d{1,3}$/.test(trimmed)) return trimmed;
  const plain = trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
  const octets = plain.split('.');
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  const hextets = plain.split(':').filter(Boolean);
  if (hextets.length === 0) return null;
  return `${hextets.slice(0, 3).join(':')}::/48`;
}

function ipv4ToInteger(address: string): number | null {
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  const octets = plain.split('/')[0]?.split('.') ?? [];
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const part = Number(octet);
    if (part > 255) return null;
    value = value * 256 + part;
  }
  return value;
}

const [EGRESS_BASE, EGRESS_BITS] = ((): [number | null, number] => {
  const [network, bits] = ANTHROPIC_EGRESS_CIDR.split('/');
  return [ipv4ToInteger(network ?? ''), Number(bits ?? 32)];
})();

/** True when the address is inside Anthropic's documented egress range (`160.79.104.0/21`). */
export function isAnthropicEgress(address: string | null | undefined): boolean {
  if (!address || EGRESS_BASE === null) return false;
  const value = ipv4ToInteger(address);
  if (value === null) return false;
  const mask = EGRESS_BITS === 0 ? 0 : (-1 << (32 - EGRESS_BITS)) >>> 0;
  return ((value & mask) >>> 0) === ((EGRESS_BASE & mask) >>> 0);
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

interface WalkOptions {
  /** Keys replaced by `[redacted]` on top of `SENSITIVE_KEYS` (the per-tool deny-list). */
  readonly denyKeys: ReadonlySet<string>;
  /** False inside a `arguments` / `_meta` subtree: those are stored as the model wrote them. */
  readonly maskIdentifiers: boolean;
}

interface WalkState {
  readonly redacted: string[];
  /** The containers on the path being walked, not every container met: only an ancestor is a cycle. */
  readonly seen: WeakSet<object>;
  /** Characters this walk may still keep; see `MAX_EVENT_CHARS`. */
  remaining: number;
}

function freshState(budget = MAX_EVENT_CHARS): WalkState {
  return { redacted: [], seen: new WeakSet(), remaining: budget };
}

function record(state: WalkState, path: string): void {
  if (path !== '' && !state.redacted.includes(path)) state.redacted.push(path);
}

/** Applies the pattern deny-list, the bare-PAN mask and the length cap to one string. */
function redactString(value: string, path: string, state: WalkState): string {
  let output = value;
  for (const pattern of GLOBAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(output)) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, REDACTED_PLACEHOLDER);
    }
  }
  CARD_NUMBER_PATTERN.lastIndex = 0;
  if (CARD_NUMBER_PATTERN.test(output)) {
    CARD_NUMBER_PATTERN.lastIndex = 0;
    output = output.replace(CARD_NUMBER_PATTERN, (match) =>
      looksLikeCardNumber(match) ? maskToLastFour(match) : match,
    );
  }
  if (output !== value) record(state, path);
  if (output.length > MAX_STRING_CHARS) {
    output = `${output.slice(0, MAX_STRING_CHARS)}${TRUNCATION_SUFFIX}`;
    record(state, path);
  }
  // The whole-payload budget, on top of the per-string cap: 200 keys of 16,384 characters each is
  // a 3.3 MB event even though every individual string is inside its own limit.
  if (output.length > state.remaining) {
    output = `${output.slice(0, Math.max(0, state.remaining))}${BUDGET_MARKER}`;
    state.remaining = 0;
    record(state, path);
  } else {
    state.remaining -= output.length;
  }
  return output;
}

function walk(
  value: unknown,
  path: string,
  depth: number,
  options: WalkOptions,
  state: WalkState,
): unknown {
  if (value === null || value === undefined) return null;
  const kind = typeof value;
  if (kind === 'string') return redactString(value as string, path, state);
  if (kind === 'number') return Number.isFinite(value as number) ? value : null;
  if (kind === 'boolean') return value;
  if (kind === 'bigint') return (value as bigint).toString();
  if (kind === 'function' || kind === 'symbol') return null;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return DEPTH_MARKER;

  const asObject = value as object;
  if (state.seen.has(asObject)) return '[circular]';
  state.seen.add(asObject);
  try {
    return walkContainer(asObject, path, depth, options, state);
  } finally {
    // Ancestor-scoped: one sub-object shared by several siblings (the catalog's `rationale`
    // property, for one) is walked every time; otherwise the second copy would be stored as
    // "[circular]" with nothing in `redacted_fields` to say so (invariant 13).
    state.seen.delete(asObject);
  }
}

function walkContainer(
  value: object,
  path: string,
  depth: number,
  options: WalkOptions,
  state: WalkState,
): unknown {
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    const kept = value.slice(0, MAX_ARRAY_ITEMS);
    for (const [index, item] of kept.entries()) {
      if (state.remaining <= 0) {
        items.push(`${BUDGET_MARKER}: ${kept.length - index} more items dropped`);
        record(state, path);
        return items;
      }
      const childPath = path === '' ? `[${index}]` : `${path}[${index}]`;
      items.push(walk(item, childPath, depth + 1, options, state));
    }
    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items truncated]`);
    }
    return items;
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS);
  let index = 0;
  for (const [key, child] of entries) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (state.remaining <= 0) {
      output[BUDGET_MARKER] = `${entries.length - index} more keys dropped`;
      record(state, path === '' ? key : path);
      return output;
    }
    index += 1;
    const folded = normaliseKey(key);
    if (isSensitiveKey(folded) || options.denyKeys.has(folded)) {
      output[key] = REDACTED_PLACEHOLDER;
      record(state, childPath);
      continue;
    }
    if (MASKED_NUMBER_KEYS.has(folded)) {
      output[key] = typeof child === 'string' ? maskToLastFour(child) : REDACTED_PLACEHOLDER;
      record(state, childPath);
      continue;
    }
    if (options.maskIdentifiers && IDENTIFIER_KEYS.has(folded) && typeof child === 'string') {
      const masked = maskNumberLike(child);
      if (masked !== child) record(state, childPath);
      output[key] = masked;
      continue;
    }
    output[key] = walk(child, childPath, depth + 1, options, state);
  }
  return output;
}

// ---------------------------------------------------------------------------
// Per-event-type rules
// ---------------------------------------------------------------------------

/** The per-tool deny-list from the frozen catalog, folded to the walker's key form. */
export function denyKeysForTool(tool: unknown): ReadonlySet<string> {
  if (typeof tool !== 'string') return new Set();
  const entry = getTool(tool);
  if (!entry) return new Set();
  return new Set(entry.redactionDenyList.map(normaliseKey));
}

/** Truncates one string to the 2 KB result preview of section 3. */
export function previewOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length <= RESULT_PREVIEW_BYTES
    ? value
    : `${value.slice(0, RESULT_PREVIEW_BYTES)}${TRUNCATION_SUFFIX}`;
}

/** Structured content is kept whole while it is small, and previewed as JSON when it is not. */
function truncateStructured(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  let serialised: string;
  try {
    serialised = JSON.stringify(value) ?? 'null';
  } catch {
    return { truncated: true, preview: '[unserialisable]' };
  }
  if (serialised.length <= RESULT_PREVIEW_BYTES) return value;
  return { truncated: true, preview: serialised.slice(0, RESULT_PREVIEW_BYTES) };
}

export interface RedactionResult {
  readonly data: Record<string, unknown>;
  /** Dotted paths inside `data` that the pipeline changed. */
  readonly redacted_fields: readonly string[];
}

/**
 * Redacts one event payload. `type` selects the extra rules; everything else goes through the
 * same deny-list walker, so a field nobody thought about is still covered by key and by pattern.
 */
export function redactEventData(type: XrayEventType | string, data: unknown): RedactionResult {
  const state: WalkState = freshState();
  const source: Record<string, unknown> =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>) }
      : {};

  // `tool.call.started` is the one payload with a per-tool deny-list, and the one place where
  // arguments are stored as the model wrote them (section 3).
  if (type === 'tool.call.started') {
    const denyKeys = denyKeysForTool(source.tool);
    // Its own budget: arguments must not squeeze out the envelope fields, nor the reverse.
    const argumentState: WalkState = freshState();
    const args = walk(
      source.arguments ?? {},
      'arguments',
      1,
      { denyKeys, maskIdentifiers: false },
      argumentState,
    );
    const meta =
      source.meta === null || source.meta === undefined
        ? null
        : walk(source.meta, 'meta', 1, { denyKeys, maskIdentifiers: false }, argumentState);

    const rationale = typeof source.rationale === 'string' ? source.rationale : null;
    const overLength = rationale !== null && rationale.length > MAX_RATIONALE_CHARS;
    const declaredTruncated = source.rationale_truncated === true;

    const rest = walk(
      { ...source, arguments: undefined, meta: undefined, rationale: undefined },
      '',
      0,
      { denyKeys: new Set(), maskIdentifiers: true },
      state,
    ) as Record<string, unknown>;
    delete rest.arguments;
    delete rest.meta;
    delete rest.rationale;

    const fields = [
      ...new Set([
        ...toStringArray(source.redacted_fields),
        ...argumentState.redacted,
        ...state.redacted,
      ]),
    ];
    return {
      data: {
        ...rest,
        arguments: args ?? {},
        meta,
        // The rationale is the product: stored verbatim, only capped against a pathological size.
        rationale: overLength ? `${rationale.slice(0, MAX_RATIONALE_CHARS)}${TRUNCATION_SUFFIX}` : rationale,
        rationale_present: source.rationale_present ?? (rationale !== null && rationale !== ''),
        rationale_truncated: declaredTruncated || overLength,
        redacted_fields: fields,
      },
      redacted_fields: fields,
    };
  }

  if (type === 'http.request') {
    // `remote_ip` never reaches an event; the `/24` prefix and the egress flag do (section 3).
    const rawIp =
      typeof source.remote_ip === 'string'
        ? source.remote_ip
        : typeof source.remote_ip_prefix === 'string'
          ? source.remote_ip_prefix
          : null;
    if (typeof source.remote_ip === 'string') state.redacted.push('remote_ip');
    const egress =
      source.anthropic_egress === true ||
      (typeof source.remote_ip === 'string' && isAnthropicEgress(source.remote_ip));
    delete source.remote_ip;
    source.remote_ip_prefix = ipPrefixOf(rawIp);
    source.anthropic_egress = egress;
  }

  if (type === 'tool.call.completed') {
    source.text_preview = previewOf(source.text_preview);
    source.structured_content = truncateStructured(source.structured_content);
  }

  if (type === 'xray.pairing.created' || type === 'xray.pairing.rejected') {
    // The plaintext code never enters the log, whoever passed it (contract: `code` is hashed).
    if (typeof source.code === 'string' && source.code.startsWith('BANK-')) {
      source.code = shortHash(source.code);
      state.redacted.push('code');
    }
  }

  if (type === 'intent.declared') {
    // Verbatim, and always labelled as written by the model, not by the user.
    source.model_authored = true;
  }

  const walked = walk(source, '', 0, { denyKeys: new Set(), maskIdentifiers: true }, state) as Record<
    string,
    unknown
  >;
  const fields = [...new Set([...toStringArray(source.redacted_fields), ...state.redacted])];
  if (Array.isArray(source.redacted_fields)) walked.redacted_fields = fields;
  return { data: walked, redacted_fields: fields };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// ---------------------------------------------------------------------------
// Observer mode (read time)
// ---------------------------------------------------------------------------

/**
 * The extra masking an admin viewer sees (section 3, Decision D-5): arguments hidden entirely,
 * rationale cut to its first 80 characters. Applied on the way out, never on the way in, because
 * the same stored event also serves the pairing viewer who owns the login.
 */
export function applyObserverRedaction(event: XrayEvent): XrayEvent {
  if (event.type === 'tool.call.started') {
    const rationale = event.data.rationale;
    const masked =
      typeof rationale === 'string' && rationale.length > OBSERVER_RATIONALE_PREVIEW_CHARS
        ? `${rationale.slice(0, OBSERVER_RATIONALE_PREVIEW_CHARS)}${TRUNCATION_SUFFIX}`
        : rationale;
    return {
      ...event,
      data: {
        ...event.data,
        arguments: {},
        rationale: masked,
        rationale_truncated:
          event.data.rationale_truncated ||
          (typeof rationale === 'string' && rationale.length > OBSERVER_RATIONALE_PREVIEW_CHARS),
        redacted_fields: [...new Set([...event.data.redacted_fields, 'arguments'])],
      },
    };
  }
  if (event.type === 'intent.declared') {
    const text = event.data.text;
    if (text.length <= OBSERVER_RATIONALE_PREVIEW_CHARS) return event;
    return {
      ...event,
      data: {
        ...event.data,
        text: `${text.slice(0, OBSERVER_RATIONALE_PREVIEW_CHARS)}${TRUNCATION_SUFFIX}`,
        truncated: true,
      },
    };
  }
  return event;
}
