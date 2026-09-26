/**
 * Shared building blocks for the panels (block: dashboard).
 *
 * Badges, key/value rows, section headers, code blocks and the two placeholder states. Panels
 * compose these so a badge means the same thing everywhere on the page. Pure `h()` trees; no DOM.
 */
import { cx, h } from './h.js';
import { FAMILY_GLYPHS, FAMILY_LABELS, STATUS_LABELS, familyOf } from './catalogue.js';
import { clip, plural, prettyJson, ratio } from './format.js';
import { jsonView, viewerId } from './json-view.js';
import { idFor } from './open-state.js';

/** A coloured status pill: OK, Error, Warning, Denied, In flight, Info. */
export function statusBadge(status, label) {
  return h('span', { class: `badge badge-${status}` }, label ?? STATUS_LABELS[status] ?? status);
}

/** A neutral pill for facts that are not a severity (scopes, protocol versions, flags). */
export function tag(text, extraClass) {
  return h('span', { class: cx('tag', extraClass) }, text);
}

/** The three-to-four letter family marker at the head of a timeline row. */
export function familyTag(type) {
  const family = familyOf(type);
  return h(
    'span',
    { class: `fam fam-${family}`, title: `${FAMILY_LABELS[family] ?? family} events` },
    FAMILY_GLYPHS[family] ?? '?',
  );
}

/** One `label / value` row inside a definition list. */
export function kv(label, value, options = {}) {
  return h(
    'div',
    { class: cx('kv', options.wide && 'kv-wide', options.class) },
    h('dt', { class: 'kv-key' }, label),
    h('dd', { class: cx('kv-value', options.mono && 'mono') }, value === undefined ? '-' : value),
  );
}

export function kvList(...rows) {
  return h('dl', { class: 'kv-list' }, ...rows);
}

/** A panel section with a heading and optional trailing note. */
export function section(title, note, ...body) {
  return h(
    'section',
    { class: 'section' },
    h(
      'header',
      { class: 'section-head' },
      h('h3', { class: 'section-title' }, title),
      note ? h('span', { class: 'section-note' }, note) : null,
    ),
    ...body,
  );
}

/**
 * Monospace block for SQL, JSON and previews.
 *
 * `options.id` is not decoration: `.code[id]` is the rule that lets a block become its own
 * scroller, because `mount.js` only puts back the offset of an element carrying an `id`. A block
 * without one grows and lets the panel scroll instead. Give an id to anything that can be long.
 */
export function codeBlock(text, options = {}) {
  return h(
    'pre',
    {
      class: cx('code', options.class),
      id: options.id ?? null,
      'data-lang': options.lang ?? null,
    },
    h('code', {}, String(text ?? '')),
  );
}

export function jsonBlock(value, options = {}) {
  return codeBlock(prettyJson(value, options.max ?? 20_000), { class: 'code-json', lang: 'json' });
}

/** The "nothing to show here yet" state inside a panel. */
export function emptyState(title, body, action) {
  return h(
    'div',
    { class: 'empty' },
    h('p', { class: 'empty-title' }, title),
    body ? h('p', { class: 'empty-body' }, body) : null,
    action ?? null,
  );
}

/** A horizontal bar; `value/max` drives the fill and `tone` its colour. */
export function meter(value, max, options = {}) {
  const fraction = ratio(value, max);
  return h(
    'div',
    {
      class: cx('meter', options.class),
      role: 'img',
      'aria-label': options.label ?? `${Math.round(fraction * 100)} percent`,
      title: options.title ?? null,
    },
    h('div', {
      class: cx('meter-fill', options.tone && `meter-${options.tone}`),
      // A tiny but non-zero value still gets a visible hairline, so "fast" never reads as "absent".
      style:
        fraction > 0
          ? `width:max(2px, ${(fraction * 100).toFixed(3)}%)`
          : 'width:0',
    }),
  );
}

