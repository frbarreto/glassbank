/**
 * The spine's open state (block: dashboard).
 *
 * `public/open-state.js` is pure data work - what is open, what the depth says about everything
 * else, and what has to be forgotten - so it is asserted here directly, on hand-built views and on
 * a store folded over the recording. The rendering that reads it is in `panels.test.mjs`; the
 * browser behaviour is in `public/_dev/check-console.mjs`.
 */
import { describe, expect, it } from 'vitest';
import {
  DEPTHS,
  OPEN_CAP,
  callKey,
  cardKey,
  catRawKey,
  catToolKey,
  catViewerId,
  collapseUnder,
  connKey,
  defaultFor,
  episodeKey,
  escTarget,
  idFor,
  insideKey,
  isOpen,
  prune,
  reqKey,
  resKey,
  setDepth,
  toggle,
  toolKey,
  viewerPrefixesOf,
  whyKey,
} from '../open-state.js';
import { storeFromFixture } from './helpers.mjs';

/** The view fields this module owns, and nothing else. */
function view(overrides = {}) {
  return {
    depth: 'calls',
    open: {},
    openOrder: [],
    json: {},
    lastToggled: null,
    follow: true,
    ...overrides,
  };
}

describe('the depth table', () => {
  it('answers every kind at every depth exactly as the level model states it', () => {
    expect(DEPTHS).toEqual(['overview', 'calls', 'open', 'inside']);
    const table = {
      ep: [false, true, true, true],
      conn: [false, false, false, false],
      call: [false, false, true, true],
      inside: [false, false, false, true],
      card: [false, false, false, true],
    };
    for (const [kind, expected] of Object.entries(table)) {
      expect(DEPTHS.map((depth) => defaultFor(depth, kind))).toEqual(expected);
    }
  });

  it('keeps every other kind closed unless the reader says otherwise', () => {
    for (const kind of ['req', 'res', 'tool', 'toolRaw', 'connInit', 'why', 'toolbarMore']) {
      expect(DEPTHS.map((depth) => defaultFor(depth, kind))).toEqual([false, false, false, false]);
    }
    // An unknown depth falls back to the default one rather than opening everything.
    expect(defaultFor('nonsense', 'call')).toBe(false);
    expect(defaultFor(undefined, 'ep')).toBe(true);
  });

  it('lets an explicit choice win over the depth in both directions', () => {
    const closedAtOpen = view({ depth: 'open', open: { 'call:xs#1': 'closed' } });
    expect(isOpen(closedAtOpen, 'call:xs#1', 'call')).toBe(false);
    expect(isOpen(closedAtOpen, 'call:xs#2', 'call')).toBe(true);
    const openAtCalls = view({ open: { 'call:xs#1': 'open' } });
    expect(isOpen(openAtCalls, 'call:xs#1', 'call')).toBe(true);
    expect(isOpen(openAtCalls, 'call:xs#2', 'call')).toBe(false);
  });
});

