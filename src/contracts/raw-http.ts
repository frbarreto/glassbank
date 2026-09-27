/**
 * Capturing the request as it arrived (block: contracts, v0.9, D-28).
 *
 * Every block that parses a body (`auth`, `mcp`, the app's fallback parsers) hands `keepRawBody`
 * to its body parser as `verify`, so the bytes are kept before anything interprets them; whoever
 * emits `http.request` then calls `captureRawRequest` for the `raw` block. The observed flag lets
 * the app's catch-all observer skip a response an MCP endpoint already reports with its own
 * correlation, so each request is reported exactly once.
 *
 * Pure functions over a structural request type: no Express import, no I/O.
 */
import type { RawHeader, RawHttpRequest } from './events.js';

/**
 * Where `keepRawBody` leaves the bytes on the request. `Symbol.for`, so every copy agrees; not
 * exported, because the barrel carries no runtime state (`rawBodyOf` is the way to read it).
 */
const RAW_BODY_KEY = Symbol.for('glassbank.rawBody');

/** The `res.locals` key that marks a response whose `http.request` is already arranged. */
export const HTTP_OBSERVED_LOCAL = 'glassbankHttpObserved';

/** The parts of a Node or Express request the capture reads. */
export interface RawRequestSource {
  readonly method?: string;
  readonly originalUrl?: string;
  readonly url?: string;
  readonly httpVersion?: string;
  readonly rawHeaders?: readonly string[];
  readonly rawTrailers?: readonly string[];
  readonly socket?: { readonly remoteAddress?: string; readonly remotePort?: number } | null;
}

/**
 * The `verify` hook of `express.json` / `express.urlencoded`: body-parser calls it with the bytes
 * it read (inflated when the client compressed them), before parsing. It never throws, so a body
 * the parser then refuses (malformed JSON) is still kept.
 */
export function keepRawBody(request: object, _response: unknown, body: Buffer): void {
  (request as Record<symbol, unknown>)[RAW_BODY_KEY] = body;
}

/** The bytes `keepRawBody` kept, if a parser read this request. */
export function rawBodyOf(request: object): Buffer | null {
  const value = (request as Record<symbol, unknown>)[RAW_BODY_KEY];
  return Buffer.isBuffer(value) ? value : null;
}

/** Node's flat `[name, value, name, value, ...]` as pairs, order and case kept. */
function pairsOf(flat: readonly string[] | undefined): RawHeader[] {
  if (!Array.isArray(flat)) return [];
  const pairs: RawHeader[] = [];
  for (let index = 0; index + 1 < flat.length; index += 2) {
    pairs.push([String(flat[index]), String(flat[index + 1])]);
  }
  return pairs;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Text when the bytes are valid UTF-8, otherwise base64: either way every byte survives. */
function encodeBody(bytes: Buffer): { body: string; encoding: 'utf8' | 'base64' } {
  try {
    return { body: UTF8.decode(bytes), encoding: 'utf8' };
  } catch {
    return { body: bytes.toString('base64'), encoding: 'base64' };
  }
}

/** The `raw` block of `http.request`: the request as it reached the process. */
export function captureRawRequest(request: RawRequestSource): RawHttpRequest {
  const bytes = rawBodyOf(request);
  const encoded = bytes === null ? null : encodeBody(bytes);
  return {
    method: request.method ?? '',
    url: request.originalUrl ?? request.url ?? '',
    http_version: request.httpVersion ?? null,
    headers: pairsOf(request.rawHeaders),
    trailers: pairsOf(request.rawTrailers),
    body: encoded?.body ?? null,
    body_encoding: encoded?.encoding ?? null,
    body_bytes: bytes?.length ?? null,
    body_read: bytes !== null,
    remote_address: request.socket?.remoteAddress ?? null,
    remote_port: request.socket?.remotePort ?? null,
  };
}

interface LocalsCarrier {
  readonly locals?: Record<string, unknown>;
}

/** Marks a response whose `http.request` its own endpoint reports (the MCP endpoints). */
export function markHttpObserved(response: LocalsCarrier): void {
  if (response.locals) response.locals[HTTP_OBSERVED_LOCAL] = true;
}

/** True when an endpoint already reports this response's `http.request`. */
export function isHttpObserved(response: LocalsCarrier): boolean {
  return response.locals?.[HTTP_OBSERVED_LOCAL] === true;
}
