/**
 * The persona card (block: dashboard).
 *
 * Who is in this session and what they hold, at the top of the Sessions aside: the persona behind
 * the selected session (or the viewer's most recent one), the money as the bank sees it right now
 * with the per-login overlay applied (ADR-15), the cards, the transfer limit and the grant that
 * authorised the calls. Balances come from `GET /xray/api/sessions/:xs/bank`
 * (`XraySessionBankResponse`), fetched by `app.js` into `view.bank`; everything else is read from
 * the store. Fixture mode never fetches: it shows the facts the recording carries and says so.
 *
 * Pure `renderPersona(model)`; `model` is `{ store, view, now }`.
 */
import { cx, h } from './h.js';
import { button, tag } from './ui.js';
import { clockTime, count, expiry, money, plural } from './format.js';
import { PUBLIC_LOGIN_ID } from './api.js';

/** `bank.op` operations after which the balances or card states may have changed. */
export const BANK_REFRESH_OPERATIONS = new Set([
  'card.lock',
  'card.unlock',
  'transfer.confirm',
  'overlay.reset',
]);

const ACCOUNT_TYPE_LABELS = {
  checking: 'checking',
  savings: 'savings',
  credit_card: 'credit card',
};

/** The session the card describes: the selected one, else the viewer's most recent. */
export function effectiveSessionXs(store, view) {
  if (view.selectedXs) return view.selectedXs;
  const sessions = store.getSessions();
  const loginId = view.viewer?.login_id ?? null;
  const own = loginId ? sessions.find((session) => session.login_id === loginId) : null;
  return (own ?? sessions[0])?.xs ?? null;
}

/** The persona facts the store already knows, before or without the bank route. */
function storedPersona(store, view, session) {
  const grant = session?.grant_id ? store.getGrant(session.grant_id) : session?.grant ?? null;
  const login = session?.login_id
    ? store.getLoginGroups().find((group) => group.login_id === session.login_id) ?? null
    : null;
  const viewerPersona =
    view.viewer?.persona && (!session?.login_id || view.viewer.login_id === session.login_id)
      ? view.viewer.persona
      : null;
  return {
    id: session?.persona?.id ?? session?.persona_id ?? grant?.persona_id ?? viewerPersona?.id ?? null,
    name: session?.persona?.name ?? viewerPersona?.name ?? null,
    kind: session?.persona?.kind ?? viewerPersona?.kind ?? null,
    shared: Boolean(
      session?.persona?.shared ?? (grant?.shared_persona || login?.shared_persona || viewerPersona?.shared),
    ),
    grant,
  };
}

function personaHead(persona) {
  return h(
    'header',
    { class: 'persona-head' },
    h(
      'div',
      { class: 'persona-title' },
      h('span', { class: 'persona-name' }, persona.name ?? 'Persona'),
      persona.kind ? tag(persona.kind, 'tag-quiet') : null,
      persona.shared ? tag('shared', 'tag-warn') : null,
    ),
    persona.id ? h('span', { class: 'persona-id mono' }, persona.id) : null,
  );
}

function grantLine(grant, session, now) {
  if (!grant && !session) return null;
  const parts = [];
  if (grant?.auth_level) parts.push(grant.auth_level.replace('_', ' '));
  if (grant?.scopes?.length) parts.push(plural(grant.scopes.length, 'scope'));
  const client = grant?.client_name ?? session?.client?.name ?? null;
  if (client) parts.push(`client ${client}`);
  const tokenExpiry = grant?.token_expires_at ?? session?.token_expires_at ?? null;
  if (tokenExpiry) parts.push(`access token ${expiry(tokenExpiry, now)}`);
  if (parts.length === 0) return null;
  return h('p', { class: 'persona-grant' }, parts.join(' · '));
}

function accountRow(account, currency) {
  const type = ACCOUNT_TYPE_LABELS[account.account_type] ?? account.account_type;
  const isCredit = account.account_type === 'credit_card';
  return h(
    'li',
    { class: cx('persona-account', `persona-account-${account.account_type}`, account.status === 'closed' && 'is-closed') },
    h(
      'span',
      { class: 'persona-account-name' },
      account.name,
      h('span', { class: 'persona-account-type' }, ` ${type}`),
      account.status === 'closed' ? tag('closed', 'tag-quiet') : null,
    ),
    h(
      'span',
      { class: 'persona-account-money' },
      h('span', { class: cx('mono', 'persona-account-balance', account.balance_cents < 0 && 'is-negative') }, money(account.balance_cents, account.currency ?? currency)),
      isCredit && account.credit_limit_cents !== null && account.credit_limit_cents !== undefined
        ? h('span', { class: 'persona-account-limit mono' }, `limit ${money(account.credit_limit_cents, account.currency ?? currency)}`)
        : null,
    ),
  );
}

