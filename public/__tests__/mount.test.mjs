/**
 * The DOM layer's pure helpers (block: dashboard).
 *
 * `mount()` itself needs a document, but the piece that went wrong for the user - an inner
 * scroller recreated at the top on every repaint - is a pure function over an element tree, so it
 * is asserted here on a plain object tree with `children`, `id`, `scrollTop` and `scrollLeft`.
 */
import { describe, expect, it } from 'vitest';
import {
  TIMELINE_MODES,
  collectScrollPositions,
  readTimelineMode,
  restoreScrollPositions,
} from '../mount.js';

function element(id, scrollTop = 0, scrollLeft = 0, children = []) {
  return { id, scrollTop, scrollLeft, children };
}

/** The timeline panel as the browser sees it: a container, a toolbar, and the inner scroller. */
function timelineTree(scrollTop) {
  return element('panel-timeline', 0, 0, [
    element('', 0, 0, [
      element('filter-input'),
      element('timeline-scroll', scrollTop, 0, [element('', 0, 0, [element('row-1')])]),
      element('code-1', 0, 120),
    ]),
  ]);
}

describe('scroll positions across a repaint', () => {
  it('snapshots only the descendants that are actually scrolled, by id', () => {
    const positions = collectScrollPositions(timelineTree(640));
    expect([...positions.keys()].sort()).toEqual(['code-1', 'timeline-scroll']);
    expect(positions.get('timeline-scroll')).toEqual({ top: 640, left: 0 });
    expect(positions.get('code-1')).toEqual({ top: 0, left: 120 });
  });

  it('restores them onto the freshly built tree, which starts at the top', () => {
    const positions = collectScrollPositions(timelineTree(640));
    const rebuilt = timelineTree(0);
    const scroller = rebuilt.children[0].children[1];
    const code = rebuilt.children[0].children[2];
    code.scrollLeft = 0;
    expect(scroller.scrollTop).toBe(0);

    expect(restoreScrollPositions(rebuilt, positions)).toBe(2);
    expect(scroller.scrollTop).toBe(640);
    expect(code.scrollLeft).toBe(120);
    // Nothing else was touched.
    expect(rebuilt.scrollTop).toBe(0);
    expect(rebuilt.children[0].children[0].scrollTop).toBe(0);
  });

  it('is a no-op when nothing was scrolled or the id is gone', () => {
    const still = element('panel', 0, 0, [element('timeline-scroll', 0, 0, [element('row-1')])]);
    expect(collectScrollPositions(still).size).toBe(0);
    expect(restoreScrollPositions(still, new Map())).toBe(0);
    const positions = new Map([['vanished', { top: 99, left: 0 }]]);
    expect(restoreScrollPositions(still, positions)).toBe(0);
    expect(still.children[0].scrollTop).toBe(0);
  });

  it('prefers querySelectorAll when the container offers it', () => {
    const inner = element('timeline-scroll', 33);
    const container = {
      id: 'panel',
      scrollTop: 0,
      scrollLeft: 0,
      children: [],
      querySelectorAll: (selector) => (selector === '[id]' ? [inner] : []),
    };
    expect(collectScrollPositions(container).get('timeline-scroll')).toEqual({ top: 33, left: 0 });
  });
});

describe('the remembered timeline mode', () => {
  it('defaults to the chain when there is no storage at all', () => {
    expect(TIMELINE_MODES).toEqual(['chain', 'events']);
    expect(readTimelineMode()).toBe('chain');
  });

  it('migrates a browser that remembers the retired calls mode', () => {
    const values = new Map([['glass-bank-xray-timeline-mode', 'calls']]);
    globalThis.localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
    try {
      expect(readTimelineMode()).toBe('chain');
      values.set('glass-bank-xray-timeline-mode', 'events');
      expect(readTimelineMode()).toBe('events');
      values.set('glass-bank-xray-timeline-mode', 'nonsense');
      expect(readTimelineMode()).toBe('chain');
    } finally {
      delete globalThis.localStorage;
    }
  });
});
