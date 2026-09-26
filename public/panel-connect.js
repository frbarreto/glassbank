/**
 * Empty, pairing and error states (block: dashboard).
 *
 * Three surfaces: the "nothing is connected yet" screen with the pairing-code box, the banner that
 * appears when the event stream drops, and the viewer identity chip in the header. Access is
 * login-bound (ADR-10): there is no public session picker, so this screen is the front door.
 */
import { h } from './h.js';
import { button, callout, statusBadge, tag } from './ui.js';
import { expiry } from './format.js';
import { isPairingCode } from './pairing.js';

/** The pairing form. `pairing` is `{ code, error, busy }`. */
export function renderPairingForm(pairing, options = {}) {
  const ready = isPairingCode(pairing.code);
  return h(
    'form',
    { class: 'pair-form', id: 'pair-form', autocomplete: 'off' },
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, 'Pairing code'),
      h('input', {
        type: 'text',
        id: 'pair-input',
        class: 'input input-code mono',
        placeholder: 'BANK-XXXX-XXXX-XX',
        value: pairing.code,
        spellcheck: 'false',
        autocapitalize: 'characters',
        'aria-label': 'Pairing code from the chat message',
      }),
    ),
    h(
      'div',
      { class: 'pair-actions' },
      h(
        'button',
        {
          type: 'submit',
          class: 'btn btn-primary',
          'data-action': 'submit-pairing',
          disabled: !ready || pairing.busy ? true : null,
        },
        pairing.busy ? 'Opening…' : 'Open my session',
      ),
      options.compact ? null : button('Try it with sample data', 'enter-fixture', { variant: 'quiet' }),
    ),
    pairing.error ? h('p', { class: 'pair-error' }, pairing.error) : null,
  );
}

/** The full-page state shown when the viewer has no session to look at. */
export function renderConnectScreen(model) {
  const { view } = model;
  return h(
    'div',
    { class: 'connect' },
    h(
      'div',
      { class: 'connect-card' },
      h('p', { class: 'connect-eyebrow' }, 'Glass Bank X-ray'),
      h('h1', { class: 'connect-title' }, 'Watch what your assistant actually did'),
      h(
        'p',
        { class: 'connect-lead' },
        'This page shows every step of a Model Context Protocol session with the bank: which tools were on offer, which one was called, with what arguments and what stated reason, what the SQL did, and what came back.',
      ),
      h('h2', { class: 'connect-sub' }, 'Open your own session'),
      h(
        'ol',
        { class: 'connect-steps' },
        h('li', {}, 'Add Glass Bank to Claude as a custom connector and sign in with the mock login.'),
        h(
          'li',
          {},
          'In chat, ask for the X-ray link. Claude calls ',
          h('code', { class: 'mono' }, 'xray_get_session_link'),
          ' and gets back a code that looks like ',
          h('code', { class: 'mono' }, 'BANK-7Q2F-K3MZ-8A'),
          '.',
        ),
        h('li', {}, 'Paste that code (or the whole link) below. It is valid for 24 hours and works on more than one device.'),
      ),
      view.connectError
        ? callout('The dashboard API did not answer', view.connectError, 'warn')
        : null,
      renderPairingForm(view.pairing),
      h(
        'p',
        { class: 'connect-note' },
        'The code is bound to your login, not to a single connection, so re-consenting, reconnecting or re-adding the connector keeps this page alive.',
      ),
      view.adminOpen
        ? h(
            'form',
            { class: 'pair-form admin-form', id: 'admin-form', autocomplete: 'off' },
            h(
              'label',
              { class: 'field' },
              h('span', { class: 'field-label' }, 'Observer token'),
              h('input', {
                type: 'password',
                id: 'admin-input',
                class: 'input mono',
                placeholder: 'admin token',
                'aria-label': 'Observer mode admin token',
              }),
            ),
            h(
              'div',
              { class: 'pair-actions' },
              h(
                'button',
                { type: 'submit', class: 'btn', 'data-action': 'submit-admin' },
                'Enter observer mode',
              ),
              button('Cancel', 'toggle-admin', { variant: 'quiet' }),
            ),
            h(
              'p',
              { class: 'connect-note' },
              'Observer mode shows every session with arguments hidden and each rationale cut to 80 characters.',
            ),
          )
        : h(
            'p',
            { class: 'connect-admin' },
            button('Presenting? Use the observer token', 'toggle-admin', { variant: 'link' }),
          ),
    ),
  );
}

/** The banner that replaces nothing but sits above the panels when the stream is unhealthy. */
export function renderStreamBanner(model) {
  const { view, now } = model;
  const connection = view.connection ?? {};
  if (connection.state === 'open' || connection.state === 'fixture') return null;
  if (connection.state === 'connecting' && !connection.attempts) return null;

  const retryIn =
    connection.nextRetryAt && connection.nextRetryAt > now
      ? Math.ceil((connection.nextRetryAt - now) / 1000)
      : null;

  return h(
    'div',
    { class: `stream-banner state-${connection.state}`, role: 'status' },
    statusBadge(connection.state === 'closed' ? 'error' : 'warn'),
    h(
      'span',
      { class: 'banner-text' },
      connection.state === 'closed'
        ? 'The live stream is closed.'
        : 'The live stream dropped and is reconnecting.',
      retryIn === null ? '' : ` Retrying in ${retryIn} s.`,
      connection.attempts ? ` Attempt ${connection.attempts}.` : '',
    ),
    h(
      'span',
      { class: 'banner-detail' },
      'Nothing is lost: the browser resumes with Last-Event-ID and the server replays what you missed.',
    ),
    button('Reconnect now', 'reconnect', { variant: 'primary' }),
  );
}

/** The viewer identity chip in the header. */
export function renderViewerChip(model) {
  const { view, now } = model;
  if (view.mode === 'fixture') {
    return h(
      'div',
      { class: 'viewer-chip is-fixture' },
      tag('sample data', 'tag-strong'),
      h('span', { class: 'viewer-detail' }, 'replaying test/fixtures/events.jsonl'),
      button('Leave sample mode', 'leave-fixture', { variant: 'quiet' }),
    );
  }
  const viewer = view.viewer;
  if (!viewer) return h('div', { class: 'viewer-chip' }, tag('not paired', 'tag-quiet'));
  return h(
    'div',
    { class: 'viewer-chip' },
    tag(viewer.viewer_kind === 'admin' ? 'observer mode' : 'paired', 'tag-strong'),
    viewer.persona
      ? h(
          'span',
          { class: 'viewer-detail' },
          viewer.persona.name,
          viewer.persona.shared ? tag('shared persona', 'tag-warn') : null,
        )
      : viewer.login_id
        ? h('span', { class: 'viewer-detail mono' }, viewer.login_id)
        : null,
    viewer.expires_at
      ? h('span', { class: 'viewer-detail muted' }, expiry(viewer.expires_at, now))
      : null,
  );
}

/** The "shared demo persona" explanation (ADR-15), shown once above the panels. */
export function renderSharedPersonaBanner(model) {
  const { store } = model;
  const shared = store.getLoginGroups().some((group) => group.shared_persona);
  if (!shared) return null;
  return callout(
    'Shared demo persona',
    'The seed data behind this persona is public and shared with everyone who picked it. Card locks, transfers and audit entries made from your login are private to you and disappear when the server restarts (ADR-15, A-15).',
    'info',
  );
}
