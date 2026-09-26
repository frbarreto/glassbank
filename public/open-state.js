/**
 * What is open on the spine, and how deep the whole spine starts (block: dashboard).
 *
 * The reader opens and closes blocks; the depth control says what a block that was never touched
 * looks like. Both live in `view` and are pure data, so a repaint - which replaces the markup
 * wholesale - cannot lose them. Nothing here touches the DOM, the clock or the network.
 *
 * Keys are built from ids that survive a backfill, never from an index:
 *   `call:<xs>#<rid>`  `call:<xs>#<rid>/req` `/res` `/inside` `/inside/<eventId>`
 *   `conn:<xs>`        `conn:<xs>/tool/<name>`
 *   `ep:<first call key>`  `ep:<first call key>/why`
 *   `cat:<xs>/tool/<name>` `cat:<xs>/tool/<name>/raw` (the Possibility space, in the detail panel)
 * `view.open` holds only explicit choices (`open` / `closed`); everything else answers from the
 * depth table. `view.openOrder` is the insertion order of every explicit entry, open and closed
 * alike, because a reader who closes hundreds of rows must be able to evict those too.
 */
import { viewerId } from './json-view.js';

/** Macro to micro. The default state of a block with no explicit choice comes from this. */
export const DEPTHS = ['overview', 'calls', 'open', 'inside'];

/** How many explicit choices are kept before the oldest are evicted. */
export const OPEN_CAP = 400;

/**
 * The depth table. A kind that is not here (`req`, `res`, `tool`, `toolRaw`, `connInit`, `why`,
 * `toolbarMore`) is closed at every depth and opens only when the reader says so.
 */
const DEFAULTS = {
  ep: { overview: false, calls: true, open: true, inside: true },
  conn: { overview: false, calls: false, open: false, inside: false },
  call: { overview: false, calls: false, open: true, inside: true },
  inside: { overview: false, calls: false, open: false, inside: true },
  card: { overview: false, calls: false, open: false, inside: true },
};

/** The JSON viewers an open call owns; closing it takes their state with it. */
const CALL_VIEWER_BASES = ['step-args', 'step-meta', 'step-result'];

export function defaultFor(depth, kind) {
  const row = DEFAULTS[kind];
  if (!row) return false;
  return row[DEPTHS.includes(depth) ? depth : 'calls'] === true;
}

/** The explicit choice wins; otherwise the depth answers. */
export function isOpen(view, key, kind) {
  const state = view && view.open ? view.open[key] : undefined;
  if (state === 'open') return true;
  if (state === 'closed') return false;
  return defaultFor(view?.depth, kind);
}

// ---------------------------------------------------------------------------
// Keys and ids
// ---------------------------------------------------------------------------

/** `call` is a call record or its `<xs>#<rid>` key. */
export function callKey(call) {
  const raw = typeof call === 'string' ? call : call?.key;
  return `call:${raw ?? ''}`;
}

export function reqKey(key) {
  return `${key}/req`;
}

export function resKey(key) {
  return `${key}/res`;
}

export function insideKey(key) {
  return `${key}/inside`;
}

export function cardKey(key, eventId) {
  return `${key}/inside/${eventId}`;
}

export function connKey(xs) {
  return `conn:${xs}`;
}

export function toolKey(xs, name) {
  return `conn:${xs}/tool/${name}`;
}

/**
 * One tool row of the Possibility space. Its own family, independent of the connection block's
 * `toolKey`: the detail panel and the spine open and close separately.
 */
export function catToolKey(xs, name) {
  return `cat:${xs}/tool/${name}`;
}

/** The raw descriptor under a Possibility tool row. */
export function catRawKey(key) {
  return `${key}/raw`;
}

/** The JSON viewer that holds one tool's raw descriptor; closing the row forgets it. */
export function catViewerId(xs, name) {
  return viewerId('cat-descriptor', xs, name);
}

/** Keyed on the episode's first call, never on its ordinal: a backfill renumbers episodes. */
export function episodeKey(firstCallKey) {
  const raw = String(firstCallKey ?? '').replace(/^call:/, '');
  return `ep:${raw}`;
}

export function whyKey(key) {
  return `${key}/why`;
}

/**
 * A DOM id for the control that owns a key, so `mount.js` can put the focus back on it.
 * Whitespace is collapsed like `viewerId` does: a JSON-RPC id is a string of the client's choosing
 * and an HTML id may not hold a space.
 */
export function idFor(key) {
  return `tg-${String(key ?? '').replace(/[#/:]/g, '-').replace(/\s+/g, '-')}`;
}

