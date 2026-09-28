/**
 * Panel rendering (block: dashboard).
 *
 * Panels are pure functions from the read model to a node tree, so they are asserted here on the
 * tree and on the HTML it serialises to - no browser needed. The centrepiece is the availability
 * rendering of the Possibility space panel: ADR-13 keeps a write tool **listed** under a read-only
 * grant so the 403 step-up can fire, and the panel has to say "listed but not usable" rather than
 * quietly hiding it.
 *
 * `public/_dev/check-console.mjs` covers the same panels in a real browser.
 */
import { describe, expect, it } from 'vitest';
import { findNodes, hasClass, textOf, toHtml } from '../h.js';
import { renderSessions } from '../panel-sessions.js';
import { renderTimeline } from '../panel-timeline.js';
import { renderInspector } from '../panel-inspector.js';
import {
  checkListingSchemas,
  joinCatalog,
  renderPossibility,
  schemaCheckKey,
  schemaDigest,
  shownCatalog,
} from '../panel-possibility.js';
import { SCHEMA_CHECK_TEXT, paramTable, toolDescriptorCard } from '../ui.js';
import { createStore } from '../store.js';
import { renderSessionAuth } from '../panel-session-auth.js';
import { renderIntent } from '../panel-intent.js';
import { renderSqlData, scratchSchema } from '../panel-sql-data.js';
import { renderErrorsHealth } from '../panel-errors-health.js';
import { renderNowStrip } from '../panel-now-strip.js';
import { renderConnectScreen, renderStreamBanner, renderViewerChip } from '../panel-connect.js';
import { effectiveSessionXs, renderPersona } from '../panel-persona.js';
import { parseFilter } from '../filters.js';
import { createApi } from '../api.js';
import {
  catRawKey,
  catToolKey,
  catViewerId,
  collapseUnder,
  episodeKey,
  idFor,
  toggle,
} from '../open-state.js';
import { buildLinks } from '../chain.js';
import { FIXTURE_NOW, loadFixture, makeView, storeFromFixture } from './helpers.mjs';

/** Event 30 is inside the first session, before the step-up widened the grant. */
const BEFORE_STEPUP = 30;

function model(overrides = {}, maxId) {
  const store = storeFromFixture(maxId);
  const view = makeView(overrides);
  view.filter = parseFilter(view.filterRaw);
  return { store, view, now: FIXTURE_NOW };
}

describe('Possibility space: the availability table', () => {
  it('shows write tools as listed but not usable under a read-only grant (ADR-13)', () => {
    const context = model({ selectedXs: 'xs_3f1c9a' }, BEFORE_STEPUP);
    const tree = renderPossibility(context);
    const items = findNodes(tree, (node) => hasClass(node, 'tool-item'));
    expect(items).toHaveLength(17);

    const unavailable = items.filter((node) => hasClass(node, 'is-unavailable'));
    expect(unavailable).toHaveLength(2);
    // The panel exists to surface these, so they sort to the top.
    expect(items.slice(0, 2)).toEqual(unavailable);

    const names = unavailable.map((node) =>
      textOf(findNodes(node, (child) => hasClass(child, 'tool-name'))[0]),
    );
    expect(names.sort()).toEqual(['create_transfer', 'lock_or_unlock_card']);

    const transfer = unavailable.find((node) => textOf(node).includes('create_transfer'));
    expect(textOf(transfer)).toContain('listed');
    expect(textOf(transfer)).toContain('not usable');
    expect(textOf(transfer)).toContain('the grant is missing a scope');
    expect(textOf(transfer)).toContain('transfers:write');
    expect(textOf(transfer)).toContain('destructive');
  });

  it('counts the catalog the way the header tiles do', () => {
    const tree = renderPossibility(model({ selectedXs: 'xs_3f1c9a' }, BEFORE_STEPUP));
    const text = textOf(tree);
    expect(text).toContain('17tools listed');
    expect(text).toContain('15usable now');
    expect(text).toContain('2listed, not usable');
    expect(text).toContain('2 tool(s) are listed but cannot run yet');
    expect(text).toContain('feature flags: writes, transfers');
  });

  it('shows everything as usable once the step-up has widened the grant', () => {
    const tree = renderPossibility(model({ selectedXs: 'xs_3f1c9a' }));
    const items = findNodes(tree, (node) => hasClass(node, 'tool-item'));
    expect(items.filter((node) => hasClass(node, 'is-unavailable'))).toHaveLength(0);
    expect(textOf(tree)).toContain('0listed, not usable');
  });

  it('joins the tool metadata to its availability row', () => {
    const store = storeFromFixture(BEFORE_STEPUP);
    const rows = joinCatalog(store.getCatalog('xs_3f1c9a'));
    const card = rows.find((row) => row.tool === 'lock_or_unlock_card');
    expect(card.tool_meta.destructive).toBe(true);
    expect(card.tool_meta.read_only).toBe(false);
    expect(card.missing_scopes).toEqual(['cards:write']);
    expect(card.listed).toBe(true);
    expect(card.available).toBe(false);
  });

  it('explains itself when no catalog has arrived yet', () => {
    const tree = renderPossibility(model({ selectedXs: 'xs_3f1c9a' }, 5));
    expect(textOf(tree)).toContain('No catalog snapshot yet');
  });
});

