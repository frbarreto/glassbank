/* global window, document, location, navigator, requestAnimationFrame, crypto */
/**
 * The X-ray dashboard (block: dashboard).
 *
 * Composition root of the SPA: it owns the view state, wires one event source into the reducer,
 * and repaints the eight panels of docs/XRAY_EVENT_MODEL.md section 7. Everything it knows about
 * the server is the HTTP read model of `src/contracts/xray-api.ts`; it imports nothing from `src/`
 * (docs/REPO_LAYOUT.md section 3).
 *
 * `?fixture=1` swaps the live SSE client for a player over `test/fixtures/events.jsonl`, so the
 * whole UI can be built and driven with no server running.
 */
import { createApi, readQuery } from './api.js';
import { createStore } from './store.js';
import { createFixtureSource, createLiveSource } from './stream.js';
import { parseFilter, toggleToken } from './filters.js';
import { callKeyOf } from './catalogue.js';
import {
  DEPTHS,
  collapseUnder,
  escTarget,
  prune,
  setDepth,
  toggle as toggleOpen,
} from './open-state.js';
import { codeFromUrl, isPairingCode, normalisePairingInput, pairingErrorText } from './pairing.js';
import {
  applyTheme,
  createScheduler,
  delegate,
  mount,
  nextTheme,
  readTheme,
  readTimelineMode,
  storeTimelineMode,
} from './mount.js';
import { h } from './h.js';
import { button, stat } from './ui.js';
import { count } from './format.js';
import { renderSessions } from './panel-sessions.js';
import { renderTimeline } from './panel-timeline.js';
import { renderInspector } from './panel-inspector.js';
import {
  checkListingSchemas,
  renderPossibility,
  schemaCheckKey,
  shownCatalog,
} from './panel-possibility.js';
import { renderSessionAuth } from './panel-session-auth.js';
import { renderIntent } from './panel-intent.js';
import { renderSqlData } from './panel-sql-data.js';
import { renderNowStrip } from './panel-now-strip.js';
import { renderErrorsHealth } from './panel-errors-health.js';
import { BANK_REFRESH_OPERATIONS, effectiveSessionXs, renderPersona } from './panel-persona.js';
import {
  renderConnectScreen,
  renderSharedPersonaBanner,
  renderStreamBanner,
  renderViewerChip,
} from './panel-connect.js';

const DETAIL_TABS = [
  { id: 'call', label: 'Call inspector', render: renderInspector },
  { id: 'tools', label: 'Possibility space', render: renderPossibility },
  { id: 'auth', label: 'Session and auth', render: renderSessionAuth },
  { id: 'intent', label: 'Intent', render: renderIntent },
  { id: 'sql', label: 'SQL and data', render: renderSqlData },
  { id: 'health', label: 'Errors and health', render: renderErrorsHealth },
];

const FIXTURE_RATES = [1, 5, 20, 100];
/** How often the persona card re-reads the balances while the page is visible. */
const BANK_REFRESH_MS = 60_000;
/** A burst of `bank.op` events (a transfer plus its audit entry) costs one fetch, not several. */
const BANK_DEBOUNCE_MS = 300;

const store = createStore();
const query = readQuery(location.search);
const api = createApi();

const view = {
  mode: query.fixture ? 'fixture' : 'live',
  ready: false,
  viewer: null,
  connection: { state: 'idle', attempts: 0 },
  selectedXs: query.xs ?? null,
  selectedCallKey: null,
  selectedEventId: null,
  detailTab: 'call',
  filterRaw: '',
  filter: parseFilter(''),
  /** `chain` (episodes of connected steps) or `events` (one row per event); remembered per browser. */
  timelineMode: readTimelineMode(),
  /**
   * What each JSON viewer has open, keyed by path (`public/json-view.js`). It lives on the view
   * rather than in the DOM because a repaint replaces the markup wholesale, and a tree that
   * folded itself back up every time an event arrived would be no better than the fixed-height
   * box it replaced.
   */
  json: {},
  /**
   * One of the five actors of `provenance.js`, or `null` for all of them. A lens over the board,
   * not a filter: the other bands stay on the page, pushed back, because a board with a hole in it
   * would be a different claim about what happened. Deliberately not remembered - it is a way of
   * reading one call, not a setting.
   */
  actorFocus: null,
  /**
   * What the reader has opened and closed on the spine, and in what order (`open-state.js`).
   * Explicit choices only: everything untouched answers from `depth`, which is what makes the
   * depth control a way back from micro to macro rather than one more thing to undo by hand.
   */
  open: {},
  openOrder: [],
  depth: 'calls',
  /** The last key opened, consumed by one `scrollIntoView` after the repaint that drew it. */
  lastToggled: null,
  /** The detail drawer and the Sessions aside; neither is remembered between page views. */
  drawer: 'closed',
  aside: 'open',
  /**
   * The browser's own check of each recorded tool schema against the digest recorded beside it,
   * keyed `<listing event id>/<tool>` (`schemaCheckKey`): `verified`, `mismatch`, `unavailable` or `failed`;
   * an absent key is still pending. `schemaCheckRevision` counts the writes, for both repaint gates.
   */
  schemaChecks: {},
  schemaCheckRevision: 0,
  follow: true,
  paused: false,
  frozenEventId: null,
  pendingCount: 0,
  theme: readTheme(),
  adminOpen: false,
  pairing: { code: '', error: null, busy: false },
  /** Set when `/xray/api/me` itself failed, which is a different problem from a bad code. */
  connectError: null,
  /** True while `backfillHistory` is reading a session's events behind the SSE window. */
  backfilling: false,
  fixture: { playing: false, cursor: 0, total: 0, rate: query.rate ?? 20 },
  notice: null,
  /** The persona card's data: `GET /xray/api/sessions/:xs/bank` for the effective session. */
  bank: { xs: null, payload: null, error: null, fetchedAt: null, busy: false },
  /**
   * The erase controls of the Sessions panel. `scope` is `null` when nothing is armed, `login` for
   * the whole history, or an `xs` for one session; it is what makes the second click necessary.
   */
  erase: { scope: null, busy: false, note: null, error: null },
};

