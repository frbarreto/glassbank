/**
 * The JSON viewer (block: dashboard).
 *
 * `json-view.js` exists because of a bug with no visible cause: the "Raw envelope" block in the
 * Call inspector could not be dragged down. The detail panel was remounted on a 250 ms tick,
 * `mount.js` puts back the scrollTop of scrolled descendants **that carry an `id`**, and the
 * `<pre class="code">` holding 5,864 px of envelope had none - so it snapped back to the top four
 * times a second. The viewer replaces that scroller with a tree that grows, plus one raw block that
 * does carry an `id`.
 *
 * Three things here are load-bearing and invisible on screen, so they are asserted rather than
 * looked at:
 *  - a path is the only key the open state has, so two different keys must never share one;
 *  - what the default rule opens, because a viewer that opens a 184-row result on arrival is the
 *    wall this file was written to remove;
 *  - the raw block, which the Copy button in `app.js` reads by `id`: it promises the exact bytes
 *    that arrived, not a rendering of them.
 *
 * Pure functions over virtual nodes, so everything runs on plain Node. `public/_dev/check-console.mjs`
 * drives the same viewer in a real browser.
 */
import { describe, expect, it } from 'vitest';
import { findNodes, hasClass, isVNode, textOf, toHtml } from '../h.js';
import {
  BIG_NODE,
  COMPACT_LIMIT,
  DEFAULT_OPEN_DEPTH,
  ITEM_PAGE,
  STRING_CLIP,
  clipString,
  entriesOf,
  isBranch,
  isOpen,
  jsonView,
  kindOf,
  pathOf,
  safeJson,
  summaryOf,
  viewerId,
} from '../json-view.js';
import { loadFixture } from './helpers.mjs';

/** The largest `catalog.tools_listed` envelope in the recording: 5.3 KB, 15 keys, 17 tools. */
const ENVELOPE = loadFixture()
  .filter((event) => event.type === 'catalog.tools_listed')
  .sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
const ENVELOPE_ID = viewerId('envelope', ENVELOPE.id);

/** An object of `size` keys, for the two halves of the default-open rule. */
const objectOf = (size) => Object.fromEntries(Array.from({ length: size }, (_, i) => [`k${i}`, i]));

/** Everything the reader can click to change what is open. */
const togglesOf = (tree) => findNodes(tree, (node) => node.attrs['data-action'] === 'toggle-json');

/** One toggle, addressed by the path it carries. */
const toggleAt = (tree, path) =>
  togglesOf(tree).find((node) => node.attrs['data-arg'] === path) ?? null;

/** The `.jv-node` a branch toggle heads, so its rows can be counted. */
const nodeAt = (tree, path) =>
  findNodes(
    tree,
    (node) => hasClass(node, 'jv-node') && node.children[0]?.attrs?.['data-arg'] === path,
  )[0] ?? null;

/** The rows a branch is drawing right now; empty while it is shut. */
function childRowsOf(node) {
  const children = node.children.find((child) => isVNode(child) && hasClass(child, 'jv-children'));
  return children
    ? children.children.filter((child) => isVNode(child) && hasClass(child, 'jv-node'))
    : [];
}

/** The top-level rows of a viewer, which are drawn without a root toggle above them. */
const rootRowsOf = (tree) =>
  findNodes(tree, (node) => hasClass(node, 'jv-root'))[0].children.filter(
    (child) => isVNode(child) && hasClass(child, 'jv-node'),
  );

/** The key printed on one row, without the keys of anything nested under it. */
const keyOf = (row) => textOf(findNodes(row, (node) => hasClass(node, 'jv-key'))[0]);

const treeBlockOf = (tree) => findNodes(tree, (node) => hasClass(node, 'jv-tree'))[0];
const rawBlockOf = (tree, id) =>
  findNodes(tree, (node) => node.attrs.id === `${id}-raw`)[0] ?? null;

