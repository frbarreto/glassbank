/**
 * Panel 3 - Call inspector (block: dashboard).
 *
 * The answer to "which tool was called, with what arguments and what stated intent, what did the
 * SQL do and what came back". Fed by `tool.*` with the `bank.*`, `etl.*`, `sql.*`, `intent.*` and
 * `auth.stepup.requested` events that carry the same `request_id` nested underneath
 * (docs/XRAY_EVENT_MODEL.md section 7, panel 3).
 *
 * With no call selected it falls back to the raw envelope of whatever row is selected, which is
 * also how an event type the dashboard does not know yet is displayed.
 */
import { cx, h } from './h.js';
import {
  argumentList,
  callout,
  codeBlock,
  emptyState,
  familyTag,
  kv,
  kvList,
  meter,
  section,
  statusBadge,
  tag,
} from './ui.js';
import {
  charCount,
  clockTime,
  count,
  duration,
  joinList,
  ratio,
  seconds,
  share,
} from './format.js';
import { isKnownType, labelOf, statusOf, summaryOf } from './catalogue.js';
import { jsonView, viewerId } from './json-view.js';

const STATUS_TEXT = {
  ok: 'Completed',
  error: 'Failed',
  denied: 'Denied before it ran',
  running: 'In flight',
  cancelled: 'Cancelled',
};

function childDetail(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case 'sql.query':
    case 'sql.rejected':
      return codeBlock(data.sql, { lang: 'sql', id: `sql-child-${event.id}` });
    case 'etl.processed':
      return h(
        'p',
        { class: 'child-note' },
        `Columns kept: ${joinList(data.columns_selected)}`,
      );
    case 'etl.load':
      return h(
        'p',
        { class: 'child-note' },
        `Columns advertised: ${joinList(data.columns_advertised)}`,
      );
    case 'intent.declared':
      return null;
    default:
      return null;
  }
}

function childRow(event, view) {
  return h(
    'div',
    { class: cx('child', view.selectedEventId === event.id && 'is-selected') },
    h(
      'button',
      {
        type: 'button',
        class: 'child-head',
        'data-action': 'select-event',
        'data-arg': String(event.id),
      },
      familyTag(event.type),
      h('span', { class: 'child-time mono', title: event.ts }, clockTime(event.ts)),
      h('span', { class: 'child-label' }, labelOf(event.type)),
      // `.child-summary` clips with an ellipsis; without this the tail of the summary is gone.
      h('span', { class: 'child-summary', title: summaryOf(event) }, summaryOf(event)),
    ),
    childDetail(event),
  );
}

function timingBlock(call, now) {
  const elapsed =
    call.duration_ms ?? (call.started_epoch ? Math.max(0, now - call.started_epoch) : null);
  const used = ratio(elapsed ?? 0, call.budget_ms);
  return h(
    'div',
    { class: 'timing' },
    h(
      'div',
      { class: 'timing-head' },
      h('span', { class: 'timing-value mono' }, duration(elapsed)),
      h(
        'span',
        { class: 'timing-budget' },
        `of the ${seconds(call.budget_ms)} per-call budget claude.ai allows`,
      ),
      h('span', { class: 'timing-share mono' }, share(elapsed ?? 0, call.budget_ms)),
    ),
    meter(elapsed ?? 0, call.budget_ms, {
      tone: used > 0.75 ? 'error' : used > 0.4 ? 'warn' : 'ok',
      label: `${duration(elapsed)} of ${duration(call.budget_ms)}`,
    }),
  );
}

function resultBlock(call, json) {
  if (call.status === 'running') {
    return h('p', { class: 'muted' }, 'The call has not returned yet.');
  }
  if (call.status === 'denied') {
    return callout(
      'The call never reached the tool',
      `The bearer gate answered before the handler ran: ${
        call.denied_reason ?? 'denied'
      }. Missing scopes: ${joinList(call.missing_scopes)}.`,
      'warn',
    );
  }
  const capUsed = ratio(call.content_chars, call.content_cap);
  return h(
    'div',
    { class: 'result' },
    kvList(
      kv('Content types', joinList(call.content_types)),
      kv(
        'Size',
        h(
          'span',
          {},
          charCount(call.content_chars),
          h(
            'span',
            { class: 'muted' },
            ` · ${share(call.content_chars, call.content_cap)} of the ${charCount(
              call.content_cap,
            )} cap`,
          ),
        ),
      ),
    ),
    meter(call.content_chars, call.content_cap, {
      tone: capUsed > 0.8 ? 'error' : capUsed > 0.5 ? 'warn' : 'ok',
      label: 'result size against the cap',
    }),
    call.error
      ? callout(
          `${call.error.class === 'protocol' ? 'Protocol error' : 'Tool error'}${
            call.error.code === null || call.error.code === undefined ? '' : ` ${call.error.code}`
          }`,
          call.error.message,
          'error',
        )
      : null,
    call.text_preview
      ? h(
          'div',
          { class: 'result-preview' },
          h('h4', { class: 'sub-title' }, 'Text content (first 2 KB, as stored)'),
          codeBlock(call.text_preview, { id: `text-${call.key}` }),
        )
      : null,
    call.structured_content
      ? h(
          'div',
          { class: 'result-preview' },
          jsonView(call.structured_content, {
            id: viewerId('structured', call.key),
            state: json,
            title: 'Structured content',
          }),
        )
      : null,
  );
}

