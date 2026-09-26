/**
 * Panel 2 - Live timeline (block: dashboard).
 *
 * Two ways to read the same stream, switched by `view.timelineMode`:
 *
 * - `chain` (the default): the calls grouped into episodes, and inside each episode a single
 *   column of calls joined by connectors that name what actually flowed from one call into the
 *   next - the scratch table, the transfer preview, the id the model copied out of an earlier
 *   result. The wiring is derived in `chain.js` from the events themselves, never guessed.
 *   Every episode, and every call inside it, is a block that opens and closes from the control
 *   that heads it (`public/open-state.js`): a closed call is one line - the model's arguments, an
 *   arrow, the server's bytes - and an open one is the triptych of `public/panel-call.js`.
 *   Several calls stay open at once, and the depth control in the toolbar is the way back to the
 *   macro line. Selecting a call (the Bytes button) opens the inspector and expands nothing.
 *   Between the episodes, one-line context rows carry the events that explain the story (session
 *   start, listings, grants, tokens, restarts, evictions, erasures); HTTP, viewer and pairing
 *   noise is hidden.
 * - `events`: one row per event, newest at the bottom so the page reads like a log tail: family
 *   marker, clock, summary, latency bar against the call budget and a status badge. Unknown event
 *   types still get a row - they render with the generic marker and their payload is available in
 *   the inspector, which is what lets the server ship an event family before this UI knows about
 *   it.
 *
 * An episode is this dashboard's grouping and says nothing about what the user typed: the server
 * never sees the conversation (docs/XRAY_EVENT_MODEL.md section 1). Every episode header says so.
 *
 * Filters, pause and jump-to-live live in the toolbar above both.
 */
import { cx, h } from './h.js';
import {
  button,
  disclosure,
  emptyState,
  familyTag,
  meter,
  provenance,
  statusBadge,
  tag,
} from './ui.js';
import {
  clockSeconds,
  clockTime,
  count,
  duration,
  plural,
  ratio,
  seconds,
} from './format.js';
import {
  STATUS_LABELS,
  callKeyOf,
  familyOf,
  isKnownType,
  labelOf,
  statusOf,
  summaryOf,
} from './catalogue.js';
import { describeFilter, isEmptyFilter, matchesFilter } from './filters.js';
import { buildChain, incomingLinks, threadsOf } from './chain.js';
import { DEPTHS, callKey, episodeKey, isOpen, whyKey } from './open-state.js';
import { renderCallOpen, renderCallRow } from './panel-call.js';
import { ACTOR_MEANING, actorOfEvent, legend } from './provenance.js';

/** How many rows the events mode draws. Older matches stay in the store and in the counters. */
export const MAX_ROWS = 400;
/** How many episodes the chain mode draws; context rows before the oldest drawn one go too. */
export const MAX_EPISODES = 40;

/**
 * The one claim every episode header makes, always on screen. An episode is this dashboard's
 * grouping of the calls; the server never sees the conversation (docs/XRAY_EVENT_MODEL.md
 * section 1), so the header may never read as a record of what was asked for.
 */
export const EPISODE_HONESTY =
  'Grouped by this dashboard, not by the server, which never sees the conversation';

export const TIMELINE_MODES = ['chain', 'events'];

/**
 * The non-call events the chain mode draws as one-line context rows, always between episodes and
 * never inside one. `server.*` is handled by the boot divider; `auth.stepup.requested` and
 * `tool.call.denied` are shown only when no step already carries them.
 */
export const CONTEXT_TYPES = new Set([
  'session.started',
  'session.initialized',
  'session.ended',
  'session.rejected',
  'catalog.tools_listed',
  'auth.grant.created',
  'auth.grant.updated',
  'auth.stepup.requested',
  'auth.token.issued',
  'auth.token.refreshed',
  'auth.token.revoked',
  'tool.call.denied',
  'protocol.error',
  'etl.table_evicted',
  'etl.worker_terminated',
  'etl.limit_reached',
  'xray.dropped',
  /** v0.4: an erase leaves this behind, and a viewer must be able to see that it happened. */
  'xray.events.deleted',
]);