let source = null;
/** In fixture mode the dashboard clock follows the recording; see `createFixtureSource`. */
let clockBase = null;
const scheduleRender = createScheduler(render);
/** What the timeline was last painted from; an unchanged signature skips the repaint. */
let lastTimelineSignature = null;
let lastDetailSignature = null;
/** True for one frame around the scroll this page performs itself; see `revealLastToggled`. */
let programmaticScroll = false;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function nowMs() {
  if (view.mode !== 'fixture' || !clockBase) return Date.now();
  // While the player runs, fixture time advances at the replay rate; while it is paused or
  // stepped, it advances in real time, so a call frozen mid-flight really does age against the
  // 300 s budget.
  const scale = clockBase.playing ? clockBase.rate : 1;
  return clockBase.clock + (Date.now() - clockBase.at) * scale;
}

function model() {
  return { store, view, now: nowMs(), api };
}

/**
 * Everything the timeline body depends on. The 250 ms clock repaints the now strip and the
 * inspector timing; the timeline itself changes only with the store, the filter, the selection or
 * the toolbar state - and, once a second, while a call is in flight, for its budget meter.
 */
function timelineSignature() {
  const inFlight = store.getInFlightCalls().length > 0;
  return [
    store.lastEventId,
    store.size,
    view.mode,
    view.timelineMode,
    view.actorFocus,
    // An expanded step holds a JSON viewer, so opening a branch has to be able to repaint.
    jsonSignature(),
    openSignature(),
    view.filterRaw,
    view.selectedEventId,
    view.selectedCallKey,
    view.selectedXs,
    view.paused,
    view.frozenEventId,
    view.follow,
    view.pendingCount,
    view.schemaCheckRevision,
    inFlight ? Math.floor(nowMs() / 1000) : 0,
  ].join('|');
}

/**
 * The depth, the two chrome states and every explicit open choice. `openOrder` and `lastToggled`
 * are deliberately absent: the order the reader clicked in changes nothing on the page, and a
 * repaint triggered by it would fight the `scrollIntoView` it exists to feed.
 */
function openSignature() {
  // The Possibility space's `cat:` rows are drawn by the detail panel, never by the timeline.
  const keys = Object.keys(view.open).filter((key) => !key.startsWith('cat:'));
  const entries = keys
    .sort()
    .map((key) => `${key}=${view.open[key]}`)
    .join(';');
  return [view.depth, view.drawer, view.aside, entries].join('|');
}

/** The open tool rows and raw descriptors of the Possibility space (`cat:` keys). */
function catalogOpenSignature() {
  return Object.keys(view.open)
    .filter((key) => key.startsWith('cat:'))
    .sort()
    .map((key) => `${key}=${view.open[key]}`)
    .join(';');
}

/** Cheap and stable: `view.json` holds a handful of keys even after "Expand all". */
function jsonSignature() {
  const keys = Object.keys(view.json);
  if (keys.length === 0) return '';
  return keys
    .sort()
    .map((key) => `${key}=${view.json[key]}`)
    .join(';');
}

/**
 * The detail panel used to repaint on every render - four times a second while a call was in
 * flight - which reset the scroll of anything inside it that was not carrying an `id` and threw
 * away any text the reader had selected. It repaints when what it shows changes, and once a
 * second while a call is running, which is the only thing in there that moves on its own.
 */
function detailSignature() {
  const inFlight = store.getInFlightCalls().length > 0;
  return [
    store.lastEventId,
    store.size,
    view.mode,
    view.detailTab,
    view.selectedCallKey,
    view.selectedEventId,
    view.selectedXs,
    view.drawer,
    view.paused,
    view.frozenEventId,
    view.connection.state,
    view.backfilling,
    jsonSignature(),
    // The Possibility space: which tool rows are open, and every verdict the digest check wrote.
    catalogOpenSignature(),
    view.schemaCheckRevision,
    inFlight ? Math.floor(nowMs() / 1000) : 0,
  ].join('|');
}