describe('Possibility space: what the client was told for each tool', () => {
  const itemFor = (tree, name) =>
    findNodes(tree, (node) => hasClass(node, 'tool-item') && node.attrs['data-tool'] === name)[0];
  const paramFor = (tree, name) =>
    findNodes(tree, (node) => hasClass(node, 'param-row') && node.attrs['data-param'] === name)[0];
  const cell = (row, className) => textOf(findNodes(row, (node) => hasClass(node, className))[0]);
  /** The short verdict in a closed row, not the whole sentence of an open card. */
  const headBadge = (tree, name) =>
    findNodes(
      itemFor(tree, name),
      (node) => hasClass(node, 'schema-check') && !hasClass(node, 'schema-check-full'),
    )[0];

  it('names the listing the rows came from, and what its content_hash does not cover', () => {
    const tree = renderPossibility(model({ selectedXs: 'xs_7b4d10' }));
    const head = findNodes(tree, (node) => hasClass(node, 'listing-head'))[0];
    const text = textOf(head);
    expect(text).toContain('tools/list #178');
    expect(text).toContain('JSON-RPC id 1');
    expect(text).toContain('17 of 17 sent');
    expect(text).toContain(
      'content_hash sha256:1c9f4b6d2ae08357 (covers names, scopes and flags, not wording or schemas)',
    );
    // The clock is the viewer's own; the recorded ISO UTC timestamp is in the title.
    expect(findNodes(head, (node) => node.attrs?.title === '2026-09-08T14:07:04.500Z')).toHaveLength(1);
    // Seventeen closed lines, each one a control, and no card until one is opened.
    expect(findNodes(tree, (node) => hasClass(node, 'tool-item-toggle'))).toHaveLength(17);
    expect(findNodes(tree, (node) => hasClass(node, 'tool-card'))).toHaveLength(0);

    // The first session re-listed with only its content_hash: the rows are the ones recorded at
    // #21, and the page says so on its own rail instead of implying #88 carried them.
    const first = renderPossibility(model({ selectedXs: 'xs_3f1c9a' }));
    expect(textOf(findNodes(first, (node) => hasClass(node, 'listing-head'))[0])).toContain(
      'tools/list #21',
    );
    const resolved = findNodes(first, (node) => hasClass(node, 'listing-resolved'))[0];
    expect(hasClass(resolved, 'who-page')).toBe(true);
    expect(textOf(resolved)).toContain('carried only its content_hash');
    expect(textOf(resolved)).toContain('does not cover wording or schemas');

    // The rows outlive their event (the store keeps 6,000): a listing no longer retained is not a
    // listing without a JSON-RPC id, and the header does not say it was never recorded.
    const store = storeFromFixture();
    const evicted = { ...store, getEventById: () => null };
    const gone = renderPossibility({ store: evicted, view: makeView({ selectedXs: 'xs_7b4d10' }), now: FIXTURE_NOW });
    const goneText = textOf(findNodes(gone, (node) => hasClass(node, 'listing-head'))[0]);
    expect(goneText).toContain('tools/list #178');
    expect(goneText).toContain('the listing event is no longer retained on this page');
    expect(goneText).not.toContain('not recorded');
  });

  it('draws the re-list line only when the latest tools/list of the session carried no rows', () => {
    const lineOf = (tree) => findNodes(tree, (node) => hasClass(node, 'listing-resolved'));
    const headOf = (tree) => textOf(findNodes(tree, (node) => hasClass(node, 'listing-head'))[0]);

    // #179 and #183 are catalog.availability: the store's fold re-resolves on them and reads `hash`
    // against #178, the listing they follow. #178 carried its 17 rows, so the page draws no line,
    // neither for the session picked by hand nor for the one it shows by default.
    const store = storeFromFixture();
    expect(store.getCatalog('xs_7b4d10').resolved_from).toBe('hash');
    expect(shownCatalog(store, 'xs_7b4d10')).toMatchObject({ event_id: 178, resolved_from: 'event' });
    const picked = renderPossibility(model({ selectedXs: 'xs_7b4d10' }));
    expect(lineOf(picked)).toHaveLength(0);
    expect(headOf(picked)).toContain('tools/list #178');
    const byDefault = renderPossibility(model());
    expect(headOf(byDefault)).toContain('tools/list #178');
    expect(lineOf(byDefault)).toHaveLength(0);

    // The first session after #22 (availability) but before #73 (its first re-list): still #21 alone.
    const early = renderPossibility(model({ selectedXs: 'xs_3f1c9a' }, 22));
    expect(headOf(early)).toContain('tools/list #21');
    expect(lineOf(early)).toHaveLength(0);

    // #73 re-listed with only its content_hash: from then on the rows stand for #21 and the line says so.
    const relisted = renderPossibility(model({ selectedXs: 'xs_3f1c9a' }, 73));
    expect(headOf(relisted)).toContain('tools/list #21');
    expect(lineOf(relisted)).toHaveLength(1);
    expect(textOf(lineOf(relisted)[0])).toContain('recorded at tools/list #21 under the same hash');
  });

  it('counts what the named listing sent, and keeps its own listing when another session re-uses the hash', () => {
    const store = storeFromFixture();
    const listing = store.getEventById(178);
    const ts = '2026-09-08T14:07:59.000Z';
    // A later availability says one tool is no longer listed: the header is about #178, which sent 17.
    store.apply({
      id: 10001,
      ts,
      type: 'catalog.availability',
      xs: 'xs_7b4d10',
      request_id: 3,
      data: {
        content_hash: listing.data.content_hash,
        source: 'get_tool_availability',
        availability: listing.data.availability.map((row) =>
          row.tool === 'execute_query' ? { ...row, listed: false } : row,
        ),
      },
    });
    // A newer full listing of another session under the same hash, then one more availability event:
    // the fold now names #10002 for xs_7b4d10, but the rows it was sent are still #178's.
    store.apply({ ...listing, id: 10002, ts, xs: 'xs_other', request_id: 7 });
    store.apply({ ...store.getEventById(10001), id: 10003 });
    expect(store.getCatalog('xs_7b4d10').event_id).toBe(10002);

    const tree = renderPossibility({ store, view: makeView({ selectedXs: 'xs_7b4d10' }), now: FIXTURE_NOW });
    const head = textOf(findNodes(tree, (node) => hasClass(node, 'listing-head'))[0]);
    expect(head).toContain('tools/list #178');
    expect(head).toContain('JSON-RPC id 1');
    expect(head).toContain('17 of 17 sent');
    expect(findNodes(tree, (node) => hasClass(node, 'listing-resolved'))).toHaveLength(0);
    expect(textOf(tree)).toContain('16tools listed');
  });

  it('names no listing when only an availability table arrived for the session', () => {
    const store = createStore();
    store.apply({
      id: 1,
      ts: '2026-09-08T14:07:00.000Z',
      type: 'catalog.availability',
      xs: 'xs_only',
      request_id: 4,
      data: {
        content_hash: 'sha256:0000000000000000',
        source: 'get_tool_availability',
        availability: [
          { tool: 'load_accounts', listed: true, available: true, unavailable_reasons: [], missing_scopes: [] },
          { tool: 'create_transfer', listed: false, available: false, unavailable_reasons: ['disabled_for_deployment'], missing_scopes: [] },
        ],
      },
    });
    const tree = renderPossibility({ store, view: makeView({ selectedXs: 'xs_only' }), now: FIXTURE_NOW });
    const head = textOf(findNodes(tree, (node) => hasClass(node, 'listing-head'))[0]);
    expect(head).toContain('no tools/list rows are retained for this session');
    expect(head).toContain('1 of 2 listed, per catalog.availability');
    expect(head).not.toContain('tools/list #');
    expect(head).not.toContain('JSON-RPC id');
    expect(findNodes(tree, (node) => hasClass(node, 'listing-resolved'))).toHaveLength(0);
  });

  it('says how many calls gave no rationale, beside the sentence that asks for one (A-06)', () => {
    const context = model({ selectedXs: 'xs_3f1c9a' });
    toggle(context.view, catToolKey('xs_3f1c9a', 'load_accounts'), false);
    const tree = renderPossibility(context);
    const answer = findNodes(itemFor(tree, 'load_accounts'), (node) => hasClass(node, 'param-answer'))[0];
    // #65 sent no rationale and #66 recorded intent.missing: the one call is counted as such.
    expect(textOf(answer)).toBe(
      'answered by params.arguments.rationale on every tools/call · called 1 time in this session, 1 of them without a rationale (intent.missing, A-06)',
    );
  });

  it('gives two descriptor cards distinct viewer and table ids when the caller names none', () => {
    const tools = storeFromFixture().getCatalog('xs_7b4d10').tools;
    const cardFor = (name) =>
      toolDescriptorCard(tools.find((tool) => tool.name === name), {
        listingId: 178,
        rawKey: `raw-${name}`,
        rawOpen: true,
      });
    const idsOf = (card) => ({
      table: findNodes(card, (node) => hasClass(node, 'param-table-wrap'))[0].attrs.id,
      viewer: findNodes(card, (node) => node.attrs?.['data-json-id'])[0].attrs['data-json-id'],
    });
    const execute = idsOf(cardFor('execute_query'));
    const transfer = idsOf(cardFor('create_transfer'));
    expect(execute.table).toBe(`params-${execute.viewer}`);
    expect(execute.viewer).not.toBe(transfer.viewer);
    expect(execute.table).not.toBe(transfer.table);
  });

  it('opens execute_query into its description, its parameters and the rationale it asks for', () => {
    const context = model({ selectedXs: 'xs_3f1c9a' });
    const key = catToolKey('xs_3f1c9a', 'execute_query');
    toggle(context.view, key, false);
    const tree = renderPossibility(context);
    const cards = findNodes(tree, (node) => hasClass(node, 'tool-card'));
    expect(cards).toHaveLength(1);
    const card = cards[0];
    const recorded = context.store
      .getCatalog('xs_3f1c9a')
      .tools.find((tool) => tool.name === 'execute_query').descriptor;

    // Verbatim and whole: the 600-character description is never clipped.
    expect(textOf(findNodes(card, (node) => hasClass(node, 'tool-card-description'))[0])).toBe(
      recorded.description,
    );
    const rows = findNodes(card, (node) => hasClass(node, 'param-row'));
    expect(rows.map((row) => row.attrs['data-param'])).toEqual(['table_name', 'query', 'rationale']);
    expect(rows.map((row) => cell(row, 'param-required'))).toEqual(['yes', 'yes', 'yes']);
    expect(rows.map((row) => cell(row, 'param-type'))).toEqual(['string', 'string', 'string']);

    // The rationale row wears the model colour and carries Ramp's description verbatim (ADR-8).
    const rationale = rows[2];
    expect(hasClass(rationale, 'is-rationale')).toBe(true);
    expect(hasClass(rationale, 'who-model')).toBe(true);
    expect(cell(rationale, 'param-description')).toBe(recorded.inputSchema.properties.rationale.description);
    expect(cell(rationale, 'param-constraints')).toBe('1-1024 chars');
    const answer = findNodes(card, (node) => hasClass(node, 'param-answer'))[0];
    expect(hasClass(answer, 'who-page')).toBe(true);
    // Six calls: five ran and #28 was refused by the rate limiter, which is still a tools/call.
    expect(textOf(answer)).toBe(
      'answered by params.arguments.rationale on every tools/call · called 6 times in this session',
    );

    const text = textOf(card);
    expect(text).toContain('as sent with tools/list #21');
    expect(text).toContain('readOnlyHint true · idempotentHint false · openWorldHint false');
    expect(text).toContain('x-read-only true · x-destructive false');
    expect(text).toContain('x-required-scopes []');
    expect(text).toContain('x-kind database');
    expect(text).toContain('input_schema_hash 6f3b6e1aaa89f5ec');

    const control = findNodes(tree, (node) => node.attrs?.['data-open-key'] === key)[0];
    expect(control.attrs['aria-expanded']).toBe('true');
    expect(control.attrs.id).toBe(idFor(key));
    expect(hasClass(itemFor(tree, 'execute_query'), 'is-open')).toBe(true);
  });

  it('reads every schema shape the catalog publishes: oneOf, enums, defaults, arrays and bounds', () => {
    const catalog = storeFromFixture().getCatalog('xs_7b4d10');
    const schemaOf = (name) => catalog.tools.find((tool) => tool.name === name).descriptor.inputSchema;

    const transfer = paramTable(schemaOf('create_transfer'), { id: 'params-transfer' });
    expect(transfer.attrs.id).toBe('params-transfer');
    expect(
      findNodes(transfer, (node) => hasClass(node, 'param-row')).map((row) => row.attrs['data-param']),
    ).toEqual([
      'from_account_id',
      'to',
      'to.payee_id',
      'to.account_id',
      'amount',
      'currency',
      'memo',
      'confirm',
      'expected_total_amount',
      'rationale',
    ]);
    expect(textOf(paramFor(transfer, 'to'))).toContain('exactly one of the 2 alternatives below');
    expect(cell(paramFor(transfer, 'to.payee_id'), 'param-alt')).toBe('alternative 1 of 2 · no other keys');
    expect(cell(paramFor(transfer, 'to.account_id'), 'param-alt')).toBe('alternative 2 of 2 · no other keys');
    expect(cell(paramFor(transfer, 'to.account_id'), 'param-required')).toBe('yes');
    expect(hasClass(paramFor(transfer, 'to.account_id'), 'is-nested')).toBe(true);
    expect(cell(paramFor(transfer, 'amount'), 'param-type')).toBe('integer');
    expect(cell(paramFor(transfer, 'amount'), 'param-constraints')).toBe('at least 1');
    expect(cell(paramFor(transfer, 'currency'), 'param-constraints')).toBe('pattern ^[A-Z]{3}$');
    expect(cell(paramFor(transfer, 'memo'), 'param-constraints')).toBe('up to 140 chars');
    expect(cell(paramFor(transfer, 'confirm'), 'param-constraints')).toBe('default false');
    expect(cell(paramFor(transfer, 'confirm'), 'param-required')).toBe('no');

    const accounts = paramTable(schemaOf('load_accounts'));
    expect(cell(paramFor(accounts, 'account_type'), 'param-constraints')).toBe(
      'one of "checking", "savings", "credit_card", "" · default ""',
    );
    const processData = paramTable(schemaOf('process_data'));
    expect(cell(paramFor(processData, 'cols'), 'param-type')).toBe('array of string');
    expect(cell(paramFor(processData, 'cols'), 'param-constraints')).toContain(
      'each item: One advertised column name.',
    );
    const transactions = paramTable(schemaOf('load_transactions'));
    expect(cell(paramFor(transactions, 'category_ids'), 'param-constraints')).toContain('default []');

    expect(textOf(paramTable({ type: 'object', properties: {} }))).toBe(
      'This schema declares no parameters.',
    );
  });

  it('re-hashes each recorded schema in the browser, and says so when it cannot', async () => {
    const store = storeFromFixture();
    const subtle = globalThis.crypto.subtle;
    for (const id of [21, 178]) {
      const verdicts = await checkListingSchemas(store.getEventById(id).data.tools, subtle);
      expect(Object.keys(verdicts)).toHaveLength(17);
      expect([...new Set(Object.values(verdicts))]).toEqual(['verified']);
    }
    const tools = store.getEventById(21).data.tools;
    const execute = tools.find((tool) => tool.name === 'execute_query');
    expect(await schemaDigest(execute.descriptor.inputSchema, subtle)).toBe('6f3b6e1aaa89f5ec');

    // One character changed in the recorded schema no longer re-hashes to the digest beside it.
    const tampered = JSON.parse(JSON.stringify(execute));
    tampered.descriptor.inputSchema.properties.query.description += '!';
    expect(await checkListingSchemas([tampered], subtle)).toEqual({ execute_query: 'mismatch' });

    // No crypto.subtle (plain http on anything but localhost): every row unavailable, no exception.
    const without = await checkListingSchemas(tools, undefined);
    expect(Object.keys(without)).toHaveLength(17);
    expect([...new Set(Object.values(without))]).toEqual(['unavailable']);
    // A crypto.subtle that exists but refuses is not "no crypto.subtle": it gets its own sentence.
    const failing = { digest: () => Promise.reject(new Error('refused')) };
    expect(await checkListingSchemas([execute], failing)).toEqual({ execute_query: 'failed' });
    expect(SCHEMA_CHECK_TEXT.failed).toBe('not checked: this browser could not compute the digest');

    // A row recorded before contracts v0.5 has nothing to re-hash.
    const legacy = { ...execute };
    delete legacy.descriptor;
    expect(await checkListingSchemas([legacy], subtle)).toEqual({});
    expect(schemaCheckKey(21, 'execute_query')).toBe('21/execute_query');
  });

  it('draws each verdict quietly, a mismatch loudly, and never reuses another listing’s verdict', () => {
    const context = model({
      selectedXs: 'xs_7b4d10',
      schemaChecks: {
        [schemaCheckKey(178, 'execute_query')]: 'verified',
        [schemaCheckKey(178, 'process_data')]: 'mismatch',
        [schemaCheckKey(178, 'load_cards')]: 'unavailable',
        // A verdict about listing #21 says nothing about the rows of #178.
        [schemaCheckKey(21, 'clear_table')]: 'verified',
      },
    });
    toggle(context.view, catToolKey('xs_7b4d10', 'execute_query'), false);
    const tree = renderPossibility(context);

    const verified = headBadge(tree, 'execute_query');
    expect(verified.attrs['data-check']).toBe('verified');
    expect(hasClass(verified, 'tag-quiet')).toBe(true);
    expect(verified.attrs.title).toBe(
      'recorded schema is intact: re-hashes to the digest recorded beside it, computed in this browser',
    );
    const mismatch = headBadge(tree, 'process_data');
    expect(mismatch.attrs['data-check']).toBe('mismatch');
    expect(hasClass(mismatch, 'badge-error')).toBe(true);
    expect(mismatch.attrs.title).toBe(
      'recorded schema does not re-hash to the digest recorded beside it (computed in this browser)',
    );
    expect(headBadge(tree, 'load_cards').attrs.title).toBe(
      'not checked: this browser has no crypto.subtle (it needs https or localhost)',
    );
    const pending = headBadge(tree, 'clear_table');
    expect(pending.attrs['data-check']).toBe('pending');
    expect(pending.attrs.title).toBe('checking the recorded schema');

    // The open card prints the whole sentence, and nothing in it speaks of wire receipt.
    const full = findNodes(tree, (node) => hasClass(node, 'schema-check-full'));
    expect(full.map(textOf)).toEqual([SCHEMA_CHECK_TEXT.verified]);
    for (const sentence of Object.values(SCHEMA_CHECK_TEXT)) {
      expect(sentence).not.toMatch(/receiv|wire|description/);
    }
  });

  it('degrades to one sentence on a listing recorded before contracts v0.5, and keeps ADR-13 loud', () => {
    const store = createStore();
    for (const event of loadFixture()) {
      if (event.id > BEFORE_STEPUP) break;
      if (event.type === 'catalog.tools_listed' && Array.isArray(event.data.tools)) {
        const tools = event.data.tools.map((tool) => {
          const row = { ...tool };
          delete row.descriptor;
          return row;
        });
        store.apply({ ...event, data: { ...event.data, tools } });
      } else {
        store.apply(event);
      }
    }
    const view = makeView({ selectedXs: 'xs_3f1c9a' });
    toggle(view, catToolKey('xs_3f1c9a', 'execute_query'), false);
    const tree = renderPossibility({ store, view, now: FIXTURE_NOW });
    const card = findNodes(tree, (node) => hasClass(node, 'tool-card'))[0];
    expect(textOf(findNodes(card, (node) => hasClass(node, 'tool-card-degrade'))[0])).toBe(
      'This listing recorded name, title, flags, scopes and a schema digest only (contracts v0.4). The description and schema the client received were not captured.',
    );
    expect(findNodes(card, (node) => hasClass(node, 'param-table'))).toHaveLength(0);
    // No schema, nothing to check: no verdict is drawn at all rather than a pending one forever.
    expect(findNodes(tree, (node) => hasClass(node, 'schema-check'))).toHaveLength(0);

    // Only the two listed-but-unusable write tools carry a loud badge; every other row is quiet.
    const items = findNodes(tree, (node) => hasClass(node, 'tool-item'));
    const loud = items.filter((item) => findNodes(item, (node) => hasClass(node, 'badge')).length > 0);
    expect(loud.map((item) => item.attrs['data-tool']).sort()).toEqual([
      'create_transfer',
      'lock_or_unlock_card',
    ]);
    expect(loud.every((item) => hasClass(item, 'is-unavailable'))).toBe(true);
  });

  it('opens the raw descriptor in a viewer with a stable id, and forgets it when the row closes', () => {
    const context = model({ selectedXs: 'xs_7b4d10' });
    context.view.json = {};
    const key = catToolKey('xs_7b4d10', 'create_transfer');
    toggle(context.view, key, false);
    toggle(context.view, catRawKey(key), false);
    const id = catViewerId('xs_7b4d10', 'create_transfer');
    context.view.json = { [`${id}!all-open`]: 'open' };
    const tree = renderPossibility(context);
    const viewer = findNodes(tree, (node) => node.attrs?.['data-json-id'] === id);
    expect(viewer).toHaveLength(1);
    expect(textOf(viewer[0])).toContain('descriptor of create_transfer as recorded on tools/list #178');
    // The table wrapper can scroll sideways at phone width, so it carries an id (mount.js).
    const wrap = findNodes(tree, (node) => hasClass(node, 'param-table-wrap'))[0];
    expect(wrap.attrs.id).toBe(`params-${id}`);
    // Opening a tool card is not a reason to stop the timeline following its tail.
    expect(context.view.follow).toBe(true);

    toggle(context.view, key, true);
    expect(context.view.open[catRawKey(key)]).toBeUndefined();
    expect(context.view.json).toEqual({});
    expect(findNodes(renderPossibility(context), (node) => hasClass(node, 'tool-card'))).toHaveLength(0);
  });
});