const QUICK_FILTERS = [
  { label: 'Tool calls', token: 'kind:tool' },
  { label: 'Rationale', token: 'kind:intent' },
  { label: 'SQL', token: 'kind:sql' },
  { label: 'Auth', token: 'kind:auth' },
  { label: 'HTTP', token: 'kind:http' },
  { label: 'Errors', token: 'status:error' },
];

function modeOf(view) {
  return TIMELINE_MODES.includes(view.timelineMode) ? view.timelineMode : 'chain';
}

// ---------------------------------------------------------------------------
// Events mode
// ---------------------------------------------------------------------------

/**
 * The row bar is scaled to the slowest event in view, not to the 300 s budget: against the budget
 * every real call is a flat line. The budget comparison is where it means something - the "now"
 * strip and the call inspector - and the tooltip here names both scales.
 */
function latencyCell(event, scaleMs) {
  const data = event.data ?? {};
  const ms = data.duration_ms ?? data.latency_ms ?? null;
  if (ms === null || ms === undefined) return h('span', { class: 'row-latency-empty' }, '');
  const budget = Number(data.budget_ms ?? 0);
  const share = ratio(ms, scaleMs);
  const title = budget
    ? `${duration(ms)}; ${(ratio(ms, budget) * 100).toFixed(2)}% of the ${seconds(
        budget,
      )} per-call budget. The bar is relative to the slowest event in view (${duration(scaleMs)}).`
    : `${duration(ms)}. The bar is relative to the slowest event in view (${duration(scaleMs)}).`;
  return h(
    'span',
    { class: 'row-latency', title },
    h('span', { class: 'row-latency-text mono' }, duration(ms)),
    meter(ms, scaleMs, { tone: share > 0.6 ? 'warn' : 'ok', label: duration(ms) }),
  );
}

/** `server.*` events are drawn as a full-width band: they are the restart markers (A-15). */
function bootDivider(event, view) {
  const selected = view.selectedEventId === event.id;
  const started = event.type === 'server.started';
  return h(
    'button',
    {
      type: 'button',
      class: cx('boot-divider', selected && 'is-selected'),
      'data-action': 'select-event',
      'data-arg': String(event.id),
      'aria-pressed': String(selected),
    },
    h('span', { class: 'boot-rule' }),
    h(
      'span',
      { class: 'boot-label' },
      started ? 'Server started' : 'Server stopping',
      h('span', { class: 'mono boot-id' }, event.data?.boot_id ?? ''),
      h('span', { class: 'boot-time mono', title: event.ts }, clockTime(event.ts)),
    ),
    h('span', { class: 'boot-rule' }),
  );
}

function eventRow(event, view, context) {
  const status = statusOf(event);
  const selected = view.selectedEventId === event.id;
  const known = isKnownType(event.type);
  // `tool.call.started` only deserves the "In flight" badge while its completion is still missing;
  // in replayed history the very next rows say how it ended.
  const stillRunning =
    event.type !== 'tool.call.started' || context.running.has(callKeyOf(event) ?? '');
  return h(
    'button',
    {
      type: 'button',
      class: cx('row', `row-${status}`, selected && 'is-selected', !known && 'row-unknown'),
      'data-action': 'select-event',
      'data-arg': String(event.id),
      'aria-pressed': String(selected),
    },
    h('span', { class: 'row-time mono', title: event.ts }, clockTime(event.ts)),
    familyTag(event.type),
    h(
      'span',
      { class: 'row-body' },
      h(
        'span',
        { class: 'row-label' },
        labelOf(event.type),
        known ? null : h('span', { class: 'badge badge-warn' }, 'unknown type'),
      ),
      h('span', { class: 'row-summary' }, summaryOf(event)),
    ),
    latencyCell(event, context.scaleMs),
    status === 'info' || (status === 'running' && !stillRunning)
      ? null
      : statusBadge(status, STATUS_LABELS[status]),
  );
}

