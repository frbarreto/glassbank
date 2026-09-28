/**
 * The Overview (block: dashboard, contracts v0.10, D-32).
 *
 * The chain answers "what did this one session do"; this page answers "what is going on": how
 * many agents came, what they called, what failed, how fast, who they claimed to be and who could
 * prove it. On the public lane it is the front door (D-31): anyone can see what anonymous agents
 * are doing with the bank's published catalog without reading a single event.
 *
 * Live, the numbers come from `GET /xray/api/stats`, counted by the server over its whole log for
 * the viewer's scope - the page itself only ever holds a few sessions. Over the recorded fixture
 * there is no server, so `statsFromStore` counts the recording in the browser, and the page says
 * which of the two it is showing.
 *
 * Pure functions; `renderOverview(model)` with `model = { store, view, now }`.
 */
import { cx, h } from './h.js';
import { button, emptyState, meter, stat, table, tag } from './ui.js';
import { clockTime, count, duration, plural, shortDateTime } from './format.js';
import { strongerVerdict, verdictBadge } from './identity.js';

export const OVERVIEW_WINDOWS = [
  { id: '1h', label: 'Last hour' },
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: 'all', label: 'Everything kept' },
];

const WINDOW_MS = { '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 };

function percentileOf(sorted, share) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1));
  return Math.round(sorted[index] * 10) / 10;
}

function bucketMinutesFor(spanMs) {
  if (spanMs <= 2 * 3_600_000) return 5;
  if (spanMs <= 2 * 86_400_000) return 60;
  if (spanMs <= 10 * 86_400_000) return 360;
  return 1440;
}

/**
 * The same shape as `XrayStatsResponse`, counted in this browser from the events the page holds.
 * Used over the recorded fixture, where there is no server to ask; `source: 'page'` says so.
 */