describe('keys and ids', () => {
  it('builds every key from ids that survive a backfill', () => {
    const key = callKey({ key: 'xs_3f1c9a#5' });
    expect(key).toBe('call:xs_3f1c9a#5');
    expect(callKey('xs_3f1c9a#5')).toBe(key);
    expect(reqKey(key)).toBe('call:xs_3f1c9a#5/req');
    expect(resKey(key)).toBe('call:xs_3f1c9a#5/res');
    expect(insideKey(key)).toBe('call:xs_3f1c9a#5/inside');
    expect(cardKey(key, 103)).toBe('call:xs_3f1c9a#5/inside/103');
    expect(connKey('xs_7b4d10')).toBe('conn:xs_7b4d10');
    expect(toolKey('xs_7b4d10', 'execute_query')).toBe('conn:xs_7b4d10/tool/execute_query');
    // An episode is keyed on its first call, never on its ordinal: a backfill renumbers episodes.
    expect(episodeKey('xs_3f1c9a#5')).toBe('ep:xs_3f1c9a#5');
    expect(episodeKey(key)).toBe('ep:xs_3f1c9a#5');
    expect(whyKey(episodeKey(key))).toBe('ep:xs_3f1c9a#5/why');
    // The Possibility space has its own family, independent of the connection block's tool keys.
    const tool = catToolKey('xs_7b4d10', 'execute_query');
    expect(tool).toBe('cat:xs_7b4d10/tool/execute_query');
    expect(catRawKey(tool)).toBe('cat:xs_7b4d10/tool/execute_query/raw');
    expect(idFor(tool)).toBe('tg-cat-xs_7b4d10-tool-execute_query');
    expect(viewerPrefixesOf(tool)).toEqual([catViewerId('xs_7b4d10', 'execute_query')]);
    expect(viewerPrefixesOf(catRawKey(tool))).toEqual(['cat-descriptor-xs_7b4d10-execute_query']);
  });

  it('opens a Possibility tool row without stopping the timeline tail-follow', () => {
    const state = view();
    const tool = catToolKey('xs_7b4d10', 'execute_query');
    toggle(state, tool, false);
    toggle(state, catRawKey(tool), false);
    state.json = { [`${catViewerId('xs_7b4d10', 'execute_query')}!raw`]: 'open', other: 'open' };
    expect(state.follow).toBe(true);
    expect(state.lastToggled).toBe(catRawKey(tool));
    // Closing the row takes its raw descriptor and that viewer's state with it.
    toggle(state, tool, true);
    expect(state.open).toEqual({ [tool]: 'closed' });
    expect(state.json).toEqual({ other: 'open' });
  });

  it('escapes a key into a DOM id, so the control keeps its focus across a repaint', () => {
    expect(idFor('call:xs_3f1c9a#5')).toBe('tg-call-xs_3f1c9a-5');
    expect(idFor('call:xs_3f1c9a#5/inside/103')).toBe('tg-call-xs_3f1c9a-5-inside-103');
    expect(idFor('conn:xs_7b4d10/tool/execute_query')).toBe('tg-conn-xs_7b4d10-tool-execute_query');
    expect(idFor(null)).toBe('tg-');
  });

  it('names the JSON viewers a key owns, so closing it takes their state with it', () => {
    expect(viewerPrefixesOf('call:xs_3f1c9a#5')).toEqual([
      'step-args-xs_3f1c9a#5',
      'step-meta-xs_3f1c9a#5',
      'step-result-xs_3f1c9a#5',
    ]);
    expect(viewerPrefixesOf(reqKey('call:xs_3f1c9a#5'))).toEqual([
      'step-args-xs_3f1c9a#5',
      'step-meta-xs_3f1c9a#5',
    ]);
    expect(viewerPrefixesOf(resKey('call:xs_3f1c9a#5'))).toEqual(['step-result-xs_3f1c9a#5']);
    expect(viewerPrefixesOf(cardKey('call:xs_3f1c9a#5', 103))).toEqual(['step-child-103']);
    expect(viewerPrefixesOf('conn:xs_7b4d10')).toEqual([]);
    expect(viewerPrefixesOf(42)).toEqual([]);
  });
});

describe('toggling', () => {
  it('opens and closes the same key, and stops the tail-follow only on the way open', () => {
    const state = view();
    toggle(state, 'call:xs#1', false);
    expect(state.open['call:xs#1']).toBe('open');
    expect(state.follow).toBe(false);
    expect(state.lastToggled).toBe('call:xs#1');

    state.follow = true;
    toggle(state, 'call:xs#1', true);
    expect(state.open['call:xs#1']).toBe('closed');
    // Closing is not the reader leaving the tail, and it scrolls nothing.
    expect(state.follow).toBe(true);
    expect(state.lastToggled).toBe(null);
  });

  it('keeps the insertion order of every explicit entry, closed ones included', () => {
    const state = view();
    toggle(state, 'call:xs#1', false);
    toggle(state, 'call:xs#2', false);
    toggle(state, 'ep:xs#1', true);
    expect(state.openOrder).toEqual(['call:xs#1', 'call:xs#2', 'ep:xs#1']);
    expect(state.open['ep:xs#1']).toBe('closed');
    // Touching a key again moves it to the end; it is never listed twice.
    toggle(state, 'call:xs#1', true);
    expect(state.openOrder).toEqual(['call:xs#2', 'ep:xs#1', 'call:xs#1']);
  });

  it('takes everything nested under a block with it when the block closes', () => {
    const key = 'call:xs#1';
    const state = view({
      open: {
        [key]: 'open',
        [insideKey(key)]: 'open',
        [cardKey(key, 103)]: 'open',
        'call:xs#2': 'open',
      },
      openOrder: [key, insideKey(key), cardKey(key, 103), 'call:xs#2'],
      json: {
        'step-args-xs#1': 'open',
        'step-args-xs#1.arguments': 'open',
        'step-result-xs#1!all-open': 'open',
        'step-child-103.data': 'open',
        'step-args-xs#2': 'open',
      },
    });
    toggle(state, key, true);
    expect(Object.keys(state.open).sort()).toEqual(['call:xs#1', 'call:xs#2']);
    expect(state.openOrder).toEqual(['call:xs#2', key]);
    // The viewers of the block and of its cards go with it; a sibling's viewer stays.
    expect(Object.keys(state.json)).toEqual(['step-args-xs#2']);
  });
});

