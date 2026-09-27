/**
 * Panel 1 - Sessions (block: dashboard).
 *
 * Fed by `/xray/api/sessions`, `session.*`, `auth.grant.*` and `server.started`
 * (docs/XRAY_EVENT_MODEL.md section 7). Sessions are grouped by login and then by grant so one
 * human's history is never split across grants (ADR-14): a step-up extension keeps the same
 * `grant_id`, and any other re-consent shows up as a child grant with `parent_grant_id`.
 * The `boot_id` chip is the restart marker (A-15).
 */
import { cx, h } from './h.js';
import { button, callout, emptyState, statusBadge, tag } from './ui.js';
import { count, expiry, plural, relativeTime, shortDateTime } from './format.js';
import { PUBLIC_LOGIN_ID } from './api.js';

/**
 * Erasing is real and irreversible, so nothing here fires on one click and nothing here appears
 * where it cannot work: fixture mode has no server to ask, and observer mode is read-only by
 * invariant 11, so an operator can never wipe someone else's history.
 */
export function canErase(view) {
  if (view.mode === 'fixture') return false;
  // Observer mode and the public lane are read-only (invariant 11, D-26).
  return (view.viewer?.viewer_kind ?? 'pairing') === 'pairing';
}

/** The two-step confirm: which control is armed, whether it is in flight, and what came back. */
function eraseState(view) {
  return view.erase ?? { scope: null, busy: false, note: null, error: null };
}

function clientLabel(client) {
  if (!client || !client.name) return 'client not announced';
  return [client.name, client.version].filter(Boolean).join(' ');
}

/**
 * One session, plus its own erase control. The control is a sibling of the row rather than a child
 * of it: a button inside a button is not valid HTML, and clicking "delete" must never be read as
 * clicking "select this session".
 */
function sessionRow(session, view, now) {
  const erase = eraseState(view);
  const armed = erase.scope === session.xs;
  return h(
    'div',
    { class: 'session-row-wrap' },
    sessionButton(session, view, now),
    canErase(view)
      ? armed
        ? h(
            'div',
            { class: 'session-erase-confirm' },
            h(
              'span',
              { class: 'session-erase-question' },
              `Delete ${plural(session.event_count, 'event')} of ${session.xs} from the server?`,
            ),
            button(erase.busy ? 'Deleting…' : 'Confirm', 'confirm-erase', {
              arg: session.xs,
              variant: 'danger',
              disabled: erase.busy,
            }),
            button('Cancel', 'cancel-erase', { variant: 'quiet' }),
          )
        : button('Delete', 'ask-erase', {
            arg: session.xs,
            variant: 'row-danger',
            title: 'Erase this session from the server. You will be asked to confirm.',
          })
      : null,
  );
}

function sessionButton(session, view, now) {
  const selected = view.selectedXs === session.xs;
  const live = !session.ended && now - Date.parse(session.last_seen_at) < 60_000;
  return h(
    'button',
    {
      type: 'button',
      class: cx('session-row', selected && 'is-selected'),
      'data-action': 'select-session',
      'data-arg': session.xs,
      'aria-pressed': String(selected),
    },
    h(
      'div',
      { class: 'session-row-head' },
      h('span', { class: 'mono session-xs' }, session.xs),
      live ? h('span', { class: 'live-dot', title: 'Activity in the last minute' }) : null,
      session.ended ? tag('ended', 'tag-quiet') : null,
    ),
    h(
      'div',
      { class: 'session-row-meta' },
      h('span', {}, clientLabel(session.client)),
      session.protocol_version ? h('span', { class: 'mono' }, session.protocol_version) : null,
      session.era ? tag(session.era, 'tag-quiet') : null,
    ),
    h(
      'div',
      { class: 'session-row-stats' },
      h('span', { title: 'Tool calls in this session' }, `${count(session.call_count)} calls`),
      h(
        'span',
        {
          class: session.error_count ? 'is-error' : null,
          title: 'Calls that failed or were denied',
        },
        `${count(session.error_count)} failed`,
      ),
      h(
        'span',
        { title: 'How many initialize handshakes this session saw (A-27)' },
        `${count(session.initialize_count)} init`,
      ),
    ),
    h(
      'div',
      { class: 'session-row-times' },
      h('span', { title: session.started_at }, `started ${shortDateTime(session.started_at)}`),
      h('span', { title: session.last_seen_at }, `last ${relativeTime(session.last_seen_at, now)}`),
    ),
    session.boot_id
      ? h(
          'div',
          { class: 'session-row-boot mono', title: 'Server boot this session ran under. A different value means the server restarted (A-15).' },
          session.boot_id,
        )
      : null,
  );
}

function grantBlock(grantGroup, view, now) {
  const grant = grantGroup.grant;
  // A public-lane visitor never consented to anything: its id is a hash, not a grant (D-26).
  const lineage = String(grantGroup.grant_id ?? '').startsWith('grt_pub_')
    ? 'anonymous visitor: IP prefix and User-Agent, hashed'
    : grant?.parent_grant_id
      ? `re-consent, continues ${grant.parent_grant_id}`
      : grant?.added_scopes?.length
        ? `extended on step-up (+${grant.added_scopes.join(', ')})`
        : 'original consent';
  return h(
    'div',
    { class: 'grant-block' },
    h(
      'div',
      { class: 'grant-head' },
      h('span', { class: 'mono grant-id' }, grantGroup.grant_id ?? 'no grant'),
      grant?.auth_level ? tag(grant.auth_level.replace('_', ' '), 'tag-strong') : null,
      grant?.revoked ? statusBadge('error', 'revoked') : null,
    ),
    h(
      'div',
      { class: 'grant-meta' },
      h('span', {}, lineage),
      grant?.expires_at ? h('span', {}, `grant ${expiry(grant.expires_at, now)}`) : null,
      grant?.token_expires_at
        ? h('span', {}, `access token ${expiry(grant.token_expires_at, now)}`)
        : null,
      grant?.client_name ? h('span', {}, `client ${grant.client_name}`) : null,
      grant?.client_reconstructed
        ? tag('reconstructed after restart', 'tag-warn')
        : null,
    ),
    ...grantGroup.sessions.map((session) => sessionRow(session, view, now)),
  );
}