function fixtureControls() {
  if (view.mode !== 'fixture') return null;
  const fixture = view.fixture;
  return h(
    'div',
    { class: 'fixture-controls' },
    button(fixture.playing ? 'Pause replay' : 'Play replay', 'fixture-toggle', {
      variant: 'primary',
    }),
    button('Step', 'fixture-step', {
      variant: 'quiet',
      title: 'Release exactly one event. Stop just after a call starts to watch the budget bar move.',
    }),
    button('Skip to end', 'fixture-skip', { variant: 'quiet' }),
    button('Restart', 'fixture-restart', { variant: 'quiet' }),
    h(
      'span',
      { class: 'fixture-rate' },
      ...FIXTURE_RATES.map((rate) =>
        button(`${rate}x`, 'fixture-rate', {
          arg: String(rate),
          variant: 'chip',
          pressed: Number(fixture.rate) === rate,
        }),
      ),
    ),
    h(
      'span',
      { class: 'fixture-progress mono' },
      `${count(fixture.cursor)} / ${count(fixture.total)}`,
    ),
  );
}

function renderHeader() {
  const counters = store.getCounters();
  const themeLabel = view.theme === 'system' ? 'Theme: system' : `Theme: ${view.theme}`;
  return h(
    'div',
    { class: 'header-inner' },
    h(
      'div',
      { class: 'brand' },
      h('span', { class: 'brand-mark' }, 'Glass Bank'),
      h('span', { class: 'brand-sub' }, 'X-ray'),
    ),
    h(
      'div',
      { class: 'header-stats' },
      stat('events', count(store.size)),
      stat('calls', count(counters.calls)),
      stat('failed', count(counters.failed_calls), {
        tone: counters.failed_calls ? 'warn' : null,
        title: 'Tool calls that returned an error or were denied before they ran',
      }),
      stat('sessions', count(store.getSessions().length)),
    ),
    fixtureControls(),
    h(
      'div',
      { class: 'header-right' },
      renderViewerChip(model()),
      button(themeLabel, 'cycle-theme', { variant: 'quiet' }),
    ),
  );
}

function renderDetailTabs() {
  return h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    ...DETAIL_TABS.map((tab) =>
      h(
        'button',
        {
          type: 'button',
          id: `tab-${tab.id}`,
          class: `tab${view.detailTab === tab.id ? ' is-active' : ''}`,
          'data-action': 'select-tab',
          'data-arg': tab.id,
          role: 'tab',
          'aria-selected': String(view.detailTab === tab.id),
          // Without this the screen reader announces six tabs that control nothing and cannot
          // move the user to the content they just selected.
          'aria-controls': 'panel-detail',
        },
        tab.label,
      ),
    ),
  );
}

function render() {
  const context = model();
  document.body.setAttribute('data-mode', view.mode);

  if (!view.ready) {
    document.getElementById('app').hidden = true;
    document.getElementById('gate').hidden = false;
    mount(document.getElementById('gate'), renderConnectScreen(context));
    return;
  }

  document.getElementById('gate').hidden = true;
  document.getElementById('app').hidden = false;

  mount(document.getElementById('header'), renderHeader());
  mount(document.getElementById('banner'), h('div', {}, renderStreamBanner(context), view.notice));
  mount(document.getElementById('now'), renderNowStrip(context));
  mount(
    document.getElementById('panel-sessions'),
    h(
      'div',
      {},
      renderPersona(context),
      renderSharedPersonaBanner(context),
      renderSessions(context),
    ),
    { scroll: 'preserve' },
  );
  pruneOpenState();
  const signature = timelineSignature();
  if (signature !== lastTimelineSignature) {
    lastTimelineSignature = signature;
    mount(document.getElementById('panel-timeline'), renderTimeline(context), {
      scroll: 'preserve',
    });
    // `mount` put the inner scroller back where the viewer left it; only the tail-follow moves it.
    const scroller = document.getElementById('timeline-scroll');
    if (scroller && view.follow && !view.paused) scroller.scrollTop = scroller.scrollHeight;
  }
  revealLastToggled();
  mount(document.getElementById('detail-tabs'), renderDetailTabs());
  const tab = DETAIL_TABS.find((candidate) => candidate.id === view.detailTab) ?? DETAIL_TABS[0];
  const detail = document.getElementById('panel-detail');
  // Name the panel after whichever tab is active, so the tabpanel announces what it is showing.
  detail?.setAttribute('aria-labelledby', `tab-${tab.id}`);
  const detailSig = detailSignature();
  if (detailSig !== lastDetailSignature) {
    lastDetailSignature = detailSig;
    mount(detail, tab.render(context), { scroll: 'preserve' });
  }
}

/**
 * Drops the open choices that no longer name anything, before the timeline is drawn from them.
 *
 * Held while a backfill is in flight and before the first events have been applied: a deep link
 * or a replay names keys before the events they belong to arrive, and pruning them on the first
 * paint would throw the reader's own request away.
 */