/** A small labelled number, used across the header and the health panel. */
export function stat(label, value, options = {}) {
  return h(
    'div',
    { class: cx('stat', options.tone && `stat-${options.tone}`), title: options.title ?? null },
    h('div', { class: 'stat-value' }, value),
    h('div', { class: 'stat-label' }, label),
  );
}

/** A clickable button rendered as markup; wired by delegation on `data-action`. */
export function button(label, action, options = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: cx('btn', options.variant && `btn-${options.variant}`, options.class),
      'data-action': action,
      'data-arg': options.arg ?? null,
      'data-arg2': options.arg2 ?? null,
      title: options.title ?? null,
      disabled: options.disabled ? true : null,
      'aria-pressed': options.pressed === undefined ? null : String(Boolean(options.pressed)),
    },
    label,
  );
}

/**
 * The control that opens and closes one block of the spine (`public/open-state.js`).
 *
 * `open` is the state the panel just drew, and it travels to the action as `data-arg2`, so the
 * click always undoes what the reader can see. The `id` is derived from the key rather than from
 * a counter, so `mount.js` puts the focus back on the same control after the repaint. `label` may
 * be a whole node: the chain step's head line is one of these.
 */
export function disclosure(label, key, open, options = {}) {
  return h(
    'button',
    {
      type: 'button',
      class: cx('disclosure', options.class, open && 'is-open'),
      id: options.id ?? idFor(key),
      'data-action': 'toggle-open',
      'data-arg': key,
      'data-arg2': open ? '1' : '0',
      'data-open-key': key,
      'data-kind': options.kind ?? null,
      'aria-expanded': String(Boolean(open)),
      title: options.title ?? null,
    },
    h(
      'span',
      { class: cx('disclosure-glyph', options.tone && `disclosure-glyph-${options.tone}`), 'aria-hidden': 'true' },
      open ? '\u25be' : '\u25b8',
    ),
    label,
  );
}

/** A note the viewer must read to interpret the panel correctly (limits, provenance). */
export function callout(title, body, tone = 'info') {
  return h(
    'div',
    { class: `callout callout-${tone}` },
    h('p', { class: 'callout-title' }, title),
    h('p', { class: 'callout-body' }, body),
  );
}

/**
 * One argument value, verbatim.
 *
 * A value that is not a string is a value the reader has to be able to read: an array of columns,
 * a nested `to`, a whole object. Pretty-printing it into a `<dd>` did nothing, because the cell
 * inherits `white-space: normal` and collapsed every newline and every run of indentation into one
 * space - a nested argument arrived as one run-on line. Those go to the JSON viewer instead.
 */
export function argumentValue(value, options = {}) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return jsonView(value, { id: options.id ?? 'args', state: options.state ?? {} });
}

/**
 * Renders `{key: value}` pairs verbatim, marking the ones the redaction pipeline replaced.
 *
 * `options` carries the viewer's `{id, state}`; without them the values still render, just with no
 * memory of what the reader opened.
 */
export function argumentList(argumentsObject, redactedFields = [], options = {}) {
  const entries = Object.entries(argumentsObject ?? {});
  if (entries.length === 0) {
    return h('p', { class: 'muted' }, 'The client sent no arguments.');
  }
  const redacted = new Set(redactedFields ?? []);
  const base = options.id ?? 'args';
  return h(
    'dl',
    { class: 'kv-list args' },
    ...entries.map(([key, value]) =>
      h(
        'div',
        { class: cx('kv', redacted.has(key) && 'kv-redacted') },
        h(
          'dt',
          { class: 'kv-key mono' },
          key,
          redacted.has(key) ? h('span', { class: 'badge badge-warn' }, 'redacted') : null,
        ),
        h(
          'dd',
          { class: 'kv-value mono' },
          argumentValue(value, { id: viewerId(base, key), state: options.state ?? {} }),
        ),
      ),
    ),
  );
}

