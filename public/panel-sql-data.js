/**
 * Panel 7 - SQL and data (block: dashboard).
 *
 * The scratch database, seen from outside: which tables the load tools built, what
 * `process_data` kept, every `execute_query` with its row count and duration, every rejection and
 * eviction, and what is still in the schema right now.
 *
 * Fed by `etl.*` and `sql.*`.
 */
import { cx, h } from './h.js';
import { codeBlock, emptyState, section, stat, statusBadge, tag } from './ui.js';
import { clockTime, count, duration, joinList, plural } from './format.js';

/**
 * Folds the ETL and SQL events of a session into the current scratch schema.
 * A table is `live` until it is cleared, evicted, or lost with a killed query runner.
 */
export function scratchSchema(events) {
  const tables = new Map();
  const touch = (name, patch) => {
    if (!name) return null;
    const existing = tables.get(name) ?? {
      table: name,
      rows: null,
      columns_advertised: [],
      columns_selected: [],
      source_tool: null,
      state: 'live',
      note: null,
      queries: 0,
      last_ts: null,
    };
    const next = { ...existing, ...patch };
    tables.set(name, next);
    return next;
  };
  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'etl.load':
        touch(data.table, {
          rows: data.rows ?? null,
          columns_advertised: data.columns_advertised ?? [],
          source_tool: data.source_tool ?? null,
          state: 'live',
          note: null,
          last_ts: event.ts,
        });
        break;
      case 'etl.processed':
        touch(data.table, {
          rows: data.rows ?? null,
          columns_advertised: data.columns_advertised ?? [],
          columns_selected: data.columns_selected ?? [],
          state: 'live',
          last_ts: event.ts,
        });
        break;
      case 'sql.query':
        if (data.table) {
          const row = tables.get(data.table);
          if (row) touch(data.table, { queries: row.queries + 1, last_ts: event.ts });
        }
        break;
      case 'sql.table_cleared':
        touch(data.table, { state: 'cleared', note: 'dropped by clear_table', last_ts: event.ts });
        break;
      case 'etl.table_evicted':
        touch(data.table, { state: 'evicted', note: `evicted: ${data.reason}`, last_ts: event.ts });
        break;
      case 'etl.worker_terminated':
        for (const lost of data.tables_lost ?? []) {
          touch(lost, {
            state: 'lost',
            note: 'the scratch database was reset when the query runner was killed',
            last_ts: event.ts,
          });
        }
        break;
      default:
        break;
    }
  }
  return [...tables.values()];
}

const STATE_BADGE = {
  live: ['ok', 'live'],
  cleared: ['info', 'cleared'],
  evicted: ['warn', 'evicted'],
  lost: ['error', 'lost'],
};

/** One scratch table as a card; five columns of table do not fit this column width. */
function tableRow(row) {
  const [tone, label] = STATE_BADGE[row.state] ?? ['info', row.state];
  return h(
    'li',
    { class: cx('scratch-item', `is-${row.state}`) },
    h(
      'div',
      { class: 'scratch-head' },
      h('span', { class: 'mono scratch-name' }, row.table),
      h('span', { class: 'scratch-badge' }, statusBadge(tone, label)),
    ),
    h(
      'p',
      { class: 'scratch-meta' },
      row.source_tool ? h('span', {}, `built by ${row.source_tool}`) : null,
      row.rows === null ? null : h('span', {}, plural(row.rows, 'row')),
      h('span', {}, plural(row.queries, 'query', 'queries')),
    ),
    h(
      'p',
      { class: 'scratch-columns mono' },
      row.columns_selected.length
        ? `${row.columns_selected.length} of ${row.columns_advertised.length} columns kept: ${joinList(
            row.columns_selected,
          )}`
        : `${row.columns_advertised.length} columns: ${joinList(row.columns_advertised)}`,
    ),
    row.note ? h('p', { class: 'scratch-note' }, row.note) : null,
  );
}