function pruneOpenState() {
  if (view.backfilling || store.size === 0) return;
  prune(view, store);
}

/**
 * Brings the block that was just opened into view, once, and tells the scroll listener that the
 * move was ours: without the flag a programmatic scroll re-arms the tail-follow, and the next
 * event that arrives scrolls the reader off the block they just opened.
 */
function revealLastToggled() {
  const key = view.lastToggled;
  if (!key) return;
  view.lastToggled = null;
  const selector = `[data-open-key="${key.replace(/["\\]/g, '\\$&')}"]`;
  const element = document.querySelector(selector);
  if (!element || typeof element.scrollIntoView !== 'function') return;
  programmaticScroll = true;
  element.scrollIntoView({ block: 'nearest' });
  requestAnimationFrame(() => {
    programmaticScroll = false;
  });
}

// ---------------------------------------------------------------------------
// Event intake
// ---------------------------------------------------------------------------

/**
 * Verdicts are kept for this many listings, newest event ids first, plus every listing a session's
 * catalog still shows; a session re-lists by hash.
 */
const SCHEMA_CHECK_LISTINGS = 50;

/** Listings being re-hashed right now, so one listing is never checked twice at once. */
const schemaChecksRunning = new Set();

/**
 * Bumped by `forgetSchemaChecks`: a check that was still running when hide or erase emptied
 * `view.schemaChecks` finds a different generation when it settles and writes nothing back.
 */
let schemaCheckGeneration = 0;

/**
 * Re-hashes every recorded schema of a full `tools/list` record with this browser's
 * `crypto.subtle` and writes one verdict per tool into `view.schemaChecks`, keyed by the listing's
 * event id so a later listing never reuses it. A hash-only re-list has nothing to hash: its rows
 * resolve to an earlier full listing, which is checked again only when its verdicts are gone, so
 * no row reads `checking` with nothing running. No `crypto.subtle` (plain http on anything but
 * localhost) writes `unavailable` for every row and throws nothing.
 */
function verifyCatalogSchemas(envelope) {
  if (!envelope || envelope.type !== 'catalog.tools_listed') return;
  const tools = envelope.data?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    verifyListing(envelope.id, tools);
    return;
  }
  // The listing the Possibility space shows for this session, so the check lands on its rows.
  const catalog = envelope.xs ? shownCatalog(store, envelope.xs) : null;
  if (!catalog || catalog.event_id === null || catalog.event_id === undefined) return;
  if (!hasSchemaChecks(catalog.event_id, catalog.tools)) verifyListing(catalog.event_id, catalog.tools);
}

/** True when every row `checkListingSchemas` would judge already has its verdict. */
function hasSchemaChecks(listingId, tools) {
  return (tools ?? []).every(
    (tool) =>
      !tool ||
      typeof tool.name !== 'string' ||
      !tool.descriptor?.inputSchema ||
      typeof tool.descriptor.inputSchema !== 'object' ||
      Object.hasOwn(view.schemaChecks, schemaCheckKey(listingId, tool.name)),
  );
}

function verifyListing(listingId, tools) {
  if (schemaChecksRunning.has(listingId)) return;
  schemaChecksRunning.add(listingId);
  const generation = schemaCheckGeneration;
  const subtle = typeof crypto !== 'undefined' && crypto ? crypto.subtle ?? null : null;
  checkListingSchemas(tools, subtle).then((verdicts) => {
    // Hide or erase ran meanwhile: those verdicts belong to a store that is gone.
    if (generation !== schemaCheckGeneration) return;
    schemaChecksRunning.delete(listingId);
    const next = { ...view.schemaChecks };
    for (const [name, verdict] of Object.entries(verdicts)) {
      next[schemaCheckKey(listingId, name)] = verdict;
    }
    view.schemaChecks = evictSchemaChecks(next);
    view.schemaCheckRevision += 1;
    scheduleRender();
  });
}

/** Drops the verdicts of listings past the newest 50, except a listing some session still shows. */
function evictSchemaChecks(checks) {
  const listingOf = (key) => Number(key.split('/')[0]);
  const candidates = [...new Set(Object.keys(checks).map(listingOf))]
    .sort((a, b) => b - a)
    .slice(SCHEMA_CHECK_LISTINGS);
  if (candidates.length === 0) return checks;
  // One walk over the retained events finds each session's latest tools/list, then `shownCatalog`
  // picks the listing the Possibility space shows for it, the same choice the panel makes.
  const latest = new Map();
  for (const event of store.getEvents()) {
    if (event.type === 'catalog.tools_listed') latest.set(event.xs, event);
  }
  const shown = new Set(
    store.getSessions().map((session) => shownCatalog(store, session.xs, latest.get(session.xs) ?? null)?.event_id),
  );
  const dropped = new Set(candidates.filter((id) => !shown.has(id)));
  if (dropped.size === 0) return checks;
  return Object.fromEntries(Object.entries(checks).filter(([key]) => !dropped.has(listingOf(key))));
}