/** A table with a caption-free head; every panel table uses the same wrapper so widths agree. */
export function table(headers, rows, options = {}) {
  return h(
    'div',
    { class: cx('table-wrap', options.class) },
    h(
      'table',
      { class: 'table' },
      h('thead', {}, h('tr', {}, ...headers.map((header) => h('th', {}, header)))),
      h('tbody', {}, ...rows),
    ),
  );
}

/**
 * One line of a rebuilt envelope: a coloured rail naming who authored it, the key it sat under and
 * the value as recorded (`public/hops.js`). The rail is the only colour in the pane - it says who,
 * never what kind of thing this is - and `implied` switches it to the dashed page rail, because a
 * value this page worked out may never be drawn as one the server recorded.
 */
export function authoredRow(options = {}, ...value) {
  const actor = options.actor ?? 'page';
  return h(
    'div',
    {
      class: cx(
        'wire-row',
        `who-${actor}`,
        options.implied && 'is-implied',
        options.emphasis && 'is-emphasis',
        options.dimmed && 'is-dimmed',
        options.class,
      ),
      'data-actor': actor,
      'data-path': options.path ?? null,
      title: options.title ?? null,
    },
    h('span', { class: 'wire-rail', 'aria-hidden': 'true' }),
    options.key === null || options.key === undefined
      ? null
      : h('span', { class: 'wire-key mono' }, options.key),
    h('span', { class: cx('wire-value', options.mono && 'mono') }, ...value),
  );
}

/** A small rounded label; `actor` colours it, `tone` marks a warning without naming a party. */
export function pill(text, options = {}) {
  return h(
    'span',
    {
      class: cx(
        'pill',
        options.actor && `who-${options.actor}`,
        options.tone && `pill-${options.tone}`,
        options.dimmed && 'is-dimmed',
        options.class,
      ),
      'data-actor': options.actor ?? null,
      title: options.title ?? null,
    },
    text,
  );
}

/** A tiny inline label, used for the "verbatim" and "inferred" provenance marks. */
export function provenance(text, tone = 'neutral') {
  return h('span', { class: `prov prov-${tone}` }, text);
}

/** Truncates a long string for a one-line cell but keeps the whole value in the tooltip. */
export function ellipsis(value, max = 80) {
  const text = String(value ?? '');
  return h('span', { title: text.length > max ? text : null }, clip(text, max));
}

// ---------------------------------------------------------------------------
// What the client was told about one tool (the contracts v0.5 `descriptor`)
// ---------------------------------------------------------------------------

/**
 * The browser's own digest verdicts (`checkListingSchemas`, `public/panel-possibility.js`). Each
 * sentence is about the recorded schema and the digest recorded beside it: never a claim that the
 * client received anything, and never about the description, which no digest covers.
 */
export const SCHEMA_CHECK_TEXT = {
  verified:
    'recorded schema is intact: re-hashes to the digest recorded beside it, computed in this browser',
  mismatch:
    'recorded schema does not re-hash to the digest recorded beside it (computed in this browser)',
  unavailable: 'not checked: this browser has no crypto.subtle (it needs https or localhost)',
  failed: 'not checked: this browser could not compute the digest',
  pending: 'checking the recorded schema',
};

/** The same verdicts, short enough for a closed row; the whole sentence rides in the `title`. */
export const SCHEMA_CHECK_LABEL = {
  verified: 'recorded schema intact',
  mismatch: 'recorded schema does not match its digest',
  unavailable: 'schema not checked',
  failed: 'schema not checked',
  pending: 'checking schema',
};

/** What a row recorded before contracts v0.5 can honestly say. */
export const DESCRIPTOR_MISSING_SENTENCE =
  'This listing recorded name, title, flags, scopes and a schema digest only (contracts v0.4). The description and schema the client received were not captured.';

