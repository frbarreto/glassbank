/**
 * Panel 4 - Possibility space (block: dashboard).
 *
 * What the client was told, tool by tool: the listing the rows came from, the availability of every
 * tool, and - once a row is opened - the descriptor as it was sent (description verbatim, the
 * parameter table with the `rationale` the model is asked for, annotations, `_meta`) with this
 * browser's own check of the recorded schema against the digest recorded beside it.
 *
 * The point of the availability half is ADR-13: a write tool stays **listed** under a read-only
 * grant so the model can call it and trigger the 403 step-up, and this list is where "listed but not
 * usable right now" is made explicit instead of silently hidden. Those rows stay loud; everything
 * else on an ordinary row is quiet.
 *
 * Nothing here claims the model read a description: what reaches the model is not observable
 * (A-05), so the page only ever says what was sent.
 *
 * Fed by `catalog.tools_listed` and `catalog.availability`; the digest verdicts arrive in
 * `view.schemaChecks`, written by `app.js` from `checkListingSchemas`.
 */
import { cx, h } from './h.js';
import {
  callout,
  disclosure,
  emptyState,
  schemaCheckBadge,
  section,
  stat,
  statusBadge,
  tag,
  toolDescriptorCard,
} from './ui.js';
import { clockTime, count, joinList, relativeTime } from './format.js';
import { catRawKey, catToolKey, catViewerId, isOpen } from './open-state.js';

const REASON_TEXT = {
  missing_scopes: 'the grant is missing a scope',
  disabled_for_deployment: 'the deployment feature flag is off',
  authorization_level_not_allowed: 'the authorization level does not allow it',
};

/**
 * What a re-list without rows stands for, said on the page rail: `content_hash` covers no wording.
 * Keyed by the `resolved_from` of `shownCatalog`, which carries one only when the session's latest
 * `tools/list` really carried no rows.
 */
const RESOLVED_TEXT = {
  hash: (id) =>
    `The latest tools/list of this session carried only its content_hash, so these rows are the ones recorded at tools/list #${id} under the same hash, which does not cover wording or schemas.`,
  snapshot_ref: (id) =>
    `The latest tools/list of this session carried no rows; these come from tools/list #${id}, the listing its snapshot_ref names.`,
  previous: (id) =>
    `The latest tools/list of this session carried no rows; these come from its previous listing, tools/list #${id}.`,
};

/** The newest retained `catalog.tools_listed` of one session, or null. The store keeps events by id. */
function latestToolsListed(store, xs) {
  const events = store.getEvents?.() ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'catalog.tools_listed' && event.xs === xs) return event;
  }
  return null;
}

/**
 * The catalog this panel shows for one session, with the provenance of its rows told by the
 * session's latest `tools/list`, not by the store's fold alone. `store.getCatalog` re-runs its
 * resolution on every `catalog.availability` too, so after #179 its `resolved_from` reads `hash`
 * against #178, the very listing #179 follows, and a newer listing of another session under the
 * same hash could take its `event_id`. So:
 * - the latest listing carried rows: those rows and that event, `resolved_from: 'event'`;
 * - it carried none: the store's resolution stands (`hash` / `snapshot_ref` / `previous` / `none`);
 * - none is retained: the store's rows, with `resolved_from: null`, so no line claims how.
 * `latest` lets a caller that already walked the events (app.js) pass the listing in.
 */
export function shownCatalog(store, xs, latest = undefined) {
  const catalog = xs ? store.getCatalog(xs) : null;
  if (!catalog) return null;
  const listing = latest === undefined ? latestToolsListed(store, xs) : latest;
  if (!listing) return { ...catalog, resolved_from: null };
  const own = listing.data?.tools;
  if (Array.isArray(own) && own.length > 0) {
    return { ...catalog, tools: own, event_id: listing.id, resolved_from: 'event' };
  }
  return catalog;
}

