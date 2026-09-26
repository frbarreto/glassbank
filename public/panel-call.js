/**
 * One tool call, as a row and as three panes (block: dashboard).
 *
 * The complaint this file answers: on the spine you could not find the inputs and the outputs of a
 * call, and at a glance you could not tell which was which. The old board mixed what the client
 * sent with what the server did on receipt in one "IN" column, and printed this page's own
 * summaries of the result ("6 rows", "audit aud_0002") in the server's colour, so the page said
 * "the server answered 6 rows" when the server answered 486 characters of JSON.
 *
 * So there are exactly two renderers here:
 *
 * - `renderCallRow` - one line. On the left, the model's arguments as they were recorded; on the
 *   right, the head of the result text the server actually sent and how much of it this recording
 *   holds. Nothing this page worked out appears on that line: the captions belong to the connectors
 *   and the thread heads, which wear the dashed page rail and say so.
 * - `renderCallOpen` - the triptych: the JSON-RPC request as it arrived, what happened inside, and
 *   the result as it left. REQUEST holds only what the client sent; everything the server did on
 *   receipt - the scope check, the redaction, recording the intent - belongs to INSIDE.
 *
 * Every value comes from `public/hops.js`, which decides who authored what and writes the
 * sentences; this file draws them and never re-words them. Colour encodes the actor and nothing
 * else - not the phase, not the event family - so `status` is a glyph plus a word instead.
 *
 * Pure `h()` trees over `{store, view, now}`; no DOM, no clock beyond the injected `now`.
 */
import { cx, h } from './h.js';
import {
  argumentValue,
  authoredRow,
  codeBlock,
  disclosure,
  pill,
} from './ui.js';
import { clockTime, duration, seconds } from './format.js';
import {
  insideHop,
  missingRationale,
  overlapChip,
  requestHop,
  responseHop,
} from './hops.js';
import {
  callKey,
  cardKey,
  insideKey,
  isOpen,
  reqKey,
  resKey,
} from './open-state.js';
import { jsonView, viewerId } from './json-view.js';
import { ACTORS, ACTOR_LABELS, ACTOR_MEANING, actorOfEvent } from './provenance.js';

/** The head of the result text a row prints. The whole preview stays in the `title`. */
export const ROW_TEXT_CHARS = 180;

/** Colour is the actor's, so the status has to carry itself: a glyph and a word. */
const STATUS_GLYPHS = {
  ok: '✓',
  error: '✗',
  denied: '✗',
  running: '⏱',
  cancelled: '⊘',
};

const STATUS_WORDS = {
  ok: 'OK',
  error: 'error',
  denied: 'denied',
  running: 'running',
  cancelled: 'cancelled',
};

/** The middle pane's title. The two wire panes take theirs from `hops.js`. */
export const INSIDE_TITLE = 'INSIDE · this server and our engine';

function dimmed(focus, actor) {
  return focus !== null && focus !== undefined && focus !== actor;
}

