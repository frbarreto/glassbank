/**
 * The overview (block: xray, v0.10, D-32): `GET /xray/api/stats`.
 *
 * The dashboard only ever holds a few sessions of the log (a 200-event replay, a backfill of three
 * sessions), so "what is going on overall" has to be counted where the whole log is: here, over
 * the SQLite log, for exactly the events the viewer's scope may read (`matchesScope`, invariant
 * 11). Counts, not contents: the only values this answers with are tool names, client labels, the
 * scalar arguments the model sent (redacted like the dashboard, never the rationale, never for the
 * observer) and error messages - each of which the same viewer can already read on the timeline.
 *
 * The scan reads a handful of fields per event through `json_extract`, never the raw request
 * bodies, stops at `MAX_SCAN` rows and says so, and its answer is cached for a few seconds per
 * scope and window, because the page polls it.
 */
import type {
  BotAuthVerdict,
  ViewerKind,
  XrayStatsArgument,
  XrayStatsBucket,
  XrayStatsClient,
  XrayStatsError,
  XrayStatsResponse,
  XrayStatsTool,
  XrayStatsWindow,
  XrayEvent,
  XrayViewerScope,
} from '../contracts/index.js';

import { OVERVIEW_TYPES, overviewRowOf, type EventLog, type OverviewRow } from './log.js';
import { strongerVerdict } from './verdicts.js';
import type { ReadModel } from './read-model.js';
import { redactEventData } from './redaction.js';
import type { Ring } from './ring.js';
import { logFilterFor } from './sse.js';

/** Rows read at most for one answer; past it the answer says `truncated`. */
export const MAX_SCAN = 200_000;
/** Rows per SQLite page. */
export const SCAN_PAGE = 5000;
/** How long one answer is reused for the same scope and window. */
export const OVERVIEW_CACHE_MS = 5000;
/** Answers kept in that cache at once. */
const OVERVIEW_CACHE_ENTRIES = 64;

const WINDOW_MS: Record<Exclude<XrayStatsWindow, 'all'>, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 7 * 86_400_000,
};

export function parseWindow(value: unknown): XrayStatsWindow {
  return value === '1h' || value === '7d' || value === 'all' ? value : '24h';
}

function percentile(sorted: readonly number[], share: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1));
  return Math.round((sorted[index] ?? 0) * 10) / 10;
}

function bucketMinutesFor(spanMs: number): number {
  if (spanMs <= 2 * 3_600_000) return 5;
  if (spanMs <= 2 * 86_400_000) return 60;
  if (spanMs <= 10 * 86_400_000) return 360;
  return 1440;
}

/** A scalar argument worth counting: short text, a number or a flag. Objects and long text are not. */
function scalarText(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > 80 || text === '[redacted]') return null;
  return text;
}

export interface OverviewDeps {
  readonly log: EventLog;
  readonly ring: Ring;
  readonly readModel: ReadModel;
  readonly now: () => Date;
  readonly retentionHours: number;
  /** Flushes the write queue first, so the answer includes what just happened. */
  readonly flush: () => void;
}

interface SessionTally {
  label: string | null;
  userAgent: string | null;
  verdict: string | null;
  agent: string | null;
  calls: number;
}

export interface Overview {
  stats(scope: XrayViewerScope, window: XrayStatsWindow): XrayStatsResponse;
}

