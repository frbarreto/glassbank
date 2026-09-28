/**
 * The Account view (block: dashboard, contracts v0.10, D-31).
 *
 * The chain says what the agent did; this page says what the money looks like while it does it.
 * It reads `GET /xray/api/sessions/:xs/bank/activity` - the persona behind the session, on this
 * login's overlay, the same numbers `load_statement_lines`, `load_cards`, `load_bills` and
 * `load_transfers` return to the model - and draws it the way a banking app would: balances,
 * spending by category, money in and out per month, the statement, cards, bills and transfers.
 *
 * Two things tie it back to the X-ray:
 *   - **Changed by the agent**: every audit entry this login's writes left, with the rationale the
 *     model gave, linked to the call in the chain when the page holds the `bank.op` that wrote it.
 *   - **Read by the model**: what the model loaded in this session (`etl.load`), so the reader can
 *     tell the account from what the model has actually seen of it.
 *
 * Read-only on purpose: writes belong to the model and its tools (D-3). Reading this page emits
 * nothing, because the model did not cause it.
 *
 * Pure `renderAccount(model)`; `model` is `{ store, view, now }`.
 */
import { cx, h } from './h.js';
import { button, emptyState, meter, stat, table, tag } from './ui.js';
import { clockTime, count, money, plural, shortDateTime } from './format.js';
import { PUBLIC_LOGIN_ID } from './api.js';
import { effectiveSessionXs } from './panel-persona.js';

/** The windows the months control offers (`XRAY_ACTIVITY_MONTHS`). */
export const ACCOUNT_MONTHS = [1, 3, 6, 12];
/** Statement rows drawn before "show more". */
export const STATEMENT_PAGE = 40;
/** Categories drawn as bars; the rest fold into one "Other" bar. */
export const CATEGORY_BARS = 8;

const ACCOUNT_TYPE_LABELS = {
  checking: 'Checking',
  savings: 'Savings',
  credit_card: 'Credit card',
};
const SOURCE_LABELS = { transaction: 'Card or account', transfer: 'Transfer', bill: 'Bill' };

/** The session whose persona the page shows: the selected one, else the viewer's most recent. */
export function accountSessionXs(store, view) {
  const xs = effectiveSessionXs(store, view);
  if (!xs) return null;
  return store.getSession(xs)?.login_id === PUBLIC_LOGIN_ID ? null : xs;
}

/** Statement lines after the reader's filter (`view.account.filter`). */
export function filterLines(lines, filter = {}) {
  const text = String(filter.text ?? '')
    .trim()
    .toLowerCase();
  return (lines ?? []).filter((line) => {
    if (filter.account && line.account_id !== filter.account) return false;
    if (filter.category && (line.category_id ?? '') !== filter.category) return false;
    if (filter.source && line.source !== filter.source) return false;
    if (filter.direction === 'in' && line.amount_cents < 0) return false;
    if (filter.direction === 'out' && line.amount_cents >= 0) return false;
    if (!text) return true;
    return [line.description, line.counterparty, line.category_name, line.account_name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(text));
  });
}

/** Top categories as bars, the rest summed into "Other". */
export function categoryBars(categories, limit = CATEGORY_BARS) {
  const sorted = [...(categories ?? [])].sort((a, b) => b.spent_cents - a.spent_cents);
  if (sorted.length <= limit) return sorted;
  const head = sorted.slice(0, limit - 1);
  const rest = sorted.slice(limit - 1);
  return [
    ...head,
    {
      category_id: null,
      name: `Other (${rest.length} categories)`,
      spent_cents: rest.reduce((sum, entry) => sum + entry.spent_cents, 0),
      count: rest.reduce((sum, entry) => sum + entry.count, 0),
      other: true,
    },
  ];
}

/**
 * The call that wrote an audit entry, when the page holds it: the `bank.op` carrying the entry's
 * `audit_id` is a child of the call (`store.js`), and the call's key opens it in the chain.
 */
export function callOfAudit(store, auditId) {
  if (!auditId) return null;
  for (const call of store.getCalls()) {
    for (const id of call.child_event_ids ?? []) {
      const event = store.getEventById(id);
      if (event?.type === 'bank.op' && event.data?.audit_id === auditId) return call;
    }
  }
  return null;
}