/**
 * The `view.json` viewer ids a key owns. Mirrors how the panels build them (`viewerId(base, key)`
 * in `public/ui.js` and `public/panel-timeline.js`), so closing a block also forgets what its
 * viewers had open instead of leaving orphans behind the 400-entry cap.
 */
export function viewerPrefixesOf(key) {
  if (typeof key !== 'string') return [];
  if (key.startsWith('cat:')) {
    const [xs, section, name] = key.slice('cat:'.length).split('/');
    return section === 'tool' && xs && name ? [catViewerId(xs, name)] : [];
  }
  if (!key.startsWith('call:')) return [];
  const rest = key.slice('call:'.length);
  const slash = rest.indexOf('/');
  const raw = slash === -1 ? rest : rest.slice(0, slash);
  const tail = slash === -1 ? '' : rest.slice(slash + 1);
  if (tail === '') return CALL_VIEWER_BASES.map((base) => viewerId(base, raw));
  if (tail === 'req') return [viewerId('step-args', raw), viewerId('step-meta', raw)];
  if (tail === 'res') return [viewerId('step-result', raw)];
  if (tail.startsWith('inside/')) return [viewerId('step-child', tail.slice('inside/'.length))];
  return [];
}

function ownsViewer(jsonKey, prefix) {
  return (
    jsonKey === prefix ||
    jsonKey.startsWith(`${prefix}.`) ||
    jsonKey.startsWith(`${prefix}!`) ||
    jsonKey.startsWith(`${prefix}-`)
  );
}

/** Drops every `view.json` entry belonging to any of `keys`. */
function withoutViewers(json, keys) {
  const prefixes = [];
  for (const key of keys) prefixes.push(...viewerPrefixesOf(key));
  if (prefixes.length === 0) return json;
  const next = {};
  for (const [jsonKey, state] of Object.entries(json ?? {})) {
    if (!prefixes.some((prefix) => ownsViewer(jsonKey, prefix))) next[jsonKey] = state;
  }
  return next;
}

/** The bare `<xs>#<rid>` of a `call:` or `ep:` key, without any nested suffix. */
function bareKeyOf(key) {
  const rest = key.slice(key.indexOf(':') + 1);
  const slash = rest.indexOf('/');
  return slash === -1 ? rest : rest.slice(0, slash);
}

function xsOf(key) {
  const bare = bareKeyOf(key);
  const hash = bare.indexOf('#');
  return hash === -1 ? bare : bare.slice(0, hash);
}

// ---------------------------------------------------------------------------
// Changing what is open
// ---------------------------------------------------------------------------

function remember(view, key) {
  const order = (view.openOrder ?? []).filter((entry) => entry !== key);
  order.push(key);
  view.openOrder = order;
}

/** Removes explicit entries and their viewer state; returns the keys that went. */
function forget(view, matches) {
  const gone = [];
  const kept = {};
  for (const [key, state] of Object.entries(view.open ?? {})) {
    if (matches(key)) gone.push(key);
    else kept[key] = state;
  }
  if (gone.length === 0) return gone;
  view.open = kept;
  view.openOrder = (view.openOrder ?? []).filter((key) => key in kept);
  view.json = withoutViewers(view.json ?? {}, gone);
  return gone;
}

/**
 * Flips one block. `currentlyOpen` is the state the panel drew, so the control always undoes what
 * the reader can see rather than what the view thought a repaint ago.
 *
 * Opening stops the tail-follow (an arriving event must not scroll the reader off the block they
 * just opened) and marks the key for the post-mount `scrollIntoView`. Closing takes everything
 * nested under it with it, so re-opening starts from the depth default instead of from a state
 * the reader can no longer see.
 */
export function toggle(view, key, currentlyOpen) {
  if (!key) return view;
  const open = !currentlyOpen;
  if (!open) forget(view, (entry) => entry.startsWith(`${key}/`));
  view.open = { ...(view.open ?? {}), [key]: open ? 'open' : 'closed' };
  remember(view, key);
  if (open) {
    // A Possibility tool row lives in the detail panel: opening it is no reason to stop the
    // timeline following its tail.
    if (!key.startsWith('cat:')) view.follow = false;
    view.lastToggled = key;
  } else {
    view.lastToggled = null;
    view.json = withoutViewers(view.json ?? {}, [key]);
  }
  return view;
}

/**
 * The depth control. It clears the `call:` choices only: an episode the reader folded away, a
 * connection block they opened and the toolbar's own state have nothing to do with how deep a
 * call opens.
 */
export function setDepth(view, depth) {
  if (!DEPTHS.includes(depth)) return view;
  view.depth = depth;
  forget(view, (key) => key.startsWith('call:'));
  return view;
}