function eventsBody(model, all, matching) {
  const { store, view } = model;
  const rows = matching.slice(-MAX_ROWS);
  const hidden = matching.length - rows.length;
  const context = {
    running: new Set(store.getInFlightCalls().map((call) => call.key)),
    scaleMs: Math.max(
      10,
      ...rows.map((event) => Number(event.data?.duration_ms ?? event.data?.latency_ms ?? 0)),
    ),
  };
  return h(
    'div',
    { class: 'timeline-scroll', id: 'timeline-scroll' },
    hidden > 0
      ? h(
          'p',
          { class: 'timeline-truncation' },
          `${count(hidden)} older matching events are not drawn. Narrow the filter or pick a session to see them.`,
        )
      : null,
    rows.length === 0
      ? emptyState(
          all.length === 0 ? 'Nothing has happened yet' : 'No event matches this filter',
          all.length === 0
            ? 'Events appear here in real time as your Claude client talks to the bank.'
            : 'Clear the filter to see the whole stream again.',
          all.length === 0 ? null : button('Clear filter', 'clear-filter', { variant: 'quiet' }),
        )
      : h(
          'div',
          { class: 'rows' },
          ...rows.map((event) =>
            familyOf(event.type) === 'server'
              ? bootDivider(event, view)
              : eventRow(event, view, context),
          ),
        ),
  );
}

// ---------------------------------------------------------------------------
// Chain mode
// ---------------------------------------------------------------------------

/** In chain mode a filter matches a call when it matches any event of the call. */
export function callMatchesFilter(store, filter, call) {
  if (isEmptyFilter(filter)) return true;
  const ids = [call.event_id, call.finished_event_id, ...call.child_event_ids];
  return ids.some((id) => {
    if (id === null || id === undefined) return false;
    const event = store.getEventById(id);
    return Boolean(event) && matchesFilter(filter, event);
  });
}

/** True when the event deserves a context row of its own in chain mode. */
export function isContextEvent(store, event) {
  if (familyOf(event.type) === 'server') return true;
  if (!CONTEXT_TYPES.has(event.type)) return false;
  if (event.type === 'auth.stepup.requested') {
    const call = store.getCall(callKeyOf(event));
    return !(call && call.child_event_ids.includes(event.id));
  }
  if (event.type === 'tool.call.denied') {
    const key = callKeyOf(event);
    return !(key && store.getCall(key));
  }
  return true;
}

/**
 * One call on the spine: the row, and the three panes under it when it is open
 * (`public/panel-call.js`). Nothing about a call is drawn in this file any more. The board this
 * replaced mixed what the client sent with what the server did on receipt in one column, and
 * printed this page's own captions ("6 rows", "audit aud_0002") in the server's colour.
 */
function chainCall(call, model, ctx) {
  return h(
    'div',
    { class: 'call' },
    renderCallRow(call, model, ctx),
    isOpen(model.view, callKey(call), 'call') ? renderCallOpen(call, model, ctx) : null,
  );
}

/** The rule sentence under an episode header: why these calls are one group, and whose call that is. */
function groupingSentence(episode, previousTool) {
  const linked =
    episode.links.length > 0
      ? 'the calls inside it are joined into chains by the data each one names'
      : 'nothing it produced was named by another call';
  let opened;
  switch (episode.boundary) {
    case 'first':
      opened = 'it opens with the first call of the session';
      break;
    case 'workflow':
      opened = "the server's inferred workflow changed at its first call";
      break;
    case 'closed':
      opened = `its first call shares no data with ${
        previousTool ?? 'the call before it'
      }, which finished a piece of work`;
      break;
    case 'gap':
      opened = `its first call shares no data with the one before it and came ${duration(
        episode.gap_ms,
      )} later`;
      break;
    default:
      opened = 'its first call shares no data with the one before it';
  }
  return `Grouped by this dashboard, not by the server: ${opened}, and ${linked}. Nothing here records what you typed - the server never sees the conversation.`;
}

