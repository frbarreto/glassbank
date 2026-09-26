/**
 * Panel 5 - Session and auth (block: dashboard).
 *
 * The handshake and the identity behind it: the initialize exchange, the client capabilities and
 * whatever `clientInfo` the client announced (shown verbatim, never trusted, A-28), the HTTP facts
 * the server can see, the grant that authorised the call and the auth events that shaped it.
 *
 * Fed by `session.*`, `auth.*` and `http.*`.
 */
import { h } from './h.js';
import {
  callout,
  emptyState,
  kv,
  kvList,
  section,
  statusBadge,
  table,
  tag,
} from './ui.js';
import { clockTime, count, duration, expiry, joinList, shortDateTime } from './format.js';
import { labelOf, statusOf, summaryOf } from './catalogue.js';
import { jsonView, viewerId } from './json-view.js';

const AUTH_TYPES = new Set([
  'auth.challenge',
  'auth.verified',
  'auth.rejected',
  'auth.client.registered',
  'auth.client.reconstructed',
  'auth.grant.created',
  'auth.grant.updated',
  'auth.token.issued',
  'auth.token.refreshed',
  'auth.token.revoked',
  'auth.stepup.requested',
  'auth.login.created',
]);

function httpFacts(events) {
  const latest = [...events].reverse().find((event) => event.type === 'http.request');
  if (!latest) {
    return h('p', { class: 'muted' }, 'No HTTP request has been recorded for this session yet.');
  }
  const data = latest.data ?? {};
  return kvList(
    kv('Last request', h('span', { class: 'mono' }, `${data.method} ${data.path} → ${data.status}`)),
    kv('Duration', duration(data.duration_ms)),
    kv('User agent', h('span', { class: 'mono wrap' }, data.user_agent ?? 'not sent'), { wide: true }),
    kv(
      'Remote address',
      h(
        'span',
        {},
        h('span', { class: 'mono' }, data.remote_ip_prefix ?? 'unknown'),
        data.anthropic_egress ? tag('Anthropic egress range', 'tag-ok') : null,
      ),
    ),
    kv(
      'Origin',
      h(
        'span',
        {},
        h('span', { class: 'mono' }, data.origin ?? 'header not sent'),
        ' ',
        tag(
          `policy: ${data.origin_decision ?? 'absent'}`,
          data.origin_decision === 'rejected' ? 'tag-warn' : 'tag-quiet',
        ),
      ),
    ),
    kv('MCP-Protocol-Version header', h('span', { class: 'mono' }, data.mcp_protocol_version_header ?? 'not sent')),
    kv(
      'Mcp-Session-Id',
      h(
        'span',
        { class: 'mono' },
        data.mcp_session_id ?? 'not sent (this server is stateless and issues none)',
      ),
    ),
    kv('Authorization header', data.has_authorization ? 'present' : 'absent'),
    kv('Content type', h('span', { class: 'mono' }, data.content_type ?? '-')),
  );
}

