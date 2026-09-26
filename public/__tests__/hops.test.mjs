/**
 * The three hops of one call (block: dashboard).
 *
 * `hops.js` is the data behind "the request as it arrived / what happened inside / the response as
 * it left". Everything it produces is a claim about provenance, so the failures worth catching are
 * claims that are subtly untrue: an argument drawn out of the order it arrived in, a sentence that
 * says the model wrote something it did not, a cap clause naming the wrong cap, or "the whole
 * result" printed over a preview.
 *
 * The recording (`test/fixtures/events.jsonl`, contracts v0.5) supplies the ordinary read call, the
 * write with an audit row, the call with no rationale, the two denials, the descriptor a listing
 * sent, the `http.request` that carried a call, the one result preview the producer cut and the
 * classifier's `intent.inferred` under `clear_table` #10. It cannot supply a running call, a
 * cancellation, an observer view, a rationale over either cap, a listing without descriptors, a
 * preview shortened without the marker, a multi-block result, truncated structured content, a
 * share worth printing or an overlap - those are hand-built here, in the shape `store.js` folds.
 * The classifier card is hand-built too, so its test does not depend on the recording.
 *
 * No assertion pins a clock string: `clockTime` prints the viewer's local time, so a pinned value
 * would pass in one time zone and fail in another. Where a clock matters, the expectation is built
 * with the same formatter.
 */
import { describe, expect, it } from 'vitest';
import { buildLinks, childEventsOf } from '../chain.js';
import { clockTime } from '../format.js';
import {
  RATIONALE_HANDLER_CAP,
  TRUNCATION_MARKER,
  insideHop,
  missingRationale,
  overlapChip,
  portsOf,
  rationaleLocator,
  rationaleNote,
  requestHop,
  responseHop,
  sizeFacts,
} from '../hops.js';
import { MISSING_REASONS, auditHandOff, gateFacts } from '../provenance.js';
import { storeFromFixture } from './helpers.mjs';

const store = storeFromFixture();
const events = store.getEvents({});
const calls = store.getCalls({});
const links = buildLinks(calls, events);

function callOf(key) {
  const call = calls.find((item) => item.key === key);
  if (!call) throw new Error(`the fixture has no call ${key}`);
  return call;
}

const childrenOf = (call) => childEventsOf(call, events);

function requestOf(key, extra = {}) {
  const call = callOf(key);
  return requestHop(call, store.getSession(call.xs), {
    links,
    events,
    catalog: store.getCatalog(call.xs),
    ...extra,
  });
}

const responseOf = (key) => responseHop(callOf(key), { consumers: links });
const insideOf = (key) => insideHop(callOf(key), childrenOf(callOf(key)), {});

/** A call in the shape `store.js` folds (`emptyCall`), for what the recording cannot show. */
function handBuiltCall(overrides = {}) {
  return {
    key: 'xs_hand#1',
    event_id: 900,
    xs: 'xs_hand',
    login_id: 'lgn_hand',
    grant_id: 'grt_hand',
    request_id: '1',
    tool: 'execute_query',
    started_at: '2026-09-08T14:00:00.000Z',
    started_epoch: Date.parse('2026-09-08T14:00:00.000Z'),
    finished_at: '2026-09-08T14:00:01.000Z',
    arguments: {},
    redacted_fields: [],
    rationale: null,
    rationale_present: false,
    rationale_truncated: false,
    rationale_declared: null,
    rationale_declared_truncated: false,
    meta: null,
    required_scopes: [],
    budget_ms: 300_000,
    status: 'ok',
    duration_ms: 12,
    is_error: false,
    error: null,
    content_types: ['text'],
    content_chars: 40,
    content_cap: 150_000,
    structured_content: null,
    text_preview: 'ok',
    denied_reason: null,
    missing_scopes: [],
    inferred_workflow: null,
    child_event_ids: [],
    finished_event_id: 901,
    http: null,
    ...overrides,
  };
}