export function statsFromStore(store, window, nowMs) {
  const events = store.getEvents();
  const lastTs = events.length ? Date.parse(events[events.length - 1].ts) : nowMs;
  // A recording is anchored to its own clock, not to today's.
  const anchor = Number.isFinite(lastTs) ? lastTs : nowMs;
  const sinceMs = window === 'all' ? 0 : anchor - WINDOW_MS[window];
  const rows = events.filter((event) => Date.parse(event.ts) >= sinceMs);
  const sessions = new Set();
  const visitors = new Set();
  const tallies = new Map();
  const tools = new Map();
  const durations = [];
  const argumentsSeen = new Map();
  const errors = [];
  const totals = {
    sessions: 0,
    visitors: 0,
    calls: 0,
    calls_ok: 0,
    calls_failed: 0,
    calls_denied: 0,
    rate_limited: 0,
    protocol_errors: 0,
    http_requests: 0,
    signed_requests: 0,
    verified_requests: 0,
    calls_without_rationale: 0,
    p50_ms: null,
    p95_ms: null,
  };
  const tallyOf = (xs) => {
    if (!tallies.has(xs))
      tallies.set(xs, { label: null, userAgent: null, verdict: null, agent: null, calls: 0 });
    return tallies.get(xs);
  };
  const toolOf = (name) => {
    if (!tools.has(name)) tools.set(name, { calls: 0, failed: 0, durations: [] });
    return tools.get(name);
  };
  const first = rows.length ? Date.parse(rows[0].ts) : anchor;
  const spanMs = window === 'all' ? Math.max(0, anchor - first) : WINDOW_MS[window];
  const bucketMinutes = bucketMinutesFor(spanMs);
  const bucketMs = bucketMinutes * 60_000;
  const firstBucket = Math.floor((window === 'all' ? first : sinceMs) / bucketMs) * bucketMs;
  const bucketCount = Math.min(400, Math.max(1, Math.floor((anchor - firstBucket) / bucketMs) + 1));
  const buckets = Array.from({ length: bucketCount }, () => ({ calls: 0, failed: 0 }));
  const bucketOf = (ts) => buckets[Math.floor((Date.parse(ts) - firstBucket) / bucketMs)];
  const started = new Set();

  for (const event of rows) {
    const data = event.data ?? {};
    if (event.xs) sessions.add(event.xs);
    if (event.grant_id) visitors.add(event.grant_id);
    const tally = event.xs ? tallyOf(event.xs) : null;
    if (tally && event.client?.name)
      tally.label = `${event.client.name}${event.client.version ? ` ${event.client.version}` : ''}`;
    switch (event.type) {
      case 'http.request':
        totals.http_requests += 1;
        if (data.rate_limited || data.status === 429) totals.rate_limited += 1;
        if (data.signature?.present) {
          totals.signed_requests += 1;
          if (data.signature.verdict === 'verified') totals.verified_requests += 1;
        }
        if (tally) {
          if (data.user_agent) tally.userAgent = data.user_agent;
          const stronger = strongerVerdict(tally.verdict, data.signature?.verdict ?? null);
          if (stronger !== tally.verdict) {
            tally.verdict = stronger;
            tally.agent = data.signature?.agent ?? null;
          }
        }
        break;
      case 'tool.call.started': {
        totals.calls += 1;
        started.add(`${event.xs}#${event.request_id}`);
        if (tally) tally.calls += 1;
        toolOf(data.tool ?? 'unknown tool').calls += 1;
        const bucket = bucketOf(event.ts);
        if (bucket) bucket.calls += 1;
        if (data.rationale_present === false) totals.calls_without_rationale += 1;
        for (const [key, value] of Object.entries(data.arguments ?? {})) {
          if (key === 'rationale') continue;
          const text =
            typeof value === 'string'
              ? value.trim()
              : typeof value === 'number' || typeof value === 'boolean'
                ? String(value)
                : null;
          if (!text || text.length > 80) continue;
          const id = `${data.tool}\u0000${key}\u0000${text}`;
          const entry = argumentsSeen.get(id) ?? { tool: data.tool, key, value: text, count: 0 };
          entry.count += 1;
          argumentsSeen.set(id, entry);
        }
        break;
      }
      case 'tool.call.completed': {
        const tool = toolOf(data.tool ?? 'unknown tool');
        if (Number.isFinite(Number(data.duration_ms))) {
          durations.push(Number(data.duration_ms));
          tool.durations.push(Number(data.duration_ms));
        }
        if (data.is_error) {
          totals.calls_failed += 1;
          tool.failed += 1;
          const bucket = bucketOf(event.ts);
          if (bucket) bucket.failed += 1;
          errors.push({
            ts: event.ts,
            xs: event.xs,
            request_id: event.request_id,
            tool: data.tool,
            kind: 'tool_error',
            message: data.error?.message ?? 'the tool returned an error',
          });
        } else {
          totals.calls_ok += 1;
        }
        break;
      }
      case 'tool.call.denied': {
        totals.calls_denied += 1;
        const tool = toolOf(data.tool ?? 'unknown tool');
        tool.failed += 1;
        if (!started.has(`${event.xs}#${event.request_id}`)) {
          totals.calls += 1;
          tool.calls += 1;
          if (tally) tally.calls += 1;
        }
        const bucket = bucketOf(event.ts);
        if (bucket) bucket.failed += 1;
        errors.push({
          ts: event.ts,
          xs: event.xs,
          request_id: event.request_id,
          tool: data.tool,
          kind: 'denied',
          message: `denied: ${String(data.denied_reason ?? 'refused').replace(/_/g, ' ')}`,
        });
        break;
      }
      case 'protocol.error':
        totals.protocol_errors += 1;
        errors.push({
          ts: event.ts,
          xs: event.xs ?? null,
          request_id: event.request_id ?? null,
          tool: null,
          kind: 'protocol_error',
          message: data.message ?? 'protocol error',
        });
        break;
      default:
        break;
    }
  }

  totals.sessions = sessions.size;
  totals.visitors = visitors.size;
  const sorted = [...durations].sort((a, b) => a - b);
  totals.p50_ms = percentileOf(sorted, 0.5);
  totals.p95_ms = percentileOf(sorted, 0.95);
  const clients = new Map();
  for (const tally of tallies.values()) {
    const label = tally.label ?? tally.userAgent ?? 'unknown client';
    const key = `${label}\u0000${tally.verdict ?? ''}\u0000${tally.agent ?? ''}`;
    const entry = clients.get(key) ?? {
      label,
      user_agent: tally.userAgent,
      signature_verdict: tally.verdict,
      signed_agent: tally.verdict ? tally.agent : null,
      sessions: 0,
      calls: 0,
    };
    entry.sessions += 1;
    entry.calls += tally.calls;
    clients.set(key, entry);
  }
  return {
    source: 'page',
    viewer_kind: 'fixture',
    window,
    as_of: new Date(anchor).toISOString(),
    since: window === 'all' ? null : new Date(sinceMs).toISOString(),
    covers_from: events[0]?.ts ?? null,
    boot_id: null,
    retention_hours: null,
    scanned: rows.length,
    truncated: false,
    bucket_minutes: bucketMinutes,
    totals,
    by_tool: [...tools.entries()]
      .map(([tool, entry]) => {
        const list = [...entry.durations].sort((a, b) => a - b);
        return {
          tool,
          calls: entry.calls,
          failed: entry.failed,
          p50_ms: percentileOf(list, 0.5),
          p95_ms: percentileOf(list, 0.95),
        };
      })
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
    by_client: [...clients.values()].sort((a, b) => b.calls - a.calls),
    by_time: buckets.map((bucket, index) => ({
      start: new Date(firstBucket + index * bucketMs).toISOString(),
      ...bucket,
    })),
    top_arguments: [...argumentsSeen.values()].sort((a, b) => b.count - a.count).slice(0, 12),
    recent_errors: errors.slice(-8).reverse(),
  };
}