describe('Live timeline', () => {
  it('draws one row per event, with server restarts as markers rather than rows', () => {
    const tree = renderTimeline(model());
    const rows = findNodes(tree, (node) => hasClass(node, 'row'));
    const markers = findNodes(tree, (node) => hasClass(node, 'boot-divider'));
    expect(rows).toHaveLength(197);
    expect(markers).toHaveLength(3);
    expect(textOf(markers[0])).toContain('boot_9f2a1c40');
  });

  it('does not call a finished call "in flight"', () => {
    const tree = renderTimeline(model());
    const started = findNodes(tree, (node) => textOf(node).startsWith('Call started')).length;
    expect(started).toBeGreaterThan(0);
    expect(textOf(tree)).not.toContain('In flight');
  });

  it('marks a call still in flight', () => {
    const context = model();
    context.store.apply({
      id: 6000,
      ts: '2026-09-08T14:09:00.000Z',
      v: 1,
      xs: 'xs_7b4d10',
      login_id: 'lgn_5d2c7a',
      grant_id: 'grt_8a1e33',
      persona_id: 'per_a1b2',
      seq: 200,
      request_id: '200',
      era: 'legacy',
      client: null,
      protocol_version: '2025-11-25',
      trace_id: null,
      type: 'tool.call.started',
      data: {
        tool: 'load_statement_lines',
        arguments: {},
        redacted_fields: [],
        rationale: 'Build the combined statement.',
        rationale_present: true,
        rationale_truncated: false,
        meta: null,
        required_scopes: [],
        budget_ms: 300_000,
      },
    });
    expect(textOf(renderTimeline(context))).toContain('In flight');
  });

  it('filters by tool, type, family and status', () => {
    const count = (raw) => {
      const context = model({ filterRaw: raw });
      context.view.filter = parseFilter(raw);
      return findNodes(renderTimeline(context), (node) => hasClass(node, 'row')).length;
    };
    expect(count('tool:execute_query')).toBe(19);
    expect(count('type:tool.call.completed')).toBe(24);
    expect(count('kind:sql')).toBe(9);
    expect(count('status:error')).toBe(12);
    expect(count('status:error kind:sql')).toBe(2);
    expect(count('-kind:http')).toBe(140);
  });

  it('says so when a filter matches nothing', () => {
    const context = model({ filterRaw: 'tool:no_such_tool' });
    context.view.filter = parseFilter('tool:no_such_tool');
    expect(textOf(renderTimeline(context))).toContain('No event matches this filter');
  });

  it('freezes at the paused cursor and counts what arrived since', () => {
    const context = model({ paused: true, frozenEventId: 50, pendingCount: 7 });
    const text = textOf(renderTimeline(context));
    const rows = findNodes(renderTimeline(context), (node) => hasClass(node, 'row'));
    expect(rows.length).toBeLessThan(50);
    expect(text).toContain('Paused');
    expect(text).toContain('7 new events while paused');
    expect(text).toContain('Jump to live');
  });

  it('renders an unknown event type instead of breaking', () => {
    const context = model();
    context.store.apply({
      id: 7000,
      ts: '2026-09-08T14:09:30.000Z',
      v: 1,
      xs: 'xs_7b4d10',
      login_id: null,
      grant_id: null,
      persona_id: null,
      seq: null,
      request_id: null,
      era: null,
      client: null,
      protocol_version: null,
      trace_id: null,
      type: 'ledger.posting.created',
      data: { amount_cents: 4200 },
    });
    const tree = renderTimeline(context);
    const unknown = findNodes(tree, (node) => hasClass(node, 'row-unknown'));
    expect(unknown).toHaveLength(1);
    expect(textOf(unknown[0])).toContain('unknown type');
    expect(textOf(unknown[0])).toContain('ledger.posting.created');
  });
});