/** Everything on screen went with the store, so its verdicts go too, and so do the checks in flight. */
function forgetSchemaChecks() {
  schemaCheckGeneration += 1;
  schemaChecksRunning.clear();
  view.schemaChecks = {};
  view.schemaCheckRevision += 1;
}

function onEvent(envelope) {
  const applied = store.apply(envelope);
  if (!applied) return;
  verifyCatalogSchemas(envelope);
  if (view.paused && view.frozenEventId !== null && envelope.id > view.frozenEventId) {
    view.pendingCount += 1;
  }
  if (!view.selectedXs && view.mode === 'live' && envelope.xs && store.getSessions().length === 1) {
    // A viewer with exactly one session should not have to pick it.
    view.selectedXs = null;
  }
  if (view.mode === 'live') {
    const data = envelope.data ?? {};
    if (
      envelope.type === 'bank.op' &&
      data.ok === true &&
      BANK_REFRESH_OPERATIONS.has(data.operation)
    ) {
      // A lock, unlock, confirmed transfer or reset changed what the persona holds.
      scheduleBankRefresh();
    } else if (effectiveSessionXs(store, view) !== view.bank.xs) {
      // A new session became the most recent one, so the card now describes it.
      scheduleBankRefresh();
    }
  }
  scheduleRender();
}

// ---------------------------------------------------------------------------
// The persona card's balances
// ---------------------------------------------------------------------------

let bankRequest = 0;
let bankTimer = null;

/** Reads the balances of the effective session into `view.bank`. Never runs in fixture mode. */
async function refreshBank() {
  if (view.mode !== 'live' || !view.ready) return;
  const xs = effectiveSessionXs(store, view);
  if (!xs) {
    view.bank = { xs: null, payload: null, error: null, fetchedAt: null, busy: false };
    scheduleRender();
    return;
  }
  const same = view.bank.xs === xs;
  const requestId = (bankRequest += 1);
  view.bank = {
    xs,
    payload: same ? view.bank.payload : null,
    error: same ? view.bank.error : null,
    fetchedAt: same ? view.bank.fetchedAt : null,
    busy: true,
  };
  scheduleRender();
  const result = await api.sessionBank(xs);
  // A later request (a session change, a click) supersedes this answer.
  if (requestId !== bankRequest) return;
  if (result.ok && result.payload && result.payload.persona) {
    view.bank = { xs, payload: result.payload, error: null, fetchedAt: Date.now(), busy: false };
  } else {
    view.bank = {
      xs,
      payload: view.bank.payload,
      error:
        result.payload?.message ??
        `The balances could not be loaded (status ${result.status || 'no response'}).`,
      fetchedAt: Date.now(),
      busy: false,
    };
  }
  scheduleRender();
}

function scheduleBankRefresh(delay = BANK_DEBOUNCE_MS) {
  if (view.mode !== 'live') return;
  clearTimeout(bankTimer);
  bankTimer = setTimeout(() => {
    bankTimer = null;
    refreshBank();
  }, delay);
}

function onState(state) {
  view.connection = { ...view.connection, ...state };
  if (state.state === 'fixture') {
    if (typeof state.clock === 'number') {
      clockBase = {
        clock: state.clock,
        at: state.clockAt ?? Date.now(),
        rate: Number(state.rate) || 1,
        playing: Boolean(state.playing),
      };
    }
    view.fixture = {
      playing: Boolean(state.playing),
      cursor: state.cursor ?? view.fixture.cursor,
      total: state.total ?? view.fixture.total,
      rate: state.rate ?? view.fixture.rate,
    };
  }
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * "Expand all" and "Collapse" for one viewer. Every per-node choice under that viewer is dropped
 * first, so the button does what it says instead of leaving one stubborn branch behind.
 */
function setJsonForViewer(id, value) {
  if (!id) return;
  const next = {};
  for (const [key, state] of Object.entries(view.json)) {
    if (key !== id && !key.startsWith(`${id}.`) && !key.startsWith(`${id}!`)) next[key] = state;
  }
  next[`${id}!all-open`] = value;
  view.json = next;
  scheduleRender();
}

/** How long the Copy button says what it did before going back to offering it. */
const COPY_NOTE_MS = 1600;
let copyNoteTimer = null;

/**
 * Copies the exact JSON, read out of the viewer's raw block rather than rebuilt from the tree, so
 * what lands on the clipboard is what arrived. `navigator.clipboard` needs a secure context and
 * the local dev server is plain HTTP, so the textarea fallback is the path that actually runs
 * there. The result is reported on the button itself; a banner for a copy would be shouting.
 */
async function copyJson(id) {
  const source = document.getElementById(`${id}-raw`);
  if (!source) return;
  const text = source.textContent ?? '';
  let note = 'copied';
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const carrier = document.createElement('textarea');
      carrier.value = text;
      carrier.setAttribute('readonly', '');
      carrier.style.position = 'fixed';
      carrier.style.opacity = '0';
      document.body.append(carrier);
      carrier.select();
      const done = document.execCommand('copy');
      carrier.remove();
      if (!done) note = 'blocked';
    }
  } catch {
    note = 'blocked';
  }
  view.json = { ...view.json, [`${id}!copied`]: note };
  scheduleRender();
  if (copyNoteTimer) clearTimeout(copyNoteTimer);
  copyNoteTimer = setTimeout(() => {
    const { [`${id}!copied`]: _dropped, ...rest } = view.json;
    view.json = rest;
    scheduleRender();
  }, COPY_NOTE_MS);
}

