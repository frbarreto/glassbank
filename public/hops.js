/**
 * The three hops of one tool call (block: dashboard).
 *
 * A tool call travels: the client app sends a JSON-RPC request, this server's gate reads it, our
 * engine does the work, and the server frames an answer. The timeline shows a row per event, which
 * is faithful and unreadable - it never says which of those four wrote any given value.
 *
 * This file builds the DATA for three panes - `requestHop`, `insideHop`, `responseHop` - where
 * every value carries the actor that authored it and every sentence that is not a stored fact says
 * where it came from. Nothing here renders: no DOM, no CSS, no clock (`clockTime` formats a stored
 * timestamp, it never reads one).
 *
 * Two rules decide most of what follows.
 *
 * 1. **Arrival order.** The request rows are read straight off `call.arguments`, in the order the
 *    keys arrived. `describeIn` in `chain.js` is deliberately not used: it hoists `from_date` and
 *    `to_date` into a synthetic `dates` part, which moves every later key - the `rationale`
 *    included - out of the position it actually arrived in. A pane whose whole claim is "as it
 *    arrived" cannot reorder its rows.
 * 2. **Implied is never recorded.** `method` is not a stored field; it is inferred from the event
 *    type, so its row wears the `page` actor and `implied: true`. Nothing implied may be drawn as
 *    a recorded value.
 *
 * Every length claim is derived from the strings themselves. `rationale_truncated` is set when the
 * incoming value exceeded 1,024 characters (`isRationaleTruncated` in `src/contracts/tools.ts`),
 * not 8,192, so the flag alone cannot tell the two caps apart.
 *
 * Pure functions over the read model of `store.js`.
 */
import { childEventsOf } from './chain.js';
import { clockTime, count, duration, oneLineSql, seconds } from './format.js';
import {
  ACTOR_LABELS,
  MISSING_REASONS,
  auditHandOff,
  engineBands,
  gateFacts,
} from './provenance.js';

/** What `src/xray/redaction.ts` appends to anything it cut. */
export const TRUNCATION_MARKER = '…[truncated]';
/** `RATIONALE_MAX_LENGTH`: what the handler and the audit row actually get. */
export const RATIONALE_HANDLER_CAP = 1024;
/** `MAX_RATIONALE_CHARS`: what this server keeps on `tool.call.started`. */
export const RATIONALE_RECORD_CAP = 8192;
/** `RESULT_PREVIEW_BYTES`: the producer's own cut, before the emitter's. */
export const RESULT_PREVIEW_CAP = 2048;
/** A share under this is noise on a bar and is not printed at all. */
export const RATIO_FLOOR = 0.05;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One line of a rebuilt envelope. `value` is the value as recorded, untouched, so a renderer can
 * hand an object to the JSON viewer and a string to a text node; `path` is where it sat in the
 * envelope, which is also how a renderer finds the raw value again.
 */