describe('Live timeline, chain mode', () => {
  const chainModel = (overrides = {}, maxId) => model({ timelineMode: 'chain', ...overrides }, maxId);
  const episodesOf = (tree) => findNodes(tree, (node) => hasClass(node, 'episode'));
  const rowsOf = (node) => findNodes(node, (child) => hasClass(child, 'call-row'));
  const panesOf = (node) => findNodes(node, (child) => hasClass(child, 'call-open'));
  const connectorsOf = (node) => findNodes(node, (child) => hasClass(child, 'chain-link'));
  const threadsOfTree = (node) => findNodes(node, (child) => hasClass(child, 'chain-thread'));
  const rowFor = (node, callKey) =>
    rowsOf(node).find((child) => child.attrs['data-call-key'] === callKey);
  const headFor = (node, key) =>
    findNodes(node, (child) => hasClass(child, 'call-head')).find(
      (child) => child.attrs['data-arg'] === key,
    );
  const titlesOf = (node) =>
    findNodes(node, (child) => hasClass(child, 'wire-title')).map(textOf);

  it('draws one line per call and opens nothing until it is asked to', () => {
    const tree = renderTimeline(chainModel());
    const episodes = episodesOf(tree);
    expect(episodes.length).toBeGreaterThan(3);
    // 24 `tool.call.started` plus the two calls the gate denied before they started.
    expect(rowsOf(tree)).toHaveLength(26);
    // The page must arrive readable, not saturated: no pane is drawn before a click.
    expect(panesOf(tree)).toHaveLength(0);
    expect(findNodes(tree, (node) => hasClass(node, 'row'))).toHaveLength(0);
    // C1: one block per session, and the episodes are numbered inside their own session.
    const sessions = findNodes(tree, (node) => hasClass(node, 'session-block'));
    expect(sessions.map((node) => node.attrs['data-xs'])).toEqual(['xs_3f1c9a', 'xs_7b4d10']);
    for (const session of sessions) {
      const inSession = episodesOf(session);
      const ordinals = inSession.map((node) =>
        textOf(findNodes(node, (child) => hasClass(child, 'episode-ordinal'))[0]),
      );
      expect(ordinals).toEqual(inSession.map((_, index) => `Episode ${index + 1}`));
    }
    expect(sessions.reduce((sum, node) => sum + episodesOf(node).length, 0)).toBe(episodes.length);

    const tools = rowsOf(tree).map((node) =>
      textOf(findNodes(node, (child) => hasClass(child, 'call-tool'))[0]),
    );
    expect(tools.slice(0, 4)).toEqual([
      'get_current_user',
      'load_transactions',
      'process_data',
      'execute_query',
    ]);
  });

  it('prints the model’s arguments and the server’s bytes on the row, and no caption of its own', () => {
    const tree = renderTimeline(chainModel());
    const row = rowFor(tree, 'xs_7b4d10#5');
    const text = textOf(row);

    // Left: what the model wrote, as recorded.
    expect(text).toContain('load_cards_51e8a3b6');
    expect(text).toContain('SELECT "last4", "status", "spending_limit_cents"');
    // Right: what the server sent, as recorded, and how much of it was kept.
    expect(text).toContain('[{"last4":"8842","status":"active","spending_limit_cents":250000}');
    expect(text).toContain('397 chars');
    // The page's own reading of the result - "6 rows" - belongs to the connector, on the dashed
    // page rail. Printing it in the server's colour was the whole defect this row replaces.
    expect(text).not.toContain('6 rows');
    // It is still recorded and still one click away, on the card of the step that produced it.
    const inside = renderTimeline(
      chainModel({ open: { 'call:xs_7b4d10#5': 'open', 'call:xs_7b4d10#5/inside': 'open' } }),
    );
    expect(textOf(findNodes(inside, (node) => hasClass(node, 'inside-cards'))[0])).toContain(
      'rows back',
    );

    // The rationale is a chip carrying the sentence, not a second copy of it on the line.
    const chip = findNodes(row, (node) => hasClass(node, 'digest-chip'))[0];
    expect(textOf(chip)).toBe('+rationale');
    expect(chip.attrs.title).toBe('Show every card with its status after the restart.');
    expect(text).not.toContain('Show every card with its status');

    // Both sides are attributed, and the arrow separates them.
    const inActors = findNodes(
      findNodes(row, (node) => hasClass(node, 'call-in'))[0],
      (node) => hasClass(node, 'digest-part'),
    ).map((node) => node.attrs['data-actor']);
    const outActors = findNodes(
      findNodes(row, (node) => hasClass(node, 'call-out'))[0],
      (node) => hasClass(node, 'digest-part'),
    ).map((node) => node.attrs['data-actor']);
    expect(new Set(inActors)).toEqual(new Set(['model']));
    expect(new Set(outActors)).toEqual(new Set(['server']));
    expect(findNodes(row, (node) => hasClass(node, 'call-arrow'))).toHaveLength(1);
  });

  it('makes the JSON-RPC id the only number a row is counted by', () => {
    const tree = renderTimeline(chainModel());
    const row = rowFor(tree, 'xs_7b4d10#5');
    // The per-episode step ordinal is gone: two numbering schemes for one call is one too many.
    expect(findNodes(row, (node) => hasClass(node, 'chain-step-n'))).toHaveLength(0);
    expect(findNodes(row, (node) => hasClass(node, 'call-id')).map(textOf)).toEqual(['#5']);
    // And nothing anywhere claims to be step N of its group: the ordinal is gone from the rows
    // and from the connectors that used to name it.
    expect(textOf(tree)).not.toContain('from step');
    expect(findNodes(tree, (node) => hasClass(node, 'call-id')).map(textOf)).toHaveLength(26);
  });

  it('says "8,417 sent · 2,048 kept" when the recording holds less than was sent', () => {
    const tree = renderTimeline(chainModel());
    const text = textOf(rowFor(tree, 'xs_3f1c9a#9'));
    expect(text).toContain(
      '[{"date":"2026-08-01","merchant_name":"Harbor Point Grocery","amount_cents":-84900}',
    );
    expect(text).toContain('8,417 sent · 2,048 kept');
    // `8,417 chars` would claim the recording is complete when 6,369 characters were never kept.
    expect(text).not.toContain('8,417 chars');
    // A whole preview says so in one number.
    expect(textOf(rowFor(tree, 'xs_7b4d10#4'))).toContain('33 chars');
  });

  it('opens one call into REQUEST, INSIDE and RESPONSE, in that order', () => {
    const tree = renderTimeline(chainModel({ open: { 'call:xs_7b4d10#5': 'open' } }));
    const panes = panesOf(tree);
    expect(panes).toHaveLength(1);
    expect(titlesOf(panes[0])).toEqual([
      'REQUEST · tools/call · id 5 · as it arrived',
      'INSIDE · this server and our engine',
      'RESPONSE · result of id 5 · as it left',
    ]);

    // Every pane says what it was rebuilt from; a pane without its footer is a claim with no
    // provenance, which is the one thing this layout exists to prevent.
    const footers = findNodes(panes[0], (node) => hasClass(node, 'wire-footer')).map(textOf);
    expect(footers).toHaveLength(2);
    expect(footers[0]).toContain('rebuilt by this page from tool.call.started #197');
    expect(footers[0]).toContain('the bytes on the wire were not kept');
    expect(footers[1]).toContain('rebuilt by this page from tool.call.completed #200');

    const request = findNodes(panes[0], (node) => hasClass(node, 'wire-request'))[0];
    const paths = findNodes(request, (node) => node.attrs['data-path']).map(
      (node) => node.attrs['data-path'],
    );
    expect(paths).toEqual([
      'id',
      'method',
      'params.name',
      'params.arguments.table_name',
      'params.arguments.query',
      'params.arguments.rationale',
    ]);
    // `method` is not a recorded field, so it wears the dashed page rail and nothing else.
    const method = findNodes(request, (node) => node.attrs['data-path'] === 'method')[0];
    expect(method.attrs['data-actor']).toBe('page');
    expect(hasClass(method, 'is-implied')).toBe(true);
    // Nothing the server did on receipt is in the request pane; it is all in the interior.
    expect(textOf(request)).not.toContain('checked it and wrote it down');
    // The argument a chain link fed carries its port, and nothing else does.
    const ports = findNodes(request, (node) => hasClass(node, 'wire-port'));
    expect(ports.map(textOf)).toEqual(['from #4 · table']);

    const response = findNodes(panes[0], (node) => hasClass(node, 'wire-response'))[0];
    const text = textOf(response);
    expect(text).toContain('content · text (1 block, joined)');
    expect(text).toContain('397 chars');
    expect(text).toContain('this recording kept all of it');
    // The HTTP request that carried the call, found by its JSON-RPC id (contracts v0.5).
    expect(text).toContain('one HTTP request the client app opened (http.request #196)');
    expect(text).toContain('7 ms of the 300 s allowed');
    // Never a percentage for a share under 5%: 7 ms of 300 s is noise on any bar.
    expect(findNodes(response, (node) => hasClass(node, 'wire-ratios'))).toHaveLength(0);
  });

  it('draws the rationale once, where it arrived, with its locator and the gate’s record', () => {
    const tree = renderTimeline(chainModel({ open: { 'call:xs_7b4d10#5': 'open' } }));
    const pane = panesOf(tree)[0];
    const rows = findNodes(
      pane,
      (node) => node.attrs['data-path'] === 'params.arguments.rationale',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].attrs['data-actor']).toBe('model');
    expect(hasClass(rows[0], 'is-emphasis')).toBe(true);
    expect(textOf(rows[0])).toContain('Show every card with its status after the restart.');

    const block = findNodes(pane, (node) => hasClass(node, 'wire-rationale'))[0];
    const locator = findNodes(block, (node) => hasClass(node, 'wire-locator'))[0];
    const gate = findNodes(block, (node) => hasClass(node, 'wire-gate-note'))[0];
    // The requirement is this page's claim about the schema; what happened to it is the server's.
    expect(locator.attrs['data-actor']).toBe('page');
    expect(textOf(locator)).toContain('required by the schema sent at tools/list #178');
    expect(gate.attrs['data-actor']).toBe('server');
    expect(textOf(gate)).toContain('recorded as intent.declared #198');
    expect(textOf(gate)).toContain('then removed before execute_query received the arguments');
    // The sentence itself is printed once and is not repeated by either note.
    expect(textOf(gate)).not.toContain('Show every card with its status');
    expect(textOf(locator)).not.toContain('Show every card with its status');
    expect(
      textOf(pane).split('Show every card with its status after the restart.'),
    ).toHaveLength(2);
  });

  it('numbers the interior and keeps the server’s own work out of the request', () => {
    const tree = renderTimeline(
      chainModel({
        open: { 'call:xs_7b4d10#5': 'open', 'call:xs_7b4d10#5/inside': 'open' },
      }),
    );
    const pane = panesOf(tree)[0];
    expect(textOf(findNodes(pane, (node) => hasClass(node, 'inside-summary'))[0])).toBe(
      '2 steps inside · this server → our engine',
    );
    const cards = findNodes(pane, (node) => hasClass(node, 'card'));
    expect(cards.map((node) => node.attrs['data-actor'])).toEqual(['server', 'engine']);
    expect(
      cards.map((node) => textOf(findNodes(node, (child) => hasClass(child, 'card-source'))[0])),
    ).toEqual(['tool.call.started #197', 'sql.query #199']);
    // The SQL is the model's words on a step our engine ran: two rails on one card.
    const sql = findNodes(cards[1], (node) => hasClass(node, 'card-line')).find((node) =>
      textOf(node).includes('SELECT'),
    );
    expect(sql.attrs['data-actor']).toBe('model');
    expect(textOf(cards[1])).toContain('rows back');
    // The "handed to" line is a mechanism, not an observation, so it sits on the page rail.
    const handed = findNodes(cards[0], (node) => hasClass(node, 'card-line')).find((node) =>
      textOf(node).includes('were not recorded'),
    );
    expect(handed.attrs['data-actor']).toBe('page');
  });

  it('invents no arguments for a denied call and puts the sentence on the server rail', () => {
    const tree = renderTimeline(chainModel({ open: { 'call:xs_3f1c9a#14': 'open' } }));
    const row = rowFor(tree, 'xs_3f1c9a#14');
    const text = textOf(row);
    expect(text).toContain('create_transfer');
    expect(text).toContain('✗');
    expect(text).toContain('denied');
    expect(text).toContain('the bearer gate answered before the body was read');
    // No model wrote that sentence, so it may never wear the model rail.
    const parts = findNodes(
      findNodes(row, (node) => hasClass(node, 'call-in'))[0],
      (node) => hasClass(node, 'digest-part'),
    );
    expect(parts.map((node) => node.attrs['data-actor'])).toEqual(['server']);
    expect(text).not.toContain('The client sent no arguments');

    const pane = panesOf(tree)[0];
    expect(textOf(pane)).toContain('insufficient_scope');
    expect(textOf(pane)).toContain('transfers:write');
    expect(textOf(pane)).toContain('rebuilt by this page from tool.call.denied #77');
    // The step-up the denial caused is interior work, not part of the request.
    expect(textOf(findNodes(pane, (node) => hasClass(node, 'inside'))[0])).toContain('1 step inside');
  });

  it('keeps two calls open at once and closes one with the control that opened it', () => {
    const context = chainModel();
    toggle(context.view, 'call:xs_3f1c9a#5', false);
    toggle(context.view, 'call:xs_3f1c9a#8', false);
    const opened = renderTimeline(context);
    expect(panesOf(opened)).toHaveLength(2);
    expect(rowsOf(opened)).toHaveLength(26);
    const head = headFor(opened, 'call:xs_3f1c9a#5');
    expect(head.attrs['data-action']).toBe('toggle-open');
    expect(head.attrs['aria-expanded']).toBe('true');
    // The click carries the state the panel drew, so it always undoes what the reader can see.
    expect(head.attrs['data-arg2']).toBe('1');
    expect(head.attrs.id).toBe('tg-call-xs_3f1c9a-5');
    expect(head.attrs['data-open-key']).toBe('call:xs_3f1c9a#5');

    toggle(context.view, 'call:xs_3f1c9a#5', true);
    const closed = renderTimeline(context);
    expect(panesOf(closed)).toHaveLength(1);
    expect(headFor(closed, 'call:xs_3f1c9a#5').attrs['aria-expanded']).toBe('false');
    expect(headFor(closed, 'call:xs_3f1c9a#5').attrs['data-arg2']).toBe('0');

    // Selection is the inspector's subject and expands nothing.
    const selected = renderTimeline(chainModel({ selectedCallKey: 'xs_3f1c9a#5' }));
    expect(panesOf(selected)).toHaveLength(0);
    const bytes = findNodes(selected, (node) => hasClass(node, 'call-bytes'))[0];
    expect(bytes.attrs['data-action']).toBe('select-call');
  });

  it('opens every call at depth open and every interior at depth inside', () => {
    const calls = renderTimeline(chainModel());
    expect(panesOf(calls)).toHaveLength(0);

    const open = renderTimeline(chainModel({ depth: 'open' }));
    expect(panesOf(open)).toHaveLength(26);
    expect(findNodes(open, (node) => hasClass(node, 'inside-cards'))).toHaveLength(0);

    const inside = renderTimeline(chainModel({ depth: 'inside' }));
    expect(panesOf(inside)).toHaveLength(26);
    // Every call whose interior recorded a step draws its cards; the two the gate refused do not.
    expect(findNodes(inside, (node) => hasClass(node, 'inside-cards')).length).toBeGreaterThan(20);

    // Overview folds the groups themselves away: the macro line of the whole session.
    const overview = renderTimeline(chainModel({ depth: 'overview' }));
    expect(rowsOf(overview)).toHaveLength(0);
    expect(episodesOf(overview).length).toBeGreaterThan(3);
  });

  it('collapses one episode back to one line per call, and only that episode', () => {
    const context = chainModel({ depth: 'open' });
    const tree = renderTimeline(context);
    const episode = episodesOf(tree)[1];
    const control = findNodes(episode, (node) => node.attrs['data-action'] === 'collapse-all')[0];
    const inEpisode = panesOf(episode).length;
    const total = panesOf(tree).length;
    expect(inEpisode).toBeGreaterThan(1);
    // Keyed on the first call of the group, never on its ordinal, and it names its own calls.
    expect(control.attrs['data-arg']).toBe(episodeKey(control.attrs['data-arg2'].split(' ')[0]));
    expect(control.attrs['data-arg2'].split(' ')).toHaveLength(inEpisode);

    collapseUnder(context.view, control.attrs['data-arg'], control.attrs['data-arg2'].split(' '));
    const after = renderTimeline(context);
    expect(panesOf(episodesOf(after)[1])).toHaveLength(0);
    // Back to one line each, and every one of them still drawn.
    expect(rowsOf(episodesOf(after)[1])).toHaveLength(inEpisode);
    expect(panesOf(after)).toHaveLength(total - inEpisode);
  });

  it('names the inferred workflow in the header and says whose grouping this is', () => {
    const tree = renderTimeline(chainModel());
    const header = findNodes(tree, (node) => hasClass(node, 'episode-head')).find((node) =>
      textOf(node).includes('spend analysis'),
    );
    const text = textOf(header);
    expect(text).toContain('spend analysis');
    // Never a percentage: the number is a score margin (`src/tools/intent.ts`), and printing it
    // as one claimed an accuracy the classifier does not have.
    expect(text).toContain('scored 0.85');
    expect(text).not.toContain('%');
    expect(text).toContain('inferred by this server, not by the model');
    // The one claim that is always on screen, whatever else is folded away.
    expect(text).toContain(
      'Grouped by this dashboard, not by the server, which never sees the conversation',
    );
    expect(text).not.toContain('the user asked');
    // The rule that produced this particular group is one click away.
    expect(text).not.toContain('shares no data with');
    const why = findNodes(header, (node) => hasClass(node, 'episode-why'))[0];
    expect(why.attrs['data-action']).toBe('toggle-open');
    expect(textOf(why)).toContain('why');

    const opened = renderTimeline(chainModel({ open: { [why.attrs['data-arg']]: 'open' } }));
    const body = findNodes(opened, (node) => hasClass(node, 'episode-why-body'));
    expect(body).toHaveLength(1);
    expect(textOf(body[0])).toContain('Grouped by this dashboard, not by the server');
    expect(textOf(body[0])).toContain('the server never sees the conversation');
  });

  it('quotes the first rationale of the group as the model’s own words', () => {
    const tree = renderTimeline(chainModel());
    const quote = findNodes(tree, (node) => hasClass(node, 'episode-rationale'))[0];
    expect(textOf(quote)).toContain('Confirm which demo customer this connection belongs to');
    expect(textOf(quote)).toContain("the model's words for the first call in this group");
    // A group whose first calls carried no rationale says that rather than inventing one.
    expect(textOf(tree)).toContain('carried no rationale');
  });

  it('puts a connector naming the table between two linked calls, and none before the first', () => {
    const tree = renderTimeline(chainModel());
    const etl = threadsOfTree(tree).find((node) =>
      textOf(node).includes('load_transactions_9a41c7e2'),
    );
    const tools = rowsOf(etl).map((node) =>
      textOf(findNodes(node, (child) => hasClass(child, 'call-tool'))[0]),
    );
    expect(tools).toEqual([
      'load_transactions',
      'process_data',
      'execute_query',
      'execute_query',
      'execute_query',
      'clear_table',
    ]);
    const connectors = connectorsOf(etl);
    // One fewer connector than calls: the first call of the thread started something new.
    expect(connectors).toHaveLength(tools.length - 1);
    for (const connector of connectors) {
      expect(textOf(connector)).toContain('passes');
      expect(textOf(connector)).toContain('table load_transactions_9a41c7e2');
    }
    // The children of a thread are the calls and the connectors, and the first child is a call.
    const inner = findNodes(etl, (node) => hasClass(node, 'chain-thread-steps'))[0];
    expect(hasClass(inner.children[0], 'call')).toBe(true);

    // A link reaching back across a group says which group, by the JSON-RPC id of its source.
    const sources = findNodes(tree, (node) => hasClass(node, 'chain-link-source')).map(textOf);
    expect(sources).toEqual(['from episode 2', 'from episode 1']);
    const back = connectorsOf(tree).find((node) => textOf(node).includes('from episode 1'));
    const link = findNodes(back, (node) => hasClass(node, 'chain-link-label'))[0];
    expect(link.attrs.title).toContain('load_transactions_9a41c7e2');
  });

  it('carries the source JSON-RPC id on every link, which is what a connector names', () => {
    const store = storeFromFixture();
    const events = store.getEvents({});
    const links = buildLinks(store.getCalls({}), events);
    const byKey = new Map(store.getCalls({}).map((call) => [call.key, call]));
    expect(links.length).toBeGreaterThan(8);
    for (const link of links) {
      expect(link.from_request_id).toBe(byKey.get(link.from).request_id);
    }
  });

  it('shows the transfer preview handing its total to the confirm', () => {
    const tree = renderTimeline(chainModel());
    const connector = connectorsOf(tree).find((node) => textOf(node).includes('preview'));
    expect(textOf(connector)).toContain('preview $1,284.00');
    const label = findNodes(connector, (node) => hasClass(node, 'chain-link-preview'))[0];
    expect(label.attrs.title).toContain('expected_total_amount');
    expect(label.attrs.title).toContain('prv_7c31');
  });

  it('names five parties in the legend and lets one be read on its own', () => {
    const tree = renderTimeline(chainModel());
    const chips = findNodes(tree, (node) => hasClass(node, 'actor-chip'));
    expect(chips.map(textOf)).toEqual([
      'client app',
      'model',
      'this server',
      'our engine',
      'this page',
    ]);

    const focused = renderTimeline(chainModel({ actorFocus: 'model', depth: 'open' }));
    const marks = findNodes(focused, (node) => node.attrs['data-actor'] !== null && node.attrs['data-actor'] !== undefined);
    const dimmed = marks.filter((node) => hasClass(node, 'is-dimmed'));
    // A lens, not a filter: everything is still on the page, only pushed back.
    expect(dimmed.length).toBeGreaterThan(0);
    expect(dimmed.length).toBeLessThan(marks.length);
    expect(dimmed.every((node) => node.attrs['data-actor'] !== 'model')).toBe(true);
  });

  it('shows the SQL a query ran and the error a rejected one produced, once opened', () => {
    const tree = renderTimeline(
      chainModel({
        open: { 'call:xs_3f1c9a#8': 'open', 'call:xs_3f1c9a#8/inside': 'open' },
      }),
    );
    const pane = panesOf(tree)[0];
    const text = textOf(pane);
    expect(text).toContain('ATTACH DATABASE');
    expect(text).toContain('rejected');
    // The tool's own error text, verbatim, on the server rail.
    const error = findNodes(pane, (node) => hasClass(node, 'wire-error'))[0];
    expect(error.attrs['data-actor']).toBe('server');
    expect(textOf(error).length).toBeGreaterThan(10);
  });

  it('keeps the context rows between the episodes and never inside one', () => {
    const closed = renderTimeline(chainModel());
    // C1: what happened before the first call is one line at the head of its session.
    const connection = findNodes(closed, (node) => hasClass(node, 'session-connection'))[0];
    expect(textOf(connection)).toContain('consent → token');
    expect(textOf(connection)).toContain('initialize 2025-11-25 → tools/list · 17 tools');
    expect(findNodes(connection, (node) => hasClass(node, 'flow-context'))).toHaveLength(0);

    const tree = renderTimeline(chainModel({ open: { 'conn:xs_3f1c9a': 'open' } }));
    const opened = findNodes(tree, (node) => hasClass(node, 'session-connection'))[0];
    const steps = findNodes(opened, (node) => hasClass(node, 'flow-context')).map((node) =>
      textOf(findNodes(node, (child) => hasClass(child, 'flow-context-label'))[0]),
    );
    expect(steps.filter((label) => ['Grant created', 'Access token issued', 'Session started', 'initialize', 'tools/list'].includes(label))).toEqual([
      'Grant created',
      'Access token issued',
      'Session started',
      'initialize',
      'tools/list',
    ]);
    const context = findNodes(tree, (node) => hasClass(node, 'flow-context'));
    const labels = context.map((node) =>
      textOf(findNodes(node, (child) => hasClass(child, 'flow-context-label'))[0]),
    );
    expect(labels).toContain('Grant extended');
    expect(labels).toContain('JSON-RPC error');
    expect(labels).toContain('Events dropped');
    expect(labels).toContain('Session ended');
    expect(findNodes(tree, (node) => hasClass(node, 'boot-divider'))).toHaveLength(3);
    // No context row was drawn inside an episode card.
    for (const episode of episodesOf(tree)) {
      expect(findNodes(episode, (node) => hasClass(node, 'flow-context'))).toHaveLength(0);
    }
    const text = textOf(tree);
    expect(text).not.toContain('HTTP request');
    expect(text).not.toContain('Viewer connected');
    expect(text).not.toContain('Pairing code issued');
    expect(labels).not.toContain('Step-up requested');
  });

  it('shows an erase as a context row, because history that vanishes silently is worse', () => {
    const context = chainModel();
    const deleted = {
      id: 201,
      ts: '2026-09-08T14:08:10.000Z',
      type: 'xray.events.deleted',
      v: 1,
      xs: 'xs_7b4d10',
      login_id: 'lgn_5d2c7a',
      grant_id: null,
      persona_id: null,
      seq: 99,
      request_id: null,
      era: null,
      client: null,
      protocol_version: null,
      trace_id: null,
      data: {
        scope: 'login',
        xs_deleted: null,
        deleted_count: 412,
        sessions_deleted: 3,
        viewer_kind: 'pairing',
      },
    };
    context.store.apply(deleted);
    const tree = renderTimeline(context);
    const row = findNodes(tree, (node) => hasClass(node, 'flow-context')).find((node) =>
      textOf(node).includes('History erased'),
    );
    expect(textOf(row)).toContain('Erased 412 events and 3 sessions');
    expect(textOf(row)).not.toContain('unknown type');

    const one = { ...deleted, id: 202, data: { ...deleted.data, scope: 'session', xs_deleted: 'xs_7b4d10', deleted_count: 12, sessions_deleted: 1 } };
    context.store.apply(one);
    const withSession = renderTimeline(context);
    expect(textOf(withSession)).toContain('Erased 12 events of session xs_7b4d10');
  });

  it('matches a filter against the call and everything inside it', () => {
    const rows = (raw) => {
      const context = chainModel({ filterRaw: raw });
      context.view.filter = parseFilter(raw);
      return rowsOf(renderTimeline(context)).length;
    };
    // Six `execute_query` calls that started plus the one the rate limiter denied.
    expect(rows('tool:execute_query')).toBe(7);
    expect(rows('kind:sql')).toBe(9);
    expect(rows('status:error')).toBe(4);
    expect(rows('xs:xs_7b4d10')).toBe(4);
    expect(rows('no_such_thing')).toBe(0);
    const context = chainModel({ filterRaw: 'no_such_thing' });
    context.view.filter = parseFilter('no_such_thing');
    expect(textOf(renderTimeline(context))).toContain('No call matches this filter');
  });

  it('freezes at the pause point and shows an unfinished call against its budget', () => {
    const tree = renderTimeline(chainModel({ paused: true, frozenEventId: 45, pendingCount: 3 }));
    const rows = rowsOf(tree);
    expect(rows).toHaveLength(4);
    const last = rows[rows.length - 1];
    expect(hasClass(last, 'call-row-running')).toBe(true);
    // A glyph and a word, never a colour: the five hues belong to the five parties.
    expect(textOf(last)).toContain('⏱');
    expect(textOf(last)).toContain('of 300 s');
    expect(textOf(tree)).toContain('3 new events while paused');
  });

  it('offers the two modes and counts calls in the toolbar', () => {
    const tree = renderTimeline(chainModel());
    const modes = findNodes(tree, (node) => node.attrs['data-action'] === 'set-timeline-mode');
    expect(modes.map((node) => node.attrs['data-arg'])).toEqual(['chain', 'events']);
    expect(modes[0].attrs['aria-pressed']).toBe('true');
    expect(modes[1].attrs['aria-pressed']).toBe('false');
    expect(textOf(findNodes(tree, (node) => hasClass(node, 'toolbar-count'))[0])).toBe('26 calls');
    const events = renderTimeline(model());
    expect(textOf(findNodes(events, (node) => hasClass(node, 'toolbar-count'))[0])).toBe('200 events');
  });

  it('tells the viewer what will appear when there is no call yet', () => {
    const context = chainModel({}, 20);
    const tree = renderTimeline(context);
    expect(episodesOf(tree)).toHaveLength(0);
    // The session is already there, with its connection folded into one line (C1).
    expect(findNodes(tree, (node) => hasClass(node, 'session-block')).length).toBeGreaterThan(0);
    expect(textOf(findNodes(tree, (node) => hasClass(node, 'session-connection'))[0])).toContain('session started');
    expect(textOf(tree)).toContain('No tool call yet');
    expect(textOf(tree)).toContain('each step naming what it passed to the next');
  });
});

