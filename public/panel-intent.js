/**
 * Panel 6 - Intent (block: dashboard).
 *
 * What the model said it was doing, and what this server guessed. The disclaimer is not decoration:
 * the server sees the `rationale` argument and nothing else of the conversation
 * (docs/XRAY_EVENT_MODEL.md section 1), so declared intent is labelled model-authored and inferred
 * intent is labelled as this server's guess.
 *
 * Fed by `intent.declared`, `intent.inferred` and `intent.missing`.
 */
import { h } from './h.js';
import { callout, emptyState, meter, section, stat, statusBadge, tag } from './ui.js';
import { clockTime, count, share } from './format.js';

const CANNOT_SEE = [
  'the text you typed in chat',
  'the model’s reasoning',
  'the answer the model finally gave you',
  'any other connector in the conversation',
  'the approvals you clicked in the Claude interface',
  'token usage or the conversation id',
];

/** The whole panel. `model` is `{ store, view, now }`. */
export function renderIntent(model) {
  const { store, view } = model;
  const xs = view.selectedXs ?? null;
  const events = store.getEvents({ xs });
  const declared = events.filter((event) => event.type === 'intent.declared');
  const missing = events.filter((event) => event.type === 'intent.missing');
  const inferred = events.filter((event) => event.type === 'intent.inferred').slice(-1)[0] ?? null;
  const calls = store.getCalls({ xs });
  const withRationale = calls.filter((call) => call.rationale_present).length;

  return section(
    'Intent',
    `${count(declared.length)} declared · ${count(missing.length)} missing`,
    callout(
      'The server cannot see your conversation',
      `Everything on this page comes from the protocol. The only sentence the model writes for us is the “rationale” argument on each tool call. The server never sees ${CANNOT_SEE.join(
        ', ',
      )}.`,
      'info',
    ),
    h(
      'div',
      { class: 'stat-row' },
      stat('calls with a rationale', `${count(withRationale)} / ${count(calls.length)}`, {
        tone: withRationale === calls.length ? 'ok' : 'warn',
      }),
      stat('coverage', share(withRationale, calls.length || 1)),
      stat('missing', count(missing.length), { tone: missing.length ? 'warn' : null }),
    ),
    meter(withRationale, calls.length || 1, {
      tone: withRationale === calls.length ? 'ok' : 'warn',
      label: 'share of calls that carried a rationale',
    }),
    inferred
      ? h(
          'div',
          { class: 'inferred' },
          h(
            'div',
            { class: 'inferred-head' },
            h('h4', { class: 'sub-title' }, 'Inferred workflow'),
            tag('inferred by this server, not by the model', 'tag-warn'),
          ),
          h(
            'p',
            { class: 'inferred-value' },
            String(inferred.data?.workflow ?? 'unknown').replace(/_/g, ' '),
            h(
              'span',
              {
                class: 'inferred-confidence mono',
                title:
                  'How far ahead the winning workflow scored, not a probability: 0.4 + 0.45 x the margin over the runner-up, clamped.',
              },
              `scored ${Number(inferred.data?.confidence ?? 0).toFixed(2)}`,
            ),
          ),
          h(
            'p',
            { class: 'muted' },
            `Classified from the tool sequence ${(inferred.data?.tools ?? []).join(' → ') || 'observed so far'}.`,
          ),
        )
      : null,
    h('h4', { class: 'sub-title' }, 'Declared intent, verbatim'),
    declared.length === 0 && missing.length === 0
      ? emptyState(
          'No rationale recorded yet',
          'Every tool in this catalog advertises a required `rationale` argument. It appears here the moment a call carries one.',
        )
      : h(
          'ol',
          { class: 'intent-list' },
          ...[...declared, ...missing]
            .sort((a, b) => a.id - b.id)
            .map((event) =>
              event.type === 'intent.declared'
                ? h(
                    'li',
                    { class: 'intent-item' },
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'intent-head',
                        'data-action': 'select-event',
                        'data-arg': String(event.id),
                      },
                      h('span', { class: 'mono intent-time', title: event.ts }, clockTime(event.ts)),
                      h('span', { class: 'mono intent-tool' }, event.data?.tool ?? 'unknown tool'),
                      tag('model-authored', 'tag-strong'),
                      event.data?.truncated ? tag('truncated', 'tag-warn') : null,
                    ),
                    h('blockquote', { class: 'rationale' }, event.data?.text ?? ''),
                  )
                : h(
                    'li',
                    { class: 'intent-item is-missing' },
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'intent-head',
                        'data-action': 'select-event',
                        'data-arg': String(event.id),
                      },
                      h('span', { class: 'mono intent-time', title: event.ts }, clockTime(event.ts)),
                      h('span', { class: 'mono intent-tool' }, event.data?.tool ?? 'unknown tool'),
                      statusBadge('warn', 'no rationale'),
                    ),
                    h(
                      'p',
                      { class: 'muted' },
                      `The call arrived without a usable rationale (${event.data?.reason ?? 'absent'}). It still ran: the server-side schema is lenient on purpose, so a client caching an older tools/list is never hard-failed (ADR-8).`,
                    ),
                  ),
            ),
        ),
  );
}
