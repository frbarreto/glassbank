/**
 * The second pass on the X-ray (block: dashboard, contracts v0.10): one chain per session with
 * its tracking ids and its input and output said in words (C1, C2), who is on the other end (D-29),
 * the Account view (D-31) and the Overview (D-32).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { findNodes, hasClass, textOf } from '../h.js';
import { parseFilter } from '../filters.js';
import { createStore } from '../store.js';
import {
  describeIdentity,
  emptyIdentity,
  foldHttpIdentity,
  mergeIdentity,
  strongerVerdict,
} from '../identity.js';
import { categoryBars, filterLines, renderAccount } from '../panel-account.js';
import { renderOverview, statsFromStore } from '../panel-overview.js';
import { renderTimeline, connectionStep } from '../panel-timeline.js';
import { jsonView } from '../json-view.js';
import { FIXTURE_NOW, loadFixture, makeView, storeFromFixture } from './helpers.mjs';

const ACTIVITY = JSON.parse(
  readFileSync(new URL('../fixtures/bank-activity.json', import.meta.url), 'utf8'),
);

function model(overrides = {}, maxId) {
  const store = storeFromFixture(maxId);
  const view = makeView({ timelineMode: 'chain', ...overrides });
  view.filter = parseFilter(view.filterRaw ?? '');
  return { store, view, now: FIXTURE_NOW };
}

describe('who is on the other end (D-29)', () => {
  it('keeps the strongest verdict, and never lets unsigned erase one', () => {
    expect(strongerVerdict(null, 'unsigned')).toBeNull();
    expect(strongerVerdict('invalid_signature', 'verified')).toBe('verified');
    expect(strongerVerdict('verified', 'invalid_signature')).toBe('verified');
    expect(strongerVerdict('verified', 'unsigned')).toBe('verified');
  });

  it('folds each request of a session into its identity', () => {
    const identity = emptyIdentity();
    foldHttpIdentity(identity, {
      user_agent: 'Claude-User',
      signature: { present: false, verdict: 'unsigned', challenge_sent: true },
    });
    foldHttpIdentity(identity, {
      user_agent: 'Claude-User',
      signature: { present: true, verdict: 'verified', agent: 'https://claude.ai', keyid: 'k1' },
    });
    expect(identity).toMatchObject({
      signature_verdict: 'verified',
      signed_agent: 'https://claude.ai',
      signed_requests: 1,
      verified_requests: 1,
      challenged: true,
      user_agent: 'Claude-User',
    });
    const merged = mergeIdentity(emptyIdentity(), identity);
    expect(merged.signature_verdict).toBe('verified');
  });

  it('says "signed by" only for a verified signature, and "claims" for a name', () => {
    const verified = describeIdentity({
      identity: {
        ...emptyIdentity(),
        signature_verdict: 'verified',
        signed_agent: 'https://chatgpt.com',
        verified_requests: 3,
      },
      client: { name: 'openai-mcp', version: '1.0.0' },
    });
    expect(verified).toMatchObject({ kind: 'verified', label: 'signed by chatgpt.com' });

    const failed = describeIdentity({
      identity: {
        ...emptyIdentity(),
        signature_verdict: 'unknown_key',
        signed_agent: 'https://agent.example',
      },
      client: null,
    });
    expect(failed.kind).toBe('signature');
    expect(failed.label).toContain('key not published');
    expect(failed.title).toContain('The name is therefore a claim');

    const claimed = describeIdentity({
      identity: emptyIdentity(),
      client: { name: 'Anthropic', version: '1.0.0' },
    });
    expect(claimed).toMatchObject({ kind: 'claimed', label: 'claims Anthropic · unsigned' });

    expect(describeIdentity({}).kind).toBe('unknown');
  });

  it('reads the verdict off the requests the store folds', () => {
    const store = createStore();
    store.apply({
      id: 1,
      ts: '2026-09-27T10:00:00.000Z',
      v: 1,
      xs: 'xs_signed1',
      login_id: 'lgn_public',
      grant_id: 'grt_pub_abc',
      persona_id: null,
      seq: 1,
      request_id: '1',
      era: 'legacy',
      client: null,
      protocol_version: null,
      trace_id: null,
      type: 'http.request',
      data: {
        method: 'POST',
        path: '/public/mcp',
        status: 200,
        duration_ms: 2,
        user_agent: 'SignedAgent/1.0',
        signature: { present: true, verdict: 'verified', agent: 'https://agent.example' },
      },
    });
    expect(describeIdentity(store.getSession('xs_signed1')).label).toBe('signed by agent.example');
  });
});

describe('one chain per session, with its tracking ids (C1, C2)', () => {
  it('heads each session with who connected, the proof, the ids and how it went', () => {
    const tree = renderTimeline(model());
    const heads = findNodes(tree, (node) => hasClass(node, 'session-head'));
    expect(heads).toHaveLength(2);
    const first = textOf(heads[0]);
    expect(first).toContain('Session xs_3f1c9a');
    expect(first).toContain('claims Anthropic · unsigned');
    expect(first).toContain('login lgn_5d2c7a');
    expect(first).toContain('grant grt_8a1e33');
    expect(first).toContain('ended · server stopping');
    expect(findNodes(heads[0], (node) => hasClass(node, 'identity-badge'))).toHaveLength(1);
  });

  it('folds a session to its head, and back', () => {
    const tree = renderTimeline(model({ open: { 'sess:xs_3f1c9a': 'closed' } }));
    const [first, second] = findNodes(tree, (node) => hasClass(node, 'session-block'));
    expect(findNodes(first, (node) => hasClass(node, 'call-row'))).toHaveLength(0);
    expect(findNodes(second, (node) => hasClass(node, 'call-row')).length).toBeGreaterThan(0);
  });

  it('names the connection steps in the order a client goes through them', () => {
    expect(connectionStep({ type: 'catalog.tools_listed', data: { count: 17 } })).toBe(
      'tools/list · 17 tools',
    );
    expect(
      connectionStep({
        type: 'session.initialized',
        data: { protocol_version_negotiated: '2025-11-25' },
      }),
    ).toBe('initialize 2025-11-25');
    expect(connectionStep({ type: 'tool.call.started', data: {} })).toBeNull();
  });

  it('says in and out on every row, and "rationale only" when that is the whole input', () => {
    const tree = renderTimeline(model());
    const rows = findNodes(tree, (node) => hasClass(node, 'call-row'));
    for (const row of rows) {
      const labels = findNodes(row, (node) => hasClass(node, 'io-label')).map(textOf);
      expect(labels).toEqual(['in', 'out']);
    }
    const whoAmI = rows.find((row) => row.attrs['data-call-key'] === 'xs_3f1c9a#4');
    expect(textOf(whoAmI)).toContain('rationale only');
  });

  it('prints the tracking line of an open call: login, grant, session, request and its log rows', () => {
    const tree = renderTimeline(model({ open: { 'call:xs_3f1c9a#6': 'open' } }));
    const trace = findNodes(tree, (node) => hasClass(node, 'call-trace'))[0];
    const text = textOf(trace);
    expect(text).toContain('login lgn_5d2c7a');
    expect(text).toContain('grant grt_8a1e33');
    expect(text).toContain('session xs_3f1c9a');
    expect(text).toContain('request #6');
    expect(text).toMatch(/#\d+ started/);
    expect(trace.attrs['data-actor']).toBe('page');
    const roles = findNodes(tree, (node) => hasClass(node, 'wire-role')).map(textOf);
    expect(roles[0]).toContain('input');
    expect(roles[2]).toContain('output');
  });

  it('opens the glossary of ids from the toolbar', () => {
    const closed = renderTimeline(model());
    expect(findNodes(closed, (node) => hasClass(node, 'id-glossary'))).toHaveLength(0);
    const open = renderTimeline(model({ open: { 'ui:glossary': 'open' } }));
    const text = textOf(findNodes(open, (node) => hasClass(node, 'id-glossary'))[0]);
    for (const word of ['login', 'grant', 'session', 'request', 'event', 'REQUEST is the input']) {
      expect(text).toContain(word);
    }
  });

  it('draws an envelope as tracking first and data second, with the same bytes behind Raw', () => {
    const event = loadFixture().find((candidate) => candidate.type === 'tool.call.started');
    const tree = jsonView(event, { id: 'env', state: {}, envelope: true });
    const groups = findNodes(tree, (node) => hasClass(node, 'jv-group'));
    expect(groups.map((node) => node.attrs.class)).toEqual([
      'jv-group jv-group-envelope',
      'jv-group jv-group-data',
    ]);
    expect(textOf(groups[0])).toContain('request_id');
    expect(textOf(groups[0])).not.toContain('arguments');
    expect(textOf(groups[1])).toContain('arguments');
    const raw = findNodes(tree, (node) => node.attrs.id === 'env-raw')[0];
    expect(JSON.parse(textOf(raw))).toEqual(event);
  });
});

describe('the Account view (D-31)', () => {
  const accountModel = (overrides = {}) =>
    model({
      page: 'account',
      account: { payload: ACTIVITY, filter: {}, statementRows: 40, ...overrides },
    });

  it('draws the money, the charts, the agent’s changes and what the model read', () => {
    const tree = renderAccount(accountModel());
    const text = textOf(tree);
    expect(text).toContain(ACTIVITY.persona.name);
    for (const label of [
      'cash',
      'available',
      'owed on cards',
      'net position',
      'in this month',
      'out this month',
    ]) {
      expect(text).toContain(label);
    }
    expect(findNodes(tree, (node) => hasClass(node, 'chart-flow'))).toHaveLength(1);
    expect(findNodes(tree, (node) => hasClass(node, 'category-bar')).length).toBeLessThanOrEqual(8);
    const audit = findNodes(tree, (node) => hasClass(node, 'audit-entry'));
    expect(audit).toHaveLength(ACTIVITY.audit.length);
    expect(textOf(audit[0])).toContain(ACTIVITY.audit[0].rationale);
    // What the model loaded in the session the page shows (sample mode: the most recent one).
    expect(text).toContain('load_cards_51e8a3b6');
    expect(text).toContain('Read by the model in this session');
  });

  it('filters the statement by text, account, category and direction', () => {
    const lines = ACTIVITY.lines;
    const category = lines.find((line) => line.category_id)?.category_id;
    expect(filterLines(lines, { category }).every((line) => line.category_id === category)).toBe(
      true,
    );
    expect(filterLines(lines, { direction: 'in' }).every((line) => line.amount_cents >= 0)).toBe(
      true,
    );
    expect(filterLines(lines, { source: 'bill' }).every((line) => line.source === 'bill')).toBe(
      true,
    );
    const first = lines[0];
    expect(filterLines(lines, { text: first.counterparty.toUpperCase() })).toContainEqual(first);
  });

  it('folds the long tail of categories into one "Other" bar', () => {
    const bars = categoryBars(ACTIVITY.by_category, 8);
    expect(bars).toHaveLength(8);
    expect(bars[7].other).toBe(true);
    const total = ACTIVITY.by_category.reduce((sum, entry) => sum + entry.spent_cents, 0);
    expect(bars.reduce((sum, entry) => sum + entry.spent_cents, 0)).toBe(total);
  });

  it('has no account to show on the public lane', () => {
    const tree = renderAccount(
      model({ viewer: { viewer_kind: 'public' }, account: { payload: null } }),
    );
    expect(textOf(tree)).toContain('No account on the public lane');
  });
});

describe('the Overview (D-32)', () => {
  it('counts the recording in the page when there is no server', () => {
    const stats = statsFromStore(storeFromFixture(), 'all', FIXTURE_NOW);
    expect(stats.source).toBe('page');
    expect(stats.totals).toMatchObject({ sessions: 2, calls: 26, calls_denied: 2 });
    expect(stats.by_tool[0].tool).toBe('execute_query');
    expect(stats.by_client).toHaveLength(1);
    expect(stats.by_client[0]).toMatchObject({
      label: 'Anthropic 1.0.0',
      signature_verdict: null,
      sessions: 2,
    });
    expect(stats.top_arguments.every((entry) => entry.key !== 'rationale')).toBe(true);
  });

  it('draws the tiles, the chart, the tools and the clients, and leaves argument values out for the admin', () => {
    const payload = statsFromStore(storeFromFixture(), 'all', FIXTURE_NOW);
    const paired = renderOverview(model({ overview: { window: 'all', payload } }));
    const text = textOf(paired);
    expect(text).toContain('Your sessions at a glance');
    expect(text).toContain('Counted by this page from the recording');
    expect(findNodes(paired, (node) => hasClass(node, 'chart-calls'))).toHaveLength(1);
    expect(text).toContain('What they asked for');
    const admin = renderOverview(
      model({ viewer: { viewer_kind: 'admin' }, overview: { window: 'all', payload } }),
    );
    expect(textOf(admin)).not.toContain('What they asked for');
    const pub = renderOverview(
      model({ viewer: { viewer_kind: 'public' }, overview: { window: 'all', payload } }),
    );
    expect(textOf(pub)).toContain('The public lane at a glance');
  });
});
