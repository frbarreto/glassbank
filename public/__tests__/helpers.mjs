/** Shared fixture loading for the dashboard tests (block: dashboard). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore } from '../store.js';

export const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/events.jsonl', import.meta.url));
export const CONTRACT_EVENTS_PATH = fileURLToPath(
  new URL('../../src/contracts/events.ts', import.meta.url),
);
export const CONTRACT_AUTH_PATH = fileURLToPath(
  new URL('../../src/contracts/auth.ts', import.meta.url),
);

/** The 200 recorded events of `test/fixtures/events.jsonl`, read through `public/fixtures`. */
export function loadFixture() {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** A store folded over the fixture, optionally only up to `maxId`. */
export function storeFromFixture(maxId = Number.POSITIVE_INFINITY) {
  const store = createStore();
  for (const event of loadFixture()) {
    if (event.id > maxId) break;
    store.apply(event);
  }
  return store;
}

/** A minimal view object; individual tests override what they care about. */
export function makeView(overrides = {}) {
  return {
    mode: 'fixture',
    selectedXs: null,
    selectedCallKey: null,
    selectedEventId: null,
    detailTab: 'call',
    filterRaw: '',
    /** The row-per-event mode, which most of the timeline assertions count rows in. */
    timelineMode: 'events',
    /** The spine's open state (`public/open-state.js`): explicit choices, then the depth. */
    open: {},
    openOrder: [],
    depth: 'calls',
    lastToggled: null,
    drawer: 'closed',
    aside: 'open',
    schemaChecks: {},
    erase: { scope: null, busy: false, note: null, error: null },
    bank: { xs: null, payload: null, error: null, fetchedAt: null, busy: false },
    viewer: null,
    paused: false,
    follow: true,
    pendingCount: 0,
    connection: { state: 'fixture', attempts: 0 },
    pairing: { code: '', error: null, busy: false },
    ...overrides,
  };
}

/** The fixture's own clock, so relative times in tests never depend on the wall clock. */
export const FIXTURE_NOW = Date.parse('2026-09-08T14:08:00.000Z');