function selectEvent(rawId) {
  const id = Number(rawId);
  const event = store.getEventById(id);
  view.selectedEventId = Number.isFinite(id) ? id : null;
  const key = event ? callKeyOf(event) : null;
  view.selectedCallKey = key && store.getCall(key) ? key : null;
  view.detailTab = 'call';
  scheduleRender();
}

function setFilter(raw) {
  view.filterRaw = raw;
  view.filter = parseFilter(raw);
  scheduleRender();
}

function jumpToLive() {
  view.paused = false;
  view.frozenEventId = null;
  view.pendingCount = 0;
  view.follow = true;
  scheduleRender();
}

const actions = {
  'select-session': (arg) => {
    view.selectedXs = arg || null;
    view.selectedCallKey = null;
    view.selectedEventId = null;
    if (effectiveSessionXs(store, view) !== view.bank.xs) scheduleBankRefresh(0);
    scheduleRender();
  },
  'set-timeline-mode': (arg) => {
    const mode = arg === 'events' ? 'events' : 'chain';
    view.timelineMode = mode;
    storeTimelineMode(mode);
    view.follow = true;
    scheduleRender();
  },
  'set-actor-focus': (arg) => {
    // Clicking the chip that is already focused clears it, which is also what the "show all
    // again" button does: one action, so the two controls can never disagree.
    view.actorFocus = view.actorFocus === arg ? null : arg;
    scheduleRender();
  },
  'toggle-json': (arg) => {
    if (!arg) return;
    view.json = { ...view.json, [arg]: view.json[arg] === 'open' ? 'closed' : 'open' };
    scheduleRender();
  },
  /**
   * One block of the spine. `arg2` is the state the panel drew ('1' open, '0' closed), so the
   * control always undoes what the reader can see rather than what the view thought last frame.
   */
  'toggle-open': (arg, arg2) => {
    if (!arg) return;
    toggleOpen(view, arg, arg2 === '1');
    scheduleRender();
  },
  'set-depth': (arg) => {
    if (!DEPTHS.includes(arg)) return;
    setDepth(view, arg);
    scheduleRender();
  },
  /** `arg` is 'all', an `xs` or `ep:<key>`; the episode's own button names its calls in `arg2`. */
  'collapse-all': (arg, arg2) => {
    collapseUnder(view, arg || 'all', arg2 ? arg2.split(' ').filter(Boolean) : null);
    scheduleRender();
  },
  'close-drawer': () => {
    view.drawer = 'closed';
    scheduleRender();
  },
  'toggle-aside': () => {
    view.aside = view.aside === 'open' ? 'rail' : 'open';
    scheduleRender();
  },
  'json-open-all': (arg) => setJsonForViewer(arg, 'open'),
  'json-close-all': (arg) => setJsonForViewer(arg, 'closed'),
  'copy-json': (arg) => copyJson(arg),
  'refresh-bank': () => refreshBank(),
  'select-event': (arg) => selectEvent(arg),
  /** Selection feeds the inspector and nothing else: what is open lives in `view.open`. */
  'select-call': (arg) => {
    view.selectedCallKey = arg;
    const call = store.getCall(arg);
    view.selectedEventId = call ? call.event_id : null;
    view.detailTab = 'call';
    scheduleRender();
  },
  'select-tab': (arg) => {
    view.detailTab = arg;
    scheduleRender();
  },
  'toggle-pause': () => {
    view.paused = !view.paused;
    view.frozenEventId = view.paused ? store.lastEventId : null;
    view.pendingCount = 0;
    if (!view.paused) view.follow = true;
    scheduleRender();
  },
  'jump-live': () => jumpToLive(),
  'toggle-filter-token': (arg) => setFilter(toggleToken(view.filterRaw, arg)),
  'clear-filter': () => setFilter(''),
  'cycle-theme': () => {
    view.theme = nextTheme(view.theme);
    applyTheme(view.theme);
    scheduleRender();
  },
  reconnect: () => {
    if (source && source.reconnect) source.reconnect();
  },
  'enter-fixture': () => {
    const url = new URL(location.href);
    url.searchParams.set('fixture', '1');
    location.href = url.toString();
  },
  'leave-fixture': () => {
    const url = new URL(location.href);
    url.searchParams.delete('fixture');
    url.searchParams.delete('autoplay');
    url.searchParams.delete('rate');
    location.href = url.toString();
  },
  'toggle-admin': () => {
    view.adminOpen = !view.adminOpen;
    scheduleRender();
  },
  'fixture-toggle': () => {
    if (!source) return;
    if (view.fixture.playing) source.pause();
    else source.play();
  },
  'fixture-step': () => source && source.step(),
  'fixture-skip': () => source && source.skipToEnd(),
  'fixture-restart': () => {
    if (!source) return;
    location.reload();
  },
  'fixture-rate': (arg) => source && source.setRate(Number(arg)),
  'submit-pairing': () => submitPairing(),
  'submit-admin': () => submitAdmin(),
  /** Client-side only: forget what is on screen. The server still has every event. */
  'hide-events': () => {
    const hidden = store.size;
    store.clear();
    forgetSchemaChecks();
    view.selectedCallKey = null;
    view.selectedEventId = null;
    view.pendingCount = 0;
    view.erase = {
      scope: null,
      busy: false,
      note: `${count(hidden)} events were removed from this page only. They are still on the server: reload to see them again.`,
      error: null,
    };
    lastTimelineSignature = null;
    scheduleRender();
  },
  'ask-erase': (arg) => {
    view.erase = { scope: arg || 'login', busy: false, note: null, error: null };
    scheduleRender();
  },
  'cancel-erase': () => {
    view.erase = { scope: null, busy: false, note: null, error: null };
    scheduleRender();
  },
  'confirm-erase': (arg) => eraseHistory(arg),
};

