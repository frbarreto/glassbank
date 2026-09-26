/**
 * The dashboard's copy of the contract stays in step with the contract (block: dashboard).
 *
 * `public/` imports nothing from `src/` (docs/REPO_LAYOUT.md section 3): it consumes the JSON
 * shapes over HTTP and keeps the few constants it needs - the event catalogue, the route strings,
 * the budget numbers and the pairing-code grammar - as copies. A copy that silently drifts is
 * worse than an import, so this test reads `src/contracts/*.ts` **as text** (still no import) and
 * fails when the two disagree.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KNOWN_TYPES, TYPE_LABELS } from '../catalogue.js';
import { routes } from '../api.js';
import { DEFAULT_BUDGET_MS, DEFAULT_CONTENT_CAP } from '../store.js';
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_PATTERN } from '../pairing.js';
import { MAX_ROWS } from '../panel-timeline.js';
import { CONTRACT_AUTH_PATH, CONTRACT_EVENTS_PATH } from './helpers.mjs';

const eventsSource = readFileSync(CONTRACT_EVENTS_PATH, 'utf8');
const authSource = readFileSync(CONTRACT_AUTH_PATH, 'utf8');
const apiSource = readFileSync(
  new URL('../../src/contracts/xray-api.ts', import.meta.url),
  'utf8',
);

/** Every `event('family.noun.verb', ...)` in the catalogue of `src/contracts/events.ts`. */
function contractEventTypes() {
  return [...eventsSource.matchAll(/\bevent\(\s*'([a-z]+(?:\.[a-z_]+){1,2})'/g)].map(
    (match) => match[1],
  );
}

describe('the event catalogue', () => {
  it('gives every contract event type a label', () => {
    const contractTypes = contractEventTypes();
    expect(contractTypes.length).toBeGreaterThan(40);
    const missing = contractTypes.filter((type) => !(type in TYPE_LABELS));
    expect(missing).toEqual([]);
  });

  it('invents no event type the contract does not define', () => {
    const contractTypes = new Set(contractEventTypes());
    const extra = KNOWN_TYPES.filter((type) => !contractTypes.has(type));
    expect(extra).toEqual([]);
  });
});

describe('the numbers the panels quote', () => {
  it('matches CLAUDE_TOOL_BUDGET_MS and CLAUDE_CONTENT_CHAR_CAP', () => {
    const budget = eventsSource.match(/CLAUDE_TOOL_BUDGET_MS = ([\d_]+)/)[1].replace(/_/g, '');
    const cap = eventsSource.match(/CLAUDE_CONTENT_CHAR_CAP = ([\d_]+)/)[1].replace(/_/g, '');
    expect(DEFAULT_BUDGET_MS).toBe(Number(budget));
    expect(DEFAULT_CONTENT_CAP).toBe(Number(cap));
  });

  it('draws at least the default replay window the server sends', () => {
    const replay = Number(apiSource.match(/INITIAL_REPLAY = (\d+)/)[1]);
    expect(MAX_ROWS).toBeGreaterThanOrEqual(replay);
  });
});

describe('the routes the client calls', () => {
  it('matches XRAY_ROUTES for every route the dashboard uses', () => {
    const contractRoutes = Object.fromEntries(
      [...apiSource.matchAll(/^\s{2}(\w+): '([^']+)',$/gm)].map((match) => [match[1], match[2]]),
    );
    const mine = routes('/xray');
    expect(mine.fixtures).toBe(contractRoutes.fixtures);
    expect(mine.pair).toBe(contractRoutes.pair);
    expect(mine.admin).toBe(contractRoutes.admin);
    expect(mine.me).toBe(contractRoutes.me);
    expect(mine.sessions).toBe(contractRoutes.sessions);
    // v0.4: `DELETE` here erases every event of the viewer's login.
    expect(mine.events).toBe(contractRoutes.events);
    expect(mine.catalog).toBe(contractRoutes.catalog);
    expect(mine.stream).toBe(contractRoutes.stream);
    expect(mine.session('xs_1')).toBe(contractRoutes.session.replace(':xs', 'xs_1'));
    expect(mine.sessionEvents('xs_1')).toBe(contractRoutes.sessionEvents.replace(':xs', 'xs_1'));
    expect(mine.sessionBank('xs_1')).toBe(contractRoutes.sessionBank.replace(':xs', 'xs_1'));
  });

  it('names the SSE frames the way the server writes them', () => {
    expect(apiSource).toContain("SSE_EVENT_NAME = 'xray'");
  });

  it('reads back the delete response the erase controls depend on', () => {
    expect(apiSource).toContain('interface XrayDeleteResponse');
    for (const field of ['deleted', 'sessions', 'scope']) {
      expect(apiSource).toMatch(new RegExp(`readonly ${field}:`));
    }
  });
});

describe('the pairing-code grammar', () => {
  it('matches the contract alphabet and pattern character for character', () => {
    const alphabet = authSource.match(/PAIRING_CODE_ALPHABET = '([^']+)'/)[1];
    const pattern = authSource.match(/PAIRING_CODE_PATTERN = (\/.+\/);/)[1];
    expect(PAIRING_CODE_ALPHABET).toBe(alphabet);
    expect(PAIRING_CODE_PATTERN.toString()).toBe(pattern);
  });
});