describe('the depth control and collapse', () => {
  it('clears the call choices only', () => {
    const state = view({
      open: {
        'call:xs#1': 'open',
        'call:xs#1/inside': 'open',
        'conn:xs': 'open',
        'ep:xs#1': 'closed',
        'ep:xs#1/why': 'open',
        'toolbar:more': 'open',
      },
      openOrder: ['call:xs#1', 'call:xs#1/inside', 'conn:xs', 'ep:xs#1', 'ep:xs#1/why', 'toolbar:more'],
      json: { 'step-args-xs#1': 'open', 'other-viewer': 'open' },
    });
    setDepth(state, 'inside');
    expect(state.depth).toBe('inside');
    expect(Object.keys(state.open).sort()).toEqual([
      'conn:xs',
      'ep:xs#1',
      'ep:xs#1/why',
      'toolbar:more',
    ]);
    expect(state.openOrder).toEqual(['conn:xs', 'ep:xs#1', 'ep:xs#1/why', 'toolbar:more']);
    expect(Object.keys(state.json)).toEqual(['other-viewer']);
    // A depth that does not exist changes nothing.
    setDepth(state, 'sideways');
    expect(state.depth).toBe('inside');
  });

  it('collapses everything, one session, or one episode, and leaves the episodes open', () => {
    const build = () =>
      view({
        open: {
          'call:xs_a#1': 'open',
          'call:xs_a#2': 'open',
          'call:xs_b#1': 'open',
          'conn:xs_a': 'open',
          'ep:xs_a#1': 'open',
        },
        openOrder: ['call:xs_a#1', 'call:xs_a#2', 'call:xs_b#1', 'conn:xs_a', 'ep:xs_a#1'],
      });

    const all = build();
    collapseUnder(all, 'all');
    expect(Object.keys(all.open)).toEqual(['ep:xs_a#1']);

    const session = build();
    collapseUnder(session, 'xs_a');
    expect(Object.keys(session.open).sort()).toEqual(['call:xs_b#1', 'ep:xs_a#1']);

    // At a depth whose default is an open call, forgetting the choices is not enough: a scoped
    // collapse only closes the members it was named, so both callers pass them.
    const deep = build();
    deep.depth = 'open';
    collapseUnder(deep, 'xs_a', ['xs_a#1', 'xs_a#2']);
    expect(isOpen(deep, callKey('xs_a#1'), 'call')).toBe(false);
    expect(isOpen(deep, callKey('xs_a#2'), 'call')).toBe(false);
    expect(isOpen(deep, callKey('xs_b#1'), 'call')).toBe(true);

    const episode = build();
    collapseUnder(episode, episodeKey('xs_a#1'), ['xs_a#1']);
    expect(Object.keys(episode.open).sort()).toEqual([
      'call:xs_a#2',
      'call:xs_b#1',
      'conn:xs_a',
      'ep:xs_a#1',
    ]);
  });

  it('closes what the depth would otherwise open', () => {
    // At a depth whose default is an open call, dropping the choices alone would change nothing.
    const episode = view({ depth: 'inside' });
    collapseUnder(episode, episodeKey('xs_a#1'), ['xs_a#1', 'xs_a#2']);
    expect(episode.open).toEqual({ 'call:xs_a#1': 'closed', 'call:xs_a#2': 'closed' });
    expect(episode.depth).toBe('inside');
    expect(isOpen(episode, 'call:xs_a#1', 'call')).toBe(false);

    // The unscoped form cannot enumerate the calls, so it steps the depth back instead.
    const everything = view({ depth: 'open', open: { 'call:xs_a#1': 'open' } });
    collapseUnder(everything, 'all');
    expect(everything.depth).toBe('calls');
    expect(everything.open).toEqual({});
  });
});