/**
 * The two ways to make events go away, worded so they cannot be confused with each other. Hiding
 * is a client-side forget; deleting asks the server to erase, and takes two clicks to do it.
 */
function clearControl(model) {
  const { store, view } = model;
  if (!canErase(view)) return null;
  const erase = eraseState(view);
  const armed = erase.scope === 'login';
  return h(
    'div',
    { class: 'sessions-clear' },
    armed
      ? h(
          'div',
          { class: 'sessions-clear-confirm' },
          h(
            'span',
            { class: 'sessions-clear-question' },
            `Delete ${plural(store.size, 'event')} from the server?`,
          ),
          button(erase.busy ? 'Deleting…' : 'Confirm', 'confirm-erase', {
            arg: 'login',
            variant: 'danger',
            disabled: erase.busy,
          }),
          button('Cancel', 'cancel-erase', { variant: 'quiet' }),
        )
      : h(
          'div',
          { class: 'sessions-clear-buttons' },
          button('Hide what is on screen', 'hide-events', {
            variant: 'quiet',
            title:
              'Empties this page only. The events stay on the server and a reload brings them back.',
          }),
          button('Delete my history', 'ask-erase', {
            arg: 'login',
            variant: 'danger-quiet',
            title: 'Erase every event of your login from the server. You will be asked to confirm.',
          }),
        ),
  );
}

/**
 * v0.8 (D-27): the log this viewer may read, as a JSONL file - a pairing viewer its own login, the
 * public lane its anonymous visitors, observer mode everything. A link rather than a button: the
 * browser sends the cookie and saves the file under the name the server gives it.
 */
function exportControl(model) {
  const { view, api } = model;
  if (view.mode === 'fixture' || !api || typeof api.exportUrl !== 'function') return null;
  return h(
    'div',
    { class: 'sessions-export' },
    h(
      'a',
      {
        class: 'btn btn-quiet',
        href: api.exportUrl(),
        download: '',
        title: 'Every event this page can show, one JSON event per line. It survives a server restart.',
      },
      'Download log (JSONL)',
    ),
  );
}

/** The whole panel. `model` is `{ store, view, now, api }`. */
export function renderSessions(model) {
  const { store, view, now } = model;
  const groups = store.getLoginGroups();
  const boots = store.getBoots();
  const erase = eraseState(view);
  const head = h(
    'header',
    { class: 'section-head sessions-head' },
    h('h3', { class: 'section-title' }, 'Sessions'),
    boots.length > 1
      ? h(
          'span',
          { class: 'section-note' },
          `${boots.length - 1} restart${boots.length === 2 ? '' : 's'} observed`,
        )
      : null,
    exportControl(model),
    clearControl(model),
  );
  const messages = h(
    'div',
    { class: 'sessions-messages' },
    erase.note
      ? callout('Events removed', erase.note, 'info')
      : null,
    erase.error ? callout('Nothing was deleted', erase.error, 'error') : null,
  );

  if (groups.length === 0) {
    return h(
      'section',
      { class: 'section' },
      head,
      messages,
      view.viewer?.viewer_kind === 'public'
        ? emptyState(
            'No anonymous visitor yet',
            'A session appears the moment an agent calls /public/mcp, the endpoint that needs no sign-in.',
          )
        : emptyState(
            'No session yet',
            'A session appears the moment your Claude client makes its first authenticated request to the bank. Ask it something in chat.',
          ),
    );
  }

  return h(
    'section',
    { class: 'section' },
    head,
    messages,
    h(
      'div',
      { class: 'sessions-body' },
      ...groups.map((group) =>
        h(
          'div',
          { class: 'login-group' },
          group.login_id === PUBLIC_LOGIN_ID
            ? h(
                'div',
                { class: 'login-head' },
                h('span', { class: 'login-label' }, 'Public lane'),
                h('span', { class: 'login-id' }, 'anonymous visitors, no sign-in'),
              )
            : h(
                'div',
                { class: 'login-head' },
                h('span', { class: 'login-label' }, 'Login'),
                h('span', { class: 'mono login-id' }, group.login_id ?? 'unknown'),
              ),
          group.persona_id
            ? h(
                'div',
                { class: 'login-persona' },
                h('span', { class: 'mono' }, group.persona_id),
                group.shared_persona ? tag('shared demo persona', 'tag-warn') : null,
              )
            : null,
          ...group.grants.map((grantGroup) => grantBlock(grantGroup, view, now)),
        ),
      ),
      view.selectedXs
        ? h(
            'div',
            { class: 'sessions-actions' },
            button('Show every session', 'select-session', { arg: '', variant: 'quiet' }),
          )
        : null,
    ),
  );
}
