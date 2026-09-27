/**
 * Reading the headers of a raw request (block: dashboard, contracts v0.9, D-28).
 *
 * Pure and dependency-free, so the catalogue's one-line summary can say "signed" without pulling
 * in the rendering modules (which import the catalogue themselves).
 */

/** The Web Bot Auth headers, lower-case: the signature, what it covers, and who signed. */
export const WEB_BOT_AUTH_HEADERS = Object.freeze(['signature', 'signature-input', 'signature-agent']);

/** The `[name, value]` pairs of a raw block, whatever shape arrived. */
export function headersOf(raw) {
  const headers = raw?.headers;
  if (!Array.isArray(headers)) return [];
  return headers.filter(
    (pair) => Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string',
  );
}

/** Every value of one header, in arrival order; names compare case-insensitively. */
export function headerValues(raw, name) {
  const wanted = name.toLowerCase();
  return headersOf(raw)
    .filter(([key]) => key.toLowerCase() === wanted)
    .map(([, value]) => value);
}

/**
 * The Web Bot Auth headers the request carried, `null` when it carried none. Recorded, never
 * verified: this server does not fetch the signer's key directory.
 */
export function webBotAuthOf(raw) {
  const found = WEB_BOT_AUTH_HEADERS.map((name) => [name, headerValues(raw, name)]).filter(
    ([, values]) => values.length > 0,
  );
  if (found.length === 0) return null;
  const input = headerValues(raw, 'signature-input').join(', ');
  return {
    headers: Object.fromEntries(found.map(([name, values]) => [name, values.join(', ')])),
    agent: headerValues(raw, 'signature-agent').join(', ') || null,
    keyid: /keyid="([^"]*)"/.exec(input)?.[1] ?? null,
    tag: /tag="([^"]*)"/.exec(input)?.[1] ?? null,
    complete: found.length === WEB_BOT_AUTH_HEADERS.length,
  };
}