/** Merges the tool metadata and the availability row for one tool name. */
export function joinCatalog(catalog) {
  const tools = new Map((catalog?.tools ?? []).map((tool) => [tool.name, tool]));
  const rows = [];
  const seen = new Set();
  for (const availability of catalog?.availability ?? []) {
    rows.push({ ...availability, tool_meta: tools.get(availability.tool) ?? null });
    seen.add(availability.tool);
  }
  for (const [name, tool] of tools) {
    if (seen.has(name)) continue;
    rows.push({
      tool: name,
      listed: true,
      available: true,
      unavailable_reasons: [],
      missing_scopes: [],
      tool_meta: tool,
    });
  }
  // What the panel exists to show goes first: listed but not callable (ADR-13), then anything the
  // client never saw, then the ordinary usable tools.
  return rows.sort((a, b) => {
    const rank = (row) => (!row.available ? 0 : !row.listed ? 1 : 2);
    return rank(a) - rank(b) || a.tool.localeCompare(b.tool);
  });
}

// ---------------------------------------------------------------------------
// The digest check (the effect lives in app.js; this is the pure part)
// ---------------------------------------------------------------------------

/** Where one verdict lives in `view.schemaChecks`: a later listing never reuses an older verdict. */
export function schemaCheckKey(listingId, name) {
  return `${listingId}/${name}`;
}

/**
 * The digest `src/mcp/xray.ts` records as `input_schema_hash`: SHA-256 over
 * `JSON.stringify(inputSchema)`, lowercase hex, first 16 characters. `subtle` is a `SubtleCrypto`
 * (the browser's `crypto.subtle`, or Node's `globalThis.crypto.subtle` in the tests).
 */
