/**
 * The "now" strip (block: dashboard).
 *
 * While a `tool.call.started` has no matching completion, this shows the elapsed time of that call
 * against the 300 s budget claude.ai allows per tool call (`CLAUDE_TOOL_BUDGET_MS`). With nothing
 * in flight it keeps the same bar and shows the last completed call, so the budget is always on
 * screen and the strip never makes the layout jump.
 */
import { h } from './h.js';
import { meter, statusBadge } from './ui.js';
import { clockTime, duration, ratio, seconds, share } from './format.js';

/** `model` is `{ store, view, now }`; `now` is the dashboard clock, injected for testability. */
export function renderNowStrip(model) {
  const { store, view, now } = model;
  const inFlight = store.getInFlightCalls().filter((call) => !view.selectedXs || call.xs === view.selectedXs);
  const current = inFlight[0] ?? null;
  const finished = current
    ? null
    : store
        .getCalls({ xs: view.selectedXs })
        .filter((call) => call.status !== 'running')
        .slice(-1)[0] ?? null;
  const call = current ?? finished;

  if (!call) {
    return h(
      'div',
      { class: 'now-strip is-idle' },
      h('span', { class: 'now-label' }, 'No tool call yet'),
      h(
        'span',
        { class: 'now-detail' },
        'When your Claude client calls a tool, its elapsed time appears here against the 300 s budget.',
      ),
    );
  }

  const elapsed = current
    ? Math.max(0, now - (call.started_epoch ?? now))
    : (call.duration_ms ?? 0);
  const used = ratio(elapsed, call.budget_ms);

  return h(
    'div',
    { class: `now-strip ${current ? 'is-live' : 'is-done'}` },
    h(
      'div',
      { class: 'now-lead' },
      current ? h('span', { class: 'live-dot' }) : null,
      h('span', { class: 'now-label' }, current ? 'In flight' : 'Last call'),
      h(
        'button',
        {
          type: 'button',
          class: 'now-tool mono',
          'data-action': 'select-call',
          'data-arg': call.key,
          title: 'Open this call in the inspector',
        },
        call.tool,
      ),
      current ? null : statusBadge(call.status === 'cancelled' ? 'warn' : call.status),
    ),
    h(
      'div',
      { class: 'now-bar' },
      meter(elapsed, call.budget_ms, {
        tone: used > 0.75 ? 'error' : used > 0.4 ? 'warn' : 'ok',
        label: `${duration(elapsed)} of ${duration(call.budget_ms)}`,
      }),
    ),
    h(
      'div',
      { class: 'now-numbers' },
      h('span', { class: 'now-elapsed mono' }, duration(elapsed)),
      h('span', { class: 'now-budget' }, `/ ${seconds(call.budget_ms)} budget`),
      h('span', { class: 'now-share mono' }, share(elapsed, call.budget_ms)),
    ),
    h(
      'div',
      { class: 'now-meta' },
      h('span', { class: 'mono', title: call.started_at }, clockTime(call.started_at)),
      call.rationale_present
        ? h(
            'span',
            {
              class: 'tag now-said band-model',
              title: 'Written by the model in the `rationale` argument; it is not your message.',
            },
            h('span', { class: 'band-who-name' }, 'model said:'),
          )
        : null,
      call.rationale_present
        ? // The strip clips to one line, so the whole sentence has to live in the tooltip.
          h('span', { class: 'now-rationale', title: call.rationale }, call.rationale)
        : h('span', { class: 'now-rationale is-missing' }, 'no rationale supplied'),
    ),
  );
}