function balances(payload) {
  const currency = payload.currency ?? 'USD';
  const cards = payload.cards ?? {};
  return h(
    'div',
    { class: 'persona-money' },
    h(
      'div',
      { class: 'persona-net' },
      h(
        'span',
        { class: cx('persona-net-value mono', payload.net_position_cents < 0 && 'is-negative') },
        money(payload.net_position_cents, currency),
      ),
      h('span', { class: 'persona-net-label' }, 'net position'),
    ),
    h(
      'p',
      { class: 'persona-line' },
      'cash ',
      h('span', { class: 'mono' }, money(payload.total_cash_cents, currency)),
      ' · available ',
      h('span', { class: 'mono' }, money(payload.total_available_cents, currency)),
    ),
    h(
      'p',
      { class: 'persona-line' },
      'credit owed ',
      h('span', { class: 'mono' }, money(payload.total_credit_owed_cents, currency)),
    ),
    Array.isArray(payload.accounts) && payload.accounts.length
      ? h('ul', { class: 'persona-accounts' }, ...payload.accounts.map((account) => accountRow(account, currency)))
      : h('p', { class: 'persona-line muted' }, 'No account on file.'),
    h(
      'p',
      { class: 'persona-line' },
      `${plural(cards.total ?? 0, 'card')} · ${count(cards.active ?? 0)} active · ${count(
        cards.locked ?? 0,
      )} locked · ${count(cards.fraud_locked ?? 0)} fraud locked`,
    ),
    h(
      'p',
      { class: 'persona-line' },
      'transfer limit ',
      h('span', { class: 'mono' }, money(payload.transfer_limit_cents, currency)),
      ' per transfer',
    ),
  );
}

/** The public lane's visitor (D-26): no persona, no balances, only what the bank publishes. */
function publicVisitorCard(session) {
  return h(
    'section',
    { class: 'persona-card is-public', 'aria-label': 'Anonymous visitor' },
    personaHead({ name: 'Anonymous visitor', kind: 'public lane', id: session.grant_id }),
    h(
      'p',
      { class: 'persona-line muted' },
      'No sign-in and no customer: this session called /public/mcp, which only reads what the bank publishes - its profile, products, prices and branches. A visitor is its IP prefix and User-Agent, hashed.',
    ),
  );
}

/** The whole card. */
export function renderPersona(model) {
  const { store, view, now } = model;
  const xs = effectiveSessionXs(store, view);
  const session = xs ? store.getSession(xs) : null;
  if (session && session.login_id === PUBLIC_LOGIN_ID) return publicVisitorCard(session);
  const stored = storedPersona(store, view, session);
  const bank = view.bank ?? {};
  const current = bank.xs === xs;
  const payload = current && bank.payload ? bank.payload : null;
  const persona = payload?.persona ?? stored;

  if (!xs) {
    return h(
      'section',
      { class: 'persona-card is-empty', 'aria-label': 'Persona' },
      h('p', { class: 'persona-line muted' }, 'No session yet, so no persona to show.'),
    );
  }

  const body = [];
  if (view.mode === 'fixture') {
    body.push(
      h(
        'p',
        { class: 'persona-line muted' },
        'Balances need a live server; this is the recorded sample.',
      ),
    );
  } else {
    if (current && bank.error) {
      body.push(
        h(
          'p',
          { class: 'persona-line persona-error' },
          bank.error,
          ' ',
          button('Refresh', 'refresh-bank', { variant: 'quiet', disabled: bank.busy }),
        ),
      );
    }
    if (payload) {
      body.push(balances(payload));
    } else if (!bank.error || !current) {
      body.push(h('p', { class: 'persona-line muted' }, 'loading balances'));
    }
  }
  const line = grantLine(stored.grant, session, now);
  if (line) body.push(line);

  return h(
    'section',
    { class: cx('persona-card', payload && 'has-balances'), 'aria-label': 'Persona' },
    personaHead(persona),
    ...body,
    view.mode === 'fixture'
      ? null
      : h(
          'footer',
          { class: 'persona-foot' },
          h(
            'span',
            { class: 'muted' },
            bank.busy && current
              ? 'refreshing'
              : payload?.as_of
                ? `as of ${clockTime(payload.as_of)}`
                : '',
          ),
          button(bank.busy && current ? 'Refreshing' : 'Refresh', 'refresh-bank', {
            variant: 'quiet',
            disabled: bank.busy && current,
            title: 'Fetch the balances again',
          }),
        ),
  );
}
