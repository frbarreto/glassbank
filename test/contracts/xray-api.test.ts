/**
 * The X-ray HTTP read model of docs/XRAY_EVENT_MODEL.md sections 5 and 6.
 *
 * The dashboard block consumes these shapes over HTTP without importing anything from `src/`
 * (docs/REPO_LAYOUT.md section 3), so this file is the only place the two sides meet.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type {
  ViewerMeResponse,
  XrayCatalogSnapshot,
  XraySessionEventsResponse,
  XraySessionSummary,
  XraySessionsResponse,
  XrayExportQuery,
  XrayStreamFrame,
  XrayStreamQuery,
} from '../../src/contracts/index.js';
import {
  INITIAL_REPLAY,
  MAX_EVENTS_PAGE_LIMIT,
  OBSERVER_RATIONALE_PREVIEW_CHARS,
  RESULT_PREVIEW_BYTES,
  RING_BUFFER_SIZE,
  SSE_EVENT_NAME,
  SSE_HEADERS,
  SSE_HEARTBEAT_MS,
  SSE_RETRY_MS,
  XRAY_EXPORT_CONTENT_TYPE,
  XRAY_ROUTES,
  XrayEventSchema,
  renderStreamFrame,
} from '../../src/contracts/index.js';

const fixture = readFileSync(
  fileURLToPath(new URL('../fixtures/events.jsonl', import.meta.url)),
  'utf8',
)
  .split('\n')
  .filter((line) => line.trim() !== '');

describe('the X-ray HTTP read model', () => {
  it('names every route of section 6', () => {
    expect(XRAY_ROUTES).toEqual({
      spa: '/xray/',
      assets: '/xray/assets',
      fixtures: '/xray/fixtures/events.jsonl',
      pairingLanding: '/xray/s/:code',
      pair: '/xray/api/pair',
      admin: '/xray/api/admin',
      me: '/xray/api/me',
      sessions: '/xray/api/sessions',
      session: '/xray/api/sessions/:xs',
      sessionEvents: '/xray/api/sessions/:xs/events',
      sessionBank: '/xray/api/sessions/:xs/bank',
      events: '/xray/api/events',
      catalog: '/xray/api/catalog',
      stream: '/xray/api/stream',
      healthz: '/healthz',
      health: '/health',
      export: '/xray/api/export',
    });
  });

  it('pins the SSE transport constants of section 5', () => {
    expect(SSE_EVENT_NAME).toBe('xray');
    expect(SSE_RETRY_MS).toBe(2000);
    expect(SSE_HEARTBEAT_MS).toBe(20_000);
    expect(INITIAL_REPLAY).toBe(200);
    expect(MAX_EVENTS_PAGE_LIMIT).toBe(500);
    expect(RING_BUFFER_SIZE).toBe(10_000);
    expect(RESULT_PREVIEW_BYTES).toBe(2048);
    expect(OBSERVER_RATIONALE_PREVIEW_CHARS).toBe(80);
    expect(SSE_HEADERS['Content-Type']).toBe('text/event-stream');
    expect(SSE_HEADERS['X-Accel-Buffering']).toBe('no');
  });

  it('renders one frame as event / id / data with a blank line', () => {
    const event = XrayEventSchema.parse(JSON.parse(fixture[0] as string));
    const frame: XrayStreamFrame = { event: SSE_EVENT_NAME, id: event.id, data: event };
    const rendered = renderStreamFrame(frame);
    expect(rendered.startsWith('event: xray\nid: 1\ndata: {')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(true);
    const payload = rendered.split('\n')[2]?.slice('data: '.length) as string;
    expect(XrayEventSchema.safeParse(JSON.parse(payload)).success).toBe(true);
  });

  it('types the three mutually exclusive stream filters', () => {
    const bySession: XrayStreamQuery = { xs: 'xs_3f1c9a' };
    const byLogin: XrayStreamQuery = { login: 'me' };
    const observer: XrayStreamQuery = { all: '1' };
    expect([bySession.xs, byLogin.login, observer.all]).toEqual(['xs_3f1c9a', 'me', '1']);
  });

  it('types the export as a stream scope plus a cursor, answered in the fixture line format (v0.8)', () => {
    const incremental: XrayExportQuery = { all: '1', after: 200 };
    const publicLane: XrayExportQuery = { lane: 'public' };
    expect([incremental.after, publicLane.lane]).toEqual([200, 'public']);
    expect(XRAY_EXPORT_CONTENT_TYPE).toBe('application/x-ndjson; charset=utf-8');
    // One stored envelope per line: every fixture line is what an export line looks like.
    expect(XrayEventSchema.safeParse(JSON.parse(fixture[0] as string)).success).toBe(true);
  });

  it('types the sessions envelope the way Ramp paginates', () => {
    const summary: XraySessionSummary = {
      xs: 'xs_3f1c9a',
      login_id: 'lgn_5d2c7a',
      grant_id: 'grt_8a1e33',
      parent_grant_id: null,
      persona: { id: 'per_a1b2', name: 'Ava Bennett', kind: 'retail', shared: true },
      client: { name: 'Anthropic', version: '1.0.0', title: null },
      protocol_version: '2025-11-25',
      era: 'legacy',
      started_at: '2026-09-08T14:00:15.000Z',
      last_seen_at: '2026-09-08T14:05:15.000Z',
      initialize_count: 3,
      call_count: 22,
      error_count: 4,
      token_expires_at: '2026-09-08T15:00:15.000Z',
      boot_id: 'boot_9f2a1c40',
    };
    const response: XraySessionsResponse = { data: [summary], page: { next: null } };
    expect(response.data[0]?.initialize_count).toBe(3);
    expect(response.page.next).toBeNull();
  });

  it('types the paged event history against the real fixture', () => {
    const events = fixture.slice(0, 5).map((line) => XrayEventSchema.parse(JSON.parse(line)));
    const response: XraySessionEventsResponse = { data: events, page: { next: '5' } };
    expect(response.data).toHaveLength(5);
    expect(response.data.at(-1)?.id).toBe(5);
  });

  it('types the viewer identity for both pairing and observer mode', () => {
    const viewer: ViewerMeResponse = {
      viewer_kind: 'pairing',
      login_id: 'lgn_5d2c7a',
      grant_ids: ['grt_8a1e33'],
      persona: { id: 'per_a1b2', name: 'Ava Bennett', kind: 'retail', shared: true },
      expires_at: '2026-09-09T14:00:00.000Z',
    };
    const admin: ViewerMeResponse = {
      viewer_kind: 'admin',
      expires_at: '2026-09-09T14:00:00.000Z',
    };
    expect(viewer.grant_ids).toHaveLength(1);
    expect(admin.login_id).toBeUndefined();
  });

  it('types the catalog snapshot the possibility-space panel renders', () => {
    const listing = fixture
      .map((line) => XrayEventSchema.parse(JSON.parse(line)))
      .find((event) => event.type === 'catalog.tools_listed' && event.data.tools !== null);
    expect(listing?.type).toBe('catalog.tools_listed');
    if (listing?.type !== 'catalog.tools_listed') return;
    const snapshot: XrayCatalogSnapshot = {
      xs: listing.xs as string,
      content_hash: listing.data.content_hash,
      captured_at: listing.ts,
      event_id: listing.id,
      tools: listing.data.tools ?? [],
      availability: listing.data.availability,
      feature_flags: listing.data.feature_flags,
    };
    expect(snapshot.tools).toHaveLength(17);
    expect(snapshot.availability).toHaveLength(17);
  });
});