function episodeHeader(episode, previousTool, threadCount, focus, open, memberKeys, whyOpen) {
  const workflow = episode.workflow
    ? h(
        'span',
        { class: 'episode-workflow' },
        h('span', { class: 'episode-workflow-name' }, String(episode.workflow).replace(/_/g, ' ')),
        h(
          'span',
          {
            class: 'episode-workflow-confidence mono',
            // Never a percentage: `confidence` is how far the winning workflow scored ahead of the
            // runner-up (`src/tools/intent.ts`), so the only values it can take are 0.2 for
            // `unknown` and 0.40 to 0.85 for the rest. Printed as a percentage it reads as an
            // accuracy the classifier never claimed.
            title:
              'How far ahead the winning workflow scored, not a probability. The server scores the last few tool names and looks for five sets of words in the rationale.',
          },
          `scored ${Number(episode.confidence ?? 0).toFixed(2)}`,
        ),
        tag('inferred by this server, not by the model', 'tag-warn'),
      )
    : h('span', { class: 'episode-workflow muted' }, 'no workflow inferred for these calls yet');
  return h(
    'header',
    { class: 'episode-head' },
    h(
      'div',
      { class: 'episode-head-line' },
      disclosure(
        h('span', { class: 'episode-ordinal' }, `Episode ${episode.index}`),
        episodeKey(episode.calls[0]?.key),
        open,
        {
          kind: 'ep',
          class: 'episode-toggle',
          title: open ? 'Fold this group away' : 'Show the calls in this group',
        },
      ),
      workflow,
      h(
        'span',
        { class: 'episode-facts mono', title: `${episode.started_at} to ${episode.ended_at}` },
        `${clockSeconds(episode.started_at)} - ${clockSeconds(episode.ended_at)}`,
      ),
      h('span', { class: 'episode-facts' }, plural(episode.calls.length, 'call')),
      threadCount > 1
        ? h('span', { class: 'episode-facts' }, `${plural(threadCount, 'chain')} running at once`)
        : null,
      h('span', { class: 'episode-facts mono' }, duration(episode.duration_ms)),
      episode.failures
        ? statusBadge('error', `${count(episode.failures)} failed`)
        : null,
      // Scoped to this group: `arg2` carries its call keys, because an episode is a grouping this
      // page invented and nothing in the key itself says which calls belong to it.
      button('\u21f1 Collapse', 'collapse-all', {
        arg: episodeKey(episode.calls[0]?.key),
        arg2: memberKeys.join(' '),
        variant: 'chip',
        class: 'episode-collapse',
        title: 'Close every call in this group',
      }),
    ),
    episode.rationale
      ? h(
          'blockquote',
          {
            class: cx(
              'rationale',
              'episode-rationale',
              'band-model',
              focus !== null && focus !== 'model' && 'is-dimmed',
            ),
          },
          episode.rationale,
          h(
            'footer',
            { class: 'rationale-source' },
            "the model's words for the first call in this group, stored verbatim",
          ),
        )
      : h(
          'p',
          { class: 'episode-no-rationale muted' },
          'The first call in this group carried no rationale, so the model said nothing about why.',
        ),
    // The claim itself is always on screen; the rule that produced this particular group is one
    // click away, because the reader needs it once and then never again.
    h(
      'p',
      {
        class: cx('episode-rule', 'band-page', focus !== null && focus !== 'page' && 'is-dimmed'),
      },
      provenance(EPISODE_HONESTY),
      disclosure('why', whyKey(episodeKey(episode.calls[0]?.key)), whyOpen, {
        kind: 'why',
        class: 'episode-why',
        title: 'Why these calls are one group',
      }),
    ),
    whyOpen
      ? h(
          'p',
          {
            class: cx(
              'episode-why-body',
              'band-page',
              focus !== null && focus !== 'page' && 'is-dimmed',
            ),
          },
          groupingSentence(episode, previousTool),
        )
      : null,
  );
}