/** The whole panel. `model` is `{ store, view, now }`. */
export function renderSessionAuth(model) {
  const { store, view, now } = model;
  const xs = view.selectedXs ?? store.getSessions()[0]?.xs ?? null;
  const session = xs ? store.getSession(xs) : null;

  if (!session) {
    return section(
      'Session and auth',
      null,
      emptyState(
        'No session selected',
        'Pick a session on the left, or wait for your client to make its first authenticated request.',
      ),
    );
  }

  const events = store.getEvents({ xs });
  const grant = session.grant;
  const authEvents = store
    .getEvents()
    .filter(
      (event) =>
        AUTH_TYPES.has(event.type) &&
        (event.grant_id === session.grant_id || event.login_id === session.login_id || !event.grant_id),
    )
    .slice(-14);

  return section(
    'Session and auth',
    session.xs,
    h(
      'div',
      { class: 'two-col' },
      h(
        'div',
        { class: 'col' },
        h('h4', { class: 'sub-title' }, 'The initialize handshake'),
        kvList(
          kv(
            'Protocol',
            h(
              'span',
              { class: 'mono' },
              session.protocol_version ?? 'not negotiated',
              session.protocol_version_requested &&
                session.protocol_version_requested !== session.protocol_version
                ? ` (client asked for ${session.protocol_version_requested})`
                : '',
            ),
          ),
          kv('Era', session.era ?? 'unknown'),
          kv(
            'Client',
            h(
              'span',
              {},
              h('span', { class: 'mono' }, session.client?.name ?? 'not announced'),
              ' ',
              h('span', { class: 'mono' }, session.client?.version ?? ''),
              tag('verbatim, never trusted', 'tag-quiet'),
            ),
            { wide: true },
          ),
          kv('initialize calls', count(session.initialize_count)),
          kv('Instructions sent', session.instructions_sent === false ? 'no' : 'yes'),
          kv('Started', h('span', { title: session.started_at }, shortDateTime(session.started_at))),
          kv('Last seen', h('span', { title: session.last_seen_at }, shortDateTime(session.last_seen_at))),
          session.ended ? kv('Ended', session.end_reason ?? 'yes') : null,
        ),
        session.initialize_count > 2
          ? callout(
              'Repeated initialize handshakes',
              'claude.ai reconnects every 25-80 seconds and re-runs initialize each time. The server keeps one X-ray session and counts the handshakes rather than fragmenting the history (A-27).',
              'info',
            )
          : null,
        jsonView(session.client_capabilities ?? {}, {
          id: viewerId('client-caps', session.xs),
          state: view.json ?? {},
          title: 'Client capabilities',
        }),
        jsonView(session.server_capabilities ?? {}, {
          id: viewerId('server-caps', session.xs),
          state: view.json ?? {},
          title: 'Server capabilities',
        }),
      ),
      h(
        'div',
        { class: 'col' },
        h('h4', { class: 'sub-title' }, 'What the HTTP layer saw'),
        httpFacts(events),
        h('h4', { class: 'sub-title' }, 'Grant'),
        grant
          ? kvList(
              kv('Grant', h('span', { class: 'mono' }, grant.grant_id)),
              kv(
                'Lineage',
                grant.parent_grant_id
                  ? h('span', { class: 'mono' }, `continues ${grant.parent_grant_id}`)
                  : grant.added_scopes.length
                    ? `extended in place on step-up (+${grant.added_scopes.join(', ')})`
                    : 'original consent',
                { wide: true },
              ),
              kv('Login', h('span', { class: 'mono' }, grant.login_id ?? 'unknown')),
              kv('Persona', h('span', { class: 'mono' }, grant.persona_id ?? session.persona_id ?? 'unknown')),
              kv('Authorization level', grant.auth_level ?? 'unknown'),
              kv(
                'Scopes',
                h('span', { class: 'scope-list' }, ...(grant.scopes ?? []).map((scope) => tag(scope, 'tag-quiet'))),
                { wide: true },
              ),
              kv(
                'Client registration',
                h(
                  'span',
                  {},
                  h('span', { class: 'mono' }, grant.client_name ?? 'unknown'),
                  ' ',
                  h('span', { class: 'mono muted' }, grant.client_id ?? ''),
                  grant.client_reconstructed ? tag('reconstructed after a restart', 'tag-warn') : null,
                ),
                { wide: true },
              ),
              kv('Grant expiry', grant.expires_at ? expiry(grant.expires_at, now) : 'unknown'),
              kv(
                'Access token expiry',
                session.token_expires_at ?? grant.token_expires_at
                  ? expiry(session.token_expires_at ?? grant.token_expires_at, now)
                  : 'unknown',
              ),
              grant.revoked ? kv('Revoked', statusBadge('error', 'yes')) : null,
            )
          : h('p', { class: 'muted' }, 'No grant facts have been observed for this session.'),
      ),
    ),
    h('h4', { class: 'sub-title' }, 'Auth events'),
    authEvents.length
      ? table(
          ['Time', 'Event', 'What happened'],
          authEvents.map((event) =>
            h(
              'tr',
              { class: `auth-row auth-${statusOf(event)}` },
              h('td', { class: 'mono nowrap', title: event.ts }, clockTime(event.ts)),
              h(
                'td',
                {},
                h(
                  'button',
                  { type: 'button', class: 'link', 'data-action': 'select-event', 'data-arg': String(event.id) },
                  labelOf(event.type),
                ),
              ),
              h('td', {}, summaryOf(event)),
            ),
          ),
          { class: 'auth-table' },
        )
      : h('p', { class: 'muted' }, 'No auth events in the replay window.'),
    h(
      'p',
      { class: 'panel-footnote' },
      `Tokens are never stored or logged: this panel shows expiry times and scope sets only. Scopes on this grant: ${joinList(
        grant?.scopes,
      )}.`,
    ),
  );
}
