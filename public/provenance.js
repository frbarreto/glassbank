/**
 * Who did what (block: dashboard).
 *
 * The chain says which call handed data to which. It does not say who *authored* any of it, and
 * that is the question this page exists to answer: a tool call is a collaboration between four
 * parties, and on a flat log they all look identical.
 *
 *   - `agent`  the client software - Claude Code, the claude.ai app, Codex. It opened the HTTP
 *              request, framed the JSON-RPC envelope, named itself in `initialize` and holds the
 *              OAuth token. It never chooses a tool.
 *   - `model`  the language model inside that client. It chose the tool, wrote every argument,
 *              wrote the `rationale` and wrote the SQL. Everything it wrote is stored word for
 *              word, because the words are the product.
 *   - `server` this bank server. It verified the token, checked the scopes, redacted what it
 *              refuses to keep, recorded the stated intent, counted the call and framed the answer.
 *              It decides, it does not execute.
 *   - `engine` what actually ran: the fake core banking and the per-grant scratch SQL database.
 *   - `page`   derived in this browser. Never a fact the server recorded, and always labelled.
 *
 * The rule for every claim in this file: it must be readable off an event, off the envelope, or
 * off a documented behaviour of this server's own code. Where a band states how the server behaves
 * rather than what one event says, the sentence names the mechanism so it can be checked.
 *
 * Pure functions over the read model of `store.js`. No DOM, no network, no clock.
 */
import { childEventsOf, describeIn, describeOut } from './chain.js';
import { duration, money, oneLineSql } from './format.js';

/** Drawing order, which is also the order of the legend. */
export const ACTORS = ['agent', 'model', 'server', 'engine', 'page'];

/** The short name on a band's chip. Lower case: it is read as part of a sentence. */
export const ACTOR_LABELS = {
  agent: 'client app',
  model: 'model',
  server: 'this server',
  engine: 'our engine',
  page: 'this page',
};

/** One sentence per actor, shown in the legend. Plain language, no protocol jargon. */
export const ACTOR_MEANING = {
  agent:
    'The program the model runs inside - Claude Code, the claude.ai app, Codex. It opened the connection, framed the request and holds the token. It never picks a tool.',
  model:
    'The model itself. It picked the tool, wrote every argument, wrote the reason and wrote the SQL. Stored here word for word.',
  server:
    'This bank server. It checked the token and the scopes, dropped what it refuses to keep, recorded the stated reason, and framed the answer. It decides; it does not execute.',
  engine:
    'What actually ran: the pretend core banking and the scratch SQL database, one per connection. Both ours.',
  page: 'Worked out in your browser from the events. Never something the server recorded.',
};

/** The three columns of the board: what went in, what ran, what came back. */
export const PHASES = ['in', 'work', 'out'];

export const PHASE_LABELS = { in: 'in', work: 'ran', out: 'out' };

// ---------------------------------------------------------------------------
// One actor per event type, for the rows that are not inside a call
// ---------------------------------------------------------------------------

/** Event types whose actor never depends on the payload. */
const STATIC_ACTORS = {
  'server.started': 'server',
  'server.stopping': 'server',
  'http.request': 'agent',
  'auth.challenge': 'server',
  'auth.verified': 'server',
  'auth.rejected': 'server',
  'auth.client.registered': 'agent',
  'auth.client.reconstructed': 'agent',
  'auth.grant.created': 'server',
  'auth.grant.updated': 'server',
  'auth.token.issued': 'server',
  'auth.token.refreshed': 'server',
  'auth.token.revoked': 'server',
  'auth.stepup.requested': 'server',
  'auth.login.created': 'server',
  'session.started': 'server',
  'session.initialized': 'agent',
  'session.ended': 'server',
  'session.rejected': 'server',
  'catalog.tools_listed': 'server',
  'catalog.resources_listed': 'server',
  'catalog.prompts_listed': 'server',
  'catalog.availability': 'server',
  'tool.call.started': 'model',
  'tool.call.completed': 'server',
  'tool.call.denied': 'server',
  'bank.op': 'engine',
  'etl.load': 'engine',
  'etl.processed': 'engine',
  'etl.table_evicted': 'engine',
  'etl.limit_reached': 'engine',
  'etl.worker_terminated': 'engine',
  'sql.query': 'engine',
  'sql.table_cleared': 'engine',
  'sql.rejected': 'engine',
  'intent.declared': 'model',
  'intent.inferred': 'server',
  'intent.missing': 'model',
};

