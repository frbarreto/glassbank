/**
 * Panel 8 - Errors and health (block: dashboard).
 *
 * Protocol errors against tool errors (they are different failures: one never reaches a handler),
 * per-tool p50 and p95 computed in the browser from the calls in the replay window, the state of
 * the viewer stream itself, and the initialize-loop signal.
 *
 * Fed by `protocol.*`, `tool.*`, `xray.*` and `http.*`.
 */
import { cx, h } from './h.js';
import { callout, emptyState, section, stat, statusBadge, table } from './ui.js';
import { clockTime, count, duration, relativeTime } from './format.js';
import { labelOf, statusOf, summaryOf } from './catalogue.js';

const ERROR_TYPES = new Set([
  'protocol.error',
  'sql.rejected',
  'auth.rejected',
  'session.rejected',
  'xray.pairing.rejected',
  'xray.dropped',
  'etl.worker_terminated',
  'etl.limit_reached',
  'tool.call.denied',
  'tool.call.cancelled',
]);

function isFailure(event) {
  if (ERROR_TYPES.has(event.type)) return true;
  if (event.type === 'tool.call.completed') return Boolean(event.data?.is_error);
  if (event.type === 'http.request') return Number(event.data?.status ?? 0) >= 400;
  if (event.type === 'bank.op') return event.data?.ok === false;
  return false;
}

const CONNECTION_TEXT = {
  open: ['ok', 'live'],
  connecting: ['warn', 'connecting'],
  reconnecting: ['warn', 'reconnecting'],
  closed: ['error', 'disconnected'],
  idle: ['info', 'idle'],
  fixture: ['info', 'fixture'],
};

/** The whole panel. `model` is `{ store, view, now }`. */
export function renderErrorsHealth(model) {
  const { store, view, now } = model;
  const xs = view.selectedXs ?? null;
  const events = store.getEvents({ xs });
  const counters = store.getCounters({ xs });
  const stats = store.getToolStats({ xs });
  const failures = events.filter(isFailure).slice(-40).reverse();
  const initializes = events.filter((event) => event.type === 'session.initialized').length;
  const [connectionTone, connectionLabel] =
    CONNECTION_TEXT[view.connection?.state] ?? CONNECTION_TEXT.idle;

  return section(
    'Errors and health',
    xs ? `session ${xs}` : 'every session in view',
    h(
      'div',
      { class: 'stat-row' },
      stat('protocol errors', count(counters.protocol_errors), {
        tone: counters.protocol_errors ? 'error' : null,
        title: 'JSON-RPC errors: the request never reached a tool handler',
      }),
      stat('failed calls', count(counters.errors), {
        tone: counters.errors ? 'warn' : null,
        title: 'Tool calls that returned isError, plus calls denied before they ran',
      }),
      stat('SQL rejected', count(counters.rejected_sql), {
        tone: counters.rejected_sql ? 'warn' : null,
      }),
      stat('HTTP 4xx/5xx', count(counters.http_errors)),
      stat('initialize calls', count(initializes), { tone: initializes > 5 ? 'warn' : null }),
      stat('events dropped', count(counters.dropped_events), {
        tone: counters.dropped_events ? 'warn' : null,
        title: 'Events a viewer stream dropped under backpressure; reconnecting with Last-Event-ID backfills them',
      }),
    ),
    h(
      'div',
      { class: 'health-stream' },
      h('h4', { class: 'sub-title' }, 'This dashboard stream'),
      h(
        'div',
        { class: 'stream-facts' },
        h('span', {}, statusBadge(connectionTone, connectionLabel)),
        h('span', {}, `${count(store.size)} events held`),
        h('span', { class: 'mono' }, `last event id ${count(store.lastEventId)}`),
        h('span', {}, `${count(view.connection?.attempts ?? 0)} reconnect(s)`),
        view.connection?.lastError
          ? h('span', { class: 'is-error' }, view.connection.lastError)
          : null,
        store.lastEventTs
          ? h('span', {}, `last event ${relativeTime(store.lastEventTs, now)}`)
          : null,
      ),
    ),
    initializes > 5
      ? callout(
          'Repeated initialize handshakes',
          `This session has re-run initialize ${initializes} times. claude.ai reconnects every 25-80 seconds; the server keeps one X-ray session and counts them instead of fragmenting the history (A-27).`,
          'warn',
        )
      : null,
    h('h4', { class: 'sub-title' }, 'Latency per tool'),
    stats.length
      ? table(
          ['Tool', 'Calls', 'Failed', 'p50', 'p95', 'slowest'],
          stats.map((row) =>
            h(
              'tr',
              { class: cx('stat-row-line', row.errors && 'has-errors') },
              h('td', { class: 'mono' }, row.tool),
              h('td', { class: 'mono nowrap' }, count(row.calls)),
              h('td', { class: cx('mono nowrap', row.errors && 'is-error') }, count(row.errors)),
              h('td', { class: 'mono nowrap' }, duration(row.p50)),
              h('td', { class: 'mono nowrap' }, duration(row.p95)),
              h('td', { class: 'mono nowrap' }, duration(row.max)),
            ),
          ),
          { class: 'latency-table' },
        )
      : h('p', { class: 'muted' }, 'No completed calls in the replay window.'),
    h('h4', { class: 'sub-title' }, 'Everything that went wrong'),
    failures.length
      ? table(
          ['Time', 'Event', 'What happened'],
          failures.map((event) =>
            h(
              'tr',
              { class: `fail-row fail-${statusOf(event)}` },
              h('td', { class: 'mono nowrap', title: event.ts }, clockTime(event.ts)),
              h(
                'td',
                {},
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'link',
                    'data-action': 'select-event',
                    'data-arg': String(event.id),
                  },
                  labelOf(event.type),
                ),
              ),
              h('td', {}, summaryOf(event)),
            ),
          ),
          { class: 'fail-table' },
        )
      : emptyState('Nothing has failed', 'No protocol error, failed call, rejected statement or dropped event in the window.'),
    h(
      'p',
      { class: 'panel-footnote' },
      'p50 and p95 are computed in this browser from the calls currently held, not by the server, so they move as the replay window slides.',
    ),
  );
}