function row(path, key, value, actor, extra = {}) {
  return {
    path,
    key,
    value,
    actor,
    implied: false,
    redacted: false,
    port: null,
    emphasis: false,
    ...extra,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `xs_7b4d10#4` -> `4`. A call key is `<xs>#<request_id>` and the id is the only number we print. */
function requestIdOf(callKey) {
  const text = String(callKey ?? '');
  const hash = text.lastIndexOf('#');
  return hash === -1 ? text : text.slice(hash + 1);
}

// ---------------------------------------------------------------------------
// Ports: which argument a chain link feeds
// ---------------------------------------------------------------------------

/** The argument keys one incoming link is evidence for. */
function fedKeysOf(call, item) {
  const args = isObject(call.arguments) ? call.arguments : {};
  if (item.kind === 'table') {
    const table = String(item.label ?? '').replace(/^table\s+/, '');
    const matching = Object.keys(args).filter((key) => args[key] === table);
    if (matching.length > 0) return matching;
    return 'table_name' in args ? ['table_name'] : [];
  }
  if (item.kind === 'preview') {
    if ('expected_total_amount' in args) return ['expected_total_amount'];
    return 'confirm' in args ? ['confirm'] : [];
  }
  if (item.kind === 'id') {
    // `buildLinks` labels an id link `<key> <value>`; `to.payee_id` is nested under `to`.
    const key = String(item.label ?? '').split(' ')[0];
    const top = key.includes('.') ? key.slice(0, key.indexOf('.')) : key;
    return top in args ? [top] : [];
  }
  return [];
}

/**
 * `{argument key: 'from #4 · table'}` for every argument an incoming chain link feeds. Only links
 * whose `to` is this call are read, so the caller can hand over the whole link array.
 */
export function portsOf(call, links = []) {
  const ports = {};
  if (!call) return ports;
  for (const item of links ?? []) {
    if (!item || item.to !== call.key) continue;
    const label = `from #${requestIdOf(item.from)} · ${item.kind}`;
    for (const key of fedKeysOf(call, item)) {
      if (ports[key] === undefined) ports[key] = label;
    }
  }
  return ports;
}

// ---------------------------------------------------------------------------
// The rationale: where it sat, what happened to it
// ---------------------------------------------------------------------------

/** The `catalog.tools_listed` row for this tool, when the caller handed over the catalog. */
function catalogRowOf(call, catalog) {
  if (!catalog || !Array.isArray(catalog.tools)) return null;
  return catalog.tools.find((entry) => entry?.name === call.tool) ?? null;
}

/**
 * Where the `rationale` requirement comes from, on the page rail: a claim about the schema, not
 * about this call. Contracts v0.4 recorded no schema at all, so over that recording the honest
 * sentence is that the requirement is documented (ADR-8) and the schema itself was not kept.
 */
export function rationaleLocator(call, catalog) {
  const listingId = catalog?.event_id ?? null;
  if (listingId === null) {
    return 'params.arguments.rationale · required by every published schema (ADR-8); the tools/list that carried the schema was not recorded';
  }
  const entry = catalogRowOf(call, catalog);
  if (entry?.descriptor) {
    return `params.arguments.rationale · required by the schema sent at tools/list #${listingId}`;
  }
  return `params.arguments.rationale · required by every published schema (ADR-8); the schema itself was not recorded on tools/list #${listingId} (contracts v0.4)`;
}

/** True when a stored string still carries the marker the redactor appends to anything it cut. */
function endsCut(text) {
  return typeof text === 'string' && text.endsWith(TRUNCATION_MARKER);
}

/**
 * What the gate did with the rationale, on the server rail, built from the `intent.declared` child.
 *
 * The cap clauses are derived from the two stored copies rather than from `rationale_truncated`,
 * which is true for anything over 1,024 characters and so cannot tell "the handler got a shorter
 * copy" apart from "this server cut the record".
 */
export function rationaleNote(call, children = []) {
  if (!call) return null;
  const declared = (children ?? []).find((event) => event.type === 'intent.declared') ?? null;
  const declaredText = declared?.data?.text ?? call.rationale_declared ?? null;
  if (declared === null && declaredText === null) return null;

  const started = typeof call.rationale === 'string' ? call.rationale : '';
  const startedLength = started.length;
  const declaredLength = typeof declaredText === 'string' ? declaredText.length : 0;

  const clauses = [];
  if (startedLength >= RATIONALE_RECORD_CAP || endsCut(started)) {
    clauses.push('cut by this server at 8,192 characters');
  }
  if (
    startedLength > RATIONALE_HANDLER_CAP ||
    declaredLength > RATIONALE_HANDLER_CAP ||
    endsCut(declaredText)
  ) {
    clauses.push('the handler and the audit row kept the first 1,024 characters');
  }
  const cap = clauses.length === 0 ? 'not cut' : clauses.join('; ');
  const where = declared ? `intent.declared #${declared.id} at ${clockTime(declared.ts)}` : 'intent.declared';
  return `read first, at the gate: recorded as ${where} (${count(declaredLength)} chars, ${cap}), then removed before ${call.tool} received the arguments (src/tools/registry.ts)`;
}

/**
 * The A-06 chip for a call that carried no usable rationale: the server ran it anyway and recorded
 * the omission rather than refusing the call.
 */
export function missingRationale(call, children = []) {
  if (!call) return null;
  const missing = (children ?? []).find((event) => event.type === 'intent.missing') ?? null;
  if (!missing && call.rationale_present) return null;
  if (!missing) return null;
  const reason = missing.data?.reason ?? null;
  return {
    reason,
    event_id: missing.id,
    text: `no rationale to record: ${MISSING_REASONS[reason] ?? 'it was not usable'} (intent.missing #${missing.id}, A-06)`,
  };
}

// ---------------------------------------------------------------------------
// Hop 1: the request as it arrived
// ---------------------------------------------------------------------------

/** The sentence a denied call gets instead of arguments nobody recorded. */
const DENIED_SENTENCE = 'the bearer gate answered before the body was read: no arguments were recorded';

/** The sentence an observer gets instead of the arguments the server refuses to show them. */
const OBSERVER_SENTENCE = 'arguments withheld from observers by the server';

/** True when the gate answered before the body was read: nothing of the request was recorded. */
function answeredAtTheGate(call) {
  const args = isObject(call.arguments) ? call.arguments : {};
  return call.status === 'denied' && !call.rationale_present && Object.keys(args).length === 0;
}

function childrenFrom(call, options) {
  if (Array.isArray(options.children)) return options.children;
  if (options.events) return childEventsOf(call, options.events);
  return [];
}

/**
 * The JSON-RPC request rebuilt from `tool.call.started`, in arrival order.
 *
 * `links` are the chain links (`buildLinks`), used only to port an argument back to the call that
 * fed it; `viewer` is the `ViewerMeResponse` and chooses the wording of the observer line, never
 * whether it is drawn - that is read off `redacted_fields` (Decision D-5).
 *
 * The second parameter is the session, taken in the same position as `bandsOf` so a panel can hand
 * both functions the same three values. Nothing in this pane reads it: the client facts it carries
 * (name, version, protocol) were agreed once at `initialize` and are not part of this request.
 */
export function requestHop(call, _session = null, options = {}) {
  if (!call) return null;
  const { links = [], viewer = null, catalog = null } = options;
  const children = childrenFrom(call, options);
  const args = isObject(call.arguments) ? call.arguments : {};
  const redactedFields = call.redacted_fields ?? [];
  const withheld = redactedFields.includes('arguments');
  const denied = answeredAtTheGate(call);
  const ports = portsOf(call, links);

  const rows = [
    row('id', 'id', call.request_id, 'agent'),
    row('method', 'method', 'tools/call', 'page', { implied: true }),
    row('params.name', 'name', call.tool, 'model'),
  ];

  let rationaleRow = null;
  if (!denied && !withheld) {
    for (const [key, value] of Object.entries(args)) {
      const isRationale = key === 'rationale';
      const argumentRow = row(`params.arguments.${key}`, key, value, 'model', {
        redacted: redactedFields.includes(`arguments.${key}`),
        port: ports[key] ?? null,
        emphasis: isRationale,
      });
      rows.push(argumentRow);
      if (isRationale) rationaleRow = argumentRow;
    }
  }

  if (call.meta && Object.keys(call.meta).length > 0) {
    rows.push(row('params._meta', '_meta', call.meta, 'agent'));
  }

  let rationale = null;
  if (!denied) {
    rationale = {
      row: rationaleRow,
      locator: rationaleLocator(call, catalog),
      note: rationaleNote(call, children) ?? missingRationale(call, children)?.text ?? null,
    };
  }

  return {
    title: `REQUEST · tools/call · id ${call.request_id} · as it arrived`,
    rows,
    rationale,
    denied: denied
      ? row('params.arguments', null, DENIED_SENTENCE, 'server')
      : null,
    observer: withheld
      ? row('params.arguments', null, observerSentence(viewer), 'server')
      : null,
    footer: `rebuilt by this page from tool.call.started #${call.event_id}: id, params and _meta are stored fields, method is implied by the event type; the bytes on the wire were not kept`,
    rawEventId: call.event_id,
  };
}

/** The observer line is the same fact either way; only the second person changes. */
function observerSentence(viewer) {
  return viewer?.viewer_kind === 'admin'
    ? `${OBSERVER_SENTENCE}: you are reading in observer mode`
    : OBSERVER_SENTENCE;
}

// ---------------------------------------------------------------------------
// Hop 2: what happened inside
// ---------------------------------------------------------------------------

function cardLine(key, value, actor, extra = {}) {
  return { key, value: value === null || value === undefined ? null : String(value), actor, ...extra };
}

/** A band line, re-attributed to the actor of the card it sits on. */
function fromBandLine(line, actor) {
  return { key: line.key ?? null, value: line.value, actor, tone: line.tone ?? null };
}

/** Which of a band's keyed lines describe what went in rather than what came back. */
const CARD_INPUT_KEYS = {
  'etl.processed': ['table'],
  'sql.query': ['on table'],
  'sql.rejected': ['on table'],
  'sql.table_cleared': ['table'],
  'etl.table_evicted': ['table'],
  'etl.limit_reached': ['limit'],
  'auth.stepup.requested': ['scopes'],
};

/** Splits one engine band into what the step was given and what it produced. */
function portsOfCard(event, band) {
  const data = event.data ?? {};
  const keys = CARD_INPUT_KEYS[event.type] ?? [];
  const inLines = [];
  const outLines = [];
  band.lines.forEach((line, index) => {
    // The bank band opens with a bare line naming the operation; that is the input, not the result.
    const isOperation = event.type === 'bank.op' && index === 0 && !line.key;
    const isInput = isOperation || (line.key && keys.includes(line.key));
    (isInput ? inLines : outLines).push(fromBandLine(line, band.actor));
  });
  // The SQL is the model's own words, on a step our engine ran: the two rails differ on one card.
  if (typeof data.sql === 'string' && data.sql) {
    inLines.push(cardLine('sql', oneLineSql(data.sql), 'model', { full: data.sql }));
  }
  if (event.type === 'etl.load' && typeof data.source_tool === 'string') {
    inLines.unshift(cardLine('for', data.source_tool, 'server'));
  }
  return { in: inLines, out: outLines };
}

/**
 * The gate's own card. The "handed to" line is on the page rail on purpose: the arguments the
 * handler actually received are recorded nowhere. `src/tools/registry.ts` validates against the
 * lenient schema first (which fills its defaults in), then calls `stripRationale`, and only the
 * result of both reaches the handler - so this line is a mechanism, not an observation.
 */
function gateCard(call, children, n) {
  const facts = gateFacts(call, children);
  const inLines = [];
  if (facts.rationale) {
    inLines.push(
      cardLine('rationale', facts.rationale.text, 'server', {
        tone: facts.rationale.state === 'missing' ? 'warn' : null,
        event_id: facts.rationale.event_id,
      }),
    );
  }
  if (facts.scopes) {
    inLines.push(
      cardLine('scopes', facts.scopes.text, 'server', {
        tone: facts.scopes.granted ? null : 'error',
      }),
    );
  }
  inLines.push(cardLine('dropped before storing', facts.dropped.text, 'server'));
  if (facts.budget) inLines.push(cardLine('budget', facts.budget.text, 'server'));

  return {
    n,
    actor: 'server',
    title: 'checked it and wrote it down, before running anything',
    in: inLines,
    out: [
      cardLine(
        'handed to',
        `${call.tool} - the arguments it received were not recorded: the lenient schema fills its own defaults in first, then rationale is stripped, and only that reaches the handler (src/tools/registry.ts)`,
        'page',
      ),
    ],
    source: 'tool.call.started',
    event_id: call.event_id,
    note: 'This all happens before the tool runs, so a call that is about to be refused still leaves a record of what the model said it was doing.',
  };
}

/**
 * The classifier's card. `confidence` is how far the winning workflow beat the runner-up
 * (`0.4 + 0.45 x margin`, `src/tools/intent.ts`), so it is printed as `scored 0.85` and never as a
 * percentage.
 */
function classifierCard(inferred, n) {
  const data = inferred.data ?? {};
  const score = Number(data.confidence ?? 0);
  return {
    n,
    actor: 'server',
    title: 'guessed what the last few calls were for',
    in: data.tools?.length ? [cardLine('from these tools', data.tools.join(' → '), 'server')] : [],
    out: [
      cardLine('workflow', String(data.workflow ?? 'unknown').replace(/_/g, ' '), 'server'),
      cardLine('how clear a win', score <= 0.2 ? 'nothing scored' : `scored ${score.toFixed(2)}`, 'server'),
    ],
    source: 'intent.inferred',
    event_id: inferred.id,
    note: "This server's own guess, made after the tool had finished, by scoring the last few tool names. It is a label for the run of calls, not for this one call; it changed nothing, and the model was never told.",
  };
}

/** One card per interior step, in the order they happened, plus the one-line pill above them. */
export function insideHop(call, children = [], options = {}) {
  if (!call) return null;
  const status = options.status ?? call.status;
  const list = children ?? [];
  const cards = [];

  if (!answeredAtTheGate(call)) cards.push(gateCard(call, list, cards.length + 1));

  const bands = engineBands(call, list);
  const byId = new Map(list.map((event) => [event.id, event]));
  for (const band of bands) {
    const event = byId.get(band.event_id);
    if (!event) continue;
    const split = portsOfCard(event, band);
    cards.push({
      n: cards.length + 1,
      actor: band.actor,
      title: band.title,
      in: split.in,
      out: split.out,
      source: band.source,
      event_id: band.event_id,
      note: band.note ?? null,
    });
  }

  const handOff = auditHandOff(call, list);
  if (handOff) {
    cards.push({
      n: cards.length + 1,
      actor: 'server',
      title: handOff.title,
      in: [cardLine('the model wrote', call.rationale, 'model', { quote: true })],
      out: [cardLine('audit row', handOff.text, 'server')],
      source: 'bank.op',
      event_id: handOff.event_id,
      note: handOff.note,
    });
  }

  const inferred = list.find((event) => event.type === 'intent.inferred') ?? null;
  if (inferred) cards.push(classifierCard(inferred, cards.length + 1));

  return { summary: insideSummary(call, cards, status), cards };
}

function insideSummary(call, cards, status) {
  if (cards.length === 0) {
    if (answeredAtTheGate(call)) return 'nothing ran inside: the gate answered first';
    return status === 'running' ? 'nothing recorded inside yet · still running' : 'nothing recorded inside this call';
  }
  const steps = `${count(cards.length)} step${cards.length === 1 ? '' : 's'} inside`;
  if (status === 'running') return `${steps} so far · still running`;
  const actors = [];
  for (const card of cards) {
    if (actors[actors.length - 1] !== ACTOR_LABELS[card.actor]) actors.push(ACTOR_LABELS[card.actor]);
  }
  return `${steps} · ${actors.join(' → ')}`;
}

// ---------------------------------------------------------------------------
// Hop 3: the response as it left
// ---------------------------------------------------------------------------

/**
 * How much of the text content this recording actually holds.
 *
 * `content_chars` is the sum over the text blocks; the preview is those blocks joined with a
 * newline, so a two-block result has a preview one character longer than the sum per extra block.
 * `kept` is therefore clamped to `sent`: a recording can never hold more than was sent, and saying
 * so would be the one thing this pane exists to prevent.
 */
export function sizeFacts(textPreview, contentChars, contentTypes = []) {
  const types = Array.isArray(contentTypes) ? contentTypes : [];
  const blocks = types.filter((type) => type === 'text').length;
  const preview = typeof textPreview === 'string' ? textPreview : null;
  const capped = endsCut(preview);
  const stripped = capped ? preview.slice(0, -TRUNCATION_MARKER.length) : preview;
  const sent = Number.isFinite(Number(contentChars)) ? Number(contentChars) : 0;
  const kept = stripped === null ? 0 : Math.min(stripped.length, sent);
  const label = contentLabel(types, blocks);

  if (preview === null || blocks === 0) {
    return {
      sent,
      kept: 0,
      capped: false,
      sentence: 'The result carried no text block.',
      row: row('result.content', label, 'no text', 'server'),
    };
  }

  const across = `across ${count(blocks)} block${blocks === 1 ? '' : 's'}`;
  const sentence =
    kept < sent
      ? `The text content was ${count(sent)} characters ${across}; this recording kept the first ${count(kept)}${capped ? ' (the per-result cap)' : ''}. The rest was never recorded.`
      : `The text content was ${count(sent)} characters ${across}; this recording kept all of it.`;

  return {
    sent,
    kept,
    capped,
    sentence,
    row: row(
      'result.content',
      label,
      kept < sent ? `${count(sent)} sent · ${count(kept)} kept` : `${count(sent)} chars`,
      'server',
    ),
  };
}

/**
 * `content · text (1 block, joined)`. Never `content[0]`: the stored preview is the joined text of
 * every text block, so naming one block would misdescribe the value under it.
 */
function contentLabel(types, blocks) {
  if (types.length === 0) return 'content · none recorded';
  const distinct = [...new Set(types)];
  const counted = blocks === 0 ? types.length : blocks;
  return `content · ${distinct.join(', ')} (${count(counted)} block${counted === 1 ? '' : 's'}, joined)`;
}

/** The structured content, and whether the recording holds it whole. */
function structuredFacts(value) {
  if (value === null || value === undefined) return null;
  if (isObject(value) && value.truncated === true && typeof value.preview === 'string') {
    return {
      truncated: true,
      preview: value.preview,
      value,
      sentence:
        'preview of a larger object: the first 2,048 characters of its JSON; the rest was never recorded.',
      row: row('result.structuredContent', 'structuredContent', value, 'server'),
    };
  }
  return {
    truncated: false,
    preview: null,
    value,
    sentence: 'the structured content as it left, whole.',
    row: row('result.structuredContent', 'structuredContent', value, 'server'),
  };
}

/** The event that ended this call, by type, so the footer names what it was actually rebuilt from. */
function finishingType(call) {
  if (call.status === 'denied') return 'tool.call.denied';
  if (call.status === 'cancelled') return 'tool.call.cancelled';
  return 'tool.call.completed';
}

/**
 * A share of a cap, printed only when it is worth a reader's attention: under 5% a bar is noise and
 * a percentage invites a comparison the number cannot carry.
 */
function ratioOf(part, whole, label, capped) {
  if (!Number.isFinite(Number(part)) || !whole) return null;
  const value = Number(part) / Number(whole);
  if (value < RATIO_FLOOR && !capped) return null;
  const percent = `${Math.round(value * 100)}%`;
  return { of: label, share: value, percent, text: `${percent} of ${label}`, capped: Boolean(capped) };
}

/**
 * The JSON-RPC response rebuilt from the event that ended the call.
 *
 * `now` is accepted for symmetry with the panels' `{store, view, now}` model and is not read:
 * every duration here is a stored one, so nothing in this hop depends on the clock.
 */
export function responseHop(call, options = {}) {
  if (!call) return null;
  const status = options.status ?? call.status;
  const { frozen = false, consumers = [] } = options;
  const waiting = status === 'running';

  const size = sizeFacts(call.text_preview, call.content_chars, call.content_types);
  const structured = structuredFacts(call.structured_content);

  const rows = [row('id', 'id', call.request_id, 'agent')];
  let error = null;

  if (status === 'denied') {
    // The HTTP status the gate answered with (403, 429) is on the `http.request` row, which the
    // store attaches by JSON-RPC id and `http` below prints; these rows add only what
    // `tool.call.denied` recorded, so nothing is invented.
    rows.push(row('error.reason', 'reason', call.denied_reason, 'server'));
    if ((call.missing_scopes ?? []).length > 0) {
      // Invariant 5: the challenge names every missing scope, so this row prints all of them.
      rows.push(row('error.missing_scopes', 'missing scopes', call.missing_scopes, 'server'));
    }
    error = {
      class: 'denied',
      message: call.denied_reason,
      missing_scopes: call.missing_scopes ?? [],
      required_scopes: call.required_scopes ?? [],
      tone: 'denied',
    };
  } else if (status === 'cancelled') {
    rows.push(row('error.reason', 'cancelled', call.cancel_reason ?? 'no reason given', 'server'));
    error = { class: 'cancelled', message: call.cancel_reason ?? 'no reason given', tone: 'warn' };
  } else if (waiting) {
    size.row.value = 'waiting';
    size.sentence = frozen
      ? 'the result is beyond the pause point: nothing has been recorded yet.'
      : 'this call has not answered yet: nothing has been recorded yet.';
    rows.push(size.row);
  } else {
    rows.push(size.row);
    if (structured) rows.push(structured.row);
    if (call.is_error) rows.push(row('result.isError', 'isError', true, 'server'));
    if (call.error?.message) {
      error = {
        class: call.error.class ?? 'tool',
        message: call.error.message,
        code: call.error.code ?? null,
        tone: 'error',
      };
    }
  }

  const took = Number.isFinite(call.duration_ms)
    ? {
        ms: call.duration_ms,
        budget_ms: call.budget_ms,
        text: call.budget_ms
          ? `${duration(call.duration_ms)} of the ${seconds(call.budget_ms)} allowed`
          : duration(call.duration_ms),
      }
    : null;

  const ratios = [
    ratioOf(call.duration_ms, call.budget_ms, `the ${seconds(call.budget_ms)} allowed`, false),
    // Only the content cap sets this bit. `size.capped` is the recording's 2,048-character
    // preview cut, a different cap: a 3,000-character result is not near the 150,000 one.
    ratioOf(
      call.content_chars,
      call.content_cap,
      `the ${count(call.content_cap)}-character cap`,
      call.content_cap > 0 && call.content_chars >= call.content_cap,
    ),
  ].filter(Boolean);

  const http = call.http
    ? {
        event_id: call.http.event_id,
        status: call.http.status,
        duration_ms: call.http.duration_ms,
        rows: [
          row(
            'http.request',
            'carried by',
            `one HTTP request the client app opened (http.request #${call.http.event_id})`,
            'agent',
          ),
          row(
            'http.request.status',
            'answered',
            `${call.http.status} in ${duration(call.http.duration_ms)}`,
            'server',
          ),
        ],
      }
    : null;

  const port = (consumers ?? [])
    .filter((item) => item && item.from === call.key)
    .map((item) => `to #${requestIdOf(item.to)} · ${item.kind}`);

  return {
    title: `RESPONSE · result of id ${call.request_id} · as it left`,
    rows,
    size,
    structured,
    error,
    http,
    took,
    ratios,
    port,
    footer: waiting
      ? 'nothing has left the server yet: this page has no completion event to rebuild from'
      : `rebuilt by this page from ${finishingType(call)} #${call.finished_event_id}; the bytes on the wire were not kept`,
    rawEventId: call.finished_event_id,
    waiting,
  };
}

// ---------------------------------------------------------------------------
// Overlap
// ---------------------------------------------------------------------------

function spanOf(call) {
  const from = call.started_epoch ?? Date.parse(call.started_at ?? '');
  if (!Number.isFinite(from)) return null;
  const finished = call.finished_at ? Date.parse(call.finished_at) : NaN;
  if (Number.isFinite(finished)) return { from, to: finished };
  if (Number.isFinite(Number(call.duration_ms))) return { from, to: from + Number(call.duration_ms) };
  return { from, to: Number.POSITIVE_INFINITY };
}

/**
 * The chip for a call that did not have the connection to itself: another call of the same grant
 * was still in flight when this one started, or started before this one finished. Stateless
 * transport means several calls can be open at once (invariant 6), and the spine draws them in
 * start order, which hides it.
 */
export function overlapChip(call, calls = []) {
  if (!call) return null;
  const mine = spanOf(call);
  if (!mine) return null;
  const found = [];
  for (const other of calls ?? []) {
    if (!other || other.key === call.key) continue;
    if ((other.grant_id ?? null) !== (call.grant_id ?? null)) continue;
    const theirs = spanOf(other);
    if (!theirs) continue;
    if (mine.from >= theirs.from && mine.from < theirs.to) {
      found.push({ key: other.key, request_id: other.request_id, relation: 'inside' });
    } else if (theirs.from > mine.from && theirs.from < mine.to) {
      found.push({ key: other.key, request_id: other.request_id, relation: 'contains' });
    }
  }
  if (found.length === 0) return null;
  const inside = found.find((item) => item.relation === 'inside');
  return {
    with: found,
    text: inside
      ? `started while #${inside.request_id} was still running`
      : `#${found[0].request_id} started while this call was still running`,
  };
}