describe('Persona card', () => {
  const payload = {
    xs: 'xs_7b4d10',
    login_id: 'lgn_5d2c7a',
    persona: { id: 'per_a1b2', name: 'Ava Bennett', kind: 'retail', shared: true },
    currency: 'USD',
    as_of: '2026-09-08T14:07:30.000Z',
    accounts: [
      {
        account_id: 'acc_a1b2_01',
        name: 'Everyday Checking',
        account_type: 'checking',
        currency: 'USD',
        balance_cents: 1042300,
        available_balance_cents: 1000000,
        credit_limit_cents: null,
        status: 'open',
      },
      {
        account_id: 'acc_a1b2_02',
        name: 'Rainy Day Savings',
        account_type: 'savings',
        currency: 'USD',
        balance_cents: 2500000,
        available_balance_cents: 2500000,
        credit_limit_cents: null,
        status: 'open',
      },
      {
        account_id: 'acc_a1b2_03',
        name: 'Rewards Card',
        account_type: 'credit_card',
        currency: 'USD',
        balance_cents: -184250,
        available_balance_cents: 815750,
        credit_limit_cents: 1000000,
        status: 'open',
      },
    ],
    total_cash_cents: 3542300,
    total_available_cents: 3500000,
    total_credit_owed_cents: 184250,
    net_position_cents: 3358050,
    cards: { total: 3, active: 1, locked: 1, fraud_locked: 1 },
    transfer_limit_cents: 500000,
  };
  const liveView = (bank, overrides = {}) =>
    makeView({
      mode: 'live',
      viewer: { viewer_kind: 'pairing', login_id: 'lgn_5d2c7a', persona: null, expires_at: null },
      bank,
      ...overrides,
    });

  it('describes the selected session, else the most recent one of the viewer', () => {
    const store = storeFromFixture();
    expect(effectiveSessionXs(store, makeView({ selectedXs: 'xs_3f1c9a' }))).toBe('xs_3f1c9a');
    expect(effectiveSessionXs(store, liveView({}))).toBe('xs_7b4d10');
    expect(effectiveSessionXs(store, liveView({}, { viewer: { login_id: 'lgn_other' } }))).toBe(
      'xs_7b4d10',
    );
    expect(effectiveSessionXs(storeFromFixture(0), makeView())).toBeNull();
  });

  it('renders the persona, the money, one row per account and the card counts', () => {
    const store = storeFromFixture();
    const bank = { xs: 'xs_7b4d10', payload, error: null, fetchedAt: FIXTURE_NOW, busy: false };
    const tree = renderPersona({ store, view: liveView(bank), now: FIXTURE_NOW });
    expect(hasClass(tree, 'persona-card')).toBe(true);
    const text = textOf(tree);
    expect(text).toContain('Ava Bennett');
    expect(text).toContain('retail');
    expect(text).toContain('shared');
    expect(text).toContain('per_a1b2');
    expect(textOf(findNodes(tree, (node) => hasClass(node, 'persona-net-value'))[0])).toBe('$33,580.50');
    expect(text).toContain('cash $35,423.00 · available $35,000.00');
    expect(text).toContain('credit owed $1,842.50');
    const rows = findNodes(tree, (node) => hasClass(node, 'persona-account'));
    expect(rows).toHaveLength(3);
    expect(textOf(rows[0])).toContain('Everyday Checking');
    expect(textOf(rows[0])).toContain('checking');
    expect(textOf(rows[0])).toContain('$10,423.00');
    expect(textOf(rows[2])).toContain('-$1,842.50');
    expect(textOf(rows[2])).toContain('limit $10,000.00');
    expect(text).toContain('3 cards · 1 active · 1 locked · 1 fraud locked');
    expect(text).toContain('transfer limit $5,000.00 per transfer');
    expect(text).toContain('read write · 10 scopes · client Claude · access token');
    expect(text).toContain('Refresh');
    expect(text).not.toContain('loading balances');
  });

  it('shows the error with a Refresh button, never a blank box', () => {
    const store = storeFromFixture();
    const bank = {
      xs: 'xs_7b4d10',
      payload: null,
      error: 'No bank is wired into this deployment.',
      fetchedAt: FIXTURE_NOW,
      busy: false,
    };
    const tree = renderPersona({ store, view: liveView(bank), now: FIXTURE_NOW });
    const text = textOf(tree);
    expect(text).toContain('No bank is wired into this deployment.');
    expect(text).toContain('per_a1b2');
    expect(findNodes(tree, (node) => node.attrs['data-action'] === 'refresh-bank').length).toBeGreaterThan(0);
    expect(text).not.toContain('loading balances');
  });

  it('says it is loading while the balances are on their way', () => {
    const store = storeFromFixture();
    const bank = { xs: 'xs_7b4d10', payload: null, error: null, fetchedAt: null, busy: true };
    const text = textOf(renderPersona({ store, view: liveView(bank), now: FIXTURE_NOW }));
    expect(text).toContain('loading balances');
    expect(text).toContain('Refreshing');
  });

  it('never asks for balances in fixture mode and says why', () => {
    const store = storeFromFixture();
    const text = textOf(renderPersona({ store, view: makeView(), now: FIXTURE_NOW }));
    expect(text).toContain('per_a1b2');
    expect(text).toContain('shared');
    expect(text).toContain('Balances need a live server; this is the recorded sample.');
    expect(text).not.toContain('Refresh');
  });
});