/**
 * The real one: asks the server to erase, then forgets what is on screen. A failure leaves the
 * view exactly as it was and shows the server's own message, because the events are still there.
 */
async function eraseHistory(scope) {
  if (view.mode !== 'live' || view.erase.busy) return;
  view.erase = { ...view.erase, scope: scope || 'login', busy: true, error: null, note: null };
  scheduleRender();
  const result =
    scope && scope !== 'login' ? await api.deleteSession(scope) : await api.deleteEvents();
  if (result.ok && result.payload) {
    const { deleted = 0, sessions = 0 } = result.payload;
    store.clear();
    forgetSchemaChecks();
    view.selectedCallKey = null;
    view.selectedEventId = null;
    view.selectedXs = null;
    view.pendingCount = 0;
    view.erase = {
      scope: null,
      busy: false,
      note: `${count(deleted)} event${deleted === 1 ? '' : 's'} and ${count(sessions)} session${
        sessions === 1 ? '' : 's'
      } were erased from the server.`,
      error: null,
    };
    lastTimelineSignature = null;
    scheduleRender();
    return;
  }
  // A server older than v0.4 has no route to erase; say that rather than breaking the page.
  const fallback =
    result.status === 404 || result.status === 405
      ? 'This server does not support erasing events yet. Nothing was deleted.'
      : `The server refused to erase (status ${result.status || 'no response'}). Nothing was deleted.`;
  view.erase = {
    scope: null,
    busy: false,
    note: null,
    error: result.payload?.message ?? fallback,
  };
  scheduleRender();
}

async function submitPairing() {
  const code = view.pairing.code;
  if (!isPairingCode(code)) {
    view.pairing.error = pairingErrorText('malformed');
    scheduleRender();
    return;
  }
  view.pairing = { ...view.pairing, busy: true, error: null };
  scheduleRender();
  const response = await api.pair(code);
  if (response.ok) {
    location.href = api.base ? `${api.base}/` : '/';
    return;
  }
  view.pairing = {
    ...view.pairing,
    busy: false,
    error: pairingErrorText(response.payload?.error, response.payload?.message),
  };
  scheduleRender();
}

async function submitAdmin() {
  const input = document.getElementById('admin-input');
  const token = input ? input.value : '';
  if (!token) return;
  const response = await api.admin(token);
  if (response.ok) {
    location.href = api.base ? `${api.base}/?all=1` : '/?all=1';
    return;
  }
  view.pairing = {
    ...view.pairing,
    error: response.payload?.message ?? 'That token was not accepted.',
  };
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function wireDom() {
  const root = document.body;
  delegate(root, actions);

  root.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !target.id) return;
    if (target.id === 'filter-input') setFilter(target.value);
    if (target.id === 'pair-input') {
      const raw = target.value;
      const fromUrl = raw.includes('/') ? codeFromUrl(raw) : null;
      const code = normalisePairingInput(fromUrl ?? raw);
      view.pairing = { ...view.pairing, code, error: null };
      target.value = code;
      scheduleRender();
    }
  });

  root.addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target && event.target.id === 'pair-form') submitPairing();
    if (event.target && event.target.id === 'admin-form') submitAdmin();
  });

  // Scrolling the timeline away from the tail stops the auto-follow; "Jump to live" restores it.
  const timeline = document.getElementById('panel-timeline');
  if (timeline) {
    timeline.addEventListener(
      'scroll',
      (event) => {
        const element = event.target;
        if (!element || element.id !== 'timeline-scroll') return;
        // Our own `scrollIntoView` is not the reader scrolling away from the tail.
        if (programmaticScroll) return;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
        if (view.follow !== atBottom) {
          view.follow = atBottom;
          scheduleRender();
        }
      },
      true,
    );
  }

  document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (event.key === '/' && !typing) {
      event.preventDefault();
      const input = document.getElementById('filter-input');
      if (input) input.focus();
      return;
    }
    if (event.key === 'Escape') {
      if (typing) {
        target.blur();
        return;
      }
      // Innermost first: close what was opened last, then the drawer, then let go of the call.
      const openKey = escTarget(view);
      if (openKey) {
        toggleOpen(view, openKey, true);
        scheduleRender();
        return;
      }
      if (view.drawer !== 'closed') {
        view.drawer = 'closed';
        scheduleRender();
        return;
      }
      view.selectedEventId = null;
      view.selectedCallKey = null;
      view.actorFocus = null;
      scheduleRender();
    }
  });
}