/**
 * The connector on the rail between two calls. It names what flowed, and says where it came from
 * when that is not simply the call above (a link back across a gap, or across an episode). The
 * source is named by its JSON-RPC id, which is now the only number a call has.
 */
function chainConnector(links, previousKey, focus) {
  return h(
    'div',
    {
      // The connector is one of the three things the `page` actor draws, so focusing that chip has
      // to leave it lit while the rails recede - otherwise the lens looks like it broke the page.
      class: cx('chain-link', focus !== null && focus !== 'page' && 'is-dimmed'),
    },
    h('span', { class: 'chain-link-rail', 'aria-hidden': 'true' }),
    h(
      'div',
      { class: 'chain-link-body' },
      ...links.map((item) => {
        let source = null;
        if (item.crosses_episode && item.from_episode) {
          source = `from episode ${item.from_episode}`;
        } else if (item.from !== previousKey) {
          source = `from #${item.from_request_id}`;
        }
        return h(
          'span',
          { class: cx('chain-link-label', `chain-link-${item.kind}`), title: item.detail },
          h('span', { class: 'chain-link-verb' }, 'passes'),
          h('span', { class: 'chain-link-what mono' }, item.label),
          source ? h('span', { class: 'chain-link-source' }, source) : null,
        );
      }),
    ),
  );
}

/** One thread: the artefact it is about, then its calls down a rail with the connectors between. */
function threadColumn(thread, model, ctx, incoming, drawnKeys) {
  const drawn = thread.calls.filter((call) => drawnKeys.has(call.key));
  if (drawn.length === 0) return null;
  const single = drawn.length === 1;

  const rows = [];
  let previousKey = null;
  for (const call of drawn) {
    // A connector is only honest when both of its ends are on screen.
    const links = (incoming.get(call.key) ?? []).filter(
      (item) => drawnKeys.has(item.from) || item.crosses_episode,
    );
    if (links.length) {
      rows.push(chainConnector(links, previousKey, model.view.actorFocus ?? null));
    }
    rows.push(chainCall(call, model, ctx));
    previousKey = call.key;
  }

  return h(
    'div',
    { class: cx('chain-thread', single && 'is-single') },
    single || !thread.label
      ? null
      : h(
          'div',
          { class: 'chain-thread-head', title: thread.detail ?? null },
          h('span', { class: 'chain-thread-label' }, 'one chain, carrying'),
          h('span', { class: cx('chain-thread-what', 'mono', `chain-thread-${thread.kind}`) }, thread.label),
          h('span', { class: 'chain-thread-count' }, plural(drawn.length, 'call')),
        ),
    h('div', { class: 'chain-thread-steps' }, ...rows),
  );
}

/** One episode: the header, then one column per thread of connected calls inside it. */
function episodeCard(episode, model, ctx, incoming, previousTool) {
  const { store, view } = model;
  const filtered = !isEmptyFilter(view.filter);
  const drawn = filtered
    ? episode.calls.filter((call) => callMatchesFilter(store, view.filter, call))
    : episode.calls;
  const drawnKeys = new Set(drawn.map((call) => call.key));
  const hidden = episode.calls.length - drawn.length;
  const threads = threadsOf(episode, incoming, ctx.byId);

  const open = isOpen(view, episodeKey(episode.calls[0]?.key), 'ep');

  return h(
    'article',
    {
      class: cx('episode', open && 'is-open'),
      'data-episode': String(episode.index),
    },
    episodeHeader(
      episode,
      previousTool,
      threads.length,
      view.actorFocus ?? null,
      open,
      episode.calls.map((call) => call.key),
      isOpen(view, whyKey(episodeKey(episode.calls[0]?.key)), 'why'),
    ),
    hidden > 0
      ? h(
          'p',
          { class: 'episode-filtered' },
          `${count(hidden)} of the ${count(
            episode.calls.length,
          )} calls in this group do not match the filter and are not drawn, along with the connectors that touch them.`,
        )
      : null,
    open
      ? h(
          'div',
          { class: 'episode-threads' },
          ...threads
            .map((thread) => threadColumn(thread, model, ctx, incoming, drawnKeys))
            .filter(Boolean),
        )
      : null,
  );
}