/** What the model loaded in the session: one entry per `etl.load`, oldest first. */
export function modelReads(store, xs) {
  if (!xs) return [];
  return store
    .getEvents({ xs })
    .filter((event) => event.type === 'etl.load')
    .map((event) => ({
      id: event.id,
      ts: event.ts,
      request_id: event.request_id ?? null,
      table: event.data?.table ?? null,
      source: event.data?.source_tool ?? event.data?.tool ?? event.data?.source ?? null,
      rows: event.data?.rows ?? event.data?.row_count ?? null,
    }));
}

// ---------------------------------------------------------------------------
// Charts: inline SVG from `h()`, tokens for every colour, a native tooltip on every mark
// ---------------------------------------------------------------------------

function niceMax(value) {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

function shortMoney(cents) {
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(dollars >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(dollars)}`;
}

function monthLabel(month) {
  const [year, number] = String(month).split('-').map(Number);
  const name = new Date(Date.UTC(year, (number ?? 1) - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
  return number === 1 ? `${name} ${String(year).slice(2)}` : name;
}

/** Money in and out per month: paired bars on one axis, a legend, the value on hover. */
export function monthlyFlowChart(months) {
  const width = 640;
  const height = 220;
  const pad = { top: 16, right: 8, bottom: 26, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const max = niceMax(
    Math.max(1, ...months.flatMap((entry) => [entry.money_in_cents, entry.money_out_cents])),
  );
  const slot = plotW / Math.max(1, months.length);
  const bar = Math.max(3, Math.min(16, (slot - 8) / 2));
  const y = (value) => pad.top + plotH - (value / max) * plotH;
  const ticks = [0, 0.5, 1].map((share) => share * max);

  return h(
    'figure',
    { class: 'chart chart-flow' },
    h(
      'svg',
      {
        viewBox: `0 0 ${width} ${height}`,
        role: 'img',
        'aria-label': `Money in and out per month over ${months.length} months`,
        class: 'chart-svg',
      },
      ...ticks.map((tick) =>
        h(
          'g',
          { class: 'chart-grid' },
          h('line', { x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick) }),
          h(
            'text',
            { x: pad.left - 6, y: y(tick) + 4, 'text-anchor': 'end', class: 'chart-tick' },
            shortMoney(tick),
          ),
        ),
      ),
      ...months.map((entry, index) => {
        const x = pad.left + index * slot + slot / 2;
        const inH = (entry.money_in_cents / max) * plotH;
        const outH = (entry.money_out_cents / max) * plotH;
        const label = `${monthLabel(entry.month)}: in ${money(entry.money_in_cents)}, out ${money(entry.money_out_cents)}, ${plural(entry.lines, 'line')}`;
        return h(
          'g',
          { class: 'chart-month' },
          h(
            'rect',
            { class: 'chart-hit', x: x - slot / 2, y: pad.top, width: slot, height: plotH },
            h('title', {}, label),
          ),
          h(
            'rect',
            {
              class: 'chart-bar chart-in',
              x: x - bar - 1,
              y: y(entry.money_in_cents),
              width: bar,
              height: Math.max(0, inH),
              rx: 2,
            },
            h('title', {}, label),
          ),
          h(
            'rect',
            {
              class: 'chart-bar chart-out',
              x: x + 1,
              y: y(entry.money_out_cents),
              width: bar,
              height: Math.max(0, outH),
              rx: 2,
            },
            h('title', {}, label),
          ),
          h(
            'text',
            { x, y: height - 8, 'text-anchor': 'middle', class: 'chart-tick' },
            monthLabel(entry.month),
          ),
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
        'Money in',
      ),
      h(
        'span',
        { class: 'legend-item' },
        h('span', { class: 'legend-swatch chart-out' }),
        'Money out',
      ),
      h(
        'span',
        { class: 'legend-note' },
        'Transfers between the persona’s own accounts, declined payments and unpaid bills are left out.',
      ),
    ),
  );
}

/** Spending by category: one hue, longest first, the amount written on every bar. */
function categoryChart(bars, activeCategory) {
  const max = Math.max(1, ...bars.map((entry) => entry.spent_cents));
  const total = bars.reduce((sum, entry) => sum + entry.spent_cents, 0);
  return h(
    'div',
    { class: 'category-bars', role: 'list' },
    ...bars.map((entry) =>
      h(
        'button',
        {
          type: 'button',
          role: 'listitem',
          class: cx(
            'category-bar',
            entry.other && 'is-other',
            activeCategory && activeCategory === (entry.category_id ?? '') && 'is-active',
          ),
          'data-action': entry.other ? null : 'account-filter',
          'data-arg': entry.other ? null : 'category',
          'data-arg2': entry.other ? null : (entry.category_id ?? ''),
          disabled: entry.other ? true : null,
          title: `${entry.name}: ${money(entry.spent_cents)} across ${plural(entry.count, 'payment')}, ${
            total ? Math.round((entry.spent_cents / total) * 100) : 0
          }% of the spending shown.${entry.other ? '' : ' Click to filter the statement.'}`,
        },
        h('span', { class: 'category-name' }, entry.name),
        h(
          'span',
          { class: 'category-track' },
          h('span', {
            class: 'category-fill',
            style: `width:max(2px, ${((entry.spent_cents / max) * 100).toFixed(2)}%)`,
          }),
        ),
        h('span', { class: 'category-value mono' }, money(entry.spent_cents)),
        h('span', { class: 'category-count' }, count(entry.count)),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function sectionCard(title, note, ...body) {
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

function tiles(payload) {
  const flow = payload.month_to_date ?? { money_in_cents: 0, money_out_cents: 0 };
  return h(
    'div',
    { class: 'account-tiles' },
    stat('cash', money(payload.total_cash_cents), {
      title: 'Ledger balance of the open checking and savings accounts',
    }),
    stat('available', money(payload.total_available_cents), {
      title: 'Cash minus pending card authorisations',
    }),
    stat('owed on cards', money(payload.total_credit_owed_cents), {
      tone: payload.total_credit_owed_cents > 0 ? 'warn' : null,
    }),
    stat('net position', money(payload.net_position_cents), {
      title: 'Cash minus what is owed on the cards',
    }),
    stat('in this month', money(flow.money_in_cents)),
    stat('out this month', money(flow.money_out_cents)),
  );
}

function accountsTable(payload) {
  return table(
    ['Account', 'Type', 'Balance', 'Available', 'Limit'],
    (payload.accounts ?? []).map((account) =>
      h(
        'tr',
        { class: cx(account.status !== 'open' && 'is-muted') },
        h('td', {}, account.name, account.status !== 'open' ? tag(account.status) : null),
        h('td', {}, ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type),
        h(
          'td',
          { class: cx('num mono', account.balance_cents < 0 && 'is-negative') },
          money(account.balance_cents),
        ),
        h('td', { class: 'num mono' }, money(account.available_balance_cents)),
        h(
          'td',
          { class: 'num mono' },
          account.credit_limit_cents === null ? '' : money(account.credit_limit_cents),
        ),
      ),
    ),
    { class: 'account-table' },
  );
}

function statement(payload, view) {
  const filter = view.account?.filter ?? {};
  const lines = filterLines(payload.lines, filter);
  const shown = lines.slice(0, view.account?.statementRows ?? STATEMENT_PAGE);
  const accounts = payload.accounts ?? [];
  const categories = [
    ...new Map(
      (payload.lines ?? [])
        .filter((line) => line.category_id)
        .map((line) => [line.category_id, line.category_name ?? line.category_id]),
    ).entries(),
  ].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const select = (id, label, value, options) =>
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h(
        'select',
        { id, class: 'input', 'data-account-filter': id.replace('account-filter-', '') },
        ...options.map(([optionValue, optionLabel]) =>
          h(
            'option',
            {
              value: optionValue,
              selected: String(value ?? '') === String(optionValue) ? true : null,
            },
            optionLabel,
          ),
        ),
      ),
    );
  const active = Object.values(filter).some((value) => value);
  return sectionCard(
    'Statement',
    `${count(payload.lines_total)} lines from ${payload.from_date} to ${payload.to_date}${
      payload.lines_total > (payload.lines?.length ?? 0)
        ? `, the newest ${count(payload.lines.length)} kept`
        : ''
    }. The same rows load_statement_lines gives the model.`,
    h(
      'div',
      { class: 'account-filters' },
      h(
        'label',
        { class: 'field field-grow' },
        h('span', { class: 'field-label' }, 'Search'),
        h('input', {
          type: 'search',
          id: 'account-filter-text',
          class: 'input',
          placeholder: 'merchant, payee, category',
          value: filter.text ?? '',
        }),
      ),
      select('account-filter-account', 'Account', filter.account, [
        ['', 'Every account'],
        ...accounts.map((account) => [account.account_id, account.name]),
      ]),
      select('account-filter-category', 'Category', filter.category, [
        ['', 'Every category'],
        ...categories,
      ]),
      select('account-filter-source', 'Kind', filter.source, [
        ['', 'Every kind'],
        ['transaction', 'Card or account'],
        ['transfer', 'Transfers'],
        ['bill', 'Bills'],
      ]),
      select('account-filter-direction', 'Direction', filter.direction, [
        ['', 'In and out'],
        ['out', 'Money out'],
        ['in', 'Money in'],
      ]),
      active ? button('Clear', 'account-filter-clear', { variant: 'quiet' }) : null,
    ),
    h(
      'p',
      { class: 'account-count' },
      `${count(lines.length)} of ${count(payload.lines?.length ?? 0)} lines`,
    ),
    lines.length === 0
      ? emptyState('No line matches', 'Change the search or the filters above.')
      : table(
          ['Date', 'Description', 'Category', 'Account', 'Status', 'Amount'],
          shown.map((line) =>
            h(
              'tr',
              {
                class: cx(
                  line.status === 'declined' || line.status === 'failed' ? 'is-muted' : null,
                ),
              },
              h('td', { class: 'mono nowrap' }, line.date),
              h(
                'td',
                {},
                h('div', { class: 'line-main' }, line.counterparty),
                h(
                  'div',
                  { class: 'line-sub' },
                  `${SOURCE_LABELS[line.source] ?? line.source} · ${line.description}`,
                ),
              ),
              h('td', {}, line.category_name ?? ''),
              h('td', {}, line.account_name ?? line.account_id),
              h(
                'td',
                {},
                line.status === 'posted' || line.status === 'completed' || line.status === 'paid'
                  ? h('span', { class: 'muted' }, line.status)
                  : tag(
                      line.status,
                      line.status === 'declined' ||
                        line.status === 'overdue' ||
                        line.status === 'failed'
                        ? 'tag-warn'
                        : '',
                    ),
              ),
              h(
                'td',
                { class: cx('num mono nowrap', line.amount_cents < 0 ? 'is-out' : 'is-in') },
                money(line.amount_cents),
              ),
            ),
          ),
          { class: 'account-table statement-table' },
        ),
    lines.length > shown.length
      ? button(
          `Show ${count(Math.min(STATEMENT_PAGE, lines.length - shown.length))} more`,
          'account-more',
          { variant: 'quiet' },
        )
      : null,
  );
}

function cards(payload) {
  const list = payload.card_list ?? [];
  if (list.length === 0) return null;
  return sectionCard(
    'Cards',
    'Spending this month against each card’s monthly limit. A card the agent locked shows locked here.',
    h(
      'div',
      { class: 'card-list' },
      ...list.map((card) => {
        const share =
          card.spending_limit_cents > 0
            ? card.spent_this_month_cents / card.spending_limit_cents
            : 0;
        return h(
          'div',
          { class: cx('bank-card', `is-${card.status}`) },
          h(
            'div',
            { class: 'bank-card-head' },
            h('span', { class: 'mono' }, `${card.brand} •••• ${card.last4}`),
            tag(card.status.replace('_', ' '), card.status === 'active' ? 'tag-ok' : 'tag-warn'),
          ),
          h(
            'div',
            { class: 'bank-card-holder' },
            card.cardholder_name,
            h('span', { class: 'muted' }, ` · expires ${card.expires_on}`),
          ),
          meter(card.spent_this_month_cents, card.spending_limit_cents, {
            tone: share > 0.8 ? 'warn' : 'ok',
            label: `${Math.round(share * 100)}% of the monthly limit`,
          }),
          h(
            'div',
            { class: 'bank-card-limit mono' },
            `${money(card.spent_this_month_cents)} of ${money(card.spending_limit_cents)}`,
          ),
        );
      }),
    ),
  );
}

function bills(payload) {
  const list = payload.bills ?? [];
  if (list.length === 0) return null;
  return sectionCard(
    'Bills',
    'Due in the last two months and the next two.',
    table(
      ['Due', 'Payee', 'Status', 'Amount'],
      list.map((bill) =>
        h(
          'tr',
          {},
          h('td', { class: 'mono nowrap' }, bill.due_date),
          h('td', {}, bill.payee_name),
          h(
            'td',
            {},
            tag(
              bill.status,
              bill.status === 'overdue' ? 'tag-warn' : bill.status === 'paid' ? 'tag-ok' : '',
            ),
          ),
          h('td', { class: 'num mono' }, money(bill.amount_cents)),
        ),
      ),
      { class: 'account-table' },
    ),
  );
}

function transfers(payload) {
  const list = payload.transfers ?? [];
  if (list.length === 0) return null;
  return sectionCard(
    'Transfers',
    `Scheduled or created since ${payload.from_date}.`,
    table(
      ['Date', 'To', 'Rail', 'Status', 'Amount'],
      list.map((transfer) =>
        h(
          'tr',
          {},
          h('td', { class: 'mono nowrap' }, transfer.scheduled_for),
          h(
            'td',
            {},
            h('div', { class: 'line-main' }, transfer.counterparty),
            transfer.memo ? h('div', { class: 'line-sub' }, transfer.memo) : null,
          ),
          h('td', {}, String(transfer.rail).toUpperCase()),
          h(
            'td',
            {},
            tag(
              transfer.status,
              transfer.status === 'failed'
                ? 'tag-warn'
                : transfer.status === 'completed'
                  ? 'tag-ok'
                  : '',
            ),
            transfer.audit_id ? tag('by the agent', 'tag-model') : null,
          ),
          h(
            'td',
            { class: cx('num mono', transfer.direction === 'outgoing' ? 'is-out' : 'is-in') },
            money(
              transfer.direction === 'outgoing' ? -transfer.amount_cents : transfer.amount_cents,
            ),
          ),
        ),
      ),
      { class: 'account-table' },
    ),
  );
}

function agentChanges(payload, store) {
  const entries = payload.audit ?? [];
  return sectionCard(
    'Changed by the agent',
    'Every write this login made on the persona, newest first, with the reason the model gave. The seed is shared; these changes live on this login’s copy only (ADR-15).',
    entries.length === 0
      ? h(
          'p',
          { class: 'muted account-empty' },
          'Nothing yet. A card lock or a confirmed transfer made through the tools appears here.',
        )
      : h(
          'ol',
          { class: 'audit-list' },
          ...entries.map((entry) => {
            const call = callOfAudit(store, entry.id);
            return h(
              'li',
              { class: 'audit-entry' },
              h(
                'div',
                { class: 'audit-head' },
                h('span', { class: 'audit-action mono' }, entry.action),
                h('span', { class: 'audit-summary' }, entry.summary),
                h(
                  'span',
                  { class: 'audit-time mono', title: entry.created_at },
                  shortDateTime(entry.created_at),
                ),
                call
                  ? button(`#${call.request_id} in the chain`, 'account-open-call', {
                      arg: call.key,
                      variant: 'chip',
                      title: 'Open the call that made this change',
                    })
                  : h(
                      'span',
                      {
                        class: 'muted audit-nocall',
                        title:
                          'The page does not hold the bank.op that wrote this entry (another session, or older than the window).',
                      },
                      'call not on this page',
                    ),
              ),
              entry.rationale
                ? h(
                    'blockquote',
                    { class: 'rationale who-model audit-rationale' },
                    entry.rationale,
                    h(
                      'footer',
                      { class: 'rationale-source' },
                      'the rationale the model sent with the write, stored with the audit entry',
                    ),
                  )
                : h('p', { class: 'muted' }, 'The write carried no rationale.'),
            );
          }),
        ),
  );
}

