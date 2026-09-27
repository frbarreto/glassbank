/**
 * The request as it reached the server, and the fields no schema maps (contracts v0.9, D-28).
 */
import { describe, expect, it } from 'vitest';
import { findNodes, hasClass, textOf, toHtml } from '../h.js';
import { rawRequestView, webBotAuthOf } from '../raw-request.js';
import { unmappedCount, unmappedOf } from '../unmapped.js';
import { summaryOf } from '../catalogue.js';
import { createStore } from '../store.js';
import { renderInspector } from '../panel-inspector.js';
import { parseFilter } from '../filters.js';
import { makeView } from './helpers.mjs';

const SIGNED = [
  ['Host', 'glassbank.example'],
  ['Signature-Agent', '"https://chatgpt.com"'],
  ['Signature-Input', 'sig1=("@authority" "signature-agent");created=1;keyid="kid-1";tag="web-bot-auth"'],
  ['Signature', 'sig1=:c2ln:'],
  ['x-dup', 'first'],
  ['X-Dup', 'second'],
  ['authorization', '[redacted]'],
];

function raw(overrides = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'load_cards' } });
  return {
    method: 'POST',
    url: '/mcp',
    http_version: '1.1',
    headers: SIGNED,
    trailers: [],
    body,
    body_encoding: 'utf8',
    body_bytes: body.length,
    body_read: true,
    remote_address: '169.254.1.0/24',
    remote_port: 40000,
    ...overrides,
  };
}

function envelope(id, type, data, extra = {}) {
  return {
    id,
    ts: `2026-09-27T12:00:0${id}.000Z`,
    v: 1,
    xs: 'xs_raw0001',
    login_id: 'lgn_raw0001',
    grant_id: 'grt_raw0001',
    persona_id: null,
    seq: id,
    request_id: '7',
    era: 'legacy',
    client: null,
    protocol_version: '2025-11-25',
    trace_id: null,
    type,
    data,
    ...extra,
  };
}

describe('webBotAuthOf', () => {
  it('finds the three headers whatever their case, and reads keyid and tag', () => {
    expect(webBotAuthOf(raw())).toMatchObject({
      agent: '"https://chatgpt.com"',
      keyid: 'kid-1',
      tag: 'web-bot-auth',
      complete: true,
    });
  });

  it('answers null for a request that carried none', () => {
    expect(webBotAuthOf(raw({ headers: [['Host', 'x']] }))).toBeNull();
    expect(webBotAuthOf(undefined)).toBeNull();
  });
});

describe('rawRequestView', () => {
  it('lists every header in arrival order, duplicates and case kept, signed ones marked', () => {
    const tree = rawRequestView(raw(), { id: 'test' });
    const rows = findNodes(tree, (node) => node.tag === 'tr' && !findNodes(node, (child) => child.tag === 'th').length);
    expect(rows.map((row) => textOf(row))).toEqual(
      SIGNED.map(([name, value], index) => `${index + 1}${name}${value}`),
    );
    const signed = rows.filter((row) => hasClass(row, 'raw-header-signed'));
    expect(signed.map((row) => textOf(row))).toEqual([
      `2Signature-Agent"https://chatgpt.com"`,
      `3Signature-Inputsig1=("@authority" "signature-agent");created=1;keyid="kid-1";tag="web-bot-auth"`,
      '4Signaturesig1=:c2ln:',
    ]);
    expect(textOf(tree)).toContain('POST /mcp HTTP/1.1');
    expect(textOf(tree)).toContain('Signed with Web Bot Auth');
  });

  it('says so when the request was not signed', () => {
    const html = toHtml(rawRequestView(raw({ headers: [['Host', 'x']] })));
    expect(html).toContain('No Web Bot Auth signature');
  });

  it('draws a JSON body as a tree and anything else as text', () => {
    expect(toHtml(rawRequestView(raw()))).toContain('data-json-id');
    const text = rawRequestView(raw({ body: 'plain words', headers: [] }));
    expect(textOf(text)).toContain('plain words');
  });

  it('explains a body no parser read', () => {
    const tree = rawRequestView(
      raw({ body: null, body_read: false, body_bytes: null, headers: [['content-length', '512']] }),
    );
    expect(textOf(tree)).toContain('declared a 512-byte body that no parser read');
  });
});

describe('unmappedOf', () => {
  it('returns the data and envelope keys the contract does not name', () => {
    const event = envelope(
      1,
      'http.request',
      { method: 'GET', path: '/', status: 200, duration_ms: 1, vendor_field: { a: 1 } },
      { envelope_extra: true },
    );
    expect(unmappedOf(event)).toEqual({ envelope: { envelope_extra: true }, data: { vendor_field: { a: 1 } } });
    expect(unmappedCount(event)).toBe(2);
  });

  it('returns null when everything is mapped, the raw block included', () => {
    const event = envelope(1, 'http.request', { method: 'GET', path: '/', status: 200, duration_ms: 1, raw: raw() });
    expect(unmappedOf(event)).toBeNull();
  });
});

describe('the inspector', () => {
  function inspect(events, overrides) {
    const store = createStore();
    for (const event of events) store.apply(event);
    const view = makeView(overrides(store));
    view.filter = parseFilter(view.filterRaw);
    return toHtml(renderInspector({ store, view, now: Date.parse('2026-09-27T12:01:00Z') }));
  }

  const started = envelope(1, 'tool.call.started', {
    tool: 'load_cards',
    arguments: { rationale: 'why' },
    rationale: 'why',
    rationale_present: true,
  });
  const http = envelope(2, 'http.request', {
    method: 'POST',
    path: '/mcp',
    status: 200,
    duration_ms: 3,
    raw: raw(),
    vendor_field: 'nobody mapped this',
  });

  it('shows the request as received inside the call it carried', () => {
    const html = inspect([started, http], (store) => ({ selectedCallKey: store.getCalls()[0].key }));
    expect(html).toContain('Request as received');
    expect(html).toContain('Signed with Web Bot Auth');
  });

  it('shows the raw request and the unmapped fields of an http.request row', () => {
    const html = inspect([started, http], () => ({ selectedEventId: 2 }));
    expect(html).toContain('Request as received');
    expect(html).toContain('Unmapped fields');
    expect(html).toContain('nobody mapped this');
  });

  it('marks a signed request in the one-line summary', () => {
    expect(summaryOf(http)).toContain('signed (Web Bot Auth)');
    expect(summaryOf({ ...http, data: { ...http.data, raw: raw({ headers: [] }) } })).not.toContain('signed');
  });
});
