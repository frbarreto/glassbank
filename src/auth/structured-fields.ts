/**
 * The part of RFC 8941 (Structured Field Values for HTTP) that Web Bot Auth needs (block: auth).
 *
 * `Signature-Input`, `Signature` and, in the newer drafts, `Signature-Agent` are dictionaries of
 * items and inner lists with parameters. HTTP Message Signatures (RFC 9421) builds the signature
 * base from the *serialisation* of those values, so this module parses them and serialises them
 * back in the canonical form the signer used. Pure functions, no I/O; a malformed value throws a
 * `StructuredFieldError`, which the verifier turns into the `malformed` verdict.
 */

export class StructuredFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredFieldError';
  }
}

/** A bare item: string, token, integer, decimal, byte sequence or boolean. */
export type BareItem =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'token'; readonly value: string }
  | { readonly kind: 'integer'; readonly value: number }
  | { readonly kind: 'decimal'; readonly value: number }
  | { readonly kind: 'bytes'; readonly value: Buffer }
  | { readonly kind: 'boolean'; readonly value: boolean };

export type Parameters = ReadonlyMap<string, BareItem>;

export interface Item {
  readonly type: 'item';
  readonly bare: BareItem;
  readonly params: Parameters;
}

export interface InnerList {
  readonly type: 'inner';
  readonly items: readonly Item[];
  readonly params: Parameters;
}

export type Member = Item | InnerList;

class Cursor {
  index = 0;

  constructor(readonly input: string) {}

  get done(): boolean {
    return this.index >= this.input.length;
  }

  peek(): string {
    return this.input[this.index] ?? '';
  }

  take(): string {
    const char = this.input[this.index] ?? '';
    this.index += 1;
    return char;
  }

  skipSpaces(): void {
    while (this.peek() === ' ') this.index += 1;
  }

  skipOws(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.index += 1;
  }

  fail(what: string): never {
    throw new StructuredFieldError(`${what} at character ${this.index + 1}`);
  }
}

const LCALPHA = /[a-z]/;
const KEY_CHAR = /[a-z0-9_\-.*]/;
const ALPHA = /[A-Za-z]/;
const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z:/]/;
const BASE64_CHAR = /[A-Za-z0-9+/=]/;

function parseKey(cursor: Cursor): string {
  const first = cursor.peek();
  if (!LCALPHA.test(first) && first !== '*') cursor.fail('expected a key');
  let key = '';
  while (!cursor.done && KEY_CHAR.test(cursor.peek())) key += cursor.take();
  return key;
}

function parseNumber(cursor: Cursor): BareItem {
  let sign = 1;
  if (cursor.peek() === '-') {
    cursor.take();
    sign = -1;
  }
  if (!/[0-9]/.test(cursor.peek())) cursor.fail('expected a digit');
  let text = '';
  let decimal = false;
  while (!cursor.done) {
    const char = cursor.peek();
    if (/[0-9]/.test(char)) {
      text += cursor.take();
    } else if (char === '.' && !decimal) {
      if (text.length > 12) cursor.fail('decimal too long');
      decimal = true;
      text += cursor.take();
    } else {
      break;
    }
    if (!decimal && text.length > 15) cursor.fail('integer too long');
    if (decimal && text.length > 16) cursor.fail('decimal too long');
  }
  if (decimal) {
    if (text.endsWith('.')) cursor.fail('decimal ends with a dot');
    return { kind: 'decimal', value: sign * Number(text) };
  }
  return { kind: 'integer', value: sign * Number.parseInt(text, 10) };
}

function parseString(cursor: Cursor): BareItem {
  cursor.take(); // the opening quote
  let value = '';
  for (;;) {
    if (cursor.done) cursor.fail('unterminated string');
    const char = cursor.take();
    if (char === '\\') {
      if (cursor.done) cursor.fail('dangling escape');
      const next = cursor.take();
      if (next !== '"' && next !== '\\') cursor.fail('invalid escape');
      value += next;
    } else if (char === '"') {
      return { kind: 'string', value };
    } else {
      const code = char.charCodeAt(0);
      if (code < 0x20 || code > 0x7e) cursor.fail('non-printable character in a string');
      value += char;
    }
  }
}

function parseToken(cursor: Cursor): BareItem {
  let value = cursor.take();
  while (!cursor.done && TOKEN_CHAR.test(cursor.peek())) value += cursor.take();
  return { kind: 'token', value };
}

function parseBytes(cursor: Cursor): BareItem {
  cursor.take(); // the opening colon
  let text = '';
  while (!cursor.done && cursor.peek() !== ':') {
    const char = cursor.take();
    if (!BASE64_CHAR.test(char)) cursor.fail('invalid base64 in a byte sequence');
    text += char;
  }
  if (cursor.take() !== ':') cursor.fail('unterminated byte sequence');
  return { kind: 'bytes', value: Buffer.from(text, 'base64') };
}

