/**
 * Who authored what (block: dashboard).
 *
 * `provenance.js` answers the one question a flat log cannot: a tool call is a collaboration
 * between the client program, the model, this server and our engine, and on the timeline all four
 * look identical. Two things can go wrong and neither is visible on screen: an event ends up
 * attributed to the wrong party, or a new event type is added and silently falls through the
 * classifier's default. So this file asserts the classification of every known type, and asserts
 * the bands of one call on their *structure* - actor, phase, order, and the few facts a band exists
 * to carry (the tool, the rationale, the table, the audit id, the missing scopes). The sentences
 * themselves are copy and are expected to keep changing, so nothing here quotes a whole one.
 *
 * The recorded fixture supplies a read call, a call with no rationale, a write and a denial; the
 * inference band and the payload-dependent actors are hand-built, because the recording has no
 * `intent.inferred` attached to a call and no cancellation at all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_TYPES } from '../catalogue.js';
import {
  ACTORS,
  ACTOR_LABELS,
  PHASES,
  RATIONALE_TO_AUDIT_TOOLS,
  actorOfEvent,
  actorsOf,
  bandsOf,
  boardOf,
  legend,
} from '../provenance.js';
import { storeFromFixture } from './helpers.mjs';

const PROVENANCE_SOURCE = readFileSync(new URL('../provenance.js', import.meta.url), 'utf8');

/** The session the fixture's first grant ran under; it supplies the client facts of the agent band. */
const FIXTURE_XS = 'xs_3f1c9a';

const store = storeFromFixture();
const events = store.getEvents({});
const calls = store.getCalls({});
const session = store.getSession(FIXTURE_XS);

/** Calls are addressed by `<xs>#<request_id>`, which is stable in the recording. */
function callOf(key) {
  const call = calls.find((item) => item.key === key);
  if (!call) throw new Error(`the fixture has no call ${key}`);
  return call;
}

/** Everything a band puts on screen, joined; assertions match a few words of it, never a sentence. */
function textOf(band) {
  return [band.title, ...band.lines.map((line) => line.value), band.note ?? ''].join(' \n ');
}

/** A band's keyed lines as an object, for asserting the fact rather than the layout. */
function linesByKey(band) {
  return Object.fromEntries(
    band.lines.filter((line) => line.key).map((line) => [line.key, line.value]),
  );
}

const actorPhase = (bands) => bands.map((band) => [band.actor, band.phase]);

/** A call in the shape `store.js` folds (`emptyCall`), for the cases the recording does not hold. */
function handBuiltCall(overrides = {}) {
  return {
    key: 'xs_hand#1',
    event_id: 900,
    xs: 'xs_hand',
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
    finished_event_id: null,
    ...overrides,
  };
}