export async function schemaDigest(inputSchema, subtle) {
  const bytes = new TextEncoder().encode(JSON.stringify(inputSchema));
  const buffer = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/**
 * One verdict per tool of a full listing: `verified`, `mismatch`, `unavailable` or `failed`. A row
 * with no `descriptor` (contracts v0.4) has nothing to check and gets no verdict. Without a usable
 * `crypto.subtle` (plain http on anything but localhost) every row is `unavailable` and nothing
 * throws; a digest that exists but fails to compute is `failed`, never a mismatch.
 */
export async function checkListingSchemas(tools, subtle) {
  const rows = Array.isArray(tools) ? tools : [];
  const usable = Boolean(subtle) && typeof subtle.digest === 'function';
  const checked = await Promise.all(
    rows.map(async (tool) => {
      if (!tool || typeof tool.name !== 'string') return null;
      const schema = tool.descriptor?.inputSchema;
      if (!schema || typeof schema !== 'object') return null;
      if (!usable) return [tool.name, 'unavailable'];
      try {
        const digest = await schemaDigest(schema, subtle);
        return [tool.name, digest === tool.input_schema_hash ? 'verified' : 'mismatch'];
      } catch {
        return [tool.name, 'failed'];
      }
    }),
  );
  return Object.fromEntries(checked.filter(Boolean));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function annotations(meta) {
  if (!meta) return [tag('annotations unknown', 'tag-quiet')];
  const marks = [];
  if (meta.read_only) marks.push(tag('read-only', 'tag-quiet'));
  if (meta.destructive) marks.push(tag('destructive', 'tag-quiet'));
  if (meta.idempotent) marks.push(tag('idempotent', 'tag-quiet'));
  return marks;
}

/** Quiet for an ordinary row; the two ADR-13 states (listed but unusable, hidden) stay loud. */
function availabilityBadges(row) {
  if (!row.listed) {
    return [
      statusBadge('warn', 'hidden'),
      row.available ? tag('usable', 'tag-quiet') : statusBadge('denied', 'not usable'),
    ];
  }
  if (!row.available) return [statusBadge('ok', 'listed'), statusBadge('denied', 'not usable')];
  return [tag('usable', 'tag-quiet')];
}

/**
 * `tools/list #178 · 14:07:04.500 · JSON-RPC id 1 · 17 of 17 sent · content_hash …`
 *
 * `N` is what that listing carried itself (`catalog.tools`), never the latest `catalog.availability`,
 * which a later event replaces; `M` is every tool the page knows of, hidden ones included. With no
 * listing rows at all (only availability arrived) no listing is named, and the count is what the
 * availability rows say was listed.
 */
function listingHeader(catalog, listing, rows) {
  const named = catalog.tools.length > 0;
  const parts = named
    ? [
        h('span', { class: 'mono listing-id' }, `tools/list #${catalog.event_id}`),
        listing?.ts
          ? h('span', { class: 'mono listing-time', title: listing.ts }, clockTime(listing.ts))
          : null,
        // The store keeps 6,000 events but the rows outlive their event: a missing event is not a
        // missing JSON-RPC id, so the header says which of the two it is.
        listing
          ? h('span', {}, `JSON-RPC id ${listing.request_id ?? 'not recorded'}`)
          : h('span', { class: 'listing-gone' }, 'the listing event is no longer retained on this page'),
        h('span', {}, `${count(catalog.tools.length)} of ${count(rows.length)} sent`),
      ]
    : [
        h('span', { class: 'listing-gone' }, 'no tools/list rows are retained for this session'),
        h('span', {}, `${count(rows.filter((row) => row.listed).length)} of ${count(rows.length)} listed, per catalog.availability`),
      ];
  if (catalog.content_hash) {
    parts.push(
      h(
        'span',
        { class: 'listing-hash' },
        h('span', { class: 'mono' }, `content_hash ${catalog.content_hash}`),
        ' ',
        h('span', { class: 'listing-hash-note' }, '(covers names, scopes and flags, not wording or schemas)'),
      ),
    );
  }
  const joined = [];
  parts.filter(Boolean).forEach((part, index) => {
    if (index) joined.push(' · ');
    joined.push(part);
  });
  return h('p', { class: 'listing-head' }, ...joined);
}

/**
 * Per tool: every call the store holds for this session (denied ones included), and how many of
 * them carry an `intent.missing` child, the same record the spine's `no rationale` chip reads (A-06).
 */
function callCountsOf(store, xs) {
  const counts = new Map();
  for (const call of store.getCalls?.({ xs }) ?? []) {
    const entry = counts.get(call.tool) ?? { calls: 0, missing: 0 };
    entry.calls += 1;
    const children = call.child_event_ids ?? [];
    if (children.some((id) => store.getEventById?.(id)?.type === 'intent.missing')) entry.missing += 1;
    counts.set(call.tool, entry);
  }
  return counts;
}

/**
 * One tool: a closed line (name, title, quiet badges, the digest verdict) that opens into the
 * descriptor card. Listed-but-unusable and hidden rows keep their loud styling and reason (ADR-13).
 */
function availabilityRow(row, ctx) {
  const reasons = row.unavailable_reasons ?? [];
  const meta = row.tool_meta;
  const { view, xs, catalog } = ctx;
  const key = catToolKey(xs, row.tool);
  const open = meta ? isOpen(view, key, 'catTool') : false;
  const check = meta?.descriptor
    ? (view.schemaChecks ?? {})[schemaCheckKey(catalog.event_id, row.tool)] ?? 'pending'
    : null;
  const label = h(
    'span',
    { class: 'tool-item-label' },
    h('span', { class: 'mono tool-name' }, row.tool),
    meta?.title ? h('span', { class: 'tool-item-title' }, meta.title) : null,
  );
  const scopes = meta?.scopes ?? [];
  const rawKey = catRawKey(key);
  return h(
    'li',
    {
      class: cx(
        'tool-item',
        !row.available && 'is-unavailable',
        !row.listed && 'is-hidden',
        open && 'is-open',
      ),
      'data-tool': row.tool,
    },
    h(
      'div',
      { class: 'tool-item-head' },
      meta
        ? disclosure(label, key, open, {
            kind: 'catTool',
            class: 'tool-item-toggle',
            title: open ? 'Fold the descriptor away' : 'What the client was told about this tool',
          })
        : label,
      h(
        'span',
        { class: 'tool-item-badges' },
        ...annotations(meta),
        meta ? tag(scopes.length ? scopes.join(' ') : 'no scope', 'tag-quiet mono tool-item-scopes') : null,
        ...availabilityBadges(row),
        check ? schemaCheckBadge(check) : null,
      ),
    ),
    reasons.length
      ? h(
          'p',
          { class: 'tool-item-reason' },
          reasons.map((reason) => REASON_TEXT[reason] ?? reason).join('; '),
          (row.missing_scopes ?? []).length
            ? h('span', { class: 'mono missing-scopes' }, ` ${joinList(row.missing_scopes)}`)
            : null,
        )
      : null,
    open
      ? toolDescriptorCard(row, {
          listingId: catalog.event_id,
          check,
          calls: ctx.callCounts.get(row.tool)?.calls ?? 0,
          missing: ctx.callCounts.get(row.tool)?.missing ?? 0,
          rawKey,
          rawOpen: isOpen(view, rawKey, 'catRaw'),
          viewerId: catViewerId(xs, row.tool),
          tableId: `params-${catViewerId(xs, row.tool)}`,
          state: view.json ?? {},
        })
      : null,
  );
}

/** The whole panel. `model` is `{ store, view, now }`. */
export function renderPossibility(model) {
  const { store, view, now } = model;
  const xs = view.selectedXs ?? store.getSessions()[0]?.xs ?? null;
  const catalog = xs ? shownCatalog(store, xs) : null;

  if (!catalog || (catalog.tools.length === 0 && catalog.availability.length === 0)) {
    return section(
      'Possibility space',
      null,
      emptyState(
        'No catalog snapshot yet',
        'The tool catalog appears the first time your client calls tools/list on this session.',
      ),
    );
  }

  const rows = joinCatalog(catalog);
  const listed = rows.filter((row) => row.listed).length;
  const usable = rows.filter((row) => row.available).length;
  const listedNotUsable = rows.filter((row) => row.listed && !row.available);
  const listing = store.getEventById?.(catalog.event_id) ?? null;
  const resolved = RESOLVED_TEXT[catalog.resolved_from];
  const ctx = { view, xs, catalog, callCounts: callCountsOf(store, xs) };

  return section(
    'Possibility space',
    `snapshot from ${relativeTime(catalog.captured_at, now)}`,
    listingHeader(catalog, listing, rows),
    resolved ? h('p', { class: 'listing-resolved who-page' }, resolved(catalog.event_id)) : null,
    h(
      'div',
      { class: 'stat-row' },
      stat('tools listed', count(listed), { title: 'Entries in the tools/list the client received' }),
      stat('usable now', count(usable), { tone: 'ok' }),
      stat('listed, not usable', count(listedNotUsable.length), {
        tone: listedNotUsable.length ? 'warn' : null,
      }),
      stat('re-listed', count(catalog.list_count ?? 1), {
        title: 'How many tools/list calls this session made. claude.ai re-lists every 25-80 s (A-27).',
      }),
    ),
    h(
      'div',
      { class: 'catalog-meta' },
      h('span', {}, `feature flags: ${joinList(catalog.feature_flags, 'none')}`),
      catalog.repeated
        ? tag('unchanged since the last full snapshot', 'tag-quiet')
        : tag('full snapshot', 'tag-quiet'),
    ),
    listedNotUsable.length
      ? callout(
          `${listedNotUsable.length} tool(s) are listed but cannot run yet`,
          'Write tools stay in tools/list whenever their feature flag is on, whatever the grant holds (ADR-13). That is what lets the model call one and get the 403 step-up instead of never seeing the tool at all.',
          'warn',
        )
      : null,
    h('ul', { class: 'tool-list' }, ...rows.map((row) => availabilityRow(row, ctx))),
    h(
      'p',
      { class: 'panel-footnote' },
      'A hidden tool is one the client never saw: a missing read scope or a deployment flag. A listed-but-unusable tool is one the client can call to trigger a step-up. Open a tool to see the descriptor as it was sent; whether the model read it is not observable (A-05).',
    ),
  );
}