function renderCall(model, call) {
  const { store, view, now } = model;
  const children = call.child_event_ids
    .map((id) => store.getEventById(id))
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
  return section(
    'Call inspector',
    `request ${call.request_id ?? '-'} · ${call.xs ?? 'no session'}`,
    h(
      'div',
      { class: 'call-head' },
      h('h2', { class: 'call-tool mono' }, call.tool),
      statusBadge(call.status === 'cancelled' ? 'warn' : call.status, STATUS_TEXT[call.status]),
      call.required_scopes.length ? tag(joinList(call.required_scopes), 'tag-quiet') : null,
    ),
    timingBlock(call, now),
    h(
      'div',
      { class: 'call-section' },
      h('h4', { class: 'sub-title' }, 'Stated intent'),
      call.rationale_present && call.rationale
        ? h(
            'blockquote',
            { class: 'rationale' },
            call.rationale,
            h(
              'footer',
              { class: 'rationale-source' },
              'written by the model in the `rationale` argument, stored verbatim',
              call.rationale_truncated ? ' (truncated by the server)' : '',
            ),
          )
        : callout(
            'No rationale supplied',
            'The tool schema advertises `rationale` as required, but the server validates leniently so a cached client is never hard-failed (ADR-8). The call ran and `intent.missing` was emitted.',
            'warn',
          ),
    ),
    h(
      'div',
      { class: 'call-section' },
      h(
        'h4',
        { class: 'sub-title' },
        'Arguments',
        call.redacted_fields.length
          ? h('span', { class: 'sub-note' }, `${call.redacted_fields.length} field(s) redacted`)
          : h('span', { class: 'sub-note' }, 'stored verbatim'),
      ),
      argumentList(call.arguments, call.redacted_fields, {
        id: viewerId('args', call.key),
        state: view.json ?? {},
      }),
    ),
    call.meta
      ? h(
          'div',
          { class: 'call-section' },
          jsonView(call.meta, {
            id: viewerId('meta', call.key),
            state: view.json ?? {},
            title: 'JSON-RPC _meta',
          }),
        )
      : null,
    h(
      'div',
      { class: 'call-section' },
      h('h4', { class: 'sub-title' }, 'Result'),
      resultBlock(call, view.json ?? {}),
    ),
    h(
      'div',
      { class: 'call-section' },
      h(
        'h4',
        { class: 'sub-title' },
        'What the server did',
        h('span', { class: 'sub-note' }, `${count(children.length)} event(s) inside this call`),
      ),
      children.length
        ? h('div', { class: 'children' }, ...children.map((event) => childRow(event, view)))
        : h('p', { class: 'muted' }, 'No bank, ETL or SQL work was recorded inside this call.'),
    ),
  );
}

function renderEvent(model, event) {
  const { view } = model;
  const known = isKnownType(event.type);
  return section(
    'Event inspector',
    `event ${count(event.id)}${event.xs ? ` · ${event.xs}` : ''}`,
    h(
      'div',
      { class: 'call-head' },
      familyTag(event.type),
      h('h2', { class: 'call-tool mono' }, event.type),
      statusBadge(statusOf(event)),
      known ? null : h('span', { class: 'badge badge-warn' }, 'unknown to this dashboard'),
    ),
    h('p', { class: 'event-summary' }, summaryOf(event)),
    known
      ? null
      : callout(
          'This event type is newer than the dashboard',
          'The contract is append-only, so the server may emit a family this build does not render yet. The envelope below is the whole event, unmodified.',
          'info',
        ),
    kvList(
      kv('Time', h('span', { class: 'mono' }, `${clockTime(event.ts)} · ${event.ts}`)),
      kv('Session', h('span', { class: 'mono' }, event.xs ?? 'none'), { mono: true }),
      kv('Grant', h('span', { class: 'mono' }, event.grant_id ?? 'none')),
      kv('Login', h('span', { class: 'mono' }, event.login_id ?? 'none')),
      kv('Sequence', event.seq === null || event.seq === undefined ? '-' : count(event.seq)),
      kv('JSON-RPC id', h('span', { class: 'mono' }, event.request_id ?? 'none')),
      kv('Protocol', h('span', { class: 'mono' }, event.protocol_version ?? 'none')),
      kv('Era', event.era ?? 'none'),
    ),
    h(
      'div',
      { class: 'call-section' },
      jsonView(event, {
        id: viewerId('envelope', event.id),
        state: view.json ?? {},
        title: 'Raw envelope',
      }),
    ),
  );
}

/** The whole panel. `model` is `{ store, view, now }`. */
export function renderInspector(model) {
  const { store, view } = model;
  const call = view.selectedCallKey ? store.getCall(view.selectedCallKey) : null;
  if (call) return renderCall(model, call);
  const event = view.selectedEventId ? store.getEventById(view.selectedEventId) : null;
  if (event) return renderEvent(model, event);
  return section(
    'Call inspector',
    null,
    emptyState(
      'Pick a row in the timeline',
      'Selecting a tool call shows its arguments, the rationale the model wrote, the bank and SQL work it triggered, and what came back. Any other row shows its raw envelope.',
    ),
  );
}