describe('who originated an event', () => {
  it('classifies one event of every family', () => {
    const sample = [
      'server.started',
      'http.request',
      'auth.client.registered',
      'auth.verified',
      'auth.stepup.requested',
      'session.initialized',
      'session.started',
      'catalog.tools_listed',
      'tool.call.started',
      'tool.call.completed',
      'tool.call.denied',
      'bank.op',
      'etl.load',
      'etl.worker_terminated',
      'sql.query',
      'sql.rejected',
      'intent.declared',
      'intent.inferred',
      'intent.missing',
      'xray.viewer.connected',
      'xray.events.deleted',
    ];
    expect(Object.fromEntries(sample.map((type) => [type, actorOfEvent({ type })]))).toEqual({
      // The client program opens the request and names itself; it never picks a tool.
      'http.request': 'agent',
      'auth.client.registered': 'agent',
      'session.initialized': 'agent',
      // The model is credited only with what it actually wrote.
      'tool.call.started': 'model',
      'intent.declared': 'model',
      'intent.missing': 'model',
      // The server decides, records and answers.
      'server.started': 'server',
      'auth.verified': 'server',
      'auth.stepup.requested': 'server',
      'session.started': 'server',
      'catalog.tools_listed': 'server',
      'tool.call.completed': 'server',
      'tool.call.denied': 'server',
      'intent.inferred': 'server',
      'xray.viewer.connected': 'server',
      'xray.events.deleted': 'server',
      // The engine is what ran: the fake bank and the scratch database.
      'bank.op': 'engine',
      'etl.load': 'engine',
      'etl.worker_terminated': 'engine',
      'sql.query': 'engine',
      'sql.rejected': 'engine',
    });
  });

  it('reads the payload for a cancellation: only the client cancelling is the client', () => {
    const cancelled = (reason) => actorOfEvent({ type: 'tool.call.cancelled', data: { reason } });
    expect(cancelled('client_cancelled')).toBe('agent');
    // The other two reasons of `ToolCallCancelledData` are the server giving up, not the client.
    expect(cancelled('timeout')).toBe('server');
    expect(cancelled('server_stopping')).toBe('server');
  });

  it('reads the payload for a JSON-RPC error: only -32603 is ours', () => {
    const failed = (code) => actorOfEvent({ type: 'protocol.error', data: { code } });
    expect(failed(-32603)).toBe('server');
    expect(failed('-32603')).toBe('server');
    // A malformed request, an unknown method or bad params are the client's own doing.
    expect(failed(-32600)).toBe('agent');
    expect(failed(-32601)).toBe('agent');
    expect(failed(-32602)).toBe('agent');
    expect(failed(-32700)).toBe('agent');
  });

  it('classifies every event type the dashboard knows about', () => {
    expect(KNOWN_TYPES.length).toBeGreaterThan(40);
    const unclassified = KNOWN_TYPES.filter((type) => !ACTORS.includes(actorOfEvent({ type })));
    expect(unclassified).toEqual([]);

    // `actorOfEvent` defaults to `server`, so the assertion above cannot see a *new* type going
    // unclassified. This one can: a type is classified only if this module names it, or is covered
    // by the `xray.` prefix rule. A new event type added to the catalogue has to be triaged here.
    const unnamed = KNOWN_TYPES.filter(
      (type) => !type.startsWith('xray.') && !PROVENANCE_SOURCE.includes(`'${type}'`),
    );
    expect(unnamed).toEqual([]);
  });

  it('falls back to the server rather than throwing on rubbish', () => {
    expect(actorOfEvent(null)).toBe('server');
    expect(actorOfEvent({})).toBe('server');
    expect(actorOfEvent({ type: 'something.new' })).toBe('server');
  });

  it('gives every actor a label and a meaning, in drawing order', () => {
    expect(ACTORS).toEqual(['agent', 'model', 'server', 'engine', 'page']);
    expect(legend().map((entry) => entry.actor)).toEqual(ACTORS);
    for (const entry of legend()) {
      expect(entry.label).toBe(ACTOR_LABELS[entry.actor]);
      expect(entry.meaning.length).toBeGreaterThan(20);
    }
  });
});