// ---------------------------------------------------------------------------
// The chart: calls per bucket, the failed share stacked on top in the status colour
// ---------------------------------------------------------------------------

function bucketLabel(start, minutes) {
  const date = new Date(start);
  if (minutes >= 1440) return date.toISOString().slice(5, 10);
  return clockTime(start).slice(0, 5);
}

export function callsOverTimeChart(buckets, bucketMinutes) {
  // Drawn for the full width of the page, so the ticks stay near their CSS size when it scales.
  const width = 1280;
  const height = 190;
  const pad = { top: 12, right: 8, bottom: 24, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const peak = Math.max(
    1,
    ...buckets.map((bucket) => bucket.calls + Math.max(0, bucket.failed - bucket.calls)),
  );
  const max = peak <= 4 ? 4 : Math.ceil(peak / 4) * 4;
  const slot = plotW / Math.max(1, buckets.length);
  const barW = Math.max(1, Math.min(18, slot - 2));
  const y = (value) => pad.top + plotH - (value / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  return h(
    'figure',
    { class: 'chart chart-calls' },
    h(
      'svg',
      {
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        class: 'chart-svg',
        'aria-label': `Tool calls per ${bucketMinutes} minutes`,
      },
      ...[0, max / 2, max].map((tick) =>
        h(
          'g',
          { class: 'chart-grid' },
          h('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick) }),
          h(
            'text',
            { x: pad.left - 6, y: y(tick) + 4, 'text-anchor': 'end', class: 'chart-tick' },
            String(Math.round(tick)),
          ),
        ),
      ),
      ...buckets.map((bucket, index) => {
        const x = pad.left + index * slot + (slot - barW) / 2;
        const failed = Math.min(bucket.failed, bucket.calls || bucket.failed);
        const ok = Math.max(0, bucket.calls - failed);
        const title = `${shortDateTime(bucket.start)}: ${plural(bucket.calls, 'call')}${bucket.failed ? `, ${count(bucket.failed)} failed or denied` : ''}`;
        return h(
          'g',
          { class: 'chart-bucket' },
          h(
            'rect',
            {
              class: 'chart-hit',
              x: pad.left + index * slot,
              y: pad.top,
              width: slot,
              height: plotH,
            },
            h('title', {}, title),
          ),
          ok > 0
            ? h(
                'rect',
                {
                  class: 'chart-bar chart-in',
                  x,
                  y: y(ok),
                  width: barW,
                  height: (ok / max) * plotH,
                  rx: 1.5,
                },
                h('title', {}, title),
              )
            : null,
          failed > 0
            ? h(
                'rect',
                {
                  class: 'chart-bar chart-failed',
                  x,
                  y: y(ok + failed),
                  width: barW,
                  height: Math.max(1, (failed / max) * plotH - 1),
                  rx: 1.5,
                },
                h('title', {}, title),
              )
            : null,
          index % labelEvery === 0
            ? h(
                'text',
                { x: x + barW / 2, y: height - 7, 'text-anchor': 'middle', class: 'chart-tick' },
                bucketLabel(bucket.start, bucketMinutes),
              )
            : null,
        );
      }),
      h('line', { class: 'chart-axis', x1: pad.left, x2: width - pad.right, y1: y(0), y2: y(0) }),
    ),
    h(
      'figcaption',
      { class: 'chart-legend' },
      h(
        'span',
        { class: 'legend-item' },
        h('span', { class: 'legend-swatch chart-in' }),
        'Calls that answered',
      ),
      h(
        'span',
        { class: 'legend-item' },
        h('span', { class: 'legend-swatch chart-failed' }),
        'Failed or denied',
      ),
      h(
        'span',
        { class: 'legend-note' },
        `One bar per ${bucketMinutes >= 1440 ? 'day' : bucketMinutes >= 60 ? `${bucketMinutes / 60} h` : `${bucketMinutes} min`}. Hover a bar for its numbers.`,
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function coverage(payload, view) {
  if (payload.source === 'page') {
    return `Counted by this page from the recording (${count(payload.scanned)} events), because sample mode has no server to ask.`;
  }
  let counted = `Counted by this server over its own log (${count(payload.scanned)} events read)`;
  if (payload.covers_from) counted += `, which goes back to ${shortDateTime(payload.covers_from)}`;
  const parts = [counted];
  parts.push(`It keeps ${payload.retention_hours} h at most and forgets everything on a restart`);
  if (payload.truncated) parts.push('The scan stopped at its cap, so these are lower bounds');
  const who =
    view.viewer?.viewer_kind === 'public'
      ? 'Only the anonymous calls of /public/mcp are counted here.'
      : view.viewer?.viewer_kind === 'admin'
        ? 'Every lane is counted; argument values are left out in observer mode.'
        : 'Only the sessions of your own login are counted.';
  return `${parts.join('. ')}. ${who}`;
}

function tiles(totals) {
  const failed = totals.calls_failed + totals.calls_denied;
  return h(
    'div',
    { class: 'overview-tiles' },
    stat('sessions', count(totals.sessions), { title: 'Distinct X-ray sessions (xs)' }),
    stat('visitors', count(totals.visitors), {
      title: 'Distinct grants. On the public lane one pseudo grant per IP prefix and User-Agent.',
    }),
    stat('tool calls', count(totals.calls)),
    stat('failed', count(failed), {
      tone: failed ? 'warn' : null,
      title: `${count(totals.calls_failed)} returned an error, ${count(totals.calls_denied)} were denied before they ran`,
    }),
    stat('median call', totals.p50_ms === null ? '-' : duration(totals.p50_ms), {
      title: 'Tool call duration, 50th percentile',
    }),
    stat('p95 call', totals.p95_ms === null ? '-' : duration(totals.p95_ms), {
      title: 'Tool call duration, 95th percentile',
    }),
    stat('signed', `${count(totals.verified_requests)} / ${count(totals.signed_requests)}`, {
      title:
        'HTTP requests with a Web Bot Auth signature that verified, out of those that carried one',
    }),
    stat('no rationale', count(totals.calls_without_rationale), {
      tone: totals.calls_without_rationale ? 'warn' : null,
      title: 'Calls whose rationale argument was missing (A-06)',
    }),
    stat('rate limited', count(totals.rate_limited), { tone: totals.rate_limited ? 'warn' : null }),
  );
}

function toolsTable(rows) {
  const top = Math.max(1, ...rows.map((row) => row.calls));
  return table(
    ['Tool', 'Calls', 'Failed', 'p50', 'p95'],
    rows.map((row) =>
      h(
        'tr',
        {},
        h('td', { class: 'mono' }, row.tool),
        h(
          'td',
          { class: 'num' },
          h('span', { class: 'inline-meter' }, meter(row.calls, top, { tone: 'ok' })),
          h('span', { class: 'mono' }, count(row.calls)),
        ),
        h('td', { class: cx('num mono', row.failed && 'is-warn') }, count(row.failed)),
        h('td', { class: 'num mono' }, row.p50_ms === null ? '' : duration(row.p50_ms)),
        h('td', { class: 'num mono' }, row.p95_ms === null ? '' : duration(row.p95_ms)),
      ),
    ),
    { class: 'overview-table' },
  );
}

function clientsTable(rows) {
  return table(
    ['Client, as it presented itself', 'Proof', 'Sessions', 'Calls'],
    rows.map((row) =>
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h('div', { class: 'line-main mono' }, row.label),
          row.user_agent && row.user_agent !== row.label
            ? h('div', { class: 'line-sub mono' }, row.user_agent)
            : null,
        ),
        h('td', {}, verdictBadge(row.signature_verdict, row.signed_agent)),
        h('td', { class: 'num mono' }, count(row.sessions)),
        h('td', { class: 'num mono' }, count(row.calls)),
      ),
    ),
    { class: 'overview-table' },
  );
}

function argumentsList(rows) {
  const top = Math.max(1, ...rows.map((row) => row.count));
  return h(
    'ol',
    { class: 'argument-list' },
    ...rows.map((row) =>
      h(
        'li',
        { class: 'argument-row' },
        h(
          'span',
          { class: 'argument-what' },
          h('span', { class: 'mono muted' }, `${row.tool} · ${row.key} =`),
          ' ',
          h('span', { class: 'mono who-model argument-value' }, row.value),
        ),
        h('span', { class: 'inline-meter' }, meter(row.count, top, { tone: 'ok' })),
        h('span', { class: 'mono argument-count' }, count(row.count)),
      ),
    ),
  );
}

function errorsList(rows) {
  return h(
    'ol',
    { class: 'error-list' },
    ...rows.map((row) =>
      h(
        'li',
        { class: 'error-row' },
        h('span', { class: 'mono error-time' }, shortDateTime(row.ts)),
        tag(row.kind.replace('_', ' '), 'tag-warn'),
        row.tool ? h('span', { class: 'mono' }, row.tool) : null,
        h('span', { class: 'error-message' }, row.message),
        row.xs
          ? button('open', 'open-session', {
              arg: row.xs,
              variant: 'chip',
              title: `Open session ${row.xs} in the chain`,
            })
          : null,
      ),
    ),
  );
}

function card(title, note, ...body) {
  return h(
    'section',
    { class: 'account-card' },
    h(
      'header',
      { class: 'account-card-head' },
      h('h3', { class: 'account-card-title' }, title),
      note ? h('p', { class: 'account-card-note' }, note) : null,
    ),
    ...body,
  );
}

export function renderOverview(model) {
  const { view } = model;
  const overview = view.overview ?? {};
  const payload = overview.payload;
  const isPublic = view.viewer?.viewer_kind === 'public';
  const title = isPublic
    ? 'The public lane at a glance'
    : view.viewer?.viewer_kind === 'admin'
      ? 'Every lane at a glance'
      : 'Your sessions at a glance';
  const sub = isPublic
    ? 'Anonymous agents reading what the bank publishes through /public/mcp, with no sign-in. Every one of these calls was made knowing it is shown here.'
    : 'What the agents connected to this bank are doing, without reading a single event.';

  const head = h(
    'header',
    { class: 'page-head' },
    h(
      'div',
      { class: 'page-title-block' },
      h('h2', { class: 'page-title' }, title),
      h('p', { class: 'page-sub' }, sub),
    ),
    h(
      'div',
      { class: 'page-controls' },
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': 'Time window' },
        ...OVERVIEW_WINDOWS.map((entry) =>
          button(entry.label, 'overview-window', {
            arg: entry.id,
            variant: 'seg',
            pressed: (overview.window ?? '24h') === entry.id,
          }),
        ),
      ),
      view.mode === 'fixture'
        ? null
        : button(overview.busy ? 'Counting…' : 'Refresh', 'overview-refresh', {
            variant: 'quiet',
            disabled: overview.busy,
          }),
    ),
  );

  if (!payload) {
    return h(
      'div',
      { class: 'page page-overview' },
      head,
      overview.error
        ? emptyState(
            'The overview could not be counted',
            overview.error,
            button('Try again', 'overview-refresh', { variant: 'quiet' }),
          )
        : emptyState('Counting', 'Sessions, calls, failures and clients over the window above.'),
    );
  }

  const totals = payload.totals;
  return h(
    'div',
    { class: 'page page-overview' },
    head,
    h('p', { class: 'overview-coverage' }, coverage(payload, view)),
    tiles(totals),
    totals.calls === 0 && totals.http_requests === 0
      ? emptyState(
          'Nothing in this window',
          'Pick a longer window, or connect a client and call a tool.',
        )
      : null,
    card(
      'Tool calls over time',
      null,
      callsOverTimeChart(payload.by_time ?? [], payload.bucket_minutes),
    ),
    h(
      'div',
      { class: 'account-grid' },
      card(
        'Tools',
        'Busiest first. Duration is how long this server took, from the request arriving to the answer leaving.',
        payload.by_tool.length
          ? toolsTable(payload.by_tool)
          : h('p', { class: 'muted' }, 'No tool calls.'),
      ),
      card(
        'Who is calling',
        'The name each client chose to send, and whether a Web Bot Auth signature proved it. Only “signed by …” is evidence.',
        payload.by_client.length
          ? clientsTable(payload.by_client)
          : h('p', { class: 'muted' }, 'No sessions.'),
      ),
    ),
    h(
      'div',
      { class: 'account-grid' },
      view.viewer?.viewer_kind === 'admin'
        ? null
        : card(
            'What they asked for',
            'The argument values the model sent most often, redacted like the timeline. Never the rationale.',
            payload.top_arguments.length
              ? argumentsList(payload.top_arguments)
              : h('p', { class: 'muted' }, 'No arguments yet.'),
          ),
      card(
        'Latest problems',
        'Tool errors, denials, protocol errors and rate limits, newest first.',
        payload.recent_errors.length
          ? errorsList(payload.recent_errors)
          : h('p', { class: 'muted' }, 'None in this window.'),
      ),
    ),
  );
}