/**
 * Episodes and context rows merged by event id, ascending. Episodes are built from every call up
 * to the cutoff - the filter narrows which steps are drawn, never which calls the chain is derived
 * from, because a link computed over a filtered subset would claim a hand-off that never happened.
 */
export function chainModeItems(model, all, cutoff) {
  const { store, view } = model;
  const events = all.filter((event) => event.id <= cutoff);
  const byId = new Map(events.map((event) => [event.id, event]));
  const calls = store.getCalls({ xs: view.selectedXs }).filter((call) => call.event_id <= cutoff);
  const { links, episodes } = buildChain(calls, byId);
  const incoming = incomingLinks(links);

  const matching = episodes.filter((episode) =>
    episode.calls.some((call) => callMatchesFilter(store, view.filter, call)),
  );
  const hiddenEpisodes = Math.max(0, matching.length - MAX_EPISODES);
  const drawn = matching.slice(hiddenEpisodes);
  const firstDrawnId = drawn.length ? drawn[0].event_id : Number.POSITIVE_INFINITY;

  const context = events.filter(
    (event) =>
      isContextEvent(store, event) &&
      matchesFilter(view.filter, event) &&
      (hiddenEpisodes === 0 || event.id >= firstDrawnId),
  );
  const items = [
    ...drawn.map((episode) => ({ id: episode.event_id, episode })),
    ...context.map((event) => ({ id: event.id, event })),
  ].sort((a, b) => a.id - b.id);

  return {
    items,
    byId,
    incoming,
    episodes,
    callCount: calls.filter((call) => callMatchesFilter(store, view.filter, call)).length,
    hiddenEpisodes,
    // What one call needs to draw itself (`public/panel-call.js`): the chain links behind its
    // ports, every call of the window behind its overlap chip, and the pause point.
    ctx: { cutoff, links, calls, byId },
  };
}

function chainBody(model, all, listing) {
  const { view } = model;
  const { items, incoming, hiddenEpisodes, callCount, ctx } = listing;
  let previousTool = null;
  const nodes = items.map((item) => {
    if (item.episode) {
      const node = episodeCard(item.episode, model, ctx, incoming, previousTool);
      const last = item.episode.calls[item.episode.calls.length - 1];
      previousTool = last ? last.tool : previousTool;
      return node;
    }
    return contextRow(item.event, view);
  });
  const filtered = !isEmptyFilter(view.filter);
  return h(
    'div',
    { class: 'timeline-scroll timeline-scroll-chain', id: 'timeline-scroll' },
    hiddenEpisodes > 0
      ? h(
          'p',
          { class: 'timeline-truncation' },
          `${count(hiddenEpisodes)} older matching episodes are not drawn. Narrow the filter or pick a session to see them.`,
        )
      : null,
    nodes.length ? h('div', { class: 'flow' }, ...nodes) : null,
    callCount === 0
      ? emptyState(
          filtered && all.length > 0 ? 'No call matches this filter' : 'No tool call yet',
          filtered && all.length > 0
            ? 'Clear the filter to see every episode again.'
            : 'Episodes appear here as your client uses the bank: one group of connected calls at a time, each step naming what it passed to the next.',
          filtered && all.length > 0
            ? button('Clear filter', 'clear-filter', { variant: 'quiet' })
            : null,
        )
      : null,
  );
}

function contextSummary(event) {
  const data = event.data ?? {};
  if (event.type === 'catalog.tools_listed') {
    return `${count(data.count)} tools sent to the client${
      data.tools ? '' : ' · unchanged since the last listing'
    }`;
  }
  return summaryOf(event);
}