describe('Call inspector', () => {
  it('shows arguments, rationale, timings, result and nested work for a call', () => {
    const context = model({ selectedCallKey: 'xs_3f1c9a#7' });
    const text = textOf(renderInspector(context));
    expect(text).toContain('execute_query');
    expect(text).toContain('Stated intent');
    expect(text).toContain('written by the model');
    expect(text).toContain('of the 300 s per-call budget');
    expect(text).toContain('SELECT "category_id"');
    expect(text).toContain('of the 150.0k chars cap');
    expect(text).toContain('What the server did');
  });

  it('explains a missing rationale rather than showing a blank quote', () => {
    const context = model({ selectedCallKey: 'xs_3f1c9a#11' });
    const text = textOf(renderInspector(context));
    expect(text).toContain('No rationale supplied');
    expect(text).toContain('ADR-8');
  });

  it('says a denied call never reached the tool', () => {
    const context = model({ selectedCallKey: 'xs_3f1c9a#14' });
    const text = textOf(renderInspector(context));
    expect(text).toContain('Denied before it ran');
    expect(text).toContain('The call never reached the tool');
    expect(text).toContain('transfers:write');
  });

  it('falls back to the raw envelope for a non-call row', () => {
    const context = model({ selectedEventId: 1 });
    const html = toHtml(renderInspector(context));
    expect(html).toContain('server.started');
    expect(html).toContain('Raw envelope');
    expect(html).toContain('boot_9f2a1c40');
  });

  it('labels an unknown event and still prints its payload', () => {
    const context = model({ selectedEventId: 7100 });
    context.store.apply({
      id: 7100,
      ts: '2026-09-08T14:09:40.000Z',
      v: 1,
      xs: null,
      login_id: null,
      grant_id: null,
      persona_id: null,
      seq: null,
      request_id: null,
      era: null,
      client: null,
      protocol_version: null,
      trace_id: null,
      type: 'ledger.posting.created',
      data: { amount_cents: 4200 },
    });
    const text = textOf(renderInspector(context));
    expect(text).toContain('unknown to this dashboard');
    expect(text).toContain('newer than the dashboard');
    expect(text).toContain('4200');
  });

  it('points at the timeline when nothing is selected', () => {
    expect(textOf(renderInspector(model()))).toContain('Pick a row in the timeline');
  });
});