function declaredEvent(text, overrides = {}) {
  return {
    id: 902,
    ts: '2026-09-08T14:00:00.100Z',
    type: 'intent.declared',
    data: { text, source: 'rationale', model_authored: true, truncated: false },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The request, over the recording
// ---------------------------------------------------------------------------

describe('the request as it arrived, over the fixture', () => {
  it('rebuilds the envelope in arrival order, with the rationale where it arrived', () => {
    const hop = requestOf('xs_7b4d10#5');
    // `describeIn` would hoist a date pair into a synthetic `dates` part and move everything after
    // it; this pane reads `call.arguments` straight, so the keys stay where the model wrote them.
    expect(hop.rows.map((line) => line.path)).toEqual([
      'id',
      'method',
      'params.name',
      'params.arguments.table_name',
      'params.arguments.query',
      'params.arguments.rationale',
    ]);
    expect(hop.rows.map((line) => line.actor)).toEqual([
      'agent',
      'page',
      'model',
      'model',
      'model',
      'model',
    ]);
    // `method` is not stored anywhere: it is read off the event type, so it wears the page rail.
    const method = hop.rows.find((line) => line.path === 'method');
    expect(method.implied).toBe(true);
    expect(hop.rows.filter((line) => line.implied).map((line) => line.path)).toEqual(['method']);
    expect(hop.title).toBe('REQUEST · tools/call · id 5 · as it arrived');
  });

  it('keeps the argument values as recorded and marks the rationale row', () => {
    const hop = requestOf('xs_7b4d10#5');
    const table = hop.rows.find((line) => line.key === 'table_name');
    expect(table.value).toBe('load_cards_51e8a3b6');
    expect(table.redacted).toBe(false);
    expect(hop.rationale.row).toBe(hop.rows[hop.rows.length - 1]);
    expect(hop.rationale.row.emphasis).toBe(true);
    expect(hop.rationale.row.value).toBe(callOf('xs_7b4d10#5').rationale);
  });

  it('ports an argument back to the call that fed it, and names the footer it was rebuilt from', () => {
    const hop = requestOf('xs_7b4d10#5');
    const table = hop.rows.find((line) => line.key === 'table_name');
    expect(table.port).toBe('from #4 · table');
    // Only the fed argument carries a port; nothing else is claimed to have come from anywhere.
    expect(hop.rows.filter((line) => line.port !== null)).toHaveLength(1);
    expect(hop.footer).toBe(
      'rebuilt by this page from tool.call.started #197: id, params and _meta are stored fields, method is implied by the event type; the bytes on the wire were not kept',
    );
    expect(hop.rawEventId).toBe(197);
  });

  it('locates the rationale requirement in the schema the listing sent (contracts v0.5)', () => {
    const hop = requestOf('xs_7b4d10#5');
    // Listing #178 carries the descriptor, so the page points at the schema instead of at ADR-8.
    expect(hop.rationale.locator).toBe(
      'params.arguments.rationale · required by the schema sent at tools/list #178',
    );
  });

  it('notes what the gate did with it, naming the event, its length and its cap', () => {
    const call = callOf('xs_7b4d10#5');
    const declared = childrenOf(call).find((event) => event.type === 'intent.declared');
    const hop = requestOf('xs_7b4d10#5');
    // The clock is the viewer's local time, so the expectation is built with the same formatter.
    expect(hop.rationale.note).toBe(
      `read first, at the gate: recorded as intent.declared #198 at ${clockTime(declared.ts)} (50 chars, not cut), then removed before execute_query received the arguments (src/tools/registry.ts)`,
    );
    expect(declared.data.text).toHaveLength(50);
  });

  it('reads a v0.5 descriptor when the listing carried one, and falls back to ADR-8 when not', () => {
    const call = callOf('xs_7b4d10#5');
    const catalog = {
      event_id: 178,
      tools: [{ name: 'execute_query', descriptor: { description: 'x', inputSchema: {}, annotations: {}, _meta: {} } }],
    };
    expect(rationaleLocator(call, catalog)).toBe(
      'params.arguments.rationale · required by the schema sent at tools/list #178',
    );
    // A listing recorded without descriptors (contracts v0.4): the page cites the documented rule
    // and says the schema itself was not kept, never that it read one.
    expect(rationaleLocator(call, { event_id: 178, tools: [{ name: 'execute_query' }] })).toBe(
      'params.arguments.rationale · required by every published schema (ADR-8); the schema itself was not recorded on tools/list #178 (contracts v0.4)',
    );
    // With no catalog at all the page claims nothing about a listing it never saw.
    expect(rationaleLocator(call, null)).toContain('was not recorded');
    expect(rationaleLocator(call, null)).not.toContain('#');
  });

  it('says nothing was recorded when the gate answered before the body was read', () => {
    const hop = requestOf('xs_3f1c9a#14');
    expect(hop.denied.value).toBe(
      'the bearer gate answered before the body was read: no arguments were recorded',
    );
    // Never the model rail: no model wrote that sentence.
    expect(hop.denied.actor).toBe('server');
    expect(hop.rows.some((line) => line.path.startsWith('params.arguments'))).toBe(false);
    expect(hop.rationale).toBeNull();
  });

  it('reports a missing rationale as A-06 rather than inventing one', () => {
    const call = callOf('xs_3f1c9a#11');
    const chip = missingRationale(call, childrenOf(call));
    expect(chip).toEqual({
      reason: 'absent',
      event_id: 66,
      text: `no rationale to record: ${MISSING_REASONS.absent} (intent.missing #66, A-06)`,
    });
    const hop = requestOf('xs_3f1c9a#11');
    expect(hop.rationale.row).toBeNull();
    expect(hop.rationale.note).toBe(chip.text);
    // The requirement still holds even though nothing arrived, so the locator is still drawn, and
    // it names the listing of this call's own session, not the one after the restart.
    expect(hop.rationale.locator).toBe(
      'params.arguments.rationale · required by the schema sent at tools/list #21',
    );
  });
});

// ---------------------------------------------------------------------------
// The interior, over the recording
// ---------------------------------------------------------------------------

describe('what happened inside, over the fixture', () => {
  it('opens with the gate and hands to the handler on the page rail, citing the registry', () => {
    const hop = insideOf('xs_7b4d10#5');
    const gate = hop.cards[0];
    expect(gate.n).toBe(1);
    expect(gate.actor).toBe('server');
    expect(gate.source).toBe('tool.call.started');
    const handedTo = gate.out[0];
    // The arguments the handler received are recorded nowhere: the lenient schema applies its
    // defaults, then `rationale` is stripped. That is a mechanism, so it cannot sit on a data rail.
    expect(handedTo.actor).toBe('page');
    expect(handedTo.value).toContain('were not recorded');
    expect(handedTo.value).toContain('src/tools/registry.ts');
    expect(gate.in.map((line) => line.key)).toEqual([
      'rationale',
      'dropped before storing',
      'budget',
    ]);
  });

  it('puts the SQL on the model rail of the step our engine ran', () => {
    const hop = insideOf('xs_7b4d10#5');
    const sql = hop.cards[1];
    expect(sql.actor).toBe('engine');
    expect(sql.source).toBe('sql.query');
    expect(sql.event_id).toBe(199);
    const written = sql.in.find((line) => line.key === 'sql');
    expect(written.actor).toBe('model');
    expect(sql.in.find((line) => line.key === 'on table').value).toBe('load_cards_51e8a3b6');
    expect(sql.out.map((line) => line.key)).toContain('rows back');
    expect(hop.summary).toBe('2 steps inside · this server → our engine');
  });

  it('draws the audit hand-off only on the evidence of a bank.op with an audit id', () => {
    const write = insideOf('xs_3f1c9a#18');
    const handOff = write.cards[write.cards.length - 1];
    expect(handOff.title).toBe('passed the reason on to the bank');
    expect(handOff.out[0].value).toContain('aud_0002');
    expect(handOff.in[0].actor).toBe('model');
    expect(write.cards[0].in.find((line) => line.key === 'scopes').value).toBe(
      'cards:write - granted',
    );
    // A read tool with a rationale and no audit row never claims the reason travelled anywhere.
    expect(auditHandOff(callOf('xs_3f1c9a#5'), childrenOf(callOf('xs_3f1c9a#5')))).toBeNull();
    expect(insideOf('xs_3f1c9a#5').cards.some((card) => card.title.includes('passed the reason'))).toBe(
      false,
    );
  });

  it('shows the step-up on a denial and nothing at all on the rate limit', () => {
    const denied = insideOf('xs_3f1c9a#14');
    expect(denied.cards.map((card) => card.source)).toEqual(['auth.stepup.requested']);
    expect(denied.cards[0].in[0].value).toBe('cards:write transfers:write');
    const limited = insideOf('xs_3f1c9a#28');
    expect(limited.cards).toEqual([]);
    expect(limited.summary).toBe('nothing ran inside: the gate answered first');
  });
});

// ---------------------------------------------------------------------------
// The response, over the recording
// ---------------------------------------------------------------------------

describe('the response as it left, over the fixture', () => {
  it('labels the content from content_types and says a whole preview was kept whole', () => {
    const hop = responseOf('xs_7b4d10#5');
    const content = hop.rows.find((line) => line.path === 'result.content');
    // Never `content[0]`: the stored preview is every text block joined.
    expect(content.key).toBe('content · text (1 block, joined)');
    expect(content.value).toBe('397 chars');
    expect(hop.size).toMatchObject({ sent: 397, kept: 397, capped: false });
    expect(hop.size.sentence).toBe(
      'The text content was 397 characters across 1 block; this recording kept all of it.',
    );
    expect(hop.title).toBe('RESPONSE · result of id 5 · as it left');
    expect(hop.footer).toBe(
      'rebuilt by this page from tool.call.completed #200; the bytes on the wire were not kept',
    );
    expect(hop.waiting).toBe(false);
  });

  it('never prints a share under 5%, and never a percentage for the confidence', () => {
    const hop = responseOf('xs_7b4d10#5');
    // 7 ms of 300 s and 397 of 150,000 characters: both are noise, so neither is drawn.
    expect(hop.ratios).toEqual([]);
    expect(hop.took.text).toBe('7 ms of the 300 s allowed');
    expect(JSON.stringify(hop)).not.toContain('%');
    expect(JSON.stringify(insideOf('xs_7b4d10#5'))).not.toContain('%');
  });

  it('says "8,417 sent · 2,048 kept" for the one preview the producer cut', () => {
    // The capped query (100 rows plus the row-cap sentence) is the only result over the 2,048-character
    // preview, so this row must not round the difference away into "8,417 chars".
    const hop = responseOf('xs_3f1c9a#9');
    expect(hop.size).toMatchObject({ sent: 8417, kept: 2048, capped: true });
    expect(hop.rows.find((line) => line.path === 'result.content').value).toBe(
      '8,417 sent · 2,048 kept',
    );
    expect(hop.size.sentence).toBe(
      'The text content was 8,417 characters across 1 block; this recording kept the first 2,048 (the per-result cap). The rest was never recorded.',
    );
    expect(hop.size.sentence).not.toContain('kept all of it');
  });

  it('lists every missing scope a denial carries, not the first one', () => {
    const hop = responseOf('xs_3f1c9a#14');
    const missing = hop.rows.find((line) => line.path === 'error.missing_scopes');
    expect(missing.value).toEqual(['cards:write', 'transfers:write']);
    expect(hop.error).toMatchObject({
      class: 'denied',
      message: 'insufficient_scope',
      missing_scopes: ['cards:write', 'transfers:write'],
    });
    expect(hop.footer).toBe(
      'rebuilt by this page from tool.call.denied #77; the bytes on the wire were not kept',
    );
    expect(hop.size.row.value).toBe('no text');
    // The gate refused the call before it started, and the 403 still reaches the pane: the store
    // hands the parked `http.request` to the `tool.call.denied` that opened the call.
    expect(hop.http).toMatchObject({ event_id: 76, status: 403 });
    expect(hop.http.rows[1].value).toMatch(/^403 in /);
  });

  it('reports a rate limit without inventing scopes it never named', () => {
    const hop = responseOf('xs_3f1c9a#28');
    expect(hop.rows.map((line) => line.path)).toEqual(['id', 'error.reason']);
    expect(hop.error.message).toBe('rate_limited');
    expect(hop.error.missing_scopes).toEqual([]);
    expect(hop.http).toMatchObject({ event_id: 159, status: 429 });
  });

  it('ports the result forward to the call that consumed it', () => {
    expect(responseOf('xs_7b4d10#4').port).toEqual(['to #5 · table']);
    expect(responseOf('xs_7b4d10#5').port).toEqual([]);
    // Contracts v0.5: `http.request` carries the JSON-RPC id, so the call finds the row that carried
    // it by key, never by time.
    const http = responseOf('xs_7b4d10#5').http;
    expect(http).toMatchObject({ event_id: 196, status: 200, duration_ms: 16 });
    expect(http.rows.map((line) => [line.actor, line.value])).toEqual([
      ['agent', 'one HTTP request the client app opened (http.request #196)'],
      ['server', '200 in 16 ms'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// What the recording cannot show
// ---------------------------------------------------------------------------

describe('a call that has not answered yet', () => {
  it('says it is waiting rather than claiming an empty result', () => {
    const call = handBuiltCall({
      status: 'running',
      duration_ms: null,
      finished_at: null,
      finished_event_id: null,
      content_types: [],
      content_chars: 0,
      text_preview: null,
    });
    const hop = responseHop(call, {});
    expect(hop.waiting).toBe(true);
    expect(hop.size.row.value).toBe('waiting');
    expect(hop.took).toBeNull();
    expect(hop.footer).toBe(
      'nothing has left the server yet: this page has no completion event to rebuild from',
    );
    expect(hop.rawEventId).toBeNull();
  });

  it('marks the interior as still running', () => {
    const call = handBuiltCall({ status: 'running', child_event_ids: [] });
    expect(insideHop(call, [], { status: 'running' }).summary).toBe(
      '1 step inside so far · still running',
    );
  });
});

describe('a cancelled call', () => {
  it('gives the reason on the server rail and no result rows', () => {
    const call = handBuiltCall({
      status: 'cancelled',
      cancel_reason: 'client_cancelled',
      content_types: [],
      content_chars: 0,
      text_preview: null,
      finished_event_id: 904,
    });
    const hop = responseHop(call, {});
    expect(hop.rows.map((line) => line.path)).toEqual(['id', 'error.reason']);
    expect(hop.error).toMatchObject({ class: 'cancelled', message: 'client_cancelled' });
    expect(hop.footer).toBe(
      'rebuilt by this page from tool.call.cancelled #904; the bytes on the wire were not kept',
    );
  });
});

describe('an observer reading someone else’s call', () => {
  it('reads the withholding off the event, and the viewer only chooses the wording', () => {
    const call = handBuiltCall({
      arguments: {},
      redacted_fields: ['arguments'],
      rationale: 'Show every card with its status',
      rationale_present: true,
    });
    const anyone = requestHop(call, null, {});
    expect(anyone.observer.value).toBe('arguments withheld from observers by the server');
    expect(anyone.observer.actor).toBe('server');
    expect(anyone.rows.some((line) => line.path.startsWith('params.arguments'))).toBe(false);

    const admin = requestHop(call, null, { viewer: { viewer_kind: 'admin' } });
    expect(admin.observer.value).toContain('arguments withheld from observers by the server');
    expect(admin.observer.value).toContain('observer mode');

    // A call whose arguments were not withheld draws no observer line, whoever is reading.
    expect(requestHop(handBuiltCall({ arguments: { table_name: 't' } }), null, {
      viewer: { viewer_kind: 'admin' },
    }).observer).toBeNull();
  });
});

describe('a rationale longer than a cap', () => {
  it('names the 1,024-character cap, and never the 8,192 one, when only the handler copy was cut', () => {
    const written = 'y'.repeat(1100);
    const call = handBuiltCall({
      tool: 'load_bills',
      rationale: written,
      rationale_present: true,
      // `rationale_truncated` is set for anything over 1,024 characters, so the flag alone would
      // say nothing about which cap bit: the clause is derived from the lengths instead.
      rationale_truncated: true,
      rationale_declared: written.slice(0, RATIONALE_HANDLER_CAP),
    });
    const declared = declaredEvent(written.slice(0, RATIONALE_HANDLER_CAP), {
      data: { text: written.slice(0, RATIONALE_HANDLER_CAP), truncated: true },
    });
    const note = rationaleNote(call, [declared]);
    expect(note).toContain('(1,024 chars, the handler and the audit row kept the first 1,024 characters)');
    expect(note).not.toContain('8,192');
    expect(note).toContain('then removed before load_bills received the arguments');
  });

  it('names the 8,192-character cap when this server cut the record itself', () => {
    const call = handBuiltCall({
      rationale: `${'z'.repeat(8192)}${TRUNCATION_MARKER}`,
      rationale_present: true,
      rationale_truncated: true,
      rationale_declared: 'z'.repeat(RATIONALE_HANDLER_CAP),
    });
    const declared = declaredEvent('z'.repeat(RATIONALE_HANDLER_CAP), {
      data: { text: 'z'.repeat(RATIONALE_HANDLER_CAP), truncated: true },
    });
    const note = rationaleNote(call, [declared]);
    expect(note).toContain('cut by this server at 8,192 characters');
    expect(note).toContain('the handler and the audit row kept the first 1,024 characters');
  });
});

describe('sizing a result the recording only holds part of', () => {
  it('clamps what was kept to what was sent, because the preview joins the blocks', () => {
    // Two text blocks of 11 and 12 characters are 23 in `content_chars` and 24 in the preview,
    // which joins them with a newline. A recording can never hold more than was sent.
    const facts = sizeFacts('first block\nsecond block', 23, ['text', 'text']);
    expect(facts.sent).toBe(23);
    expect(facts.kept).toBe(23);
    expect(facts.row.key).toBe('content · text (2 blocks, joined)');
    expect(facts.row.value).toBe('23 chars');
    expect(facts.sentence).toBe(
      'The text content was 23 characters across 2 blocks; this recording kept all of it.',
    );
  });

  it('says which cap bit when the producer cut the preview itself', () => {
    const facts = sizeFacts(`${'x'.repeat(2048)}${TRUNCATION_MARKER}`, 8421, ['text']);
    expect(facts).toMatchObject({ sent: 8421, kept: 2048, capped: true });
    expect(facts.row.value).toBe('8,421 sent · 2,048 kept');
    expect(facts.sentence).toBe(
      'The text content was 8,421 characters across 1 block; this recording kept the first 2,048 (the per-result cap). The rest was never recorded.',
    );
    expect(facts.sentence).not.toContain('kept all of it');
  });

  it('says how much was kept when a preview is short with no marker, and names no cap', () => {
    // Redaction can shorten a whole preview (a secret becomes the shorter placeholder,
    // src/xray/redaction.ts) without the truncation marker, so no cap bit and none is named.
    const facts = sizeFacts('x'.repeat(33), 36, ['text']);
    expect(facts).toMatchObject({ sent: 36, kept: 33, capped: false });
    expect(facts.row.value).toBe('36 sent · 33 kept');
    expect(facts.sentence).toBe(
      'The text content was 36 characters across 1 block; this recording kept the first 33. The rest was never recorded.',
    );
    expect(facts.sentence).not.toContain('(the per-result cap)');
  });

  it('says there was no text rather than printing a zero', () => {
    expect(sizeFacts(null, 0, []).row.value).toBe('no text');
    expect(sizeFacts(null, 0, []).sentence).toBe('The result carried no text block.');
  });
});

describe('structured content the recording only holds a preview of', () => {
  it('says so, in characters, and never calls it the object', () => {
    const call = handBuiltCall({
      structured_content: { truncated: true, preview: '{"rows":[{"id":"acc_a1b2_01"' },
    });
    const hop = responseHop(call, {});
    expect(hop.structured.truncated).toBe(true);
    expect(hop.structured.sentence).toBe(
      'preview of a larger object: the first 2,048 characters of its JSON; the rest was never recorded.',
    );
    expect(hop.rows.map((line) => line.path)).toContain('result.structuredContent');

    const whole = responseHop(handBuiltCall({ structured_content: { table_name: 't' } }), {});
    expect(whole.structured.truncated).toBe(false);
  });
});

describe('the HTTP request that carried the call', () => {
  it('splits the two facts across the client-app rail and the server rail', () => {
    const call = handBuiltCall({ http: { event_id: 950, status: 200, duration_ms: 41 } });
    const hop = responseHop(call, {});
    expect(hop.http.rows).toHaveLength(2);
    expect(hop.http.rows[0].actor).toBe('agent');
    expect(hop.http.rows[0].value).toContain('http.request #950');
    expect(hop.http.rows[1].actor).toBe('server');
    expect(hop.http.rows[1].value).toBe('200 in 41 ms');
    // Absent entirely when the store never attached one; never matched by time.
    expect(responseHop(handBuiltCall(), {}).http).toBeNull();
  });
});

describe('a share worth printing', () => {
  it('draws the ratio at 6% and leaves the other one out', () => {
    const call = handBuiltCall({ duration_ms: 18_000, content_chars: 486 });
    const hop = responseHop(call, {});
    expect(hop.ratios).toHaveLength(1);
    expect(hop.ratios[0]).toMatchObject({ percent: '6%', capped: false });
    expect(hop.ratios[0].text).toBe('6% of the 300 s allowed');
    // The time share is printed; the size share (486 of 150,000) is not.
    expect(hop.took.text).toBe('18.00 s of the 300 s allowed');
  });

  it('does not let the preview cut stand in for the content cap', () => {
    // The recording cut this preview at 2,048 characters; the 150,000-character content cap was
    // nowhere near, so a 2% share stays below the floor and nothing is flagged as capped.
    const cut = handBuiltCall({
      content_chars: 3_000,
      content_cap: 150_000,
      text_preview: `${'x'.repeat(2048)}${TRUNCATION_MARKER}`,
    });
    const hop = responseHop(cut, {});
    expect(hop.size.capped).toBe(true);
    expect(hop.ratios).toEqual([]);
    // Over the recording the capped query clears the floor on its own, and says so without the bit.
    expect(responseOf('xs_3f1c9a#9').ratios).toEqual([
      expect.objectContaining({ of: 'the 150,000-character cap', percent: '6%', capped: false }),
    ]);
  });

  it('draws the size share whatever it is once the cap bit is set', () => {
    const call = handBuiltCall({ content_chars: 150_000, content_cap: 150_000, text_preview: 'x' });
    const hop = responseHop(call, {});
    expect(hop.ratios.map((entry) => entry.of)).toEqual(['the 150,000-character cap']);
    expect(hop.ratios[0].capped).toBe(true);
  });
});

describe('two calls in flight at once', () => {
  it('chips the call that started while another was still running', () => {
    const first = handBuiltCall({
      key: 'xs_hand#1',
      request_id: '1',
      started_at: '2026-09-08T14:00:00.000Z',
      started_epoch: Date.parse('2026-09-08T14:00:00.000Z'),
      finished_at: '2026-09-08T14:00:05.000Z',
    });
    const second = handBuiltCall({
      key: 'xs_hand#2',
      request_id: '2',
      started_at: '2026-09-08T14:00:02.000Z',
      started_epoch: Date.parse('2026-09-08T14:00:02.000Z'),
      finished_at: '2026-09-08T14:00:03.000Z',
    });
    expect(overlapChip(second, [first, second]).text).toBe('started while #1 was still running');
    expect(overlapChip(first, [first, second]).text).toBe(
      '#2 started while this call was still running',
    );
    // A different grant is a different connection; its clock says nothing about this one.
    const elsewhere = handBuiltCall({ key: 'xs_other#2', request_id: '2', grant_id: 'grt_other' });
    expect(overlapChip(second, [elsewhere, second])).toBeNull();
    // Two calls that never overlapped get no chip at all.
    expect(overlapChip(first, [first])).toBeNull();
  });
});

describe('the classifier', () => {
  it('adds a card only when an intent.inferred is nested under the call, and scores it', () => {
    const call = handBuiltCall({ child_event_ids: [963] });
    const inferred = {
      id: 963,
      ts: '2026-09-08T14:00:01.000Z',
      type: 'intent.inferred',
      data: {
        workflow: 'spend_analysis',
        confidence: 0.85,
        source: 'classifier',
        model_authored: false,
        tools: ['load_transactions', 'process_data', 'execute_query'],
      },
    };
    const hop = insideHop(call, [inferred], {});
    const card = hop.cards[hop.cards.length - 1];
    expect(card.source).toBe('intent.inferred');
    expect(card.out.map((line) => line.value)).toEqual(['spend analysis', 'scored 0.85']);
    expect(JSON.stringify(card)).not.toContain('%');
    // Without the child there is no card; the recording nests its one under `clear_table` #10.
    expect(insideHop(call, [], {}).cards.some((item) => item.source === 'intent.inferred')).toBe(
      false,
    );
  });
});

describe('ports built from the chain links', () => {
  it('reads the fed argument off each kind of link', () => {
    const confirm = handBuiltCall({
      key: 'xs_hand#3',
      tool: 'create_transfer',
      arguments: { from_account_id: 'acc_1', to: { payee_id: 'pay_3' }, expected_total_amount: 128_400, confirm: true },
    });
    const ports = portsOf(confirm, [
      { from: 'xs_hand#2', to: 'xs_hand#3', kind: 'preview', label: 'preview $1,284.00' },
      { from: 'xs_hand#1', to: 'xs_hand#3', kind: 'id', label: 'to.payee_id pay_3' },
      { from: 'xs_hand#9', to: 'xs_other#4', kind: 'table', label: 'table t' },
    ]);
    expect(ports).toEqual({
      expected_total_amount: 'from #2 · preview',
      to: 'from #1 · id',
    });
  });
});

describe('the gate facts the board and the interior share', () => {
  it('reports the same rationale, scopes, drops and budget the band draws', () => {
    const call = callOf('xs_3f1c9a#18');
    const facts = gateFacts(call, childrenOf(call));
    expect(facts.rationale).toMatchObject({ state: 'declared', event_id: 102 });
    expect(facts.scopes).toMatchObject({ granted: true, required: ['cards:write'], missing: [] });
    expect(facts.dropped.text).toBe('nothing');
    expect(facts.budget.ms).toBe(300_000);

    const absent = callOf('xs_3f1c9a#11');
    const missing = gateFacts(absent, childrenOf(absent));
    expect(missing.rationale).toMatchObject({ state: 'missing', reason: 'absent' });
    expect(missing.rationale.text).toBe(`no rationale to record: ${MISSING_REASONS.absent}`);
  });
});