describe('shapes', () => {
  it('names every shape, and calls only an object or an array a branch', () => {
    expect([null, undefined, [], {}, 'text', 7, true, [1, { a: null }]].map(kindOf)).toEqual([
      // `null` is its own kind, not an object: printing `{} empty` for it would be a lie.
      'null',
      'undefined',
      'array',
      'object',
      'string',
      'number',
      'boolean',
      'array',
    ]);
    expect([[], {}, [1], { a: 1 }, { a: { b: [] } }].every(isBranch)).toBe(true);
    expect([null, undefined, 'text', '', 7, 0, true, false].some(isBranch)).toBe(false);
  });

  it('lists the children of a branch and nothing else', () => {
    expect(entriesOf([])).toEqual([]);
    expect(entriesOf({})).toEqual([]);
    // An index arrives as a string key, so a path is built the same way for an array as an object.
    expect(entriesOf(['a', 'b'])).toEqual([
      ['0', 'a'],
      ['1', 'b'],
    ]);
    // Insertion order, never sorted: the wire order is a fact about what arrived.
    expect(entriesOf({ b: 1, a: 2 })).toEqual([
      ['b', 1],
      ['a', 2],
    ]);
    for (const leaf of [null, undefined, 'text', 7, true]) expect(entriesOf(leaf)).toEqual([]);
  });

  it('walks a nested mix one level at a time', () => {
    const value = { rows: [{ id: 1, tags: [] }], meta: null, ok: true };
    expect(entriesOf(value).map(([key]) => key)).toEqual(['rows', 'meta', 'ok']);
    const [, rows] = entriesOf(value)[0];
    expect(entriesOf(rows)).toEqual([['0', value.rows[0]]]);
    expect(entriesOf(value.rows[0]).map(([key, child]) => [key, kindOf(child)])).toEqual([
      ['id', 'number'],
      ['tags', 'array'],
    ]);
  });
});

