/**
 * The JSON viewer (block: dashboard).
 *
 * A pretty-printed blob in a fixed-height box is the worst of both worlds: too small to read and
 * too big to skim. One `catalog.tools_listed` envelope in the recorded sample is 5.3 KB, which is
 * 5,864 px of text inside a 350 px box - sixteen screens of scrolling to find one field, in a
 * scroller that lost its position on every repaint because only elements with an `id` survive one.
 *
 * So this draws a tree instead. An object is one line until it is opened, arrays say how many
 * items they hold, long strings are cut with the rest one click away, and nothing here scrolls:
 * the viewer grows and the panel around it scrolls, which is the scroller `mount.js` already knows
 * how to put back.
 *
 * What is open is `view.json`, keyed by path, so it survives a repaint. A path is the viewer's
 * `id` plus `encodeURIComponent` of each key, which keeps a key containing a dot from faking a
 * level and keeps the whole path safe in a DOM attribute. Ids must not contain a dot; `viewerId`
 * builds one that cannot.
 *
 * Pure functions returning virtual nodes. No DOM, no network, no clock.
 */
import { cx, h } from './h.js';
import { count } from './format.js';

/** Depth that opens by default: the envelope and its `data`, which is what a reader wants first. */
export const DEFAULT_OPEN_DEPTH = 2;
/** A node with more children than this stays shut by default, however shallow it is. */
export const BIG_NODE = 24;
/** Array items drawn before the "and N more" row. */
export const ITEM_PAGE = 50;
/** A string longer than this is cut, with the whole value one click away. */
export const STRING_CLIP = 160;
/**
 * A value this small, drawn without a title, gets no toolbar. Four buttons over a five-item array
 * of column names is more chrome than content, and the tree already says everything about it.
 */
export const COMPACT_LIMIT = 400;

/** Suffixes that hang extra state off a path. `!` cannot appear in an `encodeURIComponent` key. */
const ALL_OPEN = '!all-open';
const SHOW_ALL = '!all';
const FULL_STRING = '!full';
const RAW = '!raw';
const COPIED = '!copied';

/** A viewer id with no dot in it, so paths split cleanly whatever the caller passes. */
export function viewerId(...parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && part !== '')
    .map((part) => String(part).replace(/[.\s!]+/g, '-'))
    .join('-');
}

/** `object`, `array` or the primitive's own type; `null` is its own kind, not an object. */
export function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value === undefined) return 'undefined';
  return typeof value;
}

export function isBranch(value) {
  const kind = kindOf(value);
  return kind === 'object' || kind === 'array';
}

/** The children of a branch as `[key, value]`, in insertion order for an object. */
export function entriesOf(value) {
  if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value);
}

/**
 * The characters `encodeURIComponent` leaves alone. `.` separates levels and `!` introduces the
 * suffixes above, so both have to go: without this a key literally named `a.b` shares its path
 * with the nested `a` -> `b`, and a key named `x!all` toggles the sibling `x`'s item paging
 * instead of itself. Both are reachable - `_meta` keys and tool arguments come from the client.
 */