function startFixture() {
  view.mode = 'fixture';
  view.viewer = { viewer_kind: 'pairing', login_id: null, persona: null, expires_at: null };
  view.ready = true;
  source = createFixtureSource({
    url: api.fixturesUrl(),
    onEvent,
    onState,
    rate: view.fixture.rate,
  });
  source.start({ applyAll: query.autoplay === 'all' });
}

async function startLive() {
  const me = await api.me();
  if (!me.ok) {
    view.ready = false;
    // 401 and 403 are the ordinary "not paired yet" answers and need no scary banner.
    view.connectError =
      me.status === 401 || me.status === 403
        ? null
        : `${
            me.payload?.message ?? 'The dashboard API could not be reached.'
          } (status ${me.status || 'no response'}). Sample mode below works without a server.`;
    render();
    return;
  }
  view.viewer = me.payload;
  view.ready = true;

  const sessions = await api.sessions();
  if (sessions.ok && sessions.payload && Array.isArray(sessions.payload.data)) {
    store.mergeServerSessions(sessions.payload.data);
  }

  // Backfill each session's history BEFORE the stream opens. A fresh SSE connect replays only the
  // last INITIAL_REPLAY (200) events, and `tools/list` is always the very first thing a client
  // does, so on any real session the catalog events fall out of that window and the "Possibility
  // space" panel - one of the four things this dashboard exists to show - renders empty. The
  // overlap with the replay is safe because `store.apply` dedupes on event id.
  await backfillHistory(sessions.ok ? sessions.payload : null);

  source = createLiveSource({
    url: api.streamUrl(query.all ? { all: true } : query.xs ? { xs: query.xs } : null),
    onEvent,
    onState,
  });
  source.start();
  render();
  refreshBank();
}

/** Sessions to backfill: the one asked for, else the most recent few the viewer owns. */
const BACKFILL_SESSIONS = 3;
/** Pages of `BACKFILL_PAGE_LIMIT` per session, so one long session cannot stall the boot. */
const BACKFILL_PAGES = 4;
const BACKFILL_PAGE_LIMIT = 500;

async function backfillHistory(sessionsPayload) {
  const wanted = [];
  if (query.xs) {
    wanted.push(query.xs);
  } else {
    const rows = Array.isArray(sessionsPayload?.data) ? sessionsPayload.data : [];
    for (const row of rows.slice(0, BACKFILL_SESSIONS)) {
      if (row && typeof row.xs === 'string') wanted.push(row.xs);
    }
  }
  if (wanted.length === 0) return;

  view.backfilling = true;
  scheduleRender();
  try {
    for (const xs of wanted) {
      let after;
      for (let page = 0; page < BACKFILL_PAGES; page += 1) {
        const result = await api.sessionEvents(
          xs,
          after === undefined ? { limit: BACKFILL_PAGE_LIMIT } : { after, limit: BACKFILL_PAGE_LIMIT },
        );
        if (!result.ok || !result.payload || !Array.isArray(result.payload.data)) break;
        for (const envelope of result.payload.data) {
          if (store.apply(envelope)) verifyCatalogSchemas(envelope);
        }
        const next = result.payload.page?.next;
        if (!next) break;
        after = Number(next);
        if (!Number.isFinite(after)) break;
      }
    }
  } finally {
    view.backfilling = false;
  }
  scheduleRender();
}

function startClock() {
  // The now strip and every relative time need a clock of their own; 250 ms is smooth enough for
  // the elapsed counter and cheap enough to run for hours.
  setInterval(() => {
    if (!view.ready) return;
    scheduleRender();
  }, 250);
  // The balances go stale on their own (TTL evictions do not, but card locks from another client
  // do), so the card re-reads them once a minute while someone is actually looking at the page.
  setInterval(() => {
    if (!view.ready || view.mode !== 'live') return;
    if (document.visibilityState !== 'visible') return;
    refreshBank();
  }, BANK_REFRESH_MS);
}

function boot() {
  applyTheme(view.theme);
  wireDom();
  startClock();
  if (view.mode === 'fixture') startFixture();
  else startLive();
  render();

  // A read-only handle for the browser console and for public/_dev/check-console.mjs.
  window.__xray = {
    get events() {
      return store.size;
    },
    get lastEventId() {
      return store.lastEventId;
    },
    get view() {
      return view;
    },
    store,
    render: scheduleRender,
    act: (action, arg, arg2) => (actions[action] ? actions[action](arg, arg2) : undefined),
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export { view, store, actions };
