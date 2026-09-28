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
import {
  DEPTHS,
  GLOSSARY_KEY,
  callKey,
  connKey,
  episodeKey,
  isOpen,
  sessionKey,
  whyKey,
} from './open-state.js';
import { identityBadge } from './identity.js';
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
 * The events that set a session up: the grant and its tokens, the session start, `initialize` and
 * the listings. Before the session's first call they are drawn inside its connection block; after
 * it (a re-initialize, a re-list, a token refresh) they stay context rows in the session's chain.
 */
export const CONNECTION_TYPES = new Set([
  'auth.client.registered',
  'auth.client.reconstructed',
  'auth.login.created',
  'auth.grant.created',
  'auth.grant.updated',
  'auth.token.issued',
  'auth.token.refreshed',
  'auth.verified',
  'session.started',
  'session.initialized',
  'catalog.tools_listed',
  'catalog.resources_listed',
  'catalog.prompts_listed',
  'catalog.availability',
]);

/** The one-word step a connection event stands for, in the order a client goes through them. */
export function connectionStep(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case 'auth.client.registered':
      return 'client registered';
    case 'auth.client.reconstructed':
      return 'client rebuilt';
    case 'auth.login.created':
      return 'signed in';
    case 'auth.grant.created':
      return 'consent';
    case 'auth.grant.updated':
      return 'consent extended';
    case 'auth.token.issued':
      return 'token';
    case 'auth.token.refreshed':
      return 'token refreshed';
    case 'auth.verified':
      return 'bearer checked';
    case 'session.started':
      return 'session started';
    case 'session.initialized':
      return `initialize ${data.protocol_version_negotiated ?? ''}`.trim();
    case 'catalog.tools_listed':
      return `tools/list · ${count(data.count ?? 0)} tools`;
    case 'catalog.resources_listed':
      return 'resources/list';
    case 'catalog.prompts_listed':
      return 'prompts/list';
    default:
      return null;
  }
}

/**
 * The session an event without an `xs` belongs to: a grant's consent and tokens happen before its
 * first session starts, so they go to the first session of that grant that starts after them, or
 * to its latest one before them. Events with neither an `xs` nor a grant stay outside every block.
 */
function homeSessionOf(event, sessionsByGrant) {
  if (event.xs) return event.xs;
  const grantId = event.grant_id ?? event.data?.grant_id ?? null;
  if (!grantId) return null;
  const candidates = sessionsByGrant.get(grantId);
  if (!candidates || candidates.length === 0) return null;
  // A step-up in the middle of a session belongs to that session, not to the next one.
  const within = candidates.find(
    (entry) => entry.first_event_id <= event.id && event.id <= entry.last_event_id,
  );
  if (within) return within.xs;
  const after = candidates.find((entry) => entry.first_event_id > event.id);
  return (after ?? candidates[candidates.length - 1]).xs;
}

/**
 * The chain mode's content, one block per session (C1): its connection block, then its episodes
 * and context rows by event id, then its end. Nothing of one session is ever drawn inside another;
 * events that belong to no session (a restart, a dropped-events notice) sit between the blocks.
 *
 * Episodes are built per session, from every call up to the cutoff - the filter narrows which
 * steps are drawn, never which calls the chain is derived from, because a link computed over a
 * filtered subset would claim a hand-off that never happened.
 */