describe('Sessions: erasing history', () => {
  const live = (overrides = {}) => model({ mode: 'live', ...overrides });

  it('offers hiding and deleting as two clearly different things', () => {
    const tree = renderSessions(live());
    const actions = findNodes(tree, (node) => node.attrs['data-action']).map(
      (node) => node.attrs['data-action'],
    );
    expect(actions).toContain('hide-events');
    expect(actions).toContain('ask-erase');
    const hide = findNodes(tree, (node) => node.attrs['data-action'] === 'hide-events')[0];
    expect(textOf(hide)).toBe('Hide what is on screen');
    expect(hide.attrs.title).toContain('stay on the server');
    const erase = findNodes(
      tree,
      (node) => node.attrs['data-action'] === 'ask-erase' && node.attrs['data-arg'] === 'login',
    )[0];
    expect(textOf(erase)).toBe('Delete my history');
    // Nothing is deleted by the first click: it only arms the question.
    expect(actions).not.toContain('confirm-erase');
  });

  it('needs a second click, which names how much is about to go', () => {
    const tree = renderSessions(live({ erase: { scope: 'login', busy: false, note: null, error: null } }));
    const text = textOf(tree);
    expect(text).toContain('Delete 200 events from the server?');
    const confirm = findNodes(tree, (node) => node.attrs['data-action'] === 'confirm-erase')[0];
    expect(confirm.attrs['data-arg']).toBe('login');
    expect(findNodes(tree, (node) => node.attrs['data-action'] === 'cancel-erase')).toHaveLength(1);
  });

  it('gives every session row its own two-step control, outside the row button', () => {
    const tree = renderSessions(live());
    const rows = findNodes(tree, (node) => hasClass(node, 'session-row'));
    const deletes = findNodes(
      tree,
      (node) => node.attrs['data-action'] === 'ask-erase' && node.attrs['data-arg'] !== 'login',
    );
    expect(deletes).toHaveLength(rows.length);
    expect(deletes.map((node) => node.attrs['data-arg'])).toContain('xs_3f1c9a');
    // Not nested inside the row: a click on it can never be read as selecting the session.
    for (const row of rows) {
      expect(findNodes(row, (node) => node.attrs['data-action'] === 'ask-erase')).toHaveLength(0);
    }

    const armed = renderSessions(
      live({ erase: { scope: 'xs_3f1c9a', busy: false, note: null, error: null } }),
    );
    expect(textOf(armed)).toContain('from the server?');
    expect(textOf(armed)).toContain('xs_3f1c9a');
    const confirm = findNodes(armed, (node) => node.attrs['data-action'] === 'confirm-erase')[0];
    expect(confirm.attrs['data-arg']).toBe('xs_3f1c9a');
  });

  it('never shows either control in fixture mode or to an observer', () => {
    const fixture = renderSessions(model({ mode: 'fixture' }));
    expect(textOf(fixture)).not.toContain('Delete my history');
    expect(findNodes(fixture, (node) => node.attrs['data-action'] === 'ask-erase')).toHaveLength(0);
    const observer = renderSessions(
      live({ viewer: { viewer_kind: 'admin', login_id: null, expires_at: null } }),
    );
    expect(findNodes(observer, (node) => node.attrs['data-action'] === 'ask-erase')).toHaveLength(0);
    expect(findNodes(observer, (node) => node.attrs['data-action'] === 'hide-events')).toHaveLength(0);
  });

  it('reports what went, and says plainly when nothing did', () => {
    const done = renderSessions(
      live({ erase: { scope: null, busy: false, note: '12 events and 1 session were erased.', error: null } }),
    );
    expect(textOf(done)).toContain('Events removed');
    expect(textOf(done)).toContain('12 events and 1 session were erased.');
    const failed = renderSessions(
      live({
        erase: { scope: null, busy: false, note: null, error: 'This server does not support erasing events yet.' },
      }),
    );
    expect(textOf(failed)).toContain('Nothing was deleted');
    expect(textOf(failed)).toContain('does not support erasing events yet');
  });
});

