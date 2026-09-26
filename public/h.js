/**
 * A minimal hyperscript layer (block: dashboard).
 *
 * Panels are pure functions that return virtual nodes; `toHtml` turns a tree into markup and
 * `mount.js` writes it into a container. Keeping rendering string-based has two payoffs:
 * the panels have no DOM dependency, so they run under Vitest on plain Node with no jsdom, and
 * a whole panel is repainted with one `innerHTML` assignment instead of hand-written diffing.
 *
 * No imports, no DOM access. See public/__tests__/panels.test.mjs.
 */

/** HTML elements that never carry children. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

/** Attributes rendered as bare words when their value is `true`. */
const BOOLEAN_ATTRS = new Set([
  'checked',
  'disabled',
  'hidden',
  'readonly',
  'required',
  'selected',
  'open',
]);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapes text and attribute values. Everything rendered goes through here. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

function flatten(children, into) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      flatten(child, into);
      continue;
    }
    into.push(child);
  }
  return into;
}

/**
 * Builds one virtual node. `attrs` may be omitted:
 *   h('span', 'text')            -> <span>text</span>
 *   h('span', { class: 'x' }, 1) -> <span class="x">1</span>
 */
export function h(tag, attrs, ...children) {
  let attributes = attrs;
  let rest = children;
  const isAttributeBag =
    attrs !== null &&
    typeof attrs === 'object' &&
    !Array.isArray(attrs) &&
    !(attrs && attrs.tag !== undefined && attrs.children !== undefined);
  if (!isAttributeBag) {
    attributes = {};
    rest = attrs === undefined ? children : [attrs, ...children];
  }
  return { tag, attrs: attributes || {}, children: flatten(rest, []) };
}

/** A node whose children are rendered without a wrapper element. */
export function fragment(...children) {
  return { tag: null, attrs: {}, children: flatten(children, []) };
}

/**
 * Text that is already trusted markup. Used only for inline SVG icons defined in this file;
 * nothing derived from event data is ever wrapped in it.
 */
export function rawHtml(markup) {
  return { tag: '#raw', attrs: {}, children: [String(markup)] };
}

export function isVNode(value) {
  return Boolean(value) && typeof value === 'object' && 'tag' in value && 'children' in value;
}

function renderAttrs(attrs) {
  let out = '';
  for (const [name, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (BOOLEAN_ATTRS.has(name)) {
      if (value === true || value === name) out += ` ${name}`;
      continue;
    }
    out += ` ${name}="${escapeHtml(value === true ? '' : value)}"`;
  }
  return out;
}

/** Serialises a virtual node (or an array of them) to HTML. */
export function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(toHtml).join('');
  if (!isVNode(node)) return escapeHtml(node);
  if (node.tag === '#raw') return node.children.join('');
  const inner = node.children.map(toHtml).join('');
  if (node.tag === null) return inner;
  if (VOID_TAGS.has(node.tag)) return `<${node.tag}${renderAttrs(node.attrs)}>`;
  return `<${node.tag}${renderAttrs(node.attrs)}>${inner}</${node.tag}>`;
}

/** The visible text of a tree, for assertions and for `title` fallbacks. */
export function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isVNode(node)) return String(node);
  if (node.tag === '#raw') return '';
  return node.children.map(textOf).join('');
}

/** Depth-first search for the nodes matching a predicate; used by the panel tests. */
export function findNodes(node, predicate, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) findNodes(child, predicate, found);
    return found;
  }
  if (!isVNode(node)) return found;
  if (predicate(node)) found.push(node);
  for (const child of node.children) findNodes(child, predicate, found);
  return found;
}

/** True when `node` carries `className` in its `class` attribute. */
export function hasClass(node, className) {
  const value = node.attrs && node.attrs.class;
  if (!value) return false;
  return String(value).split(/\s+/).includes(className);
}

/** Joins class names, dropping falsy entries: `cx('row', selected && 'is-selected')`. */
export function cx(...names) {
  return names.filter(Boolean).join(' ');
}