/**
 * Who originated what this event records. Two types depend on the payload: a cancel is the client's
 * unless the server timed the call out, and a JSON-RPC error is the client's unless it is our own
 * `-32603 internal error`.
 */
export function actorOfEvent(event) {
  if (!event || typeof event.type !== 'string') return 'server';
  if (event.type === 'tool.call.cancelled') {
    return event.data?.reason === 'client_cancelled' ? 'agent' : 'server';
  }
  if (event.type === 'protocol.error') {
    return Number(event.data?.code) === -32603 ? 'server' : 'agent';
  }
  if (event.type.startsWith('xray.')) return 'server';
  return STATIC_ACTORS[event.type] ?? 'server';
}

// ---------------------------------------------------------------------------
// The bands of one call
// ---------------------------------------------------------------------------

/** Tools that hand the model's `rationale` on to the bank as the reason on an audit row. */
export const RATIONALE_TO_AUDIT_TOOLS = new Set(['lock_or_unlock_card', 'create_transfer']);

/** Why a rationale was missing, in words. Exported so a hop can build the A-06 chip from it. */
export const MISSING_REASONS = {
  absent: 'the argument was not sent at all',
  empty: 'the argument was sent empty',
  wrong_type: 'the argument was not a string',
};

function line(value, extra = {}) {
  return { value: String(value), ...extra };
}

function keyed(key, value, extra = {}) {
  return { key, value: String(value), ...extra };
}

function band(actor, phase, title, lines, note = null, extra = {}) {
  return { actor, phase, title, lines: lines.filter(Boolean), note, ...extra };
}

/** `Anthropic 1.0.0`, or `an unnamed client` when `initialize` never named one. */
function clientName(session) {
  const client = session?.client;
  if (!client || typeof client.name !== 'string' || client.name === '') return null;
  return client.version ? `${client.name} ${client.version}` : client.name;
}

/** What the client software put around the call, before the model's arguments start. */
function agentBand(call, session) {
  const lines = [];
  lines.push(
    keyed('method', 'tools/call', {
      mono: true,
      hint: 'the one JSON-RPC method that runs a tool',
    }),
  );
  if (call.request_id) {
    lines.push(
      keyed('call number', `#${call.request_id}`, {
        mono: true,
        hint: 'the JSON-RPC id the client picked for this call',
      }),
    );
  }
  const name = clientName(session);
  if (name) lines.push(keyed('client', name, { hint: 'whatever the client called itself' }));
  if (session?.protocol_version) {
    lines.push(
      keyed('protocol', session.protocol_version, {
        mono: true,
        hint: 'agreed once at initialize and reused on every later call',
      }),
    );
  }
  if (call.meta && Object.keys(call.meta).length > 0) {
    // Only the shape here. The whole object went on one nowrap line with no tooltip, which is a
    // way of showing something while making it unreadable; the step's expansion has a JSON viewer
    // for it, and that is where 64 KB of `_meta` belongs.
    const keys = Object.keys(call.meta);
    lines.push(
      keyed('_meta', `${keys.length} key${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}`, {
        muted: true,
        clip: true,
      }),
    );
  }
  return band(
    'agent',
    'in',
    'framed the call and sent it',
    lines,
    'The client program did this part. The name and version are whatever it says they are; this server never checks them and never behaves differently because of them.',
  );
}

