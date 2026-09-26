/**
 * How this block talks to the X-ray emitter (block: mcp).
 *
 * CLAUDE.md invariant 13: a feature that does not emit its documented events is not finished.
 * Everything `src/mcp` observes about a request becomes a contract-validated `XrayEvent`, and
 * the helpers that shape those events live here so `index.ts` and `transport.ts` stay about
 * HTTP and JSON-RPC.
 *
 * Three rules the emitter itself guarantees and this file relies on (docs/ARCHITECTURE.md
 * section 6): `emit` never throws, never blocks the producer, and applies the redaction
 * pipeline. So a tool's arguments are handed over **verbatim** here - the per-tool deny-list of
 * `ToolCatalogEntry.redactionDenyList` and the global token patterns are the emitter's job, not
 * the transport's, and `redacted_fields` is filled in on the way through.
 */
import { createHash } from 'node:crypto';

import {
  RESULT_PREVIEW_BYTES,
  publishedToolDescriptor,
  type CatalogTool,
  type ToolCatalogEntry,
  type ToolResult,
  type XrayCorrelation,
  type XrayEmitter,
  type XrayEra,
  type XrayEventDataInput,
  type XrayEventType,
} from '../contracts/index.js';

/**
 * The first protocol revision of the 2026-07-28 `_meta` shape. Anything older is the 2025-era
 * handshake the envelope calls `legacy`; SDK 1.30.0 negotiates at most `2025-11-25`, so today
 * every session is `legacy` and the field is here to prove it rather than to guess (ADR-2).
 */
export const MODERN_ERA_PROTOCOL_VERSION = '2026-07-28';

/** `era` for a negotiated (or header-declared) protocol version. Dates sort lexicographically. */
export function eraOf(protocolVersion: string | null | undefined): XrayEra | null {
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) return null;
  return protocolVersion >= MODERN_ERA_PROTOCOL_VERSION ? 'modern' : 'legacy';
}

/**
 * Emits and reports the id the emitter assigned, when it can.
 *
 * `XrayEmitter.emit` returns `number | void` (contracts v0.2), so this reads the return value
 * structurally and returns `null` when an emitter reports nothing. `snapshot_ref` accepts `null`,
 * and the X-ray read model resolves an elided tool array by `content_hash` first, falling back to
 * `snapshot_ref`, so nothing is lost either way.
 */
export function emitWithId<T extends XrayEventType>(
  emitter: XrayEmitter,
  type: T,
  data: XrayEventDataInput<T>,
  correlation?: XrayCorrelation,
): number | null {
  const returned: unknown = (
    emitter as { emit(type: T, data: XrayEventDataInput<T>, correlation?: XrayCorrelation): unknown }
  ).emit(type, data, correlation);
  return typeof returned === 'number' && Number.isInteger(returned) && returned >= 0
    ? returned
    : null;
}

/**
 * An emitter that fills the correlation of the request in flight, so a handler in another block
 * emits `bank.op` or `sql.query` without knowing what `xs` it is running inside. Anything the
 * caller passes wins, which is how `src/etl` can attribute an event to a different request id.
 */
export function withCorrelation(
  emitter: XrayEmitter,
  correlation: XrayCorrelation,
): XrayEmitter {
  return {
    // The return value is forwarded, not swallowed: `emitWithId` reads it to fill
    // `catalog.tools_listed.snapshot_ref` (contracts v0.2, proposal P-5), and `catalog.*` is
    // emitted through exactly this wrapper.
    emit(type, data, overrides) {
      return emitter.emit(type, data, { ...correlation, ...overrides });
    },
  };
}

/** A stable digest of the published JSON schema, so a schema edit shows up on the dashboard. */
export function inputSchemaHash(entry: ToolCatalogEntry): string {
  return createHash('sha256')
    .update(JSON.stringify(entry.publishedInputSchema))
    .digest('hex')
    .slice(0, 16);
}

/** One `catalog.tools_listed.tools` row per listed entry, in `tools/list` order. */
export function catalogRowsOf(entries: readonly ToolCatalogEntry[]): CatalogTool[] {
  return entries.map((entry) => {
    // The same object `tools/list` answers with, so the recording proves the wording and the
    // schema the client received and not only their digest (contracts v0.5).
    const published = publishedToolDescriptor(entry);
    return {
      name: entry.name,
      title: entry.title,
      // The annotation, not the tri-state `x-read-only`: `partial` (touches only the caller's
      // scratch database) is not read-only, and the contract row is a boolean.
      read_only: entry.annotations.readOnlyHint === true,
      destructive: entry.annotations.destructiveHint === true,
      idempotent: entry.annotations.idempotentHint,
      scopes: [...entry.requiredScopes],
      input_schema_hash: inputSchemaHash(entry),
      descriptor: {
        description: published.description,
        inputSchema: { ...published.inputSchema },
        annotations: { ...published.annotations },
        _meta: published._meta,
      },
    };
  });
}

/** What `tool.call.completed` reports about the payload the model received. */
export interface ResultSummary {
  readonly contentTypes: string[];
  readonly contentChars: number;
  readonly textPreview: string | null;
  readonly structuredContent: unknown;
}

/**
 * The marker the emitter appends when it cuts a preview (`previewOf` in `src/xray/redaction.ts`).
 * Copied, not imported: this block may not reach into `src/xray` (docs/REPO_LAYOUT.md section 3).
 * `__tests__/events.test.ts` reads the original from disk and fails if the two ever drift.
 */
export const RESULT_PREVIEW_TRUNCATION_SUFFIX = '…[truncated]';

export function summariseResult(result: ToolResult): ResultSummary {
  const contentTypes: string[] = [];
  const texts: string[] = [];
  let contentChars = 0;
  for (const block of result.content) {
    contentTypes.push(block.type);
    if (typeof block.text === 'string') {
      contentChars += block.text.length;
      texts.push(block.text);
    }
  }
  const joined = texts.join('\n');
  return {
    contentTypes,
    contentChars,
    // The emitter truncates too; cutting here keeps a 150 000-character answer out of the queue.
    // The marker is what separates a preview from a whole result; `contentChars` above keeps
    // counting every character the model received, cut or not.
    textPreview:
      joined.length === 0
        ? null
        : joined.length <= RESULT_PREVIEW_BYTES
          ? joined
          : `${joined.slice(0, RESULT_PREVIEW_BYTES)}${RESULT_PREVIEW_TRUNCATION_SUFFIX}`,
    structuredContent: result.structuredContent ?? null,
  };
}