export function chainModeItems(model, all, cutoff) {
  const { store, view } = model;
  const events = all.filter((event) => event.id <= cutoff);
  const byId = new Map(events.map((event) => [event.id, event]));
  const calls = store.getCalls({ xs: view.selectedXs }).filter((call) => call.event_id <= cutoff);

  const callsByXs = new Map();
  for (const call of calls) {
    const key = call.xs ?? '';
    if (!callsByXs.has(key)) callsByXs.set(key, []);
    callsByXs.get(key).push(call);
  }

  const firstIds = new Map();
  const lastIds = new Map();
  for (const event of events) {
    if (!event.xs) continue;
    if (!firstIds.has(event.xs)) firstIds.set(event.xs, event.id);
    lastIds.set(event.xs, event.id);
  }
  for (const call of calls) {
    if (call.xs && !firstIds.has(call.xs)) firstIds.set(call.xs, call.event_id);
  }
  const sessionsByGrant = new Map();
  for (const [xs, firstId] of [...firstIds.entries()].sort((a, b) => a[1] - b[1])) {
    const session = store.getSession(xs);
    const grantId = session?.grant_id ?? calls.find((call) => call.xs === xs)?.grant_id ?? null;
    if (!grantId) continue;
    if (!sessionsByGrant.has(grantId)) sessionsByGrant.set(grantId, []);
    sessionsByGrant.get(grantId).push({ xs, first_event_id: firstId, last_event_id: lastIds.get(xs) ?? firstId });
  }

  const blocks = new Map();
  const blockOf = (xs) => {
    if (!blocks.has(xs)) {
      blocks.set(xs, {
        kind: 'session',
        xs,
        firstId: firstIds.get(xs) ?? Number.POSITIVE_INFINITY,
        connection: [],
        context: [],
        ended: null,
        episodes: [],
        firstCallId: Number.POSITIVE_INFINITY,
      });
    }
    return blocks.get(xs);
  };

  const allLinks = [];
  const allEpisodes = [];
  for (const [xs, sessionCalls] of callsByXs) {
    const { links, episodes } = buildChain(sessionCalls, byId);
    allLinks.push(...links);
    const block = blockOf(xs || null);
    block.episodes = episodes;
    block.firstCallId = Math.min(...sessionCalls.map((call) => call.event_id));
    allEpisodes.push(...episodes);
  }
  const incoming = incomingLinks(allLinks);

  const loose = [];
  for (const event of events) {
    const home = homeSessionOf(event, sessionsByGrant);
    if (view.selectedXs && home !== view.selectedXs && familyOf(event.type) !== 'server') continue;
    if (home === null) {
      if (isContextEvent(store, event) && matchesFilter(view.filter, event)) loose.push(event);
      continue;
    }
    const block = blockOf(home);
    block.firstId = Math.min(block.firstId, event.id);
    if (event.type === 'session.ended') {
      block.ended = event;
      continue;
    }
    if (CONNECTION_TYPES.has(event.type) && event.id < block.firstCallId) {
      block.connection.push(event);
      continue;
    }
    if (isContextEvent(store, event) && matchesFilter(view.filter, event)) block.context.push(event);
  }

  // The same 40-episode ceiling as before, taken from the oldest sessions first.
  const ordered = [...blocks.values()].sort((a, b) => a.firstId - b.firstId);
  let budget = MAX_EPISODES;
  let hiddenEpisodes = 0;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const block = ordered[index];
    const matching = block.episodes.filter((episode) =>
      episode.calls.some((call) => callMatchesFilter(store, view.filter, call)),
    );
    const kept = matching.slice(Math.max(0, matching.length - budget));
    hiddenEpisodes += matching.length - kept.length;
    budget -= kept.length;
    block.drawnEpisodes = kept;
  }
  const filtered = !isEmptyFilter(view.filter);
  const drawnBlocks = ordered.filter(
    (block) => !filtered || block.drawnEpisodes.length > 0 || block.context.length > 0,
  );

  const items = [
    ...drawnBlocks.map((block) => ({ id: block.firstId, block })),
    ...loose.map((event) => ({ id: event.id, event })),
  ].sort((a, b) => a.id - b.id);

  return {
    items,
    byId,
    incoming,
    episodes: allEpisodes,
    blocks: drawnBlocks,
    callCount: calls.filter((call) => callMatchesFilter(store, view.filter, call)).length,
    hiddenEpisodes,
    // What one call needs to draw itself (`public/panel-call.js`): the chain links behind its
    // ports, every call of the window behind its overlap chip, and the pause point.
    ctx: { cutoff, links: allLinks, calls, byId },
  };
}