/** Everything the model itself wrote, kept exactly as it arrived. */
function modelBand(call) {
  const lines = [];
  lines.push(keyed('tool', call.tool, { mono: true, strong: true }));
  for (const part of describeIn(call)) {
    if (part.key === null) {
      lines.push(line(part.value, { muted: part.muted }));
      continue;
    }
    lines.push(
      keyed(part.key, part.sql ? oneLineSql(part.value) : part.value, {
        mono: true,
        sql: part.sql === true,
        full: part.full ?? null,
        clip: true,
      }),
    );
  }
  const note =
    'The model chose this tool and wrote these values. They are stored the way they arrived, not summarised.';
  return band('model', 'in', 'chose the tool and wrote the arguments', lines, note);
}

/** The `rationale`: the only place the model writes prose, so it gets its own band. */
function rationaleBand(call) {
  if (call.rationale_present && call.rationale) {
    return band(
      'model',
      'in',
      'said why, in its own words',
      [line(call.rationale, { quote: true })],
      // `rationale_truncated` is set at 1,024 (`isRationaleTruncated`, src/contracts/tools.ts), the
      // length the handler and the audit row keep - not at the emitter's 8,192-character cap.
      call.rationale_truncated
        ? 'The model wrote this in the required `rationale` argument. It was longer than the 1,024 characters the handler and the audit row keep, so what travelled on was cut to that length.'
        : 'The model wrote this in the required `rationale` argument. It is not your message: it is the model summarising, for us, why it is calling. Whatever you actually typed never reaches this server.',
      { emphasis: true },
    );
  }
  return band(
    'model',
    'in',
    'did not say why',
    [line('no rationale on this call', { muted: true })],
    'Every tool asks for a `rationale`. This call arrived without a usable one, so the server ran it anyway and recorded the omission as `intent.missing` (A-06).',
  );
}

/**
 * What the gate checked, dropped and recorded before the tool ran, as data rather than as lines.
 *
 * `serverGateBand` renders exactly this, and so does the gate card of `public/hops.js`: the
 * sentences have one home, so the board and the interior pane can never drift apart.
 */
export function gateFacts(call, children = []) {
  const declared = children.find((event) => event.type === 'intent.declared') ?? null;
  const missing = children.find((event) => event.type === 'intent.missing') ?? null;

  let rationale = null;
  if (declared) {
    rationale = {
      state: 'declared',
      event_id: declared.id,
      reason: null,
      text: 'read the rationale, recorded it as the stated intent, then removed it from the arguments the tool received',
    };
  } else if (missing) {
    const reason = missing.data?.reason ?? null;
    rationale = {
      state: 'missing',
      event_id: missing.id,
      reason,
      text: `no rationale to record: ${MISSING_REASONS[reason] ?? 'it was not usable'}`,
    };
  }

  const required = call?.required_scopes ?? [];
  const lacking = call?.missing_scopes ?? [];
  const scopes =
    required.length > 0
      ? {
          required,
          missing: lacking,
          granted: lacking.length === 0,
          text:
            lacking.length > 0
              ? `${required.join(' ')} - missing ${lacking.join(' ')}`
              : `${required.join(' ')} - granted`,
        }
      : null;

  const redacted = call?.redacted_fields ?? [];
  const dropped = {
    fields: redacted,
    text: redacted.length > 0 ? redacted.join(', ') : 'nothing',
  };

  const budget = Number.isFinite(call?.budget_ms)
    ? { ms: call.budget_ms, text: duration(call.budget_ms) }
    : null;

  return { rationale, scopes, dropped, budget };
}

/** The gate: what this server checked, dropped and recorded before the tool ran. */
function serverGateBand(call, children) {
  const facts = gateFacts(call, children);
  const lines = [];

  if (facts.rationale?.state === 'declared') {
    lines.push(line(facts.rationale.text, { wrap: true }));
  } else if (facts.rationale?.state === 'missing') {
    lines.push(line(facts.rationale.text, { wrap: true, tone: 'warn' }));
  }

  if (facts.scopes) {
    lines.push(
      keyed('scopes', facts.scopes.text, {
        mono: true,
        tone: facts.scopes.granted ? null : 'error',
      }),
    );
  }

  lines.push(
    facts.dropped.fields.length > 0
      ? keyed('dropped before storing', facts.dropped.text, { mono: true, tone: 'warn' })
      : keyed('dropped before storing', facts.dropped.text, { muted: true }),
  );

  if (facts.budget) lines.push(keyed('budget', facts.budget.text, { muted: true }));

  return band(
    'server',
    'in',
    'checked it and wrote it down, before running anything',
    lines,
    'This all happens before the tool runs, so a call that is about to be refused still leaves a record of what the model said it was doing.',
  );
}