function contextRow(event, view) {
  if (familyOf(event.type) === 'server') return bootDivider(event, view);
  const selected = view.selectedEventId === event.id;
  const status = statusOf(event);
  return h(
    'button',
    {
      type: 'button',
      class: cx('flow-context', `flow-context-${status}`, selected && 'is-selected'),
      'data-action': 'select-event',
      'data-arg': String(event.id),
      'aria-pressed': String(selected),
    },
    h('span', { class: 'flow-context-time mono', title: event.ts }, clockTime(event.ts)),
    // The same five colours as the board: a context row is somebody's doing too, and the legend
    // above is only worth reading if it explains every mark on the page.
    h('span', {
      class: `flow-context-who band-${actorOfEvent(event)}`,
      title: ACTOR_MEANING[actorOfEvent(event)],
      'aria-hidden': 'true',
    }),
    familyTag(event.type),
    h('span', { class: 'flow-context-label' }, labelOf(event.type)),
    h('span', { class: 'flow-context-summary' }, contextSummary(event)),
    status === 'info' || status === 'notice' ? null : statusBadge(status, STATUS_LABELS[status]),
  );
}

// ---------------------------------------------------------------------------
// Toolbar and the panel
// ---------------------------------------------------------------------------

/**
 * The key to the colours. Every band, every context row and every connector on the board carries
 * one of these five, and clicking a chip pushes the other four back so one voice can be read on
 * its own. It is a lens, not a filter: nothing is removed from the page.
 */
function actorLegend(view) {
  const focus = view.actorFocus ?? null;
  return h(
    'div',
    { class: 'toolbar-line actor-legend', role: 'group', 'aria-label': 'Who did what' },
    h('span', { class: 'actor-legend-title' }, 'Who did what'),
    ...legend().map((item) =>
      h(
        'button',
        {
          type: 'button',
          class: cx(
            'actor-chip',
            `actor-chip-${item.actor}`,
            focus === item.actor && 'is-focused',
            focus !== null && focus !== item.actor && 'is-dimmed',
          ),
          'data-action': 'set-actor-focus',
          'data-arg': item.actor,
          'aria-pressed': String(focus === item.actor),
          title: item.meaning,
        },
        h('span', { class: 'actor-chip-swatch', 'aria-hidden': 'true' }),
        h('span', { class: 'actor-chip-label' }, item.label),
      ),
    ),
    focus
      ? h(
          'span',
          { class: 'actor-legend-note' },
          ACTOR_MEANING[focus],
          ' ',
          button('Show all again', 'set-actor-focus', { arg: focus, variant: 'chip-clear' }),
        )
      : h(
          'span',
          { class: 'actor-legend-note muted' },
          'Four parties and this page. Pick one to read its voice on its own.',
        ),
  );
}

function modeControl(mode) {
  return h(
    'div',
    { class: 'timeline-modes', role: 'group', 'aria-label': 'Timeline mode' },
    button('Chain', 'set-timeline-mode', {
      arg: 'chain',
      variant: 'seg',
      pressed: mode === 'chain',
      title: 'The calls grouped into episodes, each step naming what it passed to the next',
    }),
    button('Events', 'set-timeline-mode', {
      arg: 'events',
      variant: 'seg',
      pressed: mode === 'events',
      title: 'Every event as one row, like a log tail',
    }),
  );
}

const DEPTH_LABELS = {
  overview: 'Overview',
  calls: 'Calls',
  open: 'Open',
  inside: 'Inside',
};

const DEPTH_TITLES = {
  overview: 'Episode headers only',
  calls: 'One line per call; open the ones you want',
  open: 'Every call open',
  inside: 'Every call open, with the events inside it',
};

/**
 * How deep a block with no explicit choice starts (`public/open-state.js`). It is the way back
 * from micro to macro: setting a depth drops every per-call choice, so the whole spine answers
 * the control rather than the last twenty clicks.
 */
function depthControl(depth) {
  return h(
    'div',
    { class: 'timeline-depth', role: 'group', 'aria-label': 'How much of each call to show' },
    h('span', { class: 'timeline-depth-label' }, 'Depth'),
    ...DEPTHS.map((entry) =>
      button(DEPTH_LABELS[entry], 'set-depth', {
        arg: entry,
        variant: 'seg',
        pressed: depth === entry,
        title: DEPTH_TITLES[entry],
      }),
    ),
  );
}