export function createOverview(deps: OverviewDeps): Overview {
  const cache = new Map<string, { at: number; answer: XrayStatsResponse }>();

  function rowsOf(
    scope: XrayViewerScope,
    sinceMs: number,
  ): { rows: OverviewRow[]; truncated: boolean } {
    const filter = logFilterFor(scope, deps.readModel);
    const rows: OverviewRow[] = [];
    const visible = (row: OverviewRow): boolean =>
      deps.readModel.matchesScope(row as unknown as XrayEvent, scope);
    if (deps.log.degraded) {
      let cursor = 0;
      for (;;) {
        const page = deps.ring.after(cursor, SCAN_PAGE);
        for (const event of page) {
          cursor = event.id;
          if (Date.parse(event.ts) < sinceMs) continue;
          const row = overviewRowOf(event);
          if (row.type && visible(row)) rows.push(row);
        }
        if (page.length < SCAN_PAGE || rows.length >= MAX_SCAN) break;
      }
      return {
        rows: rows.filter((row) => OVERVIEW_TYPE_SET.has(row.type)),
        truncated: rows.length >= MAX_SCAN,
      };
    }
    let cursor = 0;
    let read = 0;
    for (;;) {
      const page = deps.log.readOverviewRows(sinceMs, cursor, SCAN_PAGE, filter);
      for (const row of page) {
        cursor = row.id;
        if (visible(row)) rows.push(row);
      }
      read += page.length;
      if (page.length < SCAN_PAGE) return { rows, truncated: false };
      if (read >= MAX_SCAN) return { rows, truncated: true };
    }
  }

  function compute(scope: XrayViewerScope, window: XrayStatsWindow): XrayStatsResponse {
    const nowMs = deps.now().getTime();
    const sinceMs = window === 'all' ? 0 : nowMs - WINDOW_MS[window];
    const { rows, truncated } = rowsOf(scope, sinceMs);
    const viewerKind: ViewerKind = scope.viewer_kind;

    const sessions = new Set<string>();
    const visitors = new Set<string>();
    const tallies = new Map<string, SessionTally>();
    const started = new Set<string>();
    const tools = new Map<string, { calls: number; failed: number; durations: number[] }>();
    const durations: number[] = [];
    const argumentsSeen = new Map<string, XrayStatsArgument & { count: number }>();
    const errors: XrayStatsError[] = [];
    let calls = 0;
    let ok = 0;
    let failed = 0;
    let denied = 0;
    let rateLimited = 0;
    let protocolErrors = 0;
    let httpRequests = 0;
    let signed = 0;
    let verified = 0;
    let withoutRationale = 0;

    const tallyOf = (xs: string): SessionTally => {
      const existing = tallies.get(xs);
      if (existing) return existing;
      const created: SessionTally = {
        label: null,
        userAgent: null,
        verdict: null,
        agent: null,
        calls: 0,
      };
      tallies.set(xs, created);
      return created;
    };
    const toolOf = (name: string) => {
      const existing = tools.get(name);
      if (existing) return existing;
      const created = { calls: 0, failed: 0, durations: [] as number[] };
      tools.set(name, created);
      return created;
    };

    const earliest = rows[0]?.ts ?? null;
    const spanMs =
      window === 'all'
        ? Math.max(0, nowMs - (earliest ? Date.parse(earliest) : nowMs))
        : WINDOW_MS[window];
    const bucketMinutes = bucketMinutesFor(spanMs);
    const bucketMs = bucketMinutes * 60_000;
    const firstBucket =
      Math.floor(
        (window === 'all' ? (earliest ? Date.parse(earliest) : nowMs) : sinceMs) / bucketMs,
      ) * bucketMs;
    const bucketCount = Math.min(
      400,
      Math.max(1, Math.floor((nowMs - firstBucket) / bucketMs) + 1),
    );
    const buckets: { calls: number; failed: number }[] = Array.from(
      { length: bucketCount },
      () => ({ calls: 0, failed: 0 }),
    );
    const bucketOf = (ts: string) => {
      const index = Math.floor((Date.parse(ts) - firstBucket) / bucketMs);
      return index >= 0 && index < buckets.length ? buckets[index] : undefined;
    };

    for (const row of rows) {
      if (row.xs) sessions.add(row.xs);
      if (row.grant_id) visitors.add(row.grant_id);
      const tally = row.xs ? tallyOf(row.xs) : null;
      if (tally && row.client_name) {
        tally.label = row.client_version
          ? `${row.client_name} ${row.client_version}`
          : row.client_name;
      }
      switch (row.type) {
        case 'http.request': {
          httpRequests += 1;
          if (row.rate_limited === true || row.status === 429) {
            rateLimited += 1;
            errors.push({
              ts: row.ts,
              xs: row.xs,
              request_id: row.request_id,
              tool: null,
              kind: 'rate_limited',
              message: `HTTP 429 answered to ${row.user_agent ?? 'a client'}`,
            });
          }
          if (row.sig_present === true) {
            signed += 1;
            if (row.sig_verdict === 'verified') verified += 1;
          }
          if (tally) {
            if (row.user_agent) tally.userAgent = row.user_agent;
            const stronger = strongerVerdict(tally.verdict, row.sig_verdict);
            if (stronger !== tally.verdict) {
              tally.verdict = stronger;
              tally.agent = row.sig_agent;
            }
          }
          break;
        }
        case 'tool.call.started': {
          calls += 1;
          started.add(`${row.xs ?? ''}#${row.request_id ?? ''}`);
          if (tally) tally.calls += 1;
          const tool = row.tool ?? 'unknown tool';
          toolOf(tool).calls += 1;
          const bucket = bucketOf(row.ts);
          if (bucket) bucket.calls += 1;
          if (row.rationale_present === false) withoutRationale += 1;
          if (viewerKind !== 'admin' && row.arguments) {
            // The dashboard's own view of the arguments: the per-tool deny-list, masking, no rationale.
            const shown = redactEventData('tool.call.started', { tool, arguments: row.arguments })
              .data as {
              arguments?: Record<string, unknown>;
            };
            for (const [key, value] of Object.entries(shown.arguments ?? {})) {
              if (key === 'rationale') continue;
              const text = scalarText(value);
              if (text === null) continue;
              const id = `${tool}\u0000${key}\u0000${text}`;
              const entry = argumentsSeen.get(id) ?? { tool, key, value: text, count: 0 };
              entry.count += 1;
              argumentsSeen.set(id, entry);
            }
          }
          break;
        }
        case 'tool.call.completed': {
          const tool = row.tool ?? 'unknown tool';
          if (row.duration_ms !== null) {
            durations.push(row.duration_ms);
            toolOf(tool).durations.push(row.duration_ms);
          }
          if (row.is_error === true) {
            failed += 1;
            toolOf(tool).failed += 1;
            const bucket = bucketOf(row.ts);
            if (bucket) bucket.failed += 1;
            errors.push({
              ts: row.ts,
              xs: row.xs,
              request_id: row.request_id,
              tool,
              kind: 'tool_error',
              message: redactedMessage(row.error_message ?? 'the tool returned an error'),
            });
          } else {
            ok += 1;
          }
          break;
        }
        case 'tool.call.denied': {
          denied += 1;
          const tool = row.tool ?? 'unknown tool';
          toolOf(tool).failed += 1;
          if (!started.has(`${row.xs ?? ''}#${row.request_id ?? ''}`)) {
            calls += 1;
            toolOf(tool).calls += 1;
            if (tally) tally.calls += 1;
          }
          if (row.denied_reason === 'rate_limited') rateLimited += 1;
          const bucket = bucketOf(row.ts);
          if (bucket) bucket.failed += 1;
          errors.push({
            ts: row.ts,
            xs: row.xs,
            request_id: row.request_id,
            tool,
            kind: 'denied',
            message: `denied: ${String(row.denied_reason ?? 'refused').replace(/_/g, ' ')}`,
          });
          break;
        }
        case 'protocol.error': {
          protocolErrors += 1;
          errors.push({
            ts: row.ts,
            xs: row.xs,
            request_id: row.request_id,
            tool: null,
            kind: 'protocol_error',
            message: redactedMessage(row.error_message ?? 'protocol error'),
          });
          break;
        }
        default:
          break;
      }
    }

    const byTool: XrayStatsTool[] = [...tools.entries()]
      .map(([tool, entry]) => {
        const sorted = [...entry.durations].sort((a, b) => a - b);
        return {
          tool,
          calls: entry.calls,
          failed: entry.failed,
          p50_ms: percentile(sorted, 0.5),
          p95_ms: percentile(sorted, 0.95),
        };
      })
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

    const clients = new Map<string, XrayStatsClient & { sessions: number; calls: number }>();
    for (const tally of tallies.values()) {
      const label = tally.label ?? tally.userAgent ?? 'unknown client';
      const key = `${label}\u0000${tally.verdict ?? ''}\u0000${tally.agent ?? ''}`;
      const entry =
        clients.get(key) ??
        ({
          label,
          user_agent: tally.userAgent,
          signature_verdict: (tally.verdict as BotAuthVerdict | null) ?? null,
          signed_agent: tally.verdict === null ? null : tally.agent,
          sessions: 0,
          calls: 0,
        } satisfies XrayStatsClient);
      entry.sessions += 1;
      entry.calls += tally.calls;
      clients.set(key, entry);
    }

    const sortedDurations = [...durations].sort((a, b) => a - b);
    const byTime: XrayStatsBucket[] = buckets.map((bucket, index) => ({
      start: new Date(firstBucket + index * bucketMs).toISOString(),
      calls: bucket.calls,
      failed: bucket.failed,
    }));

    return {
      viewer_kind: viewerKind,
      window,
      as_of: new Date(nowMs).toISOString(),
      since: window === 'all' ? null : new Date(sinceMs).toISOString(),
      covers_from: deps.log.degraded
        ? (deps.ring.after(0, 1)[0]?.ts ?? null)
        : deps.log.oldestTs(logFilterFor(scope, deps.readModel)),
      boot_id: deps.readModel.bootId,
      retention_hours: deps.retentionHours,
      scanned: rows.length,
      truncated,
      bucket_minutes: bucketMinutes,
      totals: {
        sessions: sessions.size,
        visitors: visitors.size,
        calls,
        calls_ok: ok,
        calls_failed: failed,
        calls_denied: denied,
        rate_limited: rateLimited,
        protocol_errors: protocolErrors,
        http_requests: httpRequests,
        signed_requests: signed,
        verified_requests: verified,
        calls_without_rationale: withoutRationale,
        p50_ms: percentile(sortedDurations, 0.5),
        p95_ms: percentile(sortedDurations, 0.95),
      },
      by_tool: byTool,
      by_client: [...clients.values()].sort((a, b) => b.calls - a.calls || b.sessions - a.sessions),
      by_time: byTime,
      top_arguments: [...argumentsSeen.values()]
        .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
        .slice(0, 12),
      recent_errors: errors.slice(-8).reverse(),
    };
  }

  return {
    stats(scope, window) {
      const key = [
        scope.viewer_kind,
        scope.filter,
        scope.login_id ?? '',
        scope.xs ?? '',
        window,
      ].join('|');
      const nowMs = deps.now().getTime();
      const cached = cache.get(key);
      if (cached && nowMs - cached.at < OVERVIEW_CACHE_MS) return cached.answer;
      deps.flush();
      const answer = compute(scope, window);
      cache.delete(key);
      cache.set(key, { at: nowMs, answer });
      while (cache.size > OVERVIEW_CACHE_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return answer;
    },
  };
}

const OVERVIEW_TYPE_SET = new Set<string>(OVERVIEW_TYPES);

/** An error message as the dashboard would show it: masked like any other value (D-28). */
function redactedMessage(message: string): string {
  const shown = redactEventData('protocol.error', { message }).data as { message?: unknown };
  const text = typeof shown.message === 'string' ? shown.message : message;
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}