describe('pruning', () => {
  it('drops the keys the store can no longer resolve, and their viewers', () => {
    // The recording up to event 150 knows one session; the second one has not started yet.
    const store = storeFromFixture(150);
    const state = view({
      open: {
        'call:xs_3f1c9a#5': 'open',
        'call:xs_3f1c9a#5/inside': 'open',
        'ep:xs_3f1c9a#5': 'open',
        'conn:xs_3f1c9a': 'open',
        'conn:xs_3f1c9a/tool/execute_query': 'open',
        'conn:xs_3f1c9a/tool/no_such_tool': 'open',
        'call:xs_7b4d10#5': 'open',
        'ep:xs_7b4d10#2': 'closed',
        'conn:xs_7b4d10': 'open',
        'toolbar:more': 'open',
      },
      openOrder: [
        'call:xs_3f1c9a#5',
        'call:xs_3f1c9a#5/inside',
        'ep:xs_3f1c9a#5',
        'conn:xs_3f1c9a',
        'conn:xs_3f1c9a/tool/execute_query',
        'conn:xs_3f1c9a/tool/no_such_tool',
        'call:xs_7b4d10#5',
        'ep:xs_7b4d10#2',
        'conn:xs_7b4d10',
        'toolbar:more',
      ],
      json: { 'step-args-xs_7b4d10#5': 'open', 'step-args-xs_3f1c9a#5': 'open' },
    });
    prune(state, store);
    expect(Object.keys(state.open).sort()).toEqual([
      'call:xs_3f1c9a#5',
      'call:xs_3f1c9a#5/inside',
      'conn:xs_3f1c9a',
      'conn:xs_3f1c9a/tool/execute_query',
      'ep:xs_3f1c9a#5',
      'toolbar:more',
    ]);
    expect(state.openOrder).toEqual([
      'call:xs_3f1c9a#5',
      'call:xs_3f1c9a#5/inside',
      'ep:xs_3f1c9a#5',
      'conn:xs_3f1c9a',
      'conn:xs_3f1c9a/tool/execute_query',
      'toolbar:more',
    ]);
    expect(Object.keys(state.json)).toEqual(['step-args-xs_3f1c9a#5']);

    // The whole recording resolves every one of them again.
    const whole = view({ open: { 'call:xs_7b4d10#5': 'open', 'conn:xs_7b4d10': 'open' } });
    prune(whole, storeFromFixture());
    expect(Object.keys(whole.open).sort()).toEqual(['call:xs_7b4d10#5', 'conn:xs_7b4d10']);
  });

  it('keeps a Possibility tool row while its session’s listing still names the tool', () => {
    const tool = catToolKey('xs_3f1c9a', 'execute_query');
    const keys = [
      tool,
      catRawKey(tool),
      catToolKey('xs_3f1c9a', 'no_such_tool'),
      catToolKey('xs_7b4d10', 'execute_query'),
      'cat:xs_3f1c9a/other/execute_query',
    ];
    const state = view({
      open: Object.fromEntries(keys.map((key) => [key, 'open'])),
      openOrder: [...keys],
    });
    // Up to event 150 the second session has not started, so its listing does not exist yet.
    prune(state, storeFromFixture(150));
    expect(Object.keys(state.open).sort()).toEqual([tool, catRawKey(tool)]);
    // Before the first listing (event 21) nothing names the tool.
    const early = view({ open: { [tool]: 'open' }, openOrder: [tool] });
    prune(early, storeFromFixture(20));
    expect(early.open).toEqual({});
  });

  it('is a no-op while a backfill is still arriving', () => {
    const state = view({
      backfilling: true,
      open: { 'call:nothing#1': 'open' },
      openOrder: ['call:nothing#1'],
    });
    prune(state, storeFromFixture());
    expect(state.open).toEqual({ 'call:nothing#1': 'open' });
  });

  it('caps the explicit choices at 400, oldest first, closed entries included', () => {
    const store = storeFromFixture();
    const open = {};
    const openOrder = [];
    for (let index = 0; index < OPEN_CAP + 5; index += 1) {
      // Every key resolves, so only the cap can evict them.
      const key = index % 2 === 0 ? 'call:xs_3f1c9a#5' : 'call:xs_3f1c9a#8';
      const suffix = `${key}/inside/${index}`;
      open[suffix] = index % 3 === 0 ? 'closed' : 'open';
      openOrder.push(suffix);
    }
    const state = view({ open, openOrder });
    const oldest = openOrder.slice(0, 5);
    expect(oldest.some((key) => open[key] === 'closed')).toBe(true);
    prune(state, store);
    expect(Object.keys(state.open)).toHaveLength(OPEN_CAP);
    expect(state.openOrder).toHaveLength(OPEN_CAP);
    for (const key of oldest) expect(state.open[key]).toBeUndefined();
    expect(state.open[openOrder[openOrder.length - 1]]).toBeDefined();
  });
});

describe('what Escape closes', () => {
  it('is the block opened last, never one that was closed', () => {
    const state = view();
    expect(escTarget(state)).toBe(null);
    toggle(state, 'call:xs#1', false);
    toggle(state, 'call:xs#2', false);
    expect(escTarget(state)).toBe('call:xs#2');
    toggle(state, 'call:xs#2', true);
    expect(escTarget(state)).toBe('call:xs#1');
    toggle(state, 'call:xs#1', true);
    expect(escTarget(state)).toBe(null);
  });
});