function toolbar(model, mode, shown, total) {
  const { view } = model;
  const filter = view.filter;
  const chips = describeFilter(filter);
  const unit = mode === 'chain' ? 'calls' : 'events';
  return h(
    'div',
    { class: 'timeline-toolbar' },
    h(
      'div',
      { class: 'toolbar-line' },
      h('label', { class: 'field field-grow' }, h('span', { class: 'field-label' }, 'Filter'), h('input', {
        type: 'search',
        id: 'filter-input',
        class: 'input mono',
        placeholder: 'tool:execute_query  type:tool.call  status:error  kind:sql  -kind:http',
        value: view.filterRaw,
        'aria-label': 'Filter the timeline',
      })),
      modeControl(mode),
      mode === 'chain' ? depthControl(view.depth ?? 'calls') : null,
      h(
        'div',
        { class: 'toolbar-buttons' },
        mode === 'chain'
          ? button('\u21f1 Collapse all', 'collapse-all', {
              arg: 'all',
              variant: 'quiet',
              title: 'Close every call and connection block, back to one line each',
            })
          : null,
        button(view.paused ? 'Resume' : 'Pause', 'toggle-pause', {
          variant: view.paused ? 'primary' : 'quiet',
          title: view.paused ? 'Resume following new events' : 'Freeze the timeline where it is',
          pressed: view.paused,
        }),
        button(
          view.pendingCount ? `Jump to live (${count(view.pendingCount)})` : 'Jump to live',
          'jump-live',
          {
            variant: view.pendingCount ? 'accent' : 'quiet',
            disabled: !view.paused && view.follow && !view.pendingCount,
          },
        ),
      ),
    ),
    h(
      'div',
      { class: 'toolbar-line toolbar-chips' },
      ...QUICK_FILTERS.map((quick) =>
        button(quick.label, 'toggle-filter-token', {
          arg: quick.token,
          variant: 'chip',
          pressed: view.filterRaw.split(/\s+/).includes(quick.token),
        }),
      ),
      chips.length
        ? button('Clear filter', 'clear-filter', { variant: 'chip-clear' })
        : null,
      h(
        'span',
        { class: 'toolbar-count' },
        isEmptyFilter(filter) ? `${count(total)} ${unit}` : `${count(shown)} of ${count(total)} ${unit}`,
      ),
    ),
    mode === 'chain' ? actorLegend(view) : null,
  );
}

/** The whole panel. `model` is `{ store, view, now }`. */
export function renderTimeline(model) {
  const { store, view } = model;
  const mode = modeOf(view);
  const all = store.getEvents({ xs: view.selectedXs });
  const cutoff = view.paused && view.frozenEventId ? view.frozenEventId : Infinity;
  const matching = all.filter((event) => event.id <= cutoff && matchesFilter(view.filter, event));

  let shown;
  let total;
  let listing = null;
  if (mode === 'chain') {
    listing = chainModeItems(model, all, cutoff);
    total = store.getCalls({ xs: view.selectedXs }).length;
    shown = listing.callCount;
  } else {
    total = all.length;
    shown = matching.length;
  }

  return h(
    'div',
    { class: cx('timeline', `timeline-mode-${mode}`) },
    toolbar(model, mode, shown, total),
    mode === 'chain' ? chainBody(model, all, listing) : eventsBody(model, all, matching),
    view.paused
      ? h(
          'div',
          { class: 'timeline-paused' },
          h('span', {}, 'Paused'),
          h(
            'span',
            { class: 'muted' },
            view.pendingCount
              ? `${count(view.pendingCount)} new event${view.pendingCount === 1 ? '' : 's'} while paused`
              : 'the stream is still running',
          ),
          button('Jump to live', 'jump-live', { variant: 'primary' }),
        )
      : null,
  );
}
