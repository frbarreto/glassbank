/**
 * The request as it reached the server (block: dashboard, contracts v0.9, D-28).
 *
 * `http.request.data.raw` is the uncategorised record of one HTTP request: every header in arrival
 * order, with its case and its duplicates, the body bytes a parser read, the socket peer. This
 * draws it without interpreting it - no header is dropped, renamed or merged - and only points out
 * the three headers of Web Bot Auth (RFC 9421 HTTP Message Signatures), because "did the agent
 * sign this?" is the question the record exists to answer. The dashboard receives the redacted
 * view (credentials hidden, addresses cut to a prefix); the operator's export holds the bytes.
 */
import { cx, h } from './h.js';
import { callout, codeBlock, table } from './ui.js';
import { count, plural } from './format.js';
import { jsonView, viewerId } from './json-view.js';
import { WEB_BOT_AUTH_HEADERS, headerValues, headersOf, webBotAuthOf } from './raw-headers.js';

export { WEB_BOT_AUTH_HEADERS, headerValues, headersOf, webBotAuthOf };

function bodyBlock(raw, id, state) {
  if (!raw.body_read) {
    const length = headerValues(raw, 'content-length')[0];
    return h(
      'p',
      { class: 'muted' },
      length && length !== '0'
        ? `The request declared a ${count(Number(length))}-byte body that no parser read (a content type or a size this route does not accept).`
        : 'The request had no body.',
    );
  }
  const note = h(
    'span',
    { class: 'sub-note' },
    `${plural(raw.body_bytes ?? 0, 'byte')}${
      raw.body_encoding === 'base64' ? ' · not UTF-8, shown as base64' : ''
    }`,
  );
  let parsed;
  if (raw.body_encoding === 'utf8' && typeof raw.body === 'string') {
    try {
      parsed = JSON.parse(raw.body);
    } catch {
      parsed = undefined;
    }
  }
  return h(
    'div',
    { class: 'raw-body' },
    h('h4', { class: 'sub-title' }, 'Body', note),
    parsed !== undefined && parsed !== null && typeof parsed === 'object'
      ? jsonView(parsed, { id: viewerId(id, 'body'), state })
      : codeBlock(raw.body ?? '', { id: `${id}-body-text` }),
  );
}

function headerTable(pairs, signed) {
  return table(
    ['#', 'Name', 'Value'],
    pairs.map(([name, value], index) =>
      h(
        'tr',
        { class: cx(signed.has(name.toLowerCase()) && 'raw-header-signed') },
        h('td', { class: 'mono raw-header-index' }, String(index + 1)),
        h('td', { class: 'mono raw-header-name' }, name),
        h('td', { class: 'mono raw-header-value' }, value),
      ),
    ),
    { class: 'raw-headers' },
  );
}

/** The whole record of one request. `options` carries the JSON viewer's `{id, state}`. */
export function rawRequestView(raw, options = {}) {
  if (raw === null || typeof raw !== 'object') return null;
  const id = options.id ?? 'raw';
  const state = options.state ?? {};
  const headers = headersOf(raw);
  const trailers = Array.isArray(raw.trailers) ? raw.trailers : [];
  const signature = webBotAuthOf(raw);
  const signed = new Set(WEB_BOT_AUTH_HEADERS);
  const peer =
    raw.remote_address === null || raw.remote_address === undefined
      ? null
      : `${raw.remote_address}${raw.remote_port ? ` port ${raw.remote_port}` : ''}`;

  return h(
    'div',
    { class: 'raw-request', 'data-raw-id': id },
    h(
      'p',
      { class: 'raw-request-line mono' },
      `${raw.method ?? '?'} ${raw.url ?? '?'}${raw.http_version ? ` HTTP/${raw.http_version}` : ''}`,
    ),
    signature
      ? callout(
          signature.complete
            ? 'Signed with Web Bot Auth'
            : 'Partial Web Bot Auth headers',
          `Signature-Agent ${signature.agent ?? 'absent'}${
            signature.keyid ? ` · keyid ${signature.keyid}` : ''
          }${signature.tag ? ` · tag ${signature.tag}` : ''}. The HTTP Message Signature (RFC 9421) is recorded as received; this server does not verify it.`,
          'info',
        )
      : h(
          'p',
          { class: 'muted raw-unsigned' },
          'No Web Bot Auth signature: the request carried no Signature, Signature-Input or Signature-Agent header.',
        ),
    h(
      'h4',
      { class: 'sub-title' },
      'Headers',
      h(
        'span',
        { class: 'sub-note' },
        `${count(headers.length)} in arrival order, case and duplicates kept`,
      ),
    ),
    headerTable(headers, signed),
    trailers.length
      ? h('div', {}, h('h4', { class: 'sub-title' }, 'Trailers'), headerTable(trailers, signed))
      : null,
    bodyBlock(raw, id, state),
    peer
      ? h(
          'p',
          { class: 'raw-peer muted' },
          'Socket peer ',
          h('span', { class: 'mono' }, peer),
          ' (on Cloud Run this is Google’s front end, not the client).',
        )
      : null,
  );
}
