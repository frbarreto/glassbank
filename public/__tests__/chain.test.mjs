/**
 * The chain: what one call handed to the next (block: dashboard).
 *
 * `chain.js` is the whole answer to "I cannot see what one action called": every link it draws has
 * to come from the events, never from a guess, so this file asserts the evidence rather than the
 * shape. Most of it runs against the recorded fixture, which contains the two link kinds the server
 * actually produced there; the `id` kind is asserted on hand-built calls because no fixture result
 * happens to quote an id back into a later argument.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSING_TOOLS,
  EPISODE_GAP_MS,
  buildChain,
  buildEpisodes,
  buildLinks,
  describeIn,
  describeOut,
  idArgumentsOf,
  incomingLinks,
  tableProduced,
  tablesConsumed,
  threadsOf,
} from '../chain.js';
import { storeFromFixture } from './helpers.mjs';

function fixtureChain(maxId) {
  const store = storeFromFixture(maxId);
  const calls = store.getCalls({});
  const events = store.getEvents({});
  return { store, calls, events, ...buildChain(calls, events) };
}

const toolsOf = (calls) => calls.map((call) => call.tool);

describe('what a call produces and consumes', () => {
  it('reads the scratch table off the result and off the ETL events', () => {
    const { calls, events } = fixtureChain();
    const load = calls.find((call) => call.tool === 'load_transactions');
    const process = calls.find((call) => call.tool === 'process_data');
    const cleared = calls.find(
      (call) => call.tool === 'clear_table' && call.arguments.table_name?.includes('transactions'),
    );
    expect(tableProduced(load, events)).toBe('load_transactions_9a41c7e2');
    expect(tablesConsumed(load, events)).toEqual([]);
    expect(tableProduced(process, events)).toBe(null);
    expect(tablesConsumed(process, events)).toEqual(['load_transactions_9a41c7e2']);
    expect(tablesConsumed(cleared, events)).toEqual(['load_transactions_9a41c7e2']);
  });

  it('finds the id-shaped arguments, `to.payee_id` included', () => {
    const { calls } = fixtureChain();
    const confirm = calls.filter((call) => call.tool === 'create_transfer').at(-1);
    expect(idArgumentsOf(confirm)).toEqual([
      { key: 'from_account_id', value: 'acc_a1b2_01' },
      { key: 'to.payee_id', value: 'pay_a1b2_03' },
    ]);
  });
});

describe('the links between calls', () => {
  it('chains the ETL sequence through the table each call names, in order', () => {
    const { calls, links } = fixtureChain();
    const table = links.filter(
      (link) => link.kind === 'table' && link.label.includes('load_transactions_9a41c7e2'),
    );
    const byKey = new Map(calls.map((call) => [call.key, call]));
    const pairs = table.map((link) => [byKey.get(link.from).tool, byKey.get(link.to).tool]);
    // load -> process -> query -> query -> query -> clear: every hop is the nearest earlier call
    // that touched the table, which is what makes this a chain rather than a star around the load.
    expect(pairs).toEqual([
      ['load_transactions', 'process_data'],
      ['process_data', 'execute_query'],
      ['execute_query', 'execute_query'],
      ['execute_query', 'execute_query'],
      ['execute_query', 'clear_table'],
      // Minutes later the model queried the table it had already dropped. The link is real and
      // crosses an episode, which is exactly why the connector says which episode it came from.
      ['clear_table', 'execute_query'],
    ]);
    expect(table.at(-1).crosses_episode).toBe(true);
    expect(table.slice(0, -1).every((link) => link.crosses_episode === false)).toBe(true);
    expect(table[0].detail).toContain('created');
    expect(table[1].detail).toContain('last worked on');
  });

  it('links a confirmed transfer to its own preview and names the evidence', () => {
    const { calls, links } = fixtureChain();
    const preview = links.filter((link) => link.kind === 'preview');
    expect(preview).toHaveLength(1);
    const byKey = new Map(calls.map((call) => [call.key, call]));
    expect(byKey.get(preview[0].from).arguments.confirm).toBe(false);
    expect(byKey.get(preview[0].to).arguments.confirm).toBe(true);
    expect(preview[0].label).toBe('preview $1,284.00');
    expect(preview[0].detail).toContain('expected_total_amount $1,284.00');
    expect(preview[0].detail).toContain('prv_7c31');
  });

  it('does not link a confirm to a preview of a different transfer', () => {
    const preview = {
      key: 'a',
      event_id: 1,
      tool: 'create_transfer',
      started_at: '2026-09-08T14:00:00.000Z',
      arguments: { from_account_id: 'acc_1', to: { payee_id: 'pay_1' }, amount: 100, confirm: false },
      child_event_ids: [],
      status: 'ok',
    };
    const otherAmount = {
      ...preview,
      key: 'b',
      event_id: 2,
      arguments: { ...preview.arguments, amount: 999, confirm: true },
    };
    const otherPayee = {
      ...preview,
      key: 'c',
      event_id: 3,
      arguments: { ...preview.arguments, to: { payee_id: 'pay_9' }, confirm: true },
    };
    expect(buildLinks([preview, otherAmount, otherPayee], [])).toEqual([]);
  });

  it('links an id in a call to the earlier result it occurs in verbatim', () => {
    const source = {
      key: 'a',
      event_id: 1,
      tool: 'load_cards',
      started_at: '2026-09-08T14:00:00.000Z',
      arguments: {},
      child_event_ids: [],
      status: 'ok',
      text_preview: 'Cards: card_ava_stone_001 (active), card_ava_stone_002 (locked).',
      structured_content: null,
    };
    const noise = {
      ...source,
      key: 'b',
      event_id: 2,
      tool: 'get_current_user',
      text_preview: 'You are Ava Stone.',
    };
    const user = {
      key: 'c',
      event_id: 3,
      tool: 'lock_or_unlock_card',
      started_at: '2026-09-08T14:00:10.000Z',
      arguments: { card_id: 'card_ava_stone_001', action: 'lock' },
      child_event_ids: [],
      status: 'ok',
    };
    const links = buildLinks([source, noise, user], []);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ from: 'a', to: 'c', kind: 'id' });
    expect(links[0].label).toBe('card_id card_ava_stone_001');
    expect(links[0].detail).toContain('appears verbatim in what load_cards returned');

    // An id the model produced from nowhere links to nothing, which is the honest answer.
    const invented = { ...user, key: 'd', event_id: 4, arguments: { card_id: 'card_made_up' } };
    expect(buildLinks([source, invented], []).filter((link) => link.to === 'd')).toEqual([]);
  });

  it('also finds the id inside a structured result, not only in the text preview', () => {
    const source = {
      key: 'a',
      event_id: 1,
      tool: 'load_accounts',
      started_at: '2026-09-08T14:00:00.000Z',
      arguments: {},
      child_event_ids: [],
      status: 'ok',
      text_preview: null,
      structured_content: { rows: [{ id: 'acc_9', name: 'Checking' }] },
    };
    const user = {
      key: 'b',
      event_id: 2,
      tool: 'load_transactions',
      started_at: '2026-09-08T14:00:05.000Z',
      arguments: { account_id: 'acc_9' },
      child_event_ids: [],
      status: 'ok',
    };
    expect(buildLinks([source, user], [])[0]).toMatchObject({ kind: 'id', from: 'a', to: 'b' });
  });
});

describe('episodes', () => {
  it('puts every call in exactly one episode, in chronological order', () => {
    const { calls, episodes } = fixtureChain();
    const seen = episodes.flatMap((episode) => episode.calls.map((call) => call.key));
    expect(seen).toHaveLength(calls.length);
    expect(new Set(seen).size).toBe(calls.length);
    expect(seen).toEqual(calls.map((call) => call.key));
    expect(episodes.map((episode) => episode.index)).toEqual(
      episodes.map((_, index) => index + 1),
    );
    const starts = episodes.map((episode) => Date.parse(episode.started_at));
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('keeps the whole linked ETL sequence in one episode whatever the clock says', () => {
    const { episodes } = fixtureChain();
    const first = episodes[0];
    expect(toolsOf(first.calls)).toEqual([
      'get_current_user',
      'load_transactions',
      'process_data',
      'execute_query',
      'execute_query',
      'execute_query',
      'clear_table',
    ]);
    expect(first.boundary).toBe('first');
    expect(first.failures).toBe(1);
    expect(first.rationale).toContain('Confirm which demo customer');
    expect(first.links.every((link) => link.kind === 'table')).toBe(true);
    expect(first.links).toHaveLength(5);
  });

  it('opens a new episode on a long gap, on a closing tool and on a new workflow', () => {
    const { episodes } = fixtureChain();
    const reasons = episodes.map((episode) => episode.boundary);
    expect(reasons[0]).toBe('first');
    expect(reasons).toContain('gap');
    expect(reasons).toContain('closed');
    expect(reasons).toContain('workflow');
    const gapped = episodes.find((episode) => episode.boundary === 'gap');
    expect(gapped.gap_ms).toBeGreaterThan(EPISODE_GAP_MS);
    const closed = episodes.find((episode) => episode.boundary === 'closed');
    expect(closed.gap_ms).toBeLessThanOrEqual(EPISODE_GAP_MS);
    expect(CLOSING_TOOLS.has('clear_table')).toBe(true);
    expect(CLOSING_TOOLS.has('lock_or_unlock_card')).toBe(true);
  });

  it('carries the inferred workflow in force, with its confidence', () => {
    const { episodes } = fixtureChain();
    // The classifier only speaks after the first sequence, so episode 1 has nothing to show.
    expect(episodes[0].workflow).toBe(null);
    const classified = episodes.find((episode) => episode.workflow !== null);
    expect(classified.workflow).toBe('spend_analysis');
    expect(classified.confidence).toBeCloseTo(0.85, 5);
    expect(classified.boundary).toBe('workflow');
  });

  it('extends the current episode on a link even across a long idle gap', () => {
    const base = {
      child_event_ids: [],
      status: 'ok',
      structured_content: null,
      text_preview: null,
    };
    const load = {
      ...base,
      key: 'a',
      event_id: 1,
      tool: 'load_cards',
      started_at: '2026-09-08T14:00:00.000Z',
      started_epoch: Date.parse('2026-09-08T14:00:00.000Z'),
      finished_at: '2026-09-08T14:00:01.000Z',
      arguments: {},
      structured_content: { table_name: 't1' },
    };
    // Ten minutes later, but it names the same table, so it belongs to the same piece of work.
    const query = {
      ...base,
      key: 'b',
      event_id: 2,
      tool: 'execute_query',
      started_at: '2026-09-08T14:10:00.000Z',
      started_epoch: Date.parse('2026-09-08T14:10:00.000Z'),
      finished_at: '2026-09-08T14:10:01.000Z',
      arguments: { table_name: 't1' },
    };
    // Same gap, but nothing in common: a new episode.
    const stranger = {
      ...base,
      key: 'c',
      event_id: 3,
      tool: 'get_current_user',
      started_at: '2026-09-08T14:20:00.000Z',
      started_epoch: Date.parse('2026-09-08T14:20:00.000Z'),
      finished_at: '2026-09-08T14:20:01.000Z',
      arguments: {},
    };
    const calls = [load, query, stranger];
    const episodes = buildEpisodes(calls, buildLinks(calls, []), []);
    expect(episodes).toHaveLength(2);
    expect(toolsOf(episodes[0].calls)).toEqual(['load_cards', 'execute_query']);
    expect(toolsOf(episodes[1].calls)).toEqual(['get_current_user']);
    expect(episodes[1].boundary).toBe('gap');
  });
});

describe('threads inside an episode', () => {
  it('splits two interleaved table chains into two threads, sharing no call', () => {
    const { episodes, links, events } = fixtureChain();
    // The fixture's episode 5 runs `xray_get_session_link` beside a full payees ETL cycle.
    const episode = episodes.find((item) =>
      item.calls.some((call) => call.tool === 'load_payees'),
    );
    const threads = threadsOf(episode, incomingLinks(links), events);
    expect(threads.length).toBeGreaterThanOrEqual(2);
    const payees = threads.find((thread) => (thread.label ?? '').includes('load_payees_c40b81d9'));
    expect(toolsOf(payees.calls)).toEqual([
      'load_payees',
      'process_data',
      'execute_query',
      'clear_table',
    ]);
    // Every call of the episode lands in exactly one thread.
    const keys = threads.flatMap((thread) => thread.calls.map((call) => call.key));
    expect(keys).toHaveLength(episode.calls.length);
    expect(new Set(keys).size).toBe(episode.calls.length);
    // A call linked to nothing is its own thread of one, with no artefact to name.
    const alone = threads.find((thread) => thread.calls.length === 1);
    expect(alone).toBeTruthy();
    expect(alone.calls[0].tool).toMatch(/xray_get_session_link|load_bills/);
  });

  it('keeps two chains apart when their calls are interleaved in time', () => {
    const base = { child_event_ids: [], status: 'ok', text_preview: null };
    const call = (key, id, tool, args, table) => ({
      ...base,
      key,
      event_id: id,
      tool,
      started_at: new Date(Date.parse('2026-09-08T14:00:00.000Z') + id * 1000).toISOString(),
      started_epoch: Date.parse('2026-09-08T14:00:00.000Z') + id * 1000,
      finished_at: new Date(Date.parse('2026-09-08T14:00:00.500Z') + id * 1000).toISOString(),
      arguments: args,
      structured_content: table ? { table_name: table } : null,
    });
    // load A, load B, process A, process B, query A, query B - the shape the real history has.
    const calls = [
      call('a1', 1, 'load_cards', {}, 'tA'),
      call('b1', 2, 'load_accounts', {}, 'tB'),
      call('a2', 3, 'process_data', { table_name: 'tA' }, null),
      call('b2', 4, 'process_data', { table_name: 'tB' }, null),
      call('a3', 5, 'execute_query', { table_name: 'tA' }, null),
      call('b3', 6, 'execute_query', { table_name: 'tB' }, null),
    ];
    const links = buildLinks(calls, []);
    const episodes = buildEpisodes(calls, links, []);
    expect(episodes).toHaveLength(1);
    const threads = threadsOf(episodes[0], incomingLinks(links), []);
    expect(threads).toHaveLength(2);
    expect(threads[0].calls.map((item) => item.key)).toEqual(['a1', 'a2', 'a3']);
    expect(threads[1].calls.map((item) => item.key)).toEqual(['b1', 'b2', 'b3']);
    expect(threads[0].label).toBe('table tA');
    expect(threads[1].label).toBe('table tB');
  });
});

describe('what a step says on one line', () => {
  it('drops the rationale and the empty arguments, and collapses a date pair', () => {
    const { calls } = fixtureChain();
    const load = calls.find((call) => call.tool === 'load_transactions');
    const parts = describeIn(load);
    expect(parts).toEqual([{ key: 'dates', value: '2026-08-01 to 2026-08-31' }]);
    const query = calls.find((call) => call.arguments.query?.startsWith('SELECT "category_id"'));
    const sql = describeIn(query).find((part) => part.sql);
    expect(sql.value).not.toContain('\n');
    expect(sql.full).toBe(query.arguments.query);
  });

  it('prints an amount as money and flattens a one-key destination', () => {
    const { calls } = fixtureChain();
    const confirm = calls.filter((call) => call.tool === 'create_transfer').at(-1);
    const parts = describeIn(confirm);
    const byKey = Object.fromEntries(parts.map((part) => [part.key, part.value]));
    expect(byKey.amount).toBe('$1,284.00');
    expect(byKey.expected_total_amount).toBe('$1,284.00');
    expect(byKey['to.payee_id']).toBe('pay_a1b2_03');
    expect(byKey.confirm).toBe('true');
    expect(parts.some((part) => part.key === 'rationale')).toBe(false);
  });

  it('includes the rationale in arrival order only when asked', () => {
    const call = {
      tool: 'lock_or_unlock_card',
      status: 'ok',
      rationale_present: true,
      rationale: 'Lock it before the trip.',
      arguments: { card_id: 'card_01', rationale: 'Lock it before the trip.', action: 'lock' },
    };
    expect(describeIn(call).map((part) => part.key)).toEqual(['card_id', 'action']);
    const parts = describeIn(call, { withRationale: true });
    expect(parts.map((part) => part.key)).toEqual(['card_id', 'rationale', 'action']);
    expect(parts[1]).toEqual({ key: 'rationale', value: 'Lock it before the trip.', rationale: true });

    // On the recording the model wrote the rationale last, so that is where it is drawn.
    const { calls } = fixtureChain();
    const load = calls.find((candidate) => candidate.tool === 'load_transactions');
    expect(describeIn(load, { withRationale: true })).toEqual([
      { key: 'dates', value: '2026-08-01 to 2026-08-31' },
      { key: 'rationale', value: load.arguments.rationale, rationale: true },
    ]);
    expect(describeIn(load)).toEqual([{ key: 'dates', value: '2026-08-01 to 2026-08-31' }]);
  });

  it('says what came back, including the cap, the audit id and a denial', () => {
    const { calls, events } = fixtureChain();
    const load = calls.find((call) => call.tool === 'load_transactions');
    expect(describeOut(load, events).map((part) => part.value)).toEqual([
      'table load_transactions_9a41c7e2',
      '184 rows',
    ]);
    // The row-cap sentence closes an 8,417-character result, past the 2,048 characters the preview
    // keeps, so the capped call is the one whose preview was cut; the cap bit comes from sql.query.
    const capped = calls.find((call) => call.text_preview?.endsWith('…[truncated]'));
    expect(capped.key).toBe('xs_3f1c9a#9');
    expect(capped.text_preview).not.toContain('more than 100 rows');
    expect(describeOut(capped, events).map((part) => part.value)).toContain('the 100-row cap bit');
    const confirm = calls.filter((call) => call.tool === 'create_transfer').at(-1);
    expect(describeOut(confirm, events).map((part) => part.value)).toContain('audit aud_0001');
    const denied = calls.find((call) => call.status === 'denied');
    const out = describeOut(denied, events);
    expect(out[0].value).toBe('denied before it ran');
    expect(out[0].tone).toBe('denied');
    const running = { ...load, status: 'running' };
    expect(describeOut(running, events, { status: 'running' })[0].value).toBe('still running');
  });
});
