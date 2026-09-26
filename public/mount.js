/* global document, Element, requestAnimationFrame, localStorage, matchMedia */
/**
 * The thin DOM layer (block: dashboard).
 *
 * Panels return virtual nodes; this file is the only place that touches the document. Each panel
 * owns one container and is repainted with a single `innerHTML` assignment, which is fast enough
 * for the sizes involved and keeps the panels free of DOM code so they can be tested on Node.
 *
 * Interaction is delegated: every control carries `data-action` (and optionally `data-arg`), and
 * one listener on the root dispatches it. That is why a full repaint never has to rebind anything.
 */
import { toHtml } from './h.js';

/**
 * Every descendant that carries an `id`. Real elements answer `querySelectorAll`; the unit test
 * hands in a plain object tree with `children`, which is why the walk is the fallback.
 */
function elementsWithId(container) {
  if (typeof container.querySelectorAll === 'function') return container.querySelectorAll('[id]');
  const found = [];
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.id) found.push(child);
      walk(child);
    }
  };
  walk(container);
  return found;
}

/**
 * Snapshots the scroll offsets of every descendant with an `id` that is scrolled at all, keyed by
 * id. A repaint replaces the whole subtree, so an inner scroller such as `#timeline-scroll`
 * would otherwise come back at the top while the viewer is reading half-way down.
 */
export function collectScrollPositions(container) {
  const positions = new Map();
  for (const element of elementsWithId(container)) {
    const top = Number(element.scrollTop) || 0;
    const left = Number(element.scrollLeft) || 0;
    if (top > 0 || left > 0) positions.set(element.id, { top, left });
  }
  return positions;
}

/** Re-applies a `collectScrollPositions` snapshot by id; returns how many elements were restored. */
export function restoreScrollPositions(container, positions) {
  if (!positions || positions.size === 0) return 0;
  let restored = 0;
  for (const element of elementsWithId(container)) {
    const position = positions.get(element.id);
    if (!position) continue;
    if (position.top) element.scrollTop = position.top;
    if (position.left) element.scrollLeft = position.left;
    restored += 1;
  }
  return restored;
}

/**
 * Repaints one container. The container's own scroll offset follows `options.scroll`
 * (`preserve`, `keep-bottom`, `bottom`); the inner scrollers are always put back where they were.
 */
export function mount(container, vnode, options = {}) {
  if (!container) return;
  const previousTop = container.scrollTop;
  const wasAtBottom =
    container.scrollHeight - container.scrollTop - container.clientHeight < 40;
  const innerPositions = collectScrollPositions(container);
  // A repaint would otherwise steal the caret out of the filter or pairing box mid-word.
  const active = document.activeElement;
  const focusId = active && active.id && container.contains(active) ? active.id : null;
  const selection =
    focusId && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd]
      : null;
  container.innerHTML = toHtml(vnode);
  restoreScrollPositions(container, innerPositions);
  if (focusId) {
    const restored = document.getElementById(focusId);
    if (restored) {
      restored.focus({ preventScroll: true });
      if (selection && typeof restored.setSelectionRange === 'function') {
        try {
          restored.setSelectionRange(selection[0], selection[1]);
        } catch {
          // `setSelectionRange` throws on input types that do not support it; the focus is enough.
        }
      }
    }
  }
  if (options.scroll === 'bottom' || (options.scroll === 'keep-bottom' && wasAtBottom)) {
    container.scrollTop = container.scrollHeight;
  } else if (options.scroll === 'preserve') {
    container.scrollTop = previousTop;
  }
}

/** Repaints an inner scroller by id after a mount, so the timeline can follow the tail. */
export function scrollToBottom(elementId) {
  const element = document.getElementById(elementId);
  if (element) element.scrollTop = element.scrollHeight;
}

/** Wires `data-action` clicks. `handlers` is `{ action(arg, arg2, event) }`. */
export function delegate(root, handlers) {
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) return;
    const action = target.getAttribute('data-action');
    const handler = handlers[action];
    if (!handler) return;
    event.preventDefault();
    handler(target.getAttribute('data-arg'), target.getAttribute('data-arg2'), event, target);
  });
}

/** Coalesces repaints into one animation frame; returns the scheduler. */
export function createScheduler(render) {
  let queued = false;
  return function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  };
}

const THEME_KEY = 'glass-bank-xray-theme';

/** `light` | `dark` | `system`. Stored per browser; nothing about it reaches the server. */
export function readTheme() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    if (theme === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A browser with site data blocked still gets the theme for this page view.
  }
}

/** `system -> dark -> light -> system`, so both explicit choices are two clicks away at most. */
export function nextTheme(theme) {
  if (theme === 'system') return 'dark';
  if (theme === 'dark') return 'light';
  return 'system';
}

const TIMELINE_MODE_KEY = 'glass-bank-xray-timeline-mode';
export const TIMELINE_MODES = ['chain', 'events'];
/** The mode `chain` replaced. A browser that remembers it gets the chain, not the old flat list. */
const RETIRED_TIMELINE_MODES = { calls: 'chain' };

/** `chain` (the default) | `events`. Stored per browser, like the theme. */
export function readTimelineMode() {
  try {
    const stored = localStorage.getItem(TIMELINE_MODE_KEY);
    if (TIMELINE_MODES.includes(stored)) return stored;
    return RETIRED_TIMELINE_MODES[stored] ?? 'chain';
  } catch {
    return 'chain';
  }
}

export function storeTimelineMode(mode) {
  try {
    localStorage.setItem(TIMELINE_MODE_KEY, mode);
  } catch {
    // Site data blocked: the choice still holds for this page view.
  }
}

export function resolvedTheme(theme) {
  if (theme !== 'system') return theme;
  try {
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