const RESERVED_IN_KEY = /[.!~*'()]/g;

function escapeKey(key) {
  return encodeURIComponent(key).replace(
    RESERVED_IN_KEY,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `root.data.arguments`. Keys are escaped so no key can fake a level or a suffix. */
export function pathOf(parentPath, key) {
  return `${parentPath}.${escapeKey(key)}`;
}

/**
 * `{} 7 keys`, `[] 184 items`, `{} empty`. The count is the whole point of a shut node: it says
 * whether opening it is worth it.
 */
export function summaryOf(value) {
  const size = entriesOf(value).length;
  const braces = Array.isArray(value) ? '[]' : '{}';
  if (size === 0) return `${braces} empty`;
  const noun = Array.isArray(value) ? 'item' : 'key';
  return `${braces} ${count(size)} ${noun}${size === 1 ? '' : 's'}`;
}

/**
 * Whether a branch is open. In order: an explicit choice for this node, then "expand all" or
 * "collapse" for the whole viewer, then the default - open while it is shallow and small, which
 * leaves an event envelope readable on arrival and folds a 184-row result away.
 */
export function isOpen(state, path, value, depth, root) {
  const explicit = state?.[path];
  if (explicit === 'open') return true;
  if (explicit === 'closed') return false;
  const all = root === undefined ? undefined : state?.[`${root}${ALL_OPEN}`];
  if (all === 'open') return true;
  if (all === 'closed') return false;
  if (depth >= DEFAULT_OPEN_DEPTH) return false;
  return entriesOf(value).length <= BIG_NODE;
}

/** Everything a reader needs to know about a string without printing all of it. */
export function clipString(text) {
  const value = String(text);
  if (value.length <= STRING_CLIP) return { shown: value, clipped: false, length: value.length };
  return { shown: `${value.slice(0, STRING_CLIP)}…`, clipped: true, length: value.length };
}

function primitiveNode(value, path, state) {
  const kind = kindOf(value);
  if (kind === 'string') {
    const full = state?.[`${path}${FULL_STRING}`] === 'open';
    const { shown, clipped, length } = clipString(value);
    return h(
      'span',
      { class: 'jv-value jv-string' },
      h('span', { class: 'jv-quote', 'aria-hidden': 'true' }, '"'),
      h('span', { class: 'jv-text' }, full ? String(value) : shown),
      h('span', { class: 'jv-quote', 'aria-hidden': 'true' }, '"'),
      clipped
        ? h(
            'button',
            {
              type: 'button',
              class: 'jv-more',
              'data-action': 'toggle-json',
              'data-arg': `${path}${FULL_STRING}`,
              title: full ? 'Cut it back down' : `Show all ${count(length)} characters`,
            },
            full ? 'less' : `${count(length - STRING_CLIP)} more`,
          )
        : null,
    );
  }
  if (kind === 'number' || kind === 'boolean') {
    return h('span', { class: `jv-value jv-${kind}` }, String(value));
  }
  if (kind === 'null') return h('span', { class: 'jv-value jv-null' }, 'null');
  if (kind === 'undefined') return h('span', { class: 'jv-value jv-null' }, 'undefined');
  // A function or a symbol cannot come off the wire, but a hand-built model can hold one.
  return h('span', { class: 'jv-value jv-null' }, String(value));
}

/** The key on the left of a row; an array index is drawn as an index, not as a quoted name. */
function keyNode(key, inArray) {
  return h('span', { class: cx('jv-key', inArray && 'jv-index') }, String(key));
}

function branchRow(key, value, path, state, depth, inArray, root) {
  const open = isOpen(state, path, value, depth, root);
  const entries = entriesOf(value);
  const showAll = state?.[`${path}${SHOW_ALL}`] === 'open';
  const shown = showAll ? entries : entries.slice(0, ITEM_PAGE);
  const hidden = entries.length - shown.length;

  return h(
    'div',
    { class: cx('jv-node', open && 'is-open') },
    h(
      'button',
      {
        type: 'button',
        class: 'jv-row jv-toggle',
        'data-action': 'toggle-json',
        'data-arg': path,
        'aria-expanded': String(open),
        title: open ? 'Fold this away' : 'Open this',
      },
      h('span', { class: 'jv-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
      key === null ? null : keyNode(key, inArray),
      h('span', { class: 'jv-summary' }, summaryOf(value)),
    ),
    open
      ? h(
          'div',
          { class: 'jv-children' },
          ...shown.map(([childKey, childValue]) =>
            valueRow(
              childKey,
              childValue,
              pathOf(path, childKey),
              state,
              depth + 1,
              Array.isArray(value),
              root,
            ),
          ),
          entries.length > ITEM_PAGE
            ? h(
                'button',
                {
                  type: 'button',
                  class: 'jv-row jv-more-items',
                  'data-action': 'toggle-json',
                  'data-arg': `${path}${SHOW_ALL}`,
                },
                showAll ? `show only the first ${count(ITEM_PAGE)}` : `and ${count(hidden)} more`,
              )
            : null,
        )
      : null,
  );
}

/** One row: a branch that can be opened, or a key and its value. */
function valueRow(key, value, path, state, depth, inArray, root) {
  if (isBranch(value)) return branchRow(key, value, path, state, depth, inArray, root);
  return h(
    'div',
    { class: 'jv-node' },
    h(
      'div',
      { class: 'jv-row jv-leaf' },
      h('span', { class: 'jv-caret', 'aria-hidden': 'true' }, ''),
      key === null ? null : keyNode(key, inArray),
      primitiveNode(value, path, state),
    ),
  );
}

/** `JSON.stringify` that cannot throw and cannot hand the page a megabyte. */
export function safeJson(value, max = 200_000) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n… ${count(text.length - max)} more characters not shown`;
}

/**
 * The viewer. `id` is the stable key its open state hangs on, so two viewers in one panel never
 * fight and the state survives a repaint. `options.title` draws a heading beside the controls.
 *
 * The raw text is always in the DOM, hidden behind the tree, for two reasons: the Copy button
 * reads it, so copying gives back exactly what arrived rather than a rendering of it, and a reader
 * who wants the bytes gets them without the viewer having to be right about anything.
 */
export function jsonView(value, options = {}) {
  const id = options.id ?? 'json';
  const state = options.state ?? {};
  const raw = state[`${id}${RAW}`] === 'open';
  const copied = state[`${id}${COPIED}`] ?? null;
  const branch = isBranch(value);
  const max = options.max ?? 200_000;
  const text = safeJson(value, max);
  // `safeJson` cuts past `max` and says so in the text, which means the copy is neither the value
  // nor valid JSON. Rare - no recorded event comes near it - but the button must not claim
  // otherwise.
  const wholeValue = !text.endsWith('characters not shown');
  const rows = branch ? entriesOf(value) : [];
  const showAllRows = state[`${id}${SHOW_ALL}`] === 'open';
  const shownRows = showAllRows ? rows : rows.slice(0, ITEM_PAGE);
  // Two buttons that cannot do anything are worse than no buttons.
  const openable = branch && !raw && rows.some(([, child]) => isBranch(child));
  const showHead = Boolean(options.title) || text.length > COMPACT_LIMIT;

  return h(
    'div',
    { class: cx('jv', raw && 'is-raw', !showHead && 'is-compact'), 'data-json-id': id },
    showHead
      ? h(
          'div',
          { class: 'jv-head' },
          options.title ? h('h4', { class: 'sub-title jv-title' }, options.title) : null,
          h('span', { class: 'jv-shape mono' }, branch ? summaryOf(value) : kindOf(value)),
          h(
            'span',
            { class: 'jv-actions' },
            openable
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'jv-action',
                    'data-action': 'json-open-all',
                    'data-arg': id,
                    title: 'Open every level',
                  },
                  'Expand all',
                )
              : null,
            openable
              ? h(
                  'button',
                  {
                    type: 'button',
                    class: 'jv-action',
                    'data-action': 'json-close-all',
                    'data-arg': id,
                    title: 'Fold everything back',
                  },
                  'Collapse',
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                class: cx('jv-action', raw && 'is-on'),
                'data-action': 'toggle-json',
                'data-arg': `${id}${RAW}`,
                'aria-pressed': String(raw),
                title: raw ? 'Back to the tree' : 'The exact JSON, as text',
              },
              raw ? 'Tree' : 'Raw',
            ),
            h(
              'button',
              {
                type: 'button',
                class: cx('jv-action', copied && `is-${copied}`),
                'data-action': 'copy-json',
                'data-arg': id,
                title: wholeValue
                  ? 'Copy the whole value as JSON, exactly as it arrived'
                  : `Copy the first ${count(max)} characters as text. The value is longer than this page keeps, so this is not the whole thing and not valid JSON.`,
              },
              copied === 'copied'
                ? 'Copied'
                : copied === 'blocked'
                  ? 'Blocked'
                  : wholeValue
                    ? 'Copy'
                    : 'Copy part',
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'jv-tree', hidden: raw ? true : null },
      branch && rows.length === 0
        ? h('p', { class: 'jv-empty muted' }, Array.isArray(value) ? 'an empty list' : 'no fields')
        : branch
          ? h(
              'div',
              { class: 'jv-children jv-root' },
              ...shownRows.map(([key, child]) =>
                valueRow(key, child, pathOf(id, key), state, 0, Array.isArray(value), id),
              ),
              // The root used to bypass this, so a viewer whose whole value is a large array drew
              // every item. `argumentList` hands each non-string argument to a viewer as its root,
              // and an argument is whatever the model decided to send.
              rows.length > ITEM_PAGE
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'jv-row jv-more-items',
                      'data-action': 'toggle-json',
                      'data-arg': `${id}${SHOW_ALL}`,
                    },
                    showAllRows
                      ? `show only the first ${count(ITEM_PAGE)}`
                      : `and ${count(rows.length - shownRows.length)} more`,
                  )
                : null,
            )
          : valueRow(null, value, `${id}.value`, state, 0, false, id),
    ),
    h(
      'pre',
      { class: 'code code-json jv-raw', id: `${id}-raw`, hidden: raw ? null : true },
      h('code', {}, text),
    ),
  );
}