/**
 * The rationale continuing past the gate: on a write that actually landed, it becomes the reason
 * on an audit row.
 *
 * The audit row is the only evidence, so it is also the condition. A write can carry a rationale
 * and never reach the bank at all - the gate records the stated intent *before* it checks the
 * feature flag, the scopes and the schema (`src/tools/registry.ts`), so a refused or malformed
 * `create_transfer` arrives here with `rationale_present` true and no `bank.op` behind it. Drawing
 * this band on the strength of the tool name alone put "passed the reason on to the bank" directly
 * above "denied before it ran", which is the one kind of mistake this whole page exists to prevent.
 */
export function auditHandOff(call, children = []) {
  if (!call || !RATIONALE_TO_AUDIT_TOOLS.has(call.tool)) return null;
  if (!call.rationale_present) return null;
  const audit = children.find(
    (event) => event.type === 'bank.op' && typeof event.data?.audit_id === 'string',
  );
  if (!audit) return null;
  return {
    tool: call.tool,
    audit_id: audit.data.audit_id,
    event_id: audit.id,
    title: 'passed the reason on to the bank',
    text: `the model's sentence is the reason kept on audit row ${audit.data.audit_id}`,
    note: 'On a write that lands, the rationale is not only observed: it travels into the bank and is stored on the audit entry. This is the one place the model’s prose outlives the call.',
  };
}

function rationaleTravelBand(call, children) {
  const handOff = auditHandOff(call, children);
  if (!handOff) return null;
  return band('server', 'in', handOff.title, [line(handOff.text, { wrap: true })], handOff.note);
}

function bankOperationLine(data) {
  const parts = [data.operation];
  if (data.card_id) parts.push(`card ${data.card_id}`);
  if (data.account_id) parts.push(`account ${data.account_id}`);
  if (Number.isFinite(data.rows)) parts.push(`${data.rows} rows`);
  if (Number.isFinite(data.pages)) parts.push(`${data.pages} pages`);
  return parts.join(' · ');
}