function queryBlock(event) {
  const data = event.data ?? {};
  const rejected = event.type === 'sql.rejected';
  return h(
    'li',
    { class: cx('query', rejected && 'is-rejected') },
    h(
      'button',
      {
        type: 'button',
        class: 'query-head',
        'data-action': 'select-event',
        'data-arg': String(event.id),
      },
      h('span', { class: 'mono query-time', title: event.ts }, clockTime(event.ts)),
      rejected
        ? statusBadge('error', String(data.rejected_reason ?? 'rejected').replace(/_/g, ' '))
        : statusBadge('ok', `${count(data.rows_returned)} rows`),
      data.capped ? tag('row cap hit', 'tag-warn') : null,
      h('span', { class: 'query-duration mono' }, duration(data.duration_ms)),
      data.table ? h('span', { class: 'mono muted' }, data.table) : null,
    ),
    codeBlock(data.sql, { lang: 'sql', id: `sql-${event.id}` }),
    rejected ? h('p', { class: 'query-error' }, data.error ?? '') : null,
  );
}

/** The whole panel. `model` is `{ store, view }`. */
export function renderSqlData(model) {
  const { store, view } = model;
  const xs = view.selectedXs ?? null;
  const events = store.getEvents({ xs });
  const schema = scratchSchema(events);
  const queries = events.filter((event) => event.type === 'sql.query' || event.type === 'sql.rejected');
  const limits = events.filter(
    (event) => event.type === 'etl.limit_reached' || event.type === 'etl.worker_terminated',
  );

  if (schema.length === 0 && queries.length === 0) {
    return section(
      'SQL and data',
      null,
      emptyState(
        'Nothing loaded yet',
        'The load tools build a scratch table per call, process_data narrows it, and execute_query reads it back. Whatever the model runs shows up here verbatim.',
      ),
    );
  }

  const live = schema.filter((row) => row.state === 'live');
  const capped = queries.filter((event) => event.data?.capped).length;

  return section(
    'SQL and data',
    plural(live.length, 'live table'),
    h(
      'div',
      { class: 'stat-row' },
      stat('tables built', count(schema.length)),
      stat('live now', count(live.length), { tone: 'ok' }),
      stat('queries', count(queries.filter((event) => event.type === 'sql.query').length)),
      stat('rejected', count(queries.filter((event) => event.type === 'sql.rejected').length), {
        tone: queries.some((event) => event.type === 'sql.rejected') ? 'warn' : null,
      }),
      stat('row cap hits', count(capped), { tone: capped ? 'warn' : null }),
    ),
    h('h4', { class: 'sub-title' }, 'Scratch schema'),
    h('ul', { class: 'scratch-list' }, ...schema.map((row) => tableRow(row))),
    limits.length
      ? h(
          'div',
          { class: 'limits' },
          h('h4', { class: 'sub-title' }, 'Guard rails that fired'),
          ...limits.map((event) =>
            h(
              'p',
              { class: 'limit-line' },
              statusBadge(event.type === 'etl.worker_terminated' ? 'error' : 'warn'),
              h('span', { class: 'mono' }, clockTime(event.ts)),
              h(
                'span',
                {},
                event.type === 'etl.worker_terminated'
                  ? `The query runner was killed after ${duration(event.data?.duration_ms)} (${
                      event.data?.reason ?? 'timeout'
                    }); tables lost: ${joinList(event.data?.tables_lost)}.`
                  : `The ${String(event.data?.limit ?? 'scratch').replace(/_/g, ' ')} limit was reached: ${
                      event.data?.message ?? ''
                    }`,
              ),
            ),
          ),
        )
      : null,
    h('h4', { class: 'sub-title' }, 'Every statement, verbatim'),
    queries.length
      ? h('ol', { class: 'query-list' }, ...queries.map((event) => queryBlock(event)))
      : h('p', { class: 'muted' }, 'No SQL has been run in this session.'),
    h(
      'p',
      { class: 'panel-footnote' },
      'SQL is model-authored and stored exactly as it arrived. The guard runs it read-only, off the main event loop, capped at 100 rows and bounded by a hard timeout.',
    ),
  );
}