/** The ids a reader meets on this page, and what each one names (the toolbar's glossary). */
export const ID_GLOSSARY = [
  ['lgn_', 'login', 'The browser that signed in at the bank’s login page (a 30-day cookie). One person, possibly several clients.'],
  ['grt_', 'grant', 'One consent: the scopes the person approved for one client, and the tokens minted from it. grt_pub_ is an anonymous public-lane visitor.'],
  ['xs_', 'session', 'The requests of one grant with no idle gap longer than the limit between them. Minted by this server, because the transport keeps no session of its own.'],
  ['#6', 'request', 'The JSON-RPC id the client chose for one call. Everything the call caused inside the server carries the same id.'],
  ['#42', 'event', 'One row of this server’s log, numbered in the order it was written. A call is several events: started, what happened inside, completed.'],
  ['per_', 'persona', 'The demo customer whose data the calls read and change.'],
  ['boot_', 'boot', 'One run of the server process. A new boot means a restart: in-memory state was lost.'],
];

function glossary() {
  return h(
    'dl',
    { class: 'id-glossary' },
    ...ID_GLOSSARY.map(([prefix, name, meaning]) =>
      h('div', { class: 'id-glossary-row' }, h('dt', {}, h('span', { class: 'mono' }, prefix), ' ', name), h('dd', {}, meaning)),
    ),
    h(
      'p',
      { class: 'id-glossary-note' },
      'Inside a call, REQUEST is the input as the client sent it, RESPONSE the output as this server sent it back, and INSIDE what happened in between. The envelope of every event (id, ts, xs, grant, request id) is tracking recorded by this server; data is what the event says.',
    ),
  );
}

/** The ids of a session, each with the sentence that says what it names. */
function sessionTrace(session, block) {
  const parts = [
    ['login', session?.login_id ?? null, ID_GLOSSARY[0][2]],
    ['grant', session?.grant_id ?? null, ID_GLOSSARY[1][2]],
    ['session', block.xs, ID_GLOSSARY[2][2]],
  ].filter(([, value]) => value);
  return h(
    'span',
    { class: 'trace-ids', title: 'The tracking ids this session is filed under' },
    ...parts.flatMap(([name, value, meaning], index) => [
      index > 0 ? h('span', { class: 'trace-sep', 'aria-hidden': 'true' }, '›') : null,
      h('span', { class: 'trace-id', title: `${name}: ${meaning}` }, h('span', { class: 'trace-name' }, name), ' ', h('span', { class: 'mono' }, value)),
    ]),
  );
}

/** The session's head: who connected, as what, under which grant, and how it went. */
function sessionHead(block, model, open) {
  const { store } = model;
  const session = store.getSession(block.xs) ?? { xs: block.xs };
  const grant = session.grant_id ? store.getGrant(session.grant_id) : null;
  const client = session.client ?? null;
  const calls = block.episodes.reduce((sum, episode) => sum + episode.calls.length, 0);
  const failed = block.episodes.reduce((sum, episode) => sum + (episode.failures ?? 0), 0);
  const ended = block.ended;
  const personaName = session.persona?.name ?? null;
  const publicVisitor = String(session.grant_id ?? '').startsWith('grt_pub_');
  return h(
    'header',
    { class: 'session-head' },
    h(
      'div',
      { class: 'session-head-line' },
      disclosure(h('span', { class: 'session-title' }, 'Session ', h('span', { class: 'mono' }, block.xs)), sessionKey(block.xs), open, {
        kind: 'sess',
        class: 'session-toggle',
        title: open ? 'Fold this session to its head' : 'Show this session',
      }),
      identityBadge(session),
      client
        ? h('span', { class: 'session-client mono', title: 'clientInfo, verbatim and untrusted (A-28)' }, `${client.name ?? ''} ${client.version ?? ''}`.trim())
        : null,
      session.protocol_version ? h('span', { class: 'session-fact mono' }, session.protocol_version) : null,
      h('span', { class: 'session-fact' }, plural(calls, 'call')),
      failed ? statusBadge('error', `${count(failed)} failed`) : null,
      ended
        ? tag(`ended · ${String(ended.data?.reason ?? 'ended').replace(/_/g, ' ')}`, 'tag-quiet')
        : tag('open', 'tag-ok'),
    ),
    h(
      'div',
      { class: 'session-head-sub' },
      sessionTrace(session, block),
      publicVisitor
        ? h('span', { class: 'session-fact' }, 'anonymous public-lane visitor')
        : grant
          ? h(
              'span',
              { class: 'session-fact', title: (grant.scopes ?? []).join(' ') },
              `${String(grant.auth_level ?? '').replace('_', ' ')} · ${plural((grant.scopes ?? []).length, 'scope')}`,
            )
          : null,
      personaName ? h('span', { class: 'session-fact' }, `as ${personaName}`) : null,
      h(
        'span',
        { class: 'session-fact mono', title: `${session.started_at ?? ''} to ${session.last_seen_at ?? ''}` },
        `${clockSeconds(session.started_at)} - ${clockSeconds(ended?.ts ?? session.last_seen_at)}`,
      ),
    ),
  );
}