/** What actually executed, one line per piece of work, in the order it happened. */
export function engineBands(call, children) {
  const bands = [];
  for (const event of children) {
    const data = event.data ?? {};
    const timing = Number.isFinite(data.duration_ms) ? duration(data.duration_ms) : null;
    const timingLine = Number.isFinite(data.latency_ms) ? duration(data.latency_ms) : timing;

    if (event.type === 'bank.op') {
      const lines = [line(bankOperationLine(data), { mono: true })];
      if (data.preview_id) lines.push(keyed('quoted', data.preview_id, { mono: true }));
      if (data.audit_id) lines.push(keyed('audit row', data.audit_id, { mono: true }));
      if (data.error) lines.push(line(data.error, { tone: 'error' }));
      if (timingLine) lines.push(keyed('took', timingLine, { muted: true }));
      bands.push(
        band(
          'engine',
          'work',
          data.ok === false ? 'the bank refused' : 'the bank did the work',
          lines,
          'The pretend core banking. Everything it holds is seeded and fake; your writes live in an overlay private to your login.',
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'etl.load') {
      bands.push(
        band(
          'engine',
          'work',
          'built a scratch table from the bank rows',
          [
            keyed('table', data.table, { mono: true }),
            keyed('rows', data.rows, {}),
            data.columns_advertised?.length
              ? keyed('columns offered to the model', data.columns_advertised.join(', '), {
                  mono: true,
                  clip: true,
                })
              : null,
            timing ? keyed('took', timing, { muted: true }) : null,
          ],
          'A private in-memory SQLite database, one per connection. The rows never leave the server: the tool answers with the table name, not with the data.',
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'etl.processed') {
      bands.push(
        band(
          'engine',
          'work',
          'kept only the columns the model asked for',
          [
            keyed('table', data.table, { mono: true }),
            keyed('kept', (data.columns_selected ?? []).join(', '), { mono: true, clip: true }),
            keyed('rows', data.rows, {}),
            timing ? keyed('took', timing, { muted: true }) : null,
          ],
          null,
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'sql.query') {
      bands.push(
        band(
          'engine',
          'work',
          "ran the model's SQL",
          [
            keyed('on table', data.table ?? 'unknown', { mono: true }),
            keyed('rows back', data.rows_returned, {}),
            data.capped ? line('the 100-row cap bit', { tone: 'warn' }) : null,
            timing ? keyed('took', timing, { muted: true }) : null,
          ],
          'The SQL is the model’s, word for word. It runs in a separate process that is killed outright at the timeout, because a native SQLite query cannot be interrupted any other way.',
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'sql.rejected') {
      bands.push(
        band(
          'engine',
          'work',
          'refused to run that SQL',
          [
            keyed('reason', data.rejected_reason, { mono: true, tone: 'error' }),
            data.error ? line(data.error, { wrap: true }) : null,
            data.table ? keyed('on table', data.table, { mono: true }) : null,
          ],
          'The guard refuses ATTACH, DETACH, PRAGMA, VACUUM and anything with more than one statement, on both sides of the process boundary.',
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'sql.table_cleared') {
      bands.push(
        band(
          'engine',
          'work',
          'dropped the scratch table',
          [
            keyed('table', data.table, { mono: true }),
            timing ? keyed('took', timing, { muted: true }) : null,
          ],
          null,
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'etl.table_evicted') {
      bands.push(
        band(
          'engine',
          'work',
          'threw a scratch table away',
          [
            keyed('table', data.table, { mono: true }),
            keyed('because', data.reason, { mono: true, tone: 'warn' }),
          ],
          'Scratch tables are evicted on idle time, on the per-connection cap, on the global cap, or because the process running them was killed.',
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'etl.limit_reached') {
      bands.push(
        band(
          'engine',
          'work',
          'hit a limit',
          [
            keyed('limit', data.limit, { mono: true, tone: 'warn' }),
            Number.isFinite(data.current) && Number.isFinite(data.max)
              ? keyed('at', `${data.current} of ${data.max}`, {})
              : null,
            data.message ? line(data.message, { wrap: true }) : null,
          ],
          null,
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'etl.worker_terminated') {
      bands.push(
        band(
          'engine',
          'work',
          'the SQL process was killed',
          [
            keyed('because', data.reason, { mono: true, tone: 'error' }),
            data.tables_lost?.length
              ? keyed('tables lost', data.tables_lost.join(', '), { mono: true, clip: true })
              : null,
          ],
          'Killing the process is the only way to stop a native SQLite query. Every scratch table it held is gone with it, and the model is told to load again.',
          { source: event.type, event_id: event.id },
        ),
      );
      continue;
    }

    if (event.type === 'auth.stepup.requested') {
      bands.push(
        band(
          'server',
          'work',
          'asked for more permission',
          [keyed('scopes', (data.missing_scopes ?? []).join(' '), { mono: true })],
          'The call needed a scope this connection was never granted, so the server answered with a challenge instead of doing the work.',
          { source: event.type, event_id: event.id },
        ),
      );
    }
  }
  return bands;
}

/** What the client got back, and what it cost against the two caps claude.ai enforces. */
function serverAnswerBand(call, events, options) {
  const status = options.status ?? call.status;
  const lines = [];
  for (const part of describeOut(call, events, options)) {
    lines.push(line(part.value, { mono: part.mono, muted: part.muted, tone: part.tone }));
  }
  if (Number.isFinite(call.duration_ms)) {
    const share = call.budget_ms ? Math.round((call.duration_ms / call.budget_ms) * 100) : null;
    lines.push(
      keyed(
        'took',
        share === null
          ? duration(call.duration_ms)
          : `${duration(call.duration_ms)} of the ${duration(call.budget_ms)} allowed (${share}%)`,
        { muted: true },
      ),
    );
  }
  if (call.content_chars > 0) {
    const share = call.content_cap ? Math.round((call.content_chars / call.content_cap) * 100) : 0;
    lines.push(
      keyed('answer size', `${call.content_chars} characters, ${share}% of the cap`, {
        muted: true,
      }),
    );
  }
  if (call.error?.message) {
    lines.push(
      keyed(call.error.class === 'protocol' ? 'protocol error' : 'tool error', call.error.message, {
        tone: 'error',
        wrap: true,
      }),
    );
  }
  const title =
    status === 'denied'
      ? 'refused the call'
      : status === 'error'
        ? 'answered with an error'
        : status === 'running'
          ? 'has not answered yet'
          : 'answered the client';
  return band(
    'server',
    'out',
    title,
    lines,
    'This is the whole of what left the server. The model sees exactly this and nothing else.',
  );
}

/**
 * The classifier, which runs after the call and changes nothing about it.
 *
 * `confidence` is not a probability and must never be printed as one: it is how far the winning
 * workflow scored ahead of the runner-up, mapped into `0.4 + 0.45 x margin` (`src/tools/intent.ts`),
 * so the only values that ever appear are `0.2` for `unknown` and `0.40` to `0.85` for the rest.
 */
function inferenceBand(children) {
  const inferred = children.find((event) => event.type === 'intent.inferred');
  if (!inferred) return null;
  const data = inferred.data ?? {};
  const score = Number(data.confidence ?? 0);
  return band(
    'server',
    'out',
    'guessed what the last few calls were for',
    [
      keyed('workflow', String(data.workflow ?? 'unknown').replace(/_/g, ' '), { strong: true }),
      keyed('how clear a win', score <= 0.2 ? 'nothing scored' : `${score.toFixed(2)} of 0.85`, {
        muted: true,
      }),
      data.tools?.length
        ? keyed('from these tools', data.tools.join(' → '), { mono: true, clip: true })
        : null,
    ],
    'This server’s own guess, made after the tool had finished, by scoring the last few tool names and looking for five sets of words in the rationale. It is a label for the run of calls, not for this one call; it changed nothing, and the model was never told. The number is how far ahead the winner scored, not a probability.',
  );
}

/**
 * Every band of one call, in board order: what came in, what ran, what went out. `session` supplies
 * the client facts, which live on the session rather than on the call.
 */
export function bandsOf(call, events, session, options = {}) {
  if (!call) return [];
  const children = childEventsOf(call, events);
  const bands = [
    agentBand(call, session),
    modelBand(call),
    rationaleBand(call),
    serverGateBand(call, children),
    rationaleTravelBand(call, children),
    ...engineBands(call, children),
    serverAnswerBand(call, events, options),
    inferenceBand(children),
  ].filter(Boolean);
  return bands;
}

/** Bands grouped into the three columns, empty ones dropped. */
export function boardOf(call, events, session, options = {}) {
  const bands = bandsOf(call, events, session, options);
  return PHASES.map((phase) => ({
    phase,
    label: PHASE_LABELS[phase],
    bands: bands.filter((item) => item.phase === phase),
  })).filter((column) => column.bands.length > 0);
}

/** Which actors appear on this board, for the legend to mark the ones in play. */
export function actorsOf(bands) {
  const found = new Set();
  for (const item of bands) found.add(item.actor);
  return ACTORS.filter((actor) => found.has(actor));
}

/** The legend, in drawing order. */
export function legend() {
  return ACTORS.map((actor) => ({
    actor,
    label: ACTOR_LABELS[actor],
    meaning: ACTOR_MEANING[actor],
  }));
}

/** Money for a band line, so the panel never formats cents itself. */
export function bandMoney(value, currency) {
  return money(value, currency);
}