function modelReadsCard(store, xs) {
  const reads = modelReads(store, xs);
  return sectionCard(
    'Read by the model in this session',
    'What the model actually pulled out of this account, one load at a time. Everything else on this page, the model has not seen.',
    reads.length === 0
      ? h('p', { class: 'muted account-empty' }, 'No load_* call in this session yet.')
      : h(
          'ul',
          { class: 'reads-list' },
          ...reads.map((read) =>
            h(
              'li',
              {},
              h('span', { class: 'mono' }, clockTime(read.ts)),
              ' ',
              h('span', { class: 'mono' }, read.table ?? 'a table'),
              read.rows === null
                ? null
                : h('span', { class: 'muted' }, ` · ${plural(read.rows, 'row')}`),
              read.request_id ? h('span', { class: 'muted' }, ` · call #${read.request_id}`) : null,
            ),
          ),
        ),
  );
}

/** The whole page. */
export function renderAccount(model) {
  const { store, view } = model;
  const account = view.account ?? {};
  const xs =
    view.mode === 'fixture'
      ? (account.xs ?? effectiveSessionXs(store, view))
      : accountSessionXs(store, view);
  const payload = account.payload;

  if (view.viewer?.viewer_kind === 'public') {
    return h(
      'div',
      { class: 'page page-account' },
      emptyState(
        'No account on the public lane',
        'Visitors of /public/mcp are anonymous: they read what the bank publishes and hold no account. Pair with a code from a signed-in session to see its account.',
      ),
    );
  }
  if (!xs && view.mode !== 'fixture') {
    return h(
      'div',
      { class: 'page page-account' },
      emptyState(
        'No session yet',
        'Once a signed-in client calls a tool, the account behind that session appears here.',
      ),
    );
  }
  if (!payload) {
    return h(
      'div',
      { class: 'page page-account' },
      account.error
        ? emptyState(
            'The account could not be read',
            account.error,
            button('Try again', 'account-refresh', { variant: 'quiet' }),
          )
        : emptyState(
            'Reading the account',
            'Balances, spending, cards and bills, as the bank holds them for this login.',
          ),
    );
  }

  const bars = categoryBars(payload.by_category);
  const persona = payload.persona ?? {};
  return h(
    'div',
    { class: 'page page-account' },
    h(
      'header',
      { class: 'page-head' },
      h(
        'div',
        { class: 'page-title-block' },
        h('h2', { class: 'page-title' }, persona.name ?? 'Account'),
        h(
          'p',
          { class: 'page-sub' },
          h('span', { class: 'mono' }, persona.id ?? ''),
          persona.shared ? tag('shared demo persona', 'tag-warn') : null,
          ' ',
          view.mode === 'fixture'
            ? 'Sample account from test/fixtures/bank-activity.json, built by the real bank code from the seeded persona. The recording’s own persona is a stand-in, so the names differ.'
            : `As the bank holds it for this login right now (${shortDateTime(payload.as_of)}), the numbers the tools return. Reading this page emits nothing.`,
        ),
      ),
      h(
        'div',
        { class: 'page-controls' },
        h(
          'div',
          { class: 'seg', role: 'group', 'aria-label': 'How far back' },
          ...ACCOUNT_MONTHS.map((months) =>
            button(
              months === 12 ? '12 months' : months === 1 ? 'This month' : `${months} months`,
              'account-months',
              {
                arg: String(months),
                variant: 'seg',
                pressed: Number(payload.months) === months,
                disabled:
                  view.mode === 'fixture' && months !== Number(payload.months) ? true : null,
                title: view.mode === 'fixture' ? 'The sample holds one window' : null,
              },
            ),
          ),
        ),
        view.mode === 'fixture'
          ? null
          : button(account.busy ? 'Reading…' : 'Refresh', 'account-refresh', {
              variant: 'quiet',
              disabled: account.busy,
            }),
      ),
    ),
    tiles(payload),
    h(
      'div',
      { class: 'account-grid' },
      sectionCard(
        'Money in and out, last 12 months',
        null,
        monthlyFlowChart(payload.by_month ?? []),
      ),
      sectionCard(
        'Spending by category',
        `Card and account payments from ${payload.from_date} to ${payload.to_date}, refunds netted out. Click a bar to filter the statement.`,
        bars.length
          ? categoryChart(bars, view.account?.filter?.category ?? null)
          : h('p', { class: 'muted' }, 'No spending in this window.'),
      ),
    ),
    h('div', { class: 'account-grid' }, agentChanges(payload, store), modelReadsCard(store, xs)),
    sectionCard('Accounts', null, accountsTable(payload)),
    statement(payload, view),
    h('div', { class: 'account-grid' }, cards(payload), bills(payload)),
    transfers(payload),
  );
}