function parseBoolean(cursor: Cursor): BareItem {
  cursor.take(); // '?'
  const char = cursor.take();
  if (char === '1') return { kind: 'boolean', value: true };
  if (char === '0') return { kind: 'boolean', value: false };
  return cursor.fail('invalid boolean');
}

function parseBareItem(cursor: Cursor): BareItem {
  const char = cursor.peek();
  if (char === '-' || /[0-9]/.test(char)) return parseNumber(cursor);
  if (char === '"') return parseString(cursor);
  if (char === '*' || ALPHA.test(char)) return parseToken(cursor);
  if (char === ':') return parseBytes(cursor);
  if (char === '?') return parseBoolean(cursor);
  return cursor.fail('expected an item');
}

function parseParameters(cursor: Cursor): Parameters {
  const params = new Map<string, BareItem>();
  while (cursor.peek() === ';') {
    cursor.take();
    cursor.skipSpaces();
    const key = parseKey(cursor);
    let value: BareItem = { kind: 'boolean', value: true };
    if (cursor.peek() === '=') {
      cursor.take();
      value = parseBareItem(cursor);
    }
    params.set(key, value);
  }
  return params;
}

function parseItem(cursor: Cursor): Item {
  const bare = parseBareItem(cursor);
  return { type: 'item', bare, params: parseParameters(cursor) };
}

function parseInnerList(cursor: Cursor): InnerList {
  cursor.take(); // '('
  const items: Item[] = [];
  for (;;) {
    cursor.skipSpaces();
    if (cursor.peek() === ')') {
      cursor.take();
      return { type: 'inner', items, params: parseParameters(cursor) };
    }
    if (cursor.done) cursor.fail('unterminated inner list');
    items.push(parseItem(cursor));
    const next = cursor.peek();
    if (next !== ' ' && next !== ')') cursor.fail('expected a space or ")" in an inner list');
  }
}

function parseMember(cursor: Cursor): Member {
  return cursor.peek() === '(' ? parseInnerList(cursor) : parseItem(cursor);
}

/** A whole dictionary field, members in order. A later duplicate key replaces an earlier one. */
export function parseDictionary(input: string): Map<string, Member> {
  const cursor = new Cursor(input);
  const members = new Map<string, Member>();
  cursor.skipSpaces();
  if (cursor.done) return members;
  for (;;) {
    const key = parseKey(cursor);
    let member: Member;
    if (cursor.peek() === '=') {
      cursor.take();
      member = parseMember(cursor);
    } else {
      member = {
        type: 'item',
        bare: { kind: 'boolean', value: true },
        params: parseParameters(cursor),
      };
    }
    members.set(key, member);
    cursor.skipOws();
    if (cursor.done) return members;
    if (cursor.take() !== ',') cursor.fail('expected a comma between members');
    cursor.skipOws();
    if (cursor.done) cursor.fail('trailing comma');
  }
}

/** A whole item field (`Signature-Agent: "https://..."` in the earlier drafts). */
export function parseItemField(input: string): Item {
  const cursor = new Cursor(input);
  cursor.skipSpaces();
  const item = parseItem(cursor);
  cursor.skipSpaces();
  if (!cursor.done) cursor.fail('unexpected characters after the item');
  return item;
}

// ---------------------------------------------------------------------------
// Serialisation (RFC 8941 section 4.1), the form RFC 9421 signs
// ---------------------------------------------------------------------------

export function serializeBareItem(bare: BareItem): string {
  switch (bare.kind) {
    case 'string':
      return `"${bare.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case 'token':
      return bare.value;
    case 'integer':
      return String(Math.trunc(bare.value));
    case 'decimal': {
      const text = String(Math.round(bare.value * 1000) / 1000);
      return text.includes('.') ? text : `${text}.0`;
    }
    case 'bytes':
      return `:${bare.value.toString('base64')}:`;
    case 'boolean':
      return bare.value ? '?1' : '?0';
    default:
      return '';
  }
}

export function serializeParameters(params: Parameters): string {
  let text = '';
  for (const [key, value] of params) {
    text += `;${key}`;
    if (!(value.kind === 'boolean' && value.value)) text += `=${serializeBareItem(value)}`;
  }
  return text;
}

export function serializeItem(item: Item): string {
  return serializeBareItem(item.bare) + serializeParameters(item.params);
}

export function serializeInnerList(list: InnerList): string {
  return `(${list.items.map(serializeItem).join(' ')})${serializeParameters(list.params)}`;
}

export function serializeMember(member: Member): string {
  return member.type === 'inner' ? serializeInnerList(member) : serializeItem(member);
}

/** A parameter's value as a plain JS value, for reading `created`, `keyid` and the rest. */
export function paramValue(params: Parameters, key: string): string | number | boolean | null {
  const bare = params.get(key);
  if (!bare) return null;
  if (bare.kind === 'bytes') return bare.value.toString('base64');
  return bare.value;
}