/** A value as recorded, on one line: a string stays a string, anything else is its JSON. */
function verbatim(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Everything both renderers need, derived once. `cutoff` is the pause point: a call whose ending
 * lies beyond it is drawn the way it looked there, which is what `frozen` means.
 */
function factsOf(call, model, ctx) {
  const { store, view } = model;
  const cutoff = ctx.cutoff ?? Number.POSITIVE_INFINITY;
  const frozen =
    call.finished_event_id !== null &&
    call.finished_event_id !== undefined &&
    call.finished_event_id > cutoff;
  const status = frozen ? 'running' : call.status;
  const children = (call.child_event_ids ?? [])
    .filter((id) => id <= cutoff)
    .map((id) => store.getEventById(id))
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
  const links = ctx.links ?? [];

  return {
    key: callKey(call),
    status,
    frozen,
    children,
    focus: view.actorFocus ?? null,
    json: view.json ?? {},
    request: requestHop(call, call.xs ? store.getSession(call.xs) : null, {
      links,
      viewer: view.viewer ?? null,
      children,
      catalog: call.xs ? store.getCatalog(call.xs) : null,
    }),
    response: responseHop(call, { status, frozen, consumers: links }),
  };
}

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

function statusMark(status, elapsed, budgetMs) {
  const word =
    status === 'running'
      ? `${duration(elapsed)} of ${seconds(budgetMs)}`
      : (STATUS_WORDS[status] ?? status);
  return h(
    'span',
    { class: cx('call-status', status !== 'ok' && 'is-notable'), 'data-status': status },
    h('span', { class: 'call-status-glyph', 'aria-hidden': 'true' }, STATUS_GLYPHS[status] ?? '·'),
    h('span', { class: 'call-status-word' }, word),
  );
}

/** One recorded value on the row: the key it arrived under and the value, untouched. */
function digestPart(key, value, actor, focus, options = {}) {
  const text = verbatim(value);
  return h(
    'span',
    {
      class: cx(
        'digest-part',
        `who-${actor}`,
        options.tone && `is-${options.tone}`,
        dimmed(focus, actor) && 'is-dimmed',
      ),
      'data-actor': actor,
      title: options.title ?? (text.length > ROW_TEXT_CHARS ? text : null),
    },
    key ? h('span', { class: 'digest-key mono' }, key) : null,
    h('span', { class: 'digest-value mono' }, text.slice(0, ROW_TEXT_CHARS)),
    options.redacted ? h('span', { class: 'badge badge-warn' }, 'redacted') : null,
  );
}

/**
 * The left half of the row: what the model wrote, verbatim, minus the rationale, which becomes a
 * chip carrying the sentence in its title. A call the gate refused before reading the body has no
 * arguments at all, and the sentence that says so is the server's, never the model's.
 */
function inDigest(call, facts) {
  const hop = facts.request;
  const focus = facts.focus;
  if (hop.denied) return [digestPart(null, hop.denied.value, hop.denied.actor, focus)];
  if (hop.observer) return [digestPart(null, hop.observer.value, hop.observer.actor, focus)];

  const parts = hop.rows
    .filter((line) => line.path.startsWith('params.arguments.') && line.key !== 'rationale')
    .map((line) =>
      digestPart(line.key, line.value, line.actor, focus, { redacted: line.redacted }),
    );

  const missing = missingRationale(call, facts.children);
  if (hop.rationale?.row) {
    parts.push(
      pill('+rationale', {
        actor: 'model',
        class: 'digest-chip',
        dimmed: dimmed(focus, 'model'),
        title: String(hop.rationale.row.value ?? ''),
      }),
    );
  } else if (missing) {
    parts.push(
      pill('no rationale', {
        actor: 'model',
        tone: 'warn',
        class: 'digest-chip',
        dimmed: dimmed(focus, 'model'),
        title: missing.text,
      }),
    );
  }

  if (parts.length === 0) {
    parts.push(
      digestPart(null, 'no arguments recorded', 'page', focus, {
        title: 'tool.call.started recorded an empty arguments object.',
      }),
    );
  }
  return parts;
}

/**
 * The right half: the bytes the server sent. The head of the recorded text, then how much of it
 * this recording holds (`sizeFacts`). Never this page's reading of the result - "6 rows" is a
 * caption the connectors carry, on the dashed page rail, where it can be seen for what it is.
 */
function outDigest(call, facts) {
  const hop = facts.response;
  const focus = facts.focus;
  const parts = [];
  if (hop.error?.message) {
    parts.push(
      digestPart(null, hop.error.message, 'server', focus, {
        tone: hop.error.tone === 'error' ? 'error' : 'warn',
      }),
    );
  }
  if (!hop.waiting && typeof call.text_preview === 'string' && call.text_preview.length > 0) {
    parts.push(digestPart(null, call.text_preview, 'server', focus, { title: call.text_preview }));
  }
  parts.push(
    digestPart(null, hop.size.row.value, 'server', focus, { title: hop.size.sentence }),
  );
  return parts;
}

/** Which parties this call involved, in legend order; the key to the rails inside it. */
function actorsOfCall(facts) {
  const seen = new Set();
  for (const line of facts.request.rows) seen.add(line.actor);
  for (const event of facts.children) seen.add(actorOfEvent(event));
  for (const line of facts.response.rows) seen.add(line.actor);
  if (facts.request.denied) seen.add(facts.request.denied.actor);
  return ACTORS.filter((actor) => seen.has(actor));
}

/**
 * One line per call. The whole line is the toggle; Bytes is a sibling button, because a button
 * nested in a button is unreachable.
 */
export function renderCallRow(call, model, ctx = {}) {
  const { view } = model;
  const facts = factsOf(call, model, ctx);
  const open = isOpen(view, facts.key, 'call');
  const selected = view.selectedCallKey === call.key;
  const elapsed =
    facts.status === 'running'
      ? call.started_epoch
        ? Math.max(0, model.now - call.started_epoch)
        : null
      : call.duration_ms;
  const overlap = overlapChip(call, ctx.calls ?? []);

  const label = h(
    'span',
    { class: 'call-line' },
    h('span', { class: 'call-id mono', title: 'the JSON-RPC id of this request' }, `#${call.request_id}`),
    h('span', { class: 'call-time mono', title: call.started_at }, clockTime(call.started_at)),
    h('span', { class: 'call-tool mono' }, call.tool),
    statusMark(facts.status, elapsed, call.budget_ms),
    // A denial never ran, so it has no duration; printing `-` would look like a missing reading.
    facts.status === 'running' || !Number.isFinite(Number(elapsed))
      ? null
      : h('span', { class: 'call-took mono' }, duration(elapsed)),
    h(
      'span',
      { class: 'call-dots' },
      ...actorsOfCall(facts).map((actor) =>
        h('span', {
          class: cx('call-dot', `who-${actor}`, dimmed(facts.focus, actor) && 'is-dimmed'),
          'data-actor': actor,
          title: `${ACTOR_LABELS[actor]}: ${ACTOR_MEANING[actor]}`,
        }),
      ),
    ),
    // The digest asks for 40rem, so a spine narrower than that gives it a line of its own rather
    // than shrinking both halves until the values disappear - which is the defect this replaces.
    h(
      'span',
      { class: 'call-digest' },
      h('span', { class: 'call-in' }, ...inDigest(call, facts)),
      h('span', { class: 'call-arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'call-out' }, ...outDigest(call, facts)),
    ),
    overlap
      ? pill(overlap.text, {
          actor: 'page',
          class: 'call-overlap',
          dimmed: dimmed(facts.focus, 'page'),
          title:
            'Worked out by this page from the recorded clocks. The transport is stateless, so several calls of one grant can be open at once (invariant 6).',
        })
      : null,
  );

  return h(
    'div',
    {
      class: cx(
        'call-row',
        `call-row-${facts.status}`,
        open && 'is-open',
        selected && 'is-selected',
      ),
      'data-call-key': call.key,
    },
    disclosure(label, facts.key, open, {
      kind: 'call',
      class: 'call-head',
      title: open ? 'Close this call' : 'Open the request, the interior and the response',
    }),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-quiet call-bytes',
        'data-action': 'select-call',
        'data-arg': call.key,
        'aria-label': `Open the envelopes of ${call.tool} in the inspector`,
        title: 'Open the recorded envelopes of this call in the inspector',
      },
      '⤢',
    ),
  );
}

// ---------------------------------------------------------------------------
// The panes
// ---------------------------------------------------------------------------

/** A value as it sat in the envelope; anything the reader has to unfold goes to the JSON viewer. */
function wireValue(line, call, json) {
  if (line.path.startsWith('params.arguments.')) {
    return argumentValue(line.value, {
      id: viewerId('step-args', call.key, line.key),
      state: json,
    });
  }
  if (line.path === 'params._meta') {
    return argumentValue(line.value, { id: viewerId('step-meta', call.key), state: json });
  }
  if (line.path === 'result.structuredContent') {
    return jsonView(line.value, { id: viewerId('step-result', call.key), state: json });
  }
  if (Array.isArray(line.value)) return line.value.map((item) => verbatim(item)).join(', ');
  if (line.value !== null && typeof line.value === 'object') {
    return jsonView(line.value, {
      id: viewerId('step-result', call.key, line.key ?? line.path),
      state: json,
    });
  }
  return verbatim(line.value);
}

function wireRow(line, call, facts) {
  return authoredRow(
    {
      actor: line.actor,
      key: line.key,
      path: line.path,
      implied: line.implied,
      dimmed: dimmed(facts.focus, line.actor),
      mono: true,
      title: line.implied ? 'Not a recorded field: implied by the event type.' : null,
    },
    wireValue(line, call, facts.json),
    line.redacted ? h('span', { class: 'badge badge-warn' }, 'redacted') : null,
    line.port
      ? pill(line.port, {
          actor: 'page',
          class: 'wire-port',
          dimmed: dimmed(facts.focus, 'page'),
          title: 'Worked out by this page from what an earlier call returned.',
        })
      : null,
  );
}

function note(text, actor, facts, extraClass) {
  if (!text) return null;
  return h(
    'p',
    {
      class: cx('wire-note', `who-${actor}`, dimmed(facts.focus, actor) && 'is-dimmed', extraClass),
      'data-actor': actor,
    },
    text,
  );
}

/**
 * The rationale, in the position it arrived in, with the two sentences `hops.js` builds for it:
 * where the requirement comes from (this page's claim about the schema) and what the gate did with
 * it (the server's own record).
 */
function rationaleBlock(line, rationale, call, facts) {
  return h(
    'div',
    { class: 'wire-rationale' },
    line
      ? authoredRow(
          {
            actor: line.actor,
            key: line.key,
            path: line.path,
            emphasis: true,
            dimmed: dimmed(facts.focus, line.actor),
            class: 'wire-rationale-row',
          },
          h('span', { class: 'wire-quote' }, String(line.value ?? '')),
        )
      : null,
    note(rationale.locator, 'page', facts, 'wire-locator'),
    note(rationale.note, 'server', facts, 'wire-gate-note'),
  );
}

/** The raw record a pane was rebuilt from, folded away behind its own control. */
function rawBlock(model, facts, eventId, key, kind) {
  if (eventId === null || eventId === undefined) return null;
  const event = model.store.getEventById(eventId);
  if (!event) return null;
  const open = isOpen(model.view, key, kind);
  return h(
    'div',
    { class: 'wire-raw' },
    disclosure(`raw ${event.type} #${eventId}`, key, open, {
      kind,
      class: 'wire-raw-toggle',
      title: 'The whole recorded envelope this pane was rebuilt from',
    }),
    open
      ? jsonView(event, {
          // Kept under the pane's own viewer base so `viewerPrefixesOf` forgets it when the pane
          // closes (`public/open-state.js`).
          id: viewerId(kind === 'req' ? 'step-args' : 'step-result', facts.key, 'raw'),
          state: facts.json,
        })
      : null,
  );
}

function requestPane(call, model, facts) {
  const hop = facts.request;
  const rows = [];
  for (const line of hop.rows) {
    if (line.path === 'params.arguments.rationale') {
      rows.push(rationaleBlock(line, hop.rationale, call, facts));
      continue;
    }
    rows.push(wireRow(line, call, facts));
  }
  if (hop.denied) rows.push(wireRow(hop.denied, call, facts));
  if (hop.observer) rows.push(wireRow(hop.observer, call, facts));
  // A rationale that never arrived still has a requirement and a record of its absence.
  if (hop.rationale && !hop.rationale.row) {
    rows.push(rationaleBlock(null, hop.rationale, call, facts));
  }

  return h(
    'section',
    { class: 'wire wire-request' },
    h('h4', { class: 'sub-title wire-title' }, hop.title),
    h('div', { class: 'wire-rows' }, ...rows),
    h(
      'p',
      {
        class: cx('wire-footer', 'who-page', dimmed(facts.focus, 'page') && 'is-dimmed'),
        'data-actor': 'page',
      },
      hop.footer,
    ),
    rawBlock(model, facts, hop.rawEventId, reqKey(facts.key), 'req'),
  );
}

function insidePane(model, facts, inside) {
  const key = insideKey(facts.key);
  const open = isOpen(model.view, key, 'inside');
  return h(
    'section',
    { class: 'inside' },
    h('h4', { class: 'sub-title wire-title' }, INSIDE_TITLE),
    disclosure(h('span', { class: 'inside-summary' }, inside.summary), key, open, {
      kind: 'inside',
      class: 'inside-toggle',
      title: open ? 'Fold the interior away' : 'Show every step that ran inside this call',
    }),
  );
}

function cardLine(line, facts) {
  const actor = line.actor ?? 'server';
  return h(
    'span',
    {
      class: cx(
        'card-line',
        `who-${actor}`,
        line.tone && `is-${line.tone}`,
        dimmed(facts.focus, actor) && 'is-dimmed',
      ),
      'data-actor': actor,
      title: line.full ?? null,
    },
    h('span', { class: 'card-line-rail', 'aria-hidden': 'true' }),
    line.key ? h('span', { class: 'card-key mono' }, line.key) : null,
    h('span', { class: cx('card-value', line.quote && 'is-quote') }, String(line.value ?? '')),
  );
}

function cardSide(side, lines, facts) {
  if (!lines || lines.length === 0) return null;
  return h(
    'div',
    { class: `card-side card-side-${side}` },
    h('span', { class: 'card-side-label' }, side),
    h('span', { class: 'card-side-lines' }, ...lines.map((line) => cardLine(line, facts))),
  );
}

function insideCard(card, model, facts) {
  const key = cardKey(facts.key, card.event_id);
  const open = isOpen(model.view, key, 'card');
  const event = model.store.getEventById(card.event_id);
  return h(
    'article',
    {
      class: cx('card', `who-${card.actor}`, dimmed(facts.focus, card.actor) && 'is-dimmed'),
      'data-actor': card.actor,
    },
    h('span', { class: 'card-rail', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'card-body' },
      h(
        'div',
        { class: 'card-head' },
        h('span', { class: 'card-n mono' }, String(card.n)),
        h('span', { class: 'card-who' }, ACTOR_LABELS[card.actor]),
        h('span', { class: 'card-title' }, card.title),
        h('span', { class: 'card-source mono' }, `${card.source} #${card.event_id}`),
      ),
      cardSide('in', card.in, facts),
      cardSide('out', card.out, facts),
      card.note ? h('p', { class: 'card-note' }, card.note) : null,
      event
        ? h(
            'div',
            { class: 'wire-raw' },
            disclosure(`raw ${event.type} #${card.event_id}`, key, open, {
              kind: 'card',
              class: 'wire-raw-toggle',
            }),
            open
              ? jsonView(event, {
                  id: viewerId('step-child', card.event_id),
                  state: facts.json,
                })
              : null,
          )
        : null,
    ),
  );
}

/** The cards span the whole triptych, under the two wire panes: they are the widest thing here. */
function insideCards(model, facts, inside) {
  if (!isOpen(model.view, insideKey(facts.key), 'inside')) return null;
  if (inside.cards.length === 0) return null;
  return h(
    'div',
    { class: 'inside-cards' },
    ...inside.cards.map((card) => insideCard(card, model, facts)),
  );
}

function responsePane(call, model, facts) {
  const hop = facts.response;
  const preview = hop.waiting ? null : call.text_preview;
  return h(
    'section',
    { class: 'wire wire-response' },
    h('h4', { class: 'sub-title wire-title' }, hop.title),
    h('div', { class: 'wire-rows' }, ...hop.rows.map((line) => wireRow(line, call, facts))),
    note(hop.size.sentence, 'page', facts, 'wire-size'),
    typeof preview === 'string' && preview.length > 0
      ? codeBlock(preview, { id: `result-${facts.key.replace(/[#/:]/g, '-')}` })
      : null,
    hop.structured ? note(hop.structured.sentence, 'page', facts, 'wire-structured') : null,
    hop.error?.message
      ? authoredRow(
          {
            actor: 'server',
            key: hop.error.class,
            path: 'error',
            dimmed: dimmed(facts.focus, 'server'),
            class: cx('wire-error', `is-${hop.error.tone ?? 'error'}`),
          },
          hop.error.message,
        )
      : null,
    ...(hop.http ? hop.http.rows.map((line) => wireRow(line, call, facts)) : []),
    hop.took
      ? authoredRow(
          { actor: 'server', key: 'took', path: 'took', dimmed: dimmed(facts.focus, 'server'), mono: true },
          hop.took.text,
        )
      : null,
    hop.ratios.length
      ? h(
          'div',
          { class: 'wire-ratios' },
          ...hop.ratios.map((entry) =>
            pill(entry.text, {
              actor: 'page',
              dimmed: dimmed(facts.focus, 'page'),
              title: 'Worked out by this page from the recorded numbers.',
            }),
          ),
        )
      : null,
    hop.port.length
      ? h(
          'div',
          { class: 'wire-ports' },
          ...hop.port.map((text) =>
            pill(text, {
              actor: 'page',
              class: 'wire-port',
              dimmed: dimmed(facts.focus, 'page'),
              title: 'Worked out by this page from what a later call named.',
            }),
          ),
        )
      : null,
    h(
      'p',
      {
        class: cx('wire-footer', 'who-page', dimmed(facts.focus, 'page') && 'is-dimmed'),
        'data-actor': 'page',
      },
      hop.footer,
    ),
    rawBlock(model, facts, hop.rawEventId, resKey(facts.key), 'res'),
  );
}

/** The three panes, opened in place under the row. */
export function renderCallOpen(call, model, ctx = {}) {
  const facts = factsOf(call, model, ctx);
  const inside = insideHop(call, facts.children, { status: facts.status });
  return h(
    'div',
    { class: 'call-open' },
    requestPane(call, model, facts),
    insidePane(model, facts, inside),
    responsePane(call, model, facts),
    insideCards(model, facts, inside),
  );
}