/**
 * Back to the macro line. `scope` is `all`, an `xs`, or `ep:<first call key>`; `members` are the
 * bare call keys of that scope when the caller knows them (the episode does).
 *
 * At a depth whose default is an open call, dropping the explicit choices alone would change
 * nothing, so the scoped form writes an explicit `closed` for the members it was given and the
 * unscoped form steps the depth back to `calls` - there is no way to enumerate every call here.
 * A scoped call therefore has to pass `members` to collapse anything at depth `open` or `inside`;
 * both callers do (the episode button names its calls in `data-arg2`).
 */
export function collapseUnder(view, scope, members = null) {
  const wanted = scope || 'all';
  const list = Array.isArray(members) ? members.filter(Boolean) : null;
  const inScope = (key) => {
    if (!key.startsWith('call:') && !key.startsWith('conn:')) return false;
    if (wanted === 'all') return true;
    if (wanted.startsWith('ep:')) {
      if (list && list.length) return key.startsWith('call:') && list.includes(bareKeyOf(key));
      return xsOf(key) === xsOf(wanted);
    }
    return xsOf(key) === wanted;
  };
  forget(view, inScope);
  if (!defaultFor(view.depth, 'call')) return view;
  if (list && list.length) {
    const open = { ...(view.open ?? {}) };
    for (const member of list) {
      open[callKey(member)] = 'closed';
      remember(view, callKey(member));
    }
    view.open = open;
  } else if (wanted === 'all') {
    view.depth = 'calls';
  }
  return view;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/** True while the key still names something the store knows about. */
function resolves(key, store) {
  if (typeof key !== 'string') return false;
  if (key.startsWith('call:') || key.startsWith('ep:')) {
    return Boolean(store.getCall?.(bareKeyOf(key)));
  }
  if (key.startsWith('cat:')) {
    // `cat:<xs>/tool/<name>` and its `/raw`: kept while the session's listing still names the tool.
    const [xs, section, name] = key.slice('cat:'.length).split('/');
    if (section !== 'tool' || !name || !store.getSession?.(xs)) return false;
    const tools = store.getCatalog?.(xs)?.tools;
    return Array.isArray(tools) && tools.some((tool) => tool && tool.name === name);
  }
  if (key.startsWith('conn:')) {
    const rest = key.slice('conn:'.length);
    const [xs, section, ...tail] = rest.split('/');
    if (!store.getSession?.(xs)) return false;
    if (section !== 'tool') return true;
    const catalog = store.getCatalog?.(xs);
    const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
    if (tools.length === 0) return false;
    const name = tail.join('/');
    return tools.some((tool) => tool && tool.name === name);
  }
  return true;
}

/**
 * Run before every timeline repaint: drops the choices that no longer name anything (an erased
 * session, a call past the store's window, a tool that is no longer in the listing), drops the
 * viewer state that hung off them, then caps what is left at `OPEN_CAP` entries, oldest first.
 *
 * Held while a backfill is in flight, because a deep link or a replay applies its keys before the
 * events they name have arrived and pruning them would throw the reader's own request away.
 */
export function prune(view, store) {
  if (!view || !store) return view;
  if (view.backfilling) return view;
  const dropped = [];
  const kept = {};
  for (const [key, state] of Object.entries(view.open ?? {})) {
    if (resolves(key, store)) kept[key] = state;
    else dropped.push(key);
  }

  const seen = new Set();
  const order = [];
  for (const key of view.openOrder ?? []) {
    if (key in kept && !seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }
  // An entry that never reached `openOrder` is still capped; it goes last, which is the only
  // order that cannot evict something newer.
  for (const key of Object.keys(kept)) {
    if (!seen.has(key)) {
      seen.add(key);
      order.push(key);
    }
  }

  let excess = order.length - OPEN_CAP;
  const survivors = [];
  for (const key of order) {
    if (excess > 0) {
      delete kept[key];
      dropped.push(key);
      excess -= 1;
      continue;
    }
    survivors.push(key);
  }

  view.open = kept;
  view.openOrder = survivors;
  if (dropped.length) view.json = withoutViewers(view.json ?? {}, dropped);
  if (view.lastToggled && !(view.lastToggled in kept)) view.lastToggled = null;
  return view;
}

/** What Escape closes: the block opened last, or nothing. */
export function escTarget(view) {
  const open = view?.open ?? {};
  const order = view?.openOrder ?? [];
  for (let index = order.length - 1; index >= 0; index -= 1) {
    if (open[order[index]] === 'open') return order[index];
  }
  return null;
}
