/**
 * `captureRawRequest` and friends (contracts v0.9, D-28): the request as it reached the process.
 */
import { describe, expect, it } from 'vitest';

import {
  captureRawRequest,
  isHttpObserved,
  keepRawBody,
  markHttpObserved,
  rawBodyOf,
  RawHttpRequestSchema,
} from '../index.js';

/** A Web Bot Auth request as an agent signs it (RFC 9421 + draft-meunier-web-bot-auth). */
function signedRequest(): Record<string, unknown> {
  return {
    method: 'POST',
    originalUrl: '/mcp?x=1',
    url: '/?x=1',
    httpVersion: '1.1',
    rawHeaders: [
      'Host',
      'glassbank.example',
      'Signature-Agent',
      '"https://chatgpt.com"',
      'Signature-Input',
      'sig1=("@authority" "signature-agent");created=1735689600;keyid="k";tag="web-bot-auth"',
      'Signature',
      'sig1=:dGVzdA==:',
      'x-dup',
      'first',
      'X-Dup',
      'second',
    ],
    rawTrailers: [],
    socket: { remoteAddress: '::ffff:169.254.1.2', remotePort: 41234 },
  };
}

describe('captureRawRequest', () => {
  it('keeps every header in arrival order, with its case and its duplicates', () => {
    const raw = captureRawRequest(signedRequest());
    expect(raw.headers).toEqual([
      ['Host', 'glassbank.example'],
      ['Signature-Agent', '"https://chatgpt.com"'],
      [
        'Signature-Input',
        'sig1=("@authority" "signature-agent");created=1735689600;keyid="k";tag="web-bot-auth"',
      ],
      ['Signature', 'sig1=:dGVzdA==:'],
      ['x-dup', 'first'],
      ['X-Dup', 'second'],
    ]);
    expect(raw.url).toBe('/mcp?x=1');
    expect(raw.http_version).toBe('1.1');
    expect(raw.remote_address).toBe('::ffff:169.254.1.2');
    expect(raw.remote_port).toBe(41234);
  });

  it('reports no body when no parser read one', () => {
    const raw = captureRawRequest(signedRequest());
    expect(raw).toMatchObject({ body: null, body_read: false, body_bytes: null, body_encoding: null });
  });

  it('keeps the exact bytes a parser read, as text when they are UTF-8', () => {
    const request = signedRequest();
    const text = '{ "jsonrpc": "2.0",  "id": 1, "method": "ping", "é": true }';
    keepRawBody(request, null, Buffer.from(text));
    const raw = captureRawRequest(request);
    expect(raw.body).toBe(text);
    expect(raw.body_encoding).toBe('utf8');
    expect(raw.body_bytes).toBe(Buffer.byteLength(text));
    expect(raw.body_read).toBe(true);
    expect(rawBodyOf(request)?.toString()).toBe(text);
  });

  it('falls back to base64 for bytes that are not UTF-8, so none is lost', () => {
    const request = signedRequest();
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x41]);
    keepRawBody(request, null, bytes);
    const raw = captureRawRequest(request);
    expect(raw.body_encoding).toBe('base64');
    expect(Buffer.from(raw.body ?? '', 'base64')).toEqual(bytes);
  });

  it('produces what the contract schema accepts, unchanged', () => {
    const raw = captureRawRequest(signedRequest());
    expect(RawHttpRequestSchema.parse(raw)).toEqual(raw);
  });
});

describe('the observed mark', () => {
  it('is set on res.locals and read back', () => {
    const response = { locals: {} as Record<string, unknown> };
    expect(isHttpObserved(response)).toBe(false);
    markHttpObserved(response);
    expect(isHttpObserved(response)).toBe(true);
  });
});