describe('paths', () => {
  it('builds a viewer id that cannot contain a dot', () => {
    // A dot would split into a level, and every path in `view.json` starts with this id.
    expect(viewerId('envelope', ENVELOPE.id)).toBe(`envelope-${ENVELOPE.id}`);
    expect(viewerId('step-args', 'xs_3f1c9a#5')).not.toContain('.');
    expect(viewerId('args', 'a.b', 'c d', 'e!f')).toBe('args-a-b-c-d-e-f');
    // An absent part is dropped rather than leaving a dangling separator.
    expect(viewerId('args', null, undefined, '')).toBe('args');
  });

  it('escapes a key so it cannot end an attribute or open a tag', () => {
    const keys = ['a b', 'a"b', "a'b", 'a<b', 'a&b', 'a/b'];
    const paths = keys.map((key) => pathOf('env', key));
    expect(new Set(paths).size).toBe(keys.length);
    expect(pathOf('env', 'a b')).toBe('env.a%20b');
    expect(pathOf('env', 'a"b')).toBe('env.a%22b');
    // `encodeURIComponent` leaves `'` alone; every attribute value still goes through
    // `escapeHtml` in `h.js`, which is asserted under "markup safety" below.
    expect(paths.some((path) => /["<>&\s]/.test(path))).toBe(false);
    // A plain key is left readable, which is what makes a path debuggable in the DOM.
    expect(pathOf('env', 'data')).toBe('env.data');
    expect(pathOf('env.data', 'tools')).toBe('env.data.tools');
  });

  it('tells a key named like a level or a suffix apart from the real thing', () => {
    // `encodeURIComponent` leaves `.` and `!` alone, and this module joins levels with `.` and
    // hangs its extra state on `!` suffixes, so both have to be escaped on top of it. Reachable:
    // `_meta` keys and tool arguments are whatever the client and the model sent.
    expect(pathOf('env', 'a.b')).not.toBe(pathOf(pathOf('env', 'a'), 'b'));
    expect(pathOf('env', 'x!all')).not.toBe(`${pathOf('env', 'x')}!all`);
    // The same for the other four `encodeURIComponent` leaves behind.
    for (const key of ['a~b', "a'b", 'a(b)', 'a*b']) {
      expect(pathOf('env', key)).not.toContain(key);
    }
    expect(pathOf('env', 'a.b')).toBe('env.a%2Eb');
  });
});

describe('the summary of a shut branch', () => {
  it('says the shape and the size, because that is what opening it is worth', () => {
    expect(summaryOf(objectOf(7))).toBe('{} 7 keys');
    expect(summaryOf(new Array(184).fill(0))).toBe('[] 184 items');
    expect(summaryOf({})).toBe('{} empty');
    expect(summaryOf([])).toBe('[] empty');
    expect(summaryOf([1])).toBe('[] 1 item');
    expect(summaryOf({ a: 1 })).toBe('{} 1 key');
    // Grouped like every other count on the page (`format.js`).
    expect(summaryOf(new Array(1200).fill(0))).toBe('[] 1,200 items');
  });
});

describe('what is open', () => {
  it('lets an explicit choice win over everything else', () => {
    expect(isOpen({ 'env.a': 'open' }, 'env.a', objectOf(100), 9, 'env')).toBe(true);
    expect(isOpen({ 'env.a': 'closed' }, 'env.a', { b: 1 }, 0, 'env')).toBe(false);
    // Including against the viewer-wide switch: one node the reader pinned survives Collapse.
    expect(isOpen({ 'env!all-open': 'closed', 'env.a': 'open' }, 'env.a', { b: 1 }, 0, 'env')).toBe(
      true,
    );
    expect(isOpen({ 'env!all-open': 'open', 'env.a': 'closed' }, 'env.a', { b: 1 }, 0, 'env')).toBe(
      false,
    );
  });

  it('applies Expand all and Collapse to that viewer alone', () => {
    expect(isOpen({ 'env!all-open': 'open' }, 'env.a.b.c', objectOf(500), 9, 'env')).toBe(true);
    expect(isOpen({ 'env!all-open': 'closed' }, 'env.a', { b: 1 }, 0, 'env')).toBe(false);
    // Two viewers in one panel never fight: the switch is keyed on the id.
    expect(isOpen({ 'other!all-open': 'open' }, 'env.a', objectOf(500), 9, 'env')).toBe(false);
    // With no root there is no viewer-wide switch to consult, and the default rule decides.
    expect(isOpen({ 'env!all-open': 'open' }, 'env.a', objectOf(500), 9, undefined)).toBe(false);
  });

  it('opens what is shallow and small, and folds away the rest', () => {
    expect(isOpen({}, 'env.a', { b: 1 }, 0, 'env')).toBe(true);
    expect(isOpen({}, 'env.a.b', { c: 1 }, DEFAULT_OPEN_DEPTH - 1, 'env')).toBe(true);
    expect(isOpen({}, 'env.a.b.c', { d: 1 }, DEFAULT_OPEN_DEPTH, 'env')).toBe(false);
    // The size half of the rule, pinned on both sides: 24 rows on arrival, 25 is a wall.
    expect(isOpen({}, 'env.a', objectOf(BIG_NODE), 0, 'env')).toBe(true);
    expect(isOpen({}, 'env.a', objectOf(BIG_NODE + 1), 0, 'env')).toBe(false);
    expect(isOpen({}, 'env.a', new Array(BIG_NODE).fill(0), 0, 'env')).toBe(true);
    expect(isOpen({}, 'env.a', new Array(BIG_NODE + 1).fill(0), 0, 'env')).toBe(false);
    // The first render has no state at all, and is not a crash.
    expect(isOpen(undefined, 'env.a', { b: 1 }, 0, 'env')).toBe(true);
  });
});

describe('the viewer over the largest recorded envelope', () => {
  const render = (state = {}) =>
    jsonView(ENVELOPE, { id: ENVELOPE_ID, state, title: 'Raw envelope' });
  const TOOLS = `${ENVELOPE_ID}.data.tools`;

  it('draws the toolbar the title asked for, with the shape and the four controls', () => {
    const tree = render();
    const head = findNodes(tree, (node) => hasClass(node, 'jv-head'));
    expect(head).toHaveLength(1);
    expect(hasClass(tree, 'is-compact')).toBe(false);
    expect(textOf(head[0])).toContain('Raw envelope');
    expect(textOf(head[0])).toContain(summaryOf(ENVELOPE));
    expect(
      findNodes(tree, (node) => hasClass(node, 'jv-action')).map((node) => [
        node.attrs['data-action'],
        node.attrs['data-arg'],
        textOf(node),
      ]),
    ).toEqual([
      ['json-open-all', ENVELOPE_ID, 'Expand all'],
      ['json-close-all', ENVELOPE_ID, 'Collapse'],
      ['toggle-json', `${ENVELOPE_ID}!raw`, 'Raw'],
      ['copy-json', ENVELOPE_ID, 'Copy'],
    ]);
  });

  it('draws one row per top-level key, in the order they arrived', () => {
    const rows = rootRowsOf(render());
    expect(rows.map(keyOf)).toEqual(Object.keys(ENVELOPE));
    expect(rows.length).toBeGreaterThan(10);
  });

  it('folds a deep branch away and says what is inside it', () => {
    const tree = render();
    // Depth 1 and 17 items: the array of tools is open on arrival...
    expect(toggleAt(tree, TOOLS).attrs['aria-expanded']).toBe('true');
    // ...and every tool in it is one line carrying its key count, not seven more rows.
    const first = toggleAt(tree, `${TOOLS}.0`);
    expect(first.attrs['aria-expanded']).toBe('false');
    expect(textOf(first)).toContain(summaryOf(ENVELOPE.data.tools[0]));
    expect(childRowsOf(nodeAt(tree, `${TOOLS}.0`))).toEqual([]);
    expect(textOf(nodeAt(tree, `${TOOLS}.0`))).not.toContain(ENVELOPE.data.tools[0].name);
  });

  it('gives every toggle the action and a path inside this viewer', () => {
    const toggles = togglesOf(render());
    expect(toggles.length).toBeGreaterThan(30);
    for (const toggle of toggles) {
      const arg = String(toggle.attrs['data-arg']);
      expect(toggle.attrs['data-action']).toBe('toggle-json');
      // `setJsonForViewer` in `app.js` clears a viewer by exactly these two prefixes.
      expect(arg.startsWith(`${ENVELOPE_ID}.`) || arg.startsWith(`${ENVELOPE_ID}!`)).toBe(true);
    }
  });

  it('draws a branch the reader opened, and leaves its siblings alone', () => {
    const path = `${TOOLS}.0`;
    const tree = render({ [path]: 'open' });
    expect(toggleAt(tree, path).attrs['aria-expanded']).toBe('true');
    const rows = childRowsOf(nodeAt(tree, path));
    expect(rows.map(keyOf)).toEqual(Object.keys(ENVELOPE.data.tools[0]));
    expect(textOf(nodeAt(tree, path))).toContain(ENVELOPE.data.tools[0].name);
    expect(toggleAt(tree, `${TOOLS}.1`).attrs['aria-expanded']).toBe('false');
  });

  it('shuts a branch the reader closed, whatever the default said', () => {
    const tree = render({ [`${ENVELOPE_ID}.data`]: 'closed' });
    expect(toggleAt(tree, `${ENVELOPE_ID}.data`).attrs['aria-expanded']).toBe('false');
    expect(toggleAt(tree, TOOLS)).toBeNull();
    expect(textOf(nodeAt(tree, `${ENVELOPE_ID}.data`))).toContain(summaryOf(ENVELOPE.data));
  });
});

describe('a long array', () => {
  const items = Array.from({ length: ITEM_PAGE + 10 }, (_, index) => `row-${index}`);
  const ID = 'rows-viewer';
  const PATH = `${ID}.rows`;
  const render = (state) => jsonView({ rows: items }, { id: ID, state, title: 'Rows' });

  it('arrives shut, with the count as the whole row', () => {
    const toggle = toggleAt(render({}), PATH);
    expect(toggle.attrs['aria-expanded']).toBe('false');
    expect(textOf(toggle)).toContain(`[] ${ITEM_PAGE + 10} items`);
  });

  it('draws one page of items and offers the rest', () => {
    const tree = render({ [PATH]: 'open' });
    const rows = childRowsOf(nodeAt(tree, PATH));
    expect(rows).toHaveLength(ITEM_PAGE);
    expect(textOf(rows[0])).toContain('row-0');
    expect(textOf(rows[ITEM_PAGE - 1])).toContain(`row-${ITEM_PAGE - 1}`);
    expect(textOf(nodeAt(tree, PATH))).not.toContain(`row-${ITEM_PAGE + 5}`);
    const more = toggleAt(tree, `${PATH}!all`);
    expect(hasClass(more, 'jv-more-items')).toBe(true);
    expect(textOf(more)).toContain('and 10 more');
  });

  it('draws all of them once the reader asks, and offers the way back', () => {
    const tree = render({ [PATH]: 'open', [`${PATH}!all`]: 'open' });
    expect(childRowsOf(nodeAt(tree, PATH))).toHaveLength(items.length);
    expect(textOf(nodeAt(tree, PATH))).toContain(`row-${items.length - 1}`);
    expect(textOf(toggleAt(tree, `${PATH}!all`))).toContain(`first ${ITEM_PAGE}`);
  });
});

describe('a long string', () => {
  /** 300 characters with a marker past the cut, so "the rest" can be asserted for. */
  const text = `${'a'.repeat(296)}TAIL`;
  const ID = 'sql-viewer';
  const PATH = `${ID}.sql`;
  const render = (state) => jsonView({ sql: text }, { id: ID, state, title: 'Arguments' });
  const shownText = (tree) => textOf(findNodes(tree, (node) => hasClass(node, 'jv-text'))[0]);

  it('cuts it at the clip and says how much is left', () => {
    const tree = render({});
    expect(shownText(tree)).toHaveLength(STRING_CLIP + 1);
    expect(shownText(tree)).not.toContain('TAIL');
    const more = toggleAt(tree, `${PATH}!full`);
    expect(hasClass(more, 'jv-more')).toBe(true);
    expect(textOf(more)).toBe(`${text.length - STRING_CLIP} more`);
    expect(more.attrs.title).toContain(`${text.length} characters`);
  });

  it('draws the whole string once the reader asks', () => {
    const tree = render({ [`${PATH}!full`]: 'open' });
    expect(shownText(tree)).toBe(text);
    expect(textOf(toggleAt(tree, `${PATH}!full`))).toBe('less');
  });

  it('leaves a string that fits alone, and cuts one character past the clip', () => {
    expect(clipString('short')).toEqual({ shown: 'short', clipped: false, length: 5 });
    const exact = 'a'.repeat(STRING_CLIP);
    expect(clipString(exact)).toEqual({ shown: exact, clipped: false, length: STRING_CLIP });
    expect(clipString(`${exact}b`).clipped).toBe(true);
    expect(clipString(`${exact}b`).shown).toHaveLength(STRING_CLIP + 1);
    // A short string gets no button at all, so a one-line value stays one line.
    expect(toggleAt(jsonView({ sql: 'SELECT 1' }, { id: ID }), `${PATH}!full`)).toBeNull();
  });
});

describe('a viewer whose whole value is a list', () => {
  // `argumentList` in public/ui.js hands each non-string argument to a viewer as its root value,
  // and an argument is whatever the model decided to send. The root used to bypass the paging that
  // every other level has, so a large array argument drew every one of its items.
  const long = Array.from({ length: 60 }, (_, index) => `column_${index}`);

  it('pages at the root the way it pages anywhere else', () => {
    const tree = jsonView(long, { id: 'cols', state: {}, title: 'cols' });
    const rows = findNodes(tree, (node) => hasClass(node, 'jv-leaf'));
    expect(rows).toHaveLength(50);
    const more = findNodes(tree, (node) => hasClass(node, 'jv-more-items'));
    expect(more).toHaveLength(1);
    expect(textOf(more[0])).toBe('and 10 more');
    expect(more[0].attrs['data-arg']).toBe('cols!all');
    // The raw block always carries the whole value, so the tree is what has to be checked.
    const treeOnly = findNodes(tree, (node) => hasClass(node, 'jv-tree'))[0];
    expect(toHtml(treeOnly)).not.toContain('column_55');
  });

  it('draws all of it once the reader asks, and offers to fold it back', () => {
    const tree = jsonView(long, { id: 'cols', state: { 'cols!all': 'open' }, title: 'cols' });
    expect(findNodes(tree, (node) => hasClass(node, 'jv-leaf'))).toHaveLength(60);
    const treeOnly = findNodes(tree, (node) => hasClass(node, 'jv-tree'))[0];
    expect(toHtml(treeOnly)).toContain('column_59');
    const more = findNodes(tree, (node) => hasClass(node, 'jv-more-items'));
    expect(textOf(more[0])).toBe('show only the first 50');
  });

  it('leaves a short list alone', () => {
    const tree = jsonView(['a', 'b'], { id: 'small', state: {}, title: 'cols' });
    expect(findNodes(tree, (node) => hasClass(node, 'jv-more-items'))).toHaveLength(0);
  });
});

describe('the raw block', () => {
  it('is always in the output, behind the tree, with an id of its own', () => {
    const tree = jsonView(ENVELOPE, { id: ENVELOPE_ID, state: {}, title: 'Raw envelope' });
    const raw = rawBlockOf(tree, ENVELOPE_ID);
    // The `id` is the point twice over: `mount.js` restores the scrollTop of nothing without one,
    // and `copyJson` in `app.js` looks this element up by exactly this id.
    expect(raw.attrs.id).toBe(`${ENVELOPE_ID}-raw`);
    expect(hasClass(raw, 'jv-raw')).toBe(true);
    expect(raw.attrs.hidden).toBe(true);
    expect(treeBlockOf(tree).attrs.hidden).toBeNull();
  });

  it('changes places with the tree when the reader asks for raw', () => {
    const tree = jsonView(ENVELOPE, {
      id: ENVELOPE_ID,
      state: { [`${ENVELOPE_ID}!raw`]: 'open' },
      title: 'Raw envelope',
    });
    expect(rawBlockOf(tree, ENVELOPE_ID).attrs.hidden).toBeNull();
    expect(treeBlockOf(tree).attrs.hidden).toBe(true);
    expect(hasClass(tree, 'is-raw')).toBe(true);
    // Expand all and Collapse would be claiming to act on a block of text, so they go away.
    expect(findNodes(tree, (node) => node.attrs['data-action'] === 'json-open-all')).toEqual([]);
    const back = toggleAt(tree, `${ENVELOPE_ID}!raw`);
    expect([textOf(back), back.attrs['aria-pressed']]).toEqual(['Tree', 'true']);
  });

  it('holds exactly what arrived, so Copy hands back the bytes and not a rendering', () => {
    const tree = jsonView(ENVELOPE, { id: ENVELOPE_ID, state: {}, title: 'Raw envelope' });
    const text = textOf(rawBlockOf(tree, ENVELOPE_ID));
    expect(JSON.parse(text)).toEqual(ENVELOPE);
    // Nothing the tree does to make the value readable leaks into it.
    expect(text).not.toContain('…');
    expect(text).not.toContain(summaryOf(ENVELOPE.data.tools[0]));
  });

  it('is there even when the toolbar is not', () => {
    // A compact viewer has no Copy button; the bytes are still one selection away.
    const tree = jsonView(['a', 'b'], { id: 'cols' });
    expect(hasClass(tree, 'is-compact')).toBe(true);
    expect(JSON.parse(textOf(rawBlockOf(tree, 'cols')))).toEqual(['a', 'b']);
  });

  it('cuts a value that would hand the page a megabyte, and says it did', () => {
    const capped = safeJson({ text: 'a'.repeat(5000) }, 200);
    expect(capped.length).toBeLessThan(300);
    expect(capped).toContain('more characters not shown');
    // The cap is a guard, not a policy: a real envelope is far under it and comes back whole.
    expect(JSON.parse(safeJson(ENVELOPE))).toEqual(ENVELOPE);
  });

  it('never throws on a value JSON cannot hold', () => {
    const circular = { name: 'loop' };
    circular.self = circular;
    expect(() => safeJson(circular)).not.toThrow();
    expect(safeJson(undefined)).toBe('undefined');
  });
});

describe('a small value', () => {
  const value = ['category_id', 'total_cents', 'count'];

  it('draws no toolbar without a title, because four buttons over three rows is chrome', () => {
    const tree = jsonView(value, { id: 'cols', state: {} });
    expect(safeJson(value).length).toBeLessThan(COMPACT_LIMIT);
    expect(hasClass(tree, 'is-compact')).toBe(true);
    expect(findNodes(tree, (node) => hasClass(node, 'jv-head'))).toEqual([]);
    expect(findNodes(tree, (node) => hasClass(node, 'jv-action'))).toEqual([]);
    expect(textOf(tree)).toContain('category_id');
  });

  it('draws one as soon as it is given a title', () => {
    const tree = jsonView(value, { id: 'cols', state: {}, title: 'Columns' });
    expect(hasClass(tree, 'is-compact')).toBe(false);
    const head = findNodes(tree, (node) => hasClass(node, 'jv-head'));
    expect(head).toHaveLength(1);
    expect(textOf(head[0])).toContain('Columns');
    // Raw and Copy only: three strings have no level to expand, and two buttons that cannot do
    // anything are worse than none.
    expect(
      findNodes(tree, (node) => hasClass(node, 'jv-action')).map((node) => textOf(node)),
    ).toEqual(['Raw', 'Copy']);
  });

  it('offers Expand all only when there is a level to expand', () => {
    const nested = jsonView({ rows: [{ id: 1 }] }, { id: 'nested', title: 'Rows' });
    expect(
      findNodes(nested, (node) => hasClass(node, 'jv-action')).map(
        (node) => node.attrs['data-action'],
      ),
    ).toEqual(['json-open-all', 'json-close-all', 'toggle-json', 'copy-json']);
  });

  it('says a branch is empty rather than drawing a blank box', () => {
    expect(textOf(jsonView({}, { id: 'empty-object', title: 'Meta' }))).toContain('no fields');
    expect(textOf(jsonView([], { id: 'empty-list', title: 'Rows' }))).toContain('an empty list');
    // The shape is still on the toolbar, and the raw block still holds the value.
    expect(textOf(jsonView([], { id: 'empty-list', title: 'Rows' }))).toContain('[] empty');
    expect(
      JSON.parse(textOf(rawBlockOf(jsonView({}, { id: 'empty-object' }), 'empty-object'))),
    ).toEqual({});
  });

  it('draws one for an untitled value that is big enough to need it', () => {
    const big = { note: 'a'.repeat(COMPACT_LIMIT) };
    expect(hasClass(jsonView(big, { id: 'note' }), 'is-compact')).toBe(false);
  });
});

describe('what the Copy button promises', () => {
  it('offers the whole value when the whole value is there', () => {
    const tree = jsonView({ a: 1 }, { id: 'small', state: {}, title: 'Value' });
    const copy = findNodes(tree, (node) => node.attrs?.['data-action'] === 'copy-json')[0];
    expect(textOf(copy)).toBe('Copy');
    expect(copy.attrs.title).toContain('exactly as it arrived');
  });

  it('says it is only a part when the value was cut, instead of claiming the whole', () => {
    // `safeJson` cuts past `max` and appends a note, so the copied text is neither the value nor
    // valid JSON. The button used to promise "exactly as it arrived" either way.
    const tree = jsonView(
      { big: 'x'.repeat(400) },
      { id: 'cut', state: {}, title: 'Value', max: 100 },
    );
    const copy = findNodes(tree, (node) => node.attrs?.['data-action'] === 'copy-json')[0];
    expect(textOf(copy)).toBe('Copy part');
    expect(copy.attrs.title).toContain('not the whole thing');
    expect(copy.attrs.title).not.toContain('exactly as it arrived');
  });
});

describe('markup safety', () => {
  it('escapes a value instead of injecting it as markup', () => {
    const value = {
      '<img src=x onerror=alert(1)>': { sql: "SELECT '<script>alert(1)</script>'" },
      'say "hi"': { quote: 'he said "hi"' },
    };
    const html = toHtml(jsonView(value, { id: 'unsafe', state: {}, title: 'Arguments' }));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;hi&quot;');
    // A key travels into `data-arg` as well, where a raw quote would end the attribute early.
    expect(html).toContain('data-arg="unsafe.%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E"');
    expect(html).toContain('data-arg="unsafe.say%20%22hi%22"');
    expect(html).not.toContain('data-arg="unsafe.<img');
  });

  it('escapes the raw block too, which holds the same value as text', () => {
    const value = { sql: '</code><script>alert(1)</script>' };
    const html = toHtml(jsonView(value, { id: 'unsafe-raw', state: {}, title: 'Arguments' }));
    expect(html).not.toContain('</code><script>');
    expect(html).toContain('&lt;/code&gt;');
  });
});