describe('the bands of a read call', () => {
  // `load_transactions`: a rationale, a `bank.op` and the `etl.load` that built the scratch table.
  const call = () => callOf('xs_3f1c9a#5');

  it('runs client, model, server, engine, server, and never goes back a phase', () => {
    const bands = bandsOf(call(), events, session);
    expect(actorPhase(bands)).toEqual([
      ['agent', 'in'], // the client framed and sent it
      ['model', 'in'], // the model chose the tool and wrote the arguments
      ['model', 'in'], // the rationale, on its own
      ['server', 'in'], // the gate
      ['engine', 'work'], // bank.op
      ['engine', 'work'], // etl.load
      ['server', 'out'], // the answer
    ]);
    const order = bands.map((band) => PHASES.indexOf(band.phase));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('credits the model with the tool name and the arguments it wrote', () => {
    const [, model] = bandsOf(call(), events, session);
    expect(model.actor).toBe('model');
    const byKey = linesByKey(model);
    expect(byKey.tool).toBe('load_transactions');
    expect(byKey.dates).toBe('2026-08-01 to 2026-08-31');
    // The rationale is prose and gets a band to itself; it is not one of the arguments here.
    expect(byKey.rationale).toBeUndefined();
  });

  it('quotes the rationale as its own band of the model', () => {
    const bands = bandsOf(call(), events, session);
    const model = bands.filter((band) => band.actor === 'model');
    expect(model).toHaveLength(2);
    const [quoted] = model[1].lines;
    expect(model[1].lines).toHaveLength(1);
    expect(quoted.quote).toBe(true);
    expect(quoted.value).toBe(call().rationale);
    expect(model[1].emphasis).toBe(true);
  });

  it("says the server read the rationale and checked the scopes before anything ran", () => {
    const gate = bandsOf(call(), events, session).find(
      (band) => band.actor === 'server' && band.phase === 'in',
    );
    // The whole point of this band: the record exists before the tool does anything (A-06).
    expect(textOf(gate)).toContain('read the rationale');
    expect(gate.title).toContain('before running anything');
    expect(textOf(gate)).toContain('before the tool runs');
    const byKey = linesByKey(gate);
    expect(byKey.scopes).toContain('transactions:read');
    expect(byKey['dropped before storing']).toBe('nothing');
  });

  it('names the scratch table on the engine band that built it', () => {
    const engine = bandsOf(call(), events, session).filter((band) => band.actor === 'engine');
    expect(engine).toHaveLength(2);
    expect(engine.every((band) => band.phase === 'work')).toBe(true);
    const table = engine.find((band) => linesByKey(band).table);
    expect(linesByKey(table).table).toBe('load_transactions_9a41c7e2');
    expect(linesByKey(table).rows).toBe('184');
    // Every engine band cites the event it was read off, so the panel can link back to it.
    expect(engine.every((band) => typeof band.source === 'string' && band.event_id > 0)).toBe(true);
  });

  it('carries the client facts off the session, not off the call', () => {
    const [agent] = bandsOf(call(), events, session);
    expect(agent.actor).toBe('agent');
    const byKey = linesByKey(agent);
    expect(byKey.method).toBe('tools/call');
    expect(byKey.client).toBe('Anthropic 1.0.0');
    expect(byKey.protocol).toBe(session.protocol_version);
    // A session that never named a client leaves the line out rather than inventing one.
    const anonymous = linesByKey(bandsOf(call(), events, {})[0]);
    expect(anonymous.client).toBeUndefined();
    expect(anonymous.method).toBe('tools/call');
  });
});

describe('the bands of a call with no rationale', () => {
  // `load_accounts` arrived without the argument at all, so the server emitted `intent.missing`.
  const call = () => callOf('xs_3f1c9a#11');

  it('says the model did not say why, with nothing quoted', () => {
    const call_ = call();
    expect(call_.rationale_present).toBe(false);
    const bands = bandsOf(call_, events, session);
    const model = bands.filter((band) => band.actor === 'model');
    expect(model).toHaveLength(2);
    expect(model[1].title).toContain('did not say why');
    expect(model[1].lines.every((line) => line.quote !== true)).toBe(true);
    expect(textOf(model[1])).toContain('rationale');
  });

  it('reports on the gate band why there was nothing to record', () => {
    const gate = bandsOf(call(), events, session).find(
      (band) => band.actor === 'server' && band.phase === 'in',
    );
    const text = textOf(gate);
    // The child event says `reason: absent`; the band spells that out rather than printing the code.
    expect(text).toContain('not sent at all');
    expect(text).not.toContain('read the rationale');
    expect(gate.lines[0].tone).toBe('warn');
  });
});

describe('the bands of a write', () => {
  // `lock_or_unlock_card`: the one place the model's prose outlives the call, on the audit row.
  const write = () => callOf('xs_3f1c9a#18');
  const read = () => callOf('xs_3f1c9a#5');

  it('says the rationale travelled on to the audit row, and names it', () => {
    expect(RATIONALE_TO_AUDIT_TOOLS.has('lock_or_unlock_card')).toBe(true);
    const gates = bandsOf(write(), events, session).filter(
      (band) => band.actor === 'server' && band.phase === 'in',
    );
    expect(gates).toHaveLength(2);
    const travel = gates[1];
    expect(textOf(travel)).toContain('aud_0002');
    expect(textOf(travel)).toContain('audit');
    expect(travel.lines).toHaveLength(1);
  });

  it('does not claim a read tool handed anything on to the bank', () => {
    expect(RATIONALE_TO_AUDIT_TOOLS.has('load_transactions')).toBe(false);
    const call = read();
    expect(call.rationale_present).toBe(true);
    const gates = bandsOf(call, events, session).filter(
      (band) => band.actor === 'server' && band.phase === 'in',
    );
    // Only the gate: nothing of what the model wrote is stored anywhere else by a read.
    expect(gates).toHaveLength(1);
    expect(textOf(gates[0])).not.toContain('audit');
  });
});

describe('the bands of a denied call', () => {
  // `create_transfer` under a read-only grant: the gate answered 403 before the tool existed.
  const call = () => callOf('xs_3f1c9a#14');

  it('says on the way out that it was refused, and which scopes were missing', () => {
    const out = bandsOf(call(), events, session).filter((band) => band.phase === 'out');
    expect(out).toHaveLength(1);
    expect(out[0].actor).toBe('server');
    expect(out[0].title).toContain('refused');
    const text = textOf(out[0]);
    expect(text).toContain('denied before it ran');
    expect(text).toContain('cards:write');
    expect(text).toContain('transfers:write');
    expect(out[0].lines[0].tone).toBe('denied');
  });

  it('still shows the missing scopes on the gate, with an error tone', () => {
    const gate = bandsOf(call(), events, session).find(
      (band) => band.actor === 'server' && band.phase === 'in',
    );
    const scopes = gate.lines.find((line) => line.key === 'scopes');
    expect(scopes.value).toContain('transfers:write');
    expect(scopes.tone).toBe('error');
  });

  it('never says the reason reached the bank on a write that never reached it', () => {
    // The gate records the stated intent *before* it checks the flag, the scopes and the schema
    // (`src/tools/registry.ts`), so a refused write arrives here with a rationale and no `bank.op`.
    // Claiming the audit story on the strength of the tool name alone printed "passed the reason
    // on to the bank" directly above "denied before it ran".
    const refused = { ...call(), rationale_present: true, rationale: 'pay the rent' };
    expect(RATIONALE_TO_AUDIT_TOOLS.has(refused.tool)).toBe(true);
    const bands = bandsOf(refused, events, session);
    expect(bands.filter((band) => band.actor === 'server' && band.phase === 'in')).toHaveLength(1);
    const everything = bands.map(textOf).join(' ');
    expect(everything).not.toContain('passed the reason on to the bank');
    // What it does say is still there: the model's words, and that they were recorded.
    expect(everything).toContain('pay the rent');
  });
});

describe('the workflow the server guessed afterwards', () => {
  const inferred = {
    id: 901,
    type: 'intent.inferred',
    request_id: '1',
    xs: 'xs_hand',
    data: {
      workflow: 'spend_analysis',
      confidence: 0.72,
      source: 'classifier',
      model_authored: false,
      tools: ['load_transactions', 'process_data', 'execute_query'],
    },
  };
  const call = () => handBuiltCall({ child_event_ids: [901] });

  it('never prints the score as a percentage, and says it changed nothing', () => {
    const bands = bandsOf(call(), [inferred], session);
    const band = bands.find((item) => item.lines.some((line) => line.key === 'workflow'));
    expect(band.actor).toBe('server');
    expect(band.phase).toBe('out');
    // `confidence` is how far the winner scored ahead of the runner-up, not a probability, so a
    // `%` anywhere in this band would be a lie about what the number means.
    expect(textOf(band)).not.toContain('%');
    expect(textOf(band)).toContain('0.72');
    expect(textOf(band)).toContain('changed nothing');
    expect(linesByKey(band).workflow).toBe('spend analysis');
    // It ran after the call finished, and is drawn after the answer it did not affect.
    expect(bands.indexOf(band)).toBe(bands.length - 1);
  });

  it('is absent when the classifier said nothing about this call', () => {
    const bands = bandsOf(handBuiltCall(), [], session);
    expect(bands.some((band) => band.lines.some((line) => line.key === 'workflow'))).toBe(false);
  });
});

describe('the board', () => {
  it('groups the bands into in, ran and out, in that order', () => {
    const call = callOf('xs_3f1c9a#5');
    const board = boardOf(call, events, session);
    expect(board.map((column) => column.phase)).toEqual(['in', 'work', 'out']);
    expect(board.map((column) => column.label)).toEqual(['in', 'ran', 'out']);
    expect(board.length).toBeLessThanOrEqual(PHASES.length);
    // Every band lands in exactly one column, in the order `bandsOf` produced them.
    const flat = board.flatMap((column) => column.bands);
    expect(flat).toEqual(bandsOf(call, events, session));
  });

  it('drops a column with nothing in it', () => {
    // A call denied before it ran has no `work`: nothing of ours ever executed.
    const board = boardOf(callOf('xs_3f1c9a#28'), events, session);
    expect(board.map((column) => column.phase)).toEqual(['in', 'out']);
    expect(board.every((column) => column.bands.length > 0)).toBe(true);
    expect(boardOf(null, events, session)).toEqual([]);
    expect(bandsOf(null, events, session)).toEqual([]);
  });
});

describe('which actors are in play', () => {
  it('lists the actors of a board in drawing order', () => {
    expect(actorsOf(bandsOf(callOf('xs_3f1c9a#5'), events, session))).toEqual([
      'agent',
      'model',
      'server',
      'engine',
    ]);
    // Nothing of ours ran on a denial, so the engine never appears.
    expect(actorsOf(bandsOf(callOf('xs_3f1c9a#28'), events, session))).toEqual([
      'agent',
      'model',
      'server',
    ]);
  });

  it('answers in ACTORS order whatever order the bands arrive in, without duplicates', () => {
    const bands = [{ actor: 'page' }, { actor: 'engine' }, { actor: 'agent' }, { actor: 'engine' }];
    expect(actorsOf(bands)).toEqual(['agent', 'engine', 'page']);
    expect(actorsOf([])).toEqual([]);
  });
});