/** Everything that happened before the first call, folded into one line that opens. */
function connectionBlock(block, model) {
  const { view } = model;
  if (block.connection.length === 0) return null;
  const key = connKey(block.xs);
  const open = isOpen(view, key, 'conn');
  const steps = [];
  for (const event of block.connection) {
    const step = connectionStep(event);
    if (step && steps[steps.length - 1] !== step) steps.push(step);
  }
  return h(
    'div',
    { class: cx('session-connection', open && 'is-open') },
    disclosure(
      h(
        'span',
        { class: 'connection-line' },
        h('span', { class: 'connection-label' }, 'connection'),
        h('span', { class: 'connection-steps' }, steps.join(' → ')),
      ),
      key,
      open,
      { kind: 'conn', class: 'connection-toggle', title: open ? 'Fold the connection back to one line' : 'Show every step of the connection' },
    ),
    open ? h('div', { class: 'connection-rows' }, ...block.connection.map((event) => contextRow(event, view))) : null,
  );
}

/** One session: its head, its connection, its episodes and context rows by id, its end. */
function sessionBlock(block, model, ctx, incoming) {
  const { view } = model;
  const open = isOpen(view, sessionKey(block.xs), 'sess');
  const nodes = [];
  if (open) {
    const items = [
      ...block.drawnEpisodes.map((episode) => ({ id: episode.event_id, episode })),
      ...block.context.map((event) => ({ id: event.id, event })),
    ].sort((a, b) => a.id - b.id);
    let previousTool = null;
    for (const item of items) {
      if (item.episode) {
        nodes.push(episodeCard(item.episode, model, ctx, incoming, previousTool));
        const last = item.episode.calls[item.episode.calls.length - 1];
        previousTool = last ? last.tool : previousTool;
      } else {
        nodes.push(contextRow(item.event, view));
      }
    }
  }
  return h(
    'section',
    { class: cx('session-block', open && 'is-open'), 'data-xs': block.xs },
    sessionHead(block, model, open),
    open ? connectionBlock(block, model) : null,
    open && nodes.length ? h('div', { class: 'session-flow' }, ...nodes) : null,
    open && block.drawnEpisodes.length === 0 && block.context.length === 0
      ? h('p', { class: 'session-empty muted' }, 'No tool call in this session yet.')
      : null,
    open && block.ended
      ? h('div', { class: 'session-end' }, contextRow(block.ended, view))
      : null,
  );
}

function chainBody(model, all, listing) {
  const { view } = model;
  const { items, incoming, hiddenEpisodes, callCount, ctx } = listing;
  const nodes = items.map((item) =>
    item.block ? sessionBlock(item.block, model, ctx, incoming) : contextRow(item.event, view),
  );
  const filtered = !isEmptyFilter(view.filter);
  return h(
    'div',
    { class: 'timeline-scroll timeline-scroll-chain', id: 'timeline-scroll' },
    isOpen(view, GLOSSARY_KEY, 'toolbarMore') ? glossary() : null,
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
        mode === 'chain'
          ? disclosure('What the ids mean', GLOSSARY_KEY, isOpen(view, GLOSSARY_KEY, 'toolbarMore'), {
              kind: 'toolbarMore',
              class: 'btn btn-quiet glossary-toggle',
              title: 'login, grant, session, request and event ids, and input versus output',
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