/** One verdict: quiet unless the schema does not re-hash. `full` prints the whole sentence. */
export function schemaCheckBadge(state, options = {}) {
  const verdict = Object.hasOwn(SCHEMA_CHECK_TEXT, state) ? state : 'pending';
  return h(
    'span',
    {
      class: cx(
        'schema-check',
        `is-${verdict}`,
        options.full && 'schema-check-full',
        verdict === 'mismatch' ? 'badge badge-error' : 'tag tag-quiet',
      ),
      'data-check': verdict,
      title: options.full ? null : SCHEMA_CHECK_TEXT[verdict],
    },
    options.full ? SCHEMA_CHECK_TEXT[verdict] : SCHEMA_CHECK_LABEL[verdict],
  );
}

function schemaTypeOf(node) {
  if (!node || typeof node !== 'object') return 'any';
  const type = Array.isArray(node.type) ? node.type.join(' | ') : node.type;
  if (type === 'array') return `array of ${schemaTypeOf(node.items)}`;
  if (type) return String(type);
  return Array.isArray(node.oneOf) ? 'one of' : 'any';
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `1-1024 chars`, `up to 140 chars`, `at least 1`. */
function range(min, max, unit) {
  const suffix = unit ? ` ${unit}` : '';
  if (min !== null && max !== null) return `${min}-${max}${suffix}`;
  if (max !== null) return `up to ${max}${suffix}`;
  if (min !== null) return `at least ${min}${suffix}`;
  return null;
}

/** Every constraint of one schema node, as short phrases; values are printed as JSON. */
function schemaConstraints(node) {
  if (!node || typeof node !== 'object') return [];
  const parts = [];
  if (Array.isArray(node.enum)) {
    parts.push(`one of ${node.enum.map((value) => JSON.stringify(value)).join(', ')}`);
  }
  if (Object.hasOwn(node, 'default')) parts.push(`default ${JSON.stringify(node.default)}`);
  const chars = range(numberOrNull(node.minLength), numberOrNull(node.maxLength), 'chars');
  if (chars) parts.push(chars);
  const bounds = range(numberOrNull(node.minimum), numberOrNull(node.maximum));
  if (bounds) parts.push(bounds);
  if (typeof node.pattern === 'string') parts.push(`pattern ${node.pattern}`);
  if (node.items && typeof node.items === 'object') {
    if (typeof node.items.description === 'string') parts.push(`each item: ${node.items.description}`);
    if (Array.isArray(node.items.enum)) {
      parts.push(`each item one of ${node.items.enum.map((value) => JSON.stringify(value)).join(', ')}`);
    }
  }
  if (Array.isArray(node.oneOf)) {
    parts.push(`exactly one of the ${node.oneOf.length} alternatives below`);
  }
  if (node.additionalProperties === false && !Array.isArray(node.oneOf)) parts.push('no other keys');
  return parts;
}

function paramRow(name, node, required, options = {}) {
  const schemaNode = node && typeof node === 'object' ? node : {};
  const constraints = schemaConstraints(schemaNode);
  return h(
    'tr',
    {
      class: cx(
        'param-row',
        options.nested && 'is-nested',
        options.rationale && 'is-rationale who-model',
      ),
      'data-param': name,
    },
    h(
      'td',
      { class: 'param-name mono' },
      name,
      options.alternative ? h('span', { class: 'param-alt' }, options.alternative) : null,
    ),
    h('td', { class: 'param-type mono' }, schemaTypeOf(schemaNode)),
    h('td', { class: 'param-required' }, required ? 'yes' : 'no'),
    h(
      'td',
      { class: 'param-desc' },
      typeof schemaNode.description === 'string'
        ? h('p', { class: 'param-description' }, schemaNode.description)
        : h('p', { class: 'param-description muted' }, 'no description'),
      constraints.length ? h('p', { class: 'param-constraints' }, constraints.join(' · ')) : null,
    ),
  );
}

/** The fields one level under a parameter: an object's properties, or each `oneOf` alternative. */
function nestedRows(name, node) {
  if (!node || typeof node !== 'object') return [];
  const rows = [];
  const fieldsOf = (object, prefix, alternative) => {
    const properties = object && typeof object.properties === 'object' ? object.properties : null;
    if (!properties) return false;
    const required = new Set(Array.isArray(object.required) ? object.required : []);
    for (const [key, child] of Object.entries(properties)) {
      rows.push(paramRow(`${prefix}.${key}`, child, required.has(key), { nested: true, alternative }));
    }
    return true;
  };
  fieldsOf(node, name, null);
  if (node.items && typeof node.items === 'object') fieldsOf(node.items, `${name}[]`, null);
  if (Array.isArray(node.oneOf)) {
    node.oneOf.forEach((option, index) => {
      const label = `alternative ${index + 1} of ${node.oneOf.length}${
        option?.additionalProperties === false ? ' · no other keys' : ''
      }`;
      if (!fieldsOf(option, name, label)) {
        rows.push(paramRow(name, option, false, { nested: true, alternative: label }));
      }
    });
  }
  return rows;
}

/**
 * A published `inputSchema` as a table: name, type, required, the description verbatim and every
 * constraint (enum, default, length and numeric bounds, pattern, array items). Nested objects are
 * drawn one level deep and `oneOf` as numbered alternatives; the raw descriptor holds the rest.
 * The top-level `rationale` row wears the model colour, because it is the one question every call
 * asks the model (ADR-8), and `options.rationaleNote` is drawn under it on the dashed page rail.
 * `options.id` goes on the wrapper, which is what lets a wide table keep its horizontal offset.
 */
export function paramTable(inputSchema, options = {}) {
  const schema = inputSchema && typeof inputSchema === 'object' ? inputSchema : {};
  const properties =
    schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return h('p', { class: 'muted param-empty' }, 'This schema declares no parameters.');
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const body = [];
  for (const [name, node] of entries) {
    const rationale = name === 'rationale';
    body.push(paramRow(name, node, required.has(name), { rationale }));
    if (rationale && options.rationaleNote) {
      body.push(
        h(
          'tr',
          { class: 'param-answer who-page' },
          h('td', { colspan: '4' }, h('p', { class: 'param-answer-note' }, options.rationaleNote)),
        ),
      );
    }
    body.push(...nestedRows(name, node));
  }
  return h(
    'div',
    { class: 'table-wrap param-table-wrap', id: options.id ?? null },
    h(
      'table',
      { class: 'table param-table' },
      h(
        'thead',
        {},
        h('tr', {}, ...['parameter', 'type', 'required', 'description'].map((label) => h('th', {}, label))),
      ),
      h('tbody', {}, ...body),
    ),
  );
}

/** `readOnlyHint true · idempotentHint false`; a `title` equal to the row's own is not repeated. */
function flagList(value, rowTitle) {
  if (!value || typeof value !== 'object') return h('span', { class: 'muted' }, 'not recorded');
  const entries = Object.entries(value).filter(([key, flag]) => !(key === 'title' && flag === rowTitle));
  if (entries.length === 0) return h('span', { class: 'muted' }, 'none');
  const parts = [];
  entries.forEach(([key, flag], index) => {
    if (index) parts.push(' · ');
    parts.push(
      h(
        'span',
        { class: 'flag' },
        h('span', { class: 'mono flag-key' }, key),
        ' ',
        h('span', { class: 'mono flag-value' }, typeof flag === 'string' ? flag : String(JSON.stringify(flag))),
      ),
    );
  });
  return h('span', { class: 'flag-list' }, ...parts);
}

/**
 * One tool as the client was told about it: the description verbatim and whole, the parameter
 * table with the `rationale` row, annotations, `_meta`, the digest verdict and a raw descriptor.
 *
 * `row` is a joined availability row (`joinCatalog`) or a recorded `catalog.tools_listed` row.
 * `ctx`: `{listingId, check, calls, missing, rawKey, rawOpen, viewerId, tableId, state}` - `check`
 * is the verdict (`verified` / `mismatch` / `unavailable` / `failed`, else pending), `calls` how
 * many times this session called the tool, `missing` how many of those calls carry an
 * `intent.missing` (A-06), `state` the `view.json` the raw viewer reads. Without `rawKey` there is
 * no raw toggle. `viewerId` and `tableId` default to ids derived from the listing and the tool, so
 * two open cards never share a DOM id or viewer state and the table keeps its scroll offset. A row
 * with no `descriptor` degrades to one sentence and the call count (contracts v0.4).
 */
export function toolDescriptorCard(row, ctx = {}) {
  const tool = row && Object.hasOwn(row, 'tool_meta') ? row.tool_meta : row;
  if (!tool || typeof tool !== 'object') {
    return h('div', { class: 'tool-card' }, h('p', { class: 'muted' }, 'No listing row was recorded for this tool.'));
  }
  const calls = `called ${plural(ctx.calls ?? 0, 'time')} in this session`;
  const missing = Number.isFinite(ctx.missing) ? ctx.missing : 0;
  // The rationale is asked for on every call, but the record says when one was not given (A-06).
  const answered =
    missing > 0 ? `${calls}, ${missing} of them without a rationale (intent.missing, A-06)` : calls;
  const baseId = ctx.viewerId ?? viewerId('descriptor', ctx.listingId, tool.name);
  const listing =
    ctx.listingId === null || ctx.listingId === undefined ? 'this listing' : `tools/list #${ctx.listingId}`;
  const descriptor = tool.descriptor && typeof tool.descriptor === 'object' ? tool.descriptor : null;
  if (!descriptor) {
    return h(
      'div',
      { class: 'tool-card is-degraded' },
      h('p', { class: 'tool-card-degrade' }, DESCRIPTOR_MISSING_SENTENCE),
      h('p', { class: 'tool-card-calls who-page' }, calls),
    );
  }
  const schema = descriptor.inputSchema;
  const hasRationale = Boolean(
    schema && typeof schema.properties === 'object' && schema.properties && Object.hasOwn(schema.properties, 'rationale'),
  );
  const rawOpen = Boolean(ctx.rawOpen);
  return h(
    'div',
    { class: 'tool-card' },
    h(
      'div',
      { class: 'tool-card-block' },
      h(
        'h4',
        { class: 'sub-title tool-card-label' },
        'description',
        h('span', { class: 'tool-card-source' }, ` · as sent with ${listing}`),
      ),
      typeof descriptor.description === 'string'
        ? h('p', { class: 'tool-card-description' }, descriptor.description)
        : h('p', { class: 'muted' }, 'The descriptor carried no description.'),
    ),
    h(
      'div',
      { class: 'tool-card-block' },
      h('h4', { class: 'sub-title tool-card-label' }, 'inputSchema'),
      paramTable(schema, {
        id: ctx.tableId ?? `params-${baseId}`,
        rationaleNote: hasRationale
          ? `answered by params.arguments.rationale on every tools/call · ${answered}`
          : null,
      }),
      hasRationale ? null : h('p', { class: 'tool-card-calls who-page' }, calls),
    ),
    kvList(
      kv('annotations', flagList(descriptor.annotations, tool.title)),
      kv('_meta', flagList(descriptor._meta)),
      kv(
        'digest',
        h(
          'span',
          { class: 'tool-card-digest' },
          h('span', { class: 'mono' }, `input_schema_hash ${tool.input_schema_hash ?? 'not recorded'}`),
          ' ',
          schemaCheckBadge(ctx.check, { full: true }),
        ),
      ),
    ),
    ctx.rawKey
      ? h(
          'div',
          { class: 'tool-card-raw' },
          disclosure('raw descriptor', ctx.rawKey, rawOpen, { kind: 'catRaw', class: 'tool-card-raw-toggle' }),
          rawOpen
            ? jsonView(descriptor, {
                id: baseId,
                state: ctx.state ?? {},
                title: `descriptor of ${tool.name} as recorded on ${listing}`,
              })
            : null,
        )
      : null,
  );
}