describe('Sessions: downloading the log (v0.8, D-27)', () => {
  const withApi = (overrides, lane) => ({
    ...model({ mode: 'live', ...overrides }),
    api: createApi('/xray', { lane }),
  });
  const linkOf = (tree) =>
    findNodes(tree, (node) => node.tag === 'a' && node.attrs.download !== undefined)[0];

  it('links every live viewer to the JSONL export of what it may read', () => {
    const paired = linkOf(renderSessions(withApi({})));
    expect(paired.attrs.href).toBe('/xray/api/export');
    expect(textOf(paired)).toBe('Download log (JSONL)');
    const observer = linkOf(
      renderSessions(withApi({ viewer: { viewer_kind: 'admin', login_id: null, expires_at: null } })),
    );
    expect(observer.attrs.href).toBe('/xray/api/export');
    const publicLane = linkOf(
      renderSessions(
        withApi({ viewer: { viewer_kind: 'public', login_id: 'lgn_public', expires_at: null } }, 'public'),
      ),
    );
    expect(publicLane.attrs.href).toBe('/xray/api/export?lane=public');
  });

  it('has nothing to download in fixture mode', () => {
    expect(linkOf(renderSessions(withApi({ mode: 'fixture' })))).toBeUndefined();
  });
});

describe('the remaining panels', () => {
  it('Sessions groups by login and grant and marks the shared persona', () => {
    const text = textOf(renderSessions(model()));
    expect(text).toContain('lgn_5d2c7a');
    expect(text).toContain('grt_8a1e33');
    expect(text).toContain('shared demo persona');
    expect(text).toContain('extended on step-up (+cards:write, transfers:write)');
    expect(text).toContain('xs_3f1c9a');
    expect(text).toContain('xs_7b4d10');
    expect(text).toContain('boot_9f2a1c40');
    expect(text).toContain('1 restart observed');
  });

  it('Session and auth shows the handshake, the HTTP facts and the grant', () => {
    const text = textOf(renderSessionAuth(model({ selectedXs: 'xs_3f1c9a' })));
    expect(text).toContain('2025-11-25');
    expect(text).toContain('verbatim, never trusted');
    expect(text).toContain('160.79.104.0/24');
    expect(text).toContain('Anthropic egress range');
    expect(text).toContain('not sent (this server is stateless and issues none)');
    expect(text).toContain('Repeated initialize handshakes');
    expect(text).toContain('Tokens are never stored or logged');
  });

  it('Intent separates what the model declared from what the server inferred', () => {
    const text = textOf(renderIntent(model({ selectedXs: 'xs_3f1c9a' })));
    expect(text).toContain('The server cannot see your conversation');
    expect(text).toContain('model-authored');
    expect(text).toContain('inferred by this server, not by the model');
    expect(text).toContain('spend analysis');
    expect(text).toContain('no rationale');
  });

  it('SQL and data lists the scratch schema, the statements and the guard rails', () => {
    const text = textOf(renderSqlData(model({ selectedXs: 'xs_3f1c9a' })));
    expect(text).toContain('load_transactions_9a41c7e2');
    expect(text).toContain('ATTACH DATABASE');
    expect(text).toContain('row cap hit');
    expect(text).toContain('The query runner was killed');
    expect(text).toContain('the scratch database was reset');

    const schema = scratchSchema(storeFromFixture().getEvents({ xs: 'xs_3f1c9a' }));
    expect(schema.map((row) => row.state)).toEqual(['lost', 'cleared', 'evicted']);
  });

  it('Errors and health separates protocol errors from tool errors', () => {
    const text = textOf(
      renderErrorsHealth(model({ selectedXs: 'xs_3f1c9a', connection: { state: 'open', attempts: 2 } })),
    );
    expect(text).toContain('protocol errors');
    expect(text).toContain('failed calls');
    expect(text).toContain('events dropped');
    expect(text).toContain('execute_query');
    expect(text).toContain('2 reconnect(s)');
    expect(text).toContain('Everything that went wrong');
  });

  it('the now strip shows the last call, and an in-flight call against the budget', () => {
    const idle = textOf(renderNowStrip(model()));
    expect(idle).toContain('Last call');
    expect(idle).toContain('/ 300 s budget');

    const context = model();
    context.store.apply({
      id: 8000,
      ts: new Date(FIXTURE_NOW - 42_000).toISOString(),
      v: 1,
      xs: 'xs_7b4d10',
      login_id: 'lgn_5d2c7a',
      grant_id: 'grt_8a1e33',
      persona_id: 'per_a1b2',
      seq: 300,
      request_id: '300',
      era: 'legacy',
      client: null,
      protocol_version: '2025-11-25',
      trace_id: null,
      type: 'tool.call.started',
      data: {
        tool: 'load_statement_lines',
        arguments: {},
        redacted_fields: [],
        rationale: 'Assemble the statement for the year.',
        rationale_present: true,
        rationale_truncated: false,
        meta: null,
        required_scopes: [],
        budget_ms: 300_000,
      },
    });
    const live = textOf(renderNowStrip(context));
    expect(live).toContain('In flight');
    expect(live).toContain('load_statement_lines');
    expect(live).toContain('42.00 s');
    expect(live).toContain('14%');
  });

  it('the now strip names the model as the author of the quote', () => {
    const inFlight = (id, data = {}) => ({
      id,
      ts: new Date(FIXTURE_NOW - 42_000).toISOString(),
      v: 1,
      xs: 'xs_7b4d10',
      login_id: 'lgn_5d2c7a',
      grant_id: 'grt_8a1e33',
      persona_id: 'per_a1b2',
      seq: id,
      request_id: String(id),
      era: 'legacy',
      client: null,
      protocol_version: '2025-11-25',
      trace_id: null,
      type: 'tool.call.started',
      data: {
        tool: 'load_statement_lines',
        arguments: {},
        redacted_fields: [],
        rationale: 'Assemble the statement for the year.',
        rationale_present: true,
        rationale_truncated: false,
        meta: null,
        required_scopes: [],
        budget_ms: 300_000,
        ...data,
      },
    });

    const quoted = model();
    quoted.store.apply(inFlight(8001));
    const strip = renderNowStrip(quoted);
    const chips = findNodes(strip, (node) => hasClass(node, 'now-said'));
    expect(chips).toHaveLength(1);
    expect(textOf(chips[0])).toBe('model said:');
    // The chip wears the model's colour through the same class the board's bands use.
    expect(hasClass(chips[0], 'band-model')).toBe(true);
    const html = toHtml(strip);
    expect(html.indexOf('model said:')).toBeLessThan(html.indexOf('Assemble the statement for the year.'));

    const silent = model();
    silent.store.apply(inFlight(8002, { rationale: null, rationale_present: false }));
    const missing = renderNowStrip(silent);
    expect(findNodes(missing, (node) => hasClass(node, 'now-said'))).toHaveLength(0);
    expect(textOf(missing)).toContain('no rationale supplied');
  });
});

describe('empty and error states', () => {
  it('the front door explains what to do with no session', () => {
    const text = textOf(renderConnectScreen(model()));
    expect(text).toContain('Watch what your assistant actually did');
    expect(text).toContain('xray_get_session_link');
    expect(text).toContain('BANK-7Q2F-K3MZ-8A');
    expect(text).toContain('Try it with sample data');
  });

  it('an empty store tells the viewer nothing has happened yet', () => {
    const context = model();
    const empty = { store: storeFromFixture(0), view: context.view, now: FIXTURE_NOW };
    expect(textOf(renderTimeline(empty))).toContain('Nothing has happened yet');
    expect(textOf(renderSessions(empty))).toContain('No session yet');
    expect(textOf(renderSqlData(empty))).toContain('Nothing loaded yet');
  });

  it('a dropped stream produces a banner that says what happens next', () => {
    const banner = renderStreamBanner({
      view: { connection: { state: 'reconnecting', attempts: 3, nextRetryAt: FIXTURE_NOW + 4000 } },
      now: FIXTURE_NOW,
    });
    const text = textOf(banner);
    expect(text).toContain('The live stream dropped and is reconnecting.');
    expect(text).toContain('Retrying in 4 s');
    expect(text).toContain('Attempt 3');
    expect(text).toContain('Last-Event-ID');
    expect(text).toContain('Reconnect now');
  });

  it('a healthy stream shows no banner at all', () => {
    expect(
      renderStreamBanner({ view: { connection: { state: 'open' } }, now: FIXTURE_NOW }),
    ).toBeNull();
  });

  it('names the viewer scope in the header', () => {
    expect(textOf(renderViewerChip({ view: { mode: 'fixture' }, now: FIXTURE_NOW }))).toContain(
      'sample data',
    );
    expect(
      textOf(
        renderViewerChip({
          view: { mode: 'live', viewer: { viewer_kind: 'admin', expires_at: null } },
          now: FIXTURE_NOW,
        }),
      ),
    ).toContain('observer mode');
    const lane = renderViewerChip({
      view: { mode: 'live', viewer: { viewer_kind: 'public', login_id: 'lgn_public' } },
      now: FIXTURE_NOW,
    });
    expect(textOf(lane)).toContain('public lane');
    expect(findNodes(lane, (node) => node.attrs['data-action'] === 'leave-public-lane')).toHaveLength(1);
  });

  it('offers the public lane on the front door, no code needed (D-26)', () => {
    const tree = renderConnectScreen({
      view: { pairing: { code: '', error: null, busy: false }, adminOpen: false, connectError: null },
    });
    expect(findNodes(tree, (node) => node.attrs['data-action'] === 'enter-public-lane')).toHaveLength(1);
    expect(textOf(tree)).toContain('/public/mcp');
  });

  it('never offers an erase to a reader of the public lane (D-26)', () => {
    const tree = renderSessions(
      model({ mode: 'live', viewer: { viewer_kind: 'public', login_id: 'lgn_public' } }),
    );
    const actions = findNodes(tree, (node) => node.attrs['data-action']).map(
      (node) => node.attrs['data-action'],
    );
    expect(actions).not.toContain('ask-erase');
    expect(actions).not.toContain('hide-events');
  });
});

describe('markup safety', () => {
  it('escapes event data instead of injecting it as markup', () => {
    const context = model({ selectedEventId: 9100 });
    context.store.apply({
      id: 9100,
      ts: '2026-09-08T14:09:50.000Z',
      v: 1,
      xs: 'xs_7b4d10',
      login_id: null,
      grant_id: null,
      persona_id: null,
      seq: null,
      request_id: null,
      era: null,
      client: null,
      protocol_version: null,
      trace_id: null,
      type: 'sql.query',
      data: {
        table: '<img src=x onerror=alert(1)>',
        sql: "SELECT '<script>alert(1)</script>'",
        rows_returned: 1,
        capped: false,
        duration_ms: 1,
      },
    });
    const html = toHtml(renderInspector(context));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
