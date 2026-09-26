# xray

Status: done; built by `src/composition.ts` (`createXray`), mounted at `/xray`, its `emitter` injected into every producer; contracts v0.5.

## Purpose
The server half of the X-ray: the `XrayEmitter` every block writes to, the redaction pipeline, the ring buffer and SQLite log, the SSE stream, the JSON read model, pairing codes and the viewer cookie.
Every path is wrapped: an X-ray failure degrades the dashboard, never a request.

## Files
| File | What it does |
|---|---|
| `index.ts` | `createXray(deps)`: opens the log, restores ids, per-`xs` `seq` and the read model from the last 5,000 rows, emits `server.started`, runs retention every 10 min, `shutdown()`. |
| `emitter.ts` | The pipeline: id and `seq`, redact, validate (strict schema, then the lenient envelope), ring push, fan-out, SQLite write batched on `setImmediate`; never throws. |
| `redaction.ts` | The deny-list walker (ancestor-scoped cycle guard), the per-type rules, `applyObserverRedaction` (read time, admin viewers). |
| `ring.ts` | The last 10,000 events or 48 MB (`RING_BYTES_BUDGET`) in memory; O(1) push; replay source when the log is degraded. |
| `log.ts` | SQLite WAL log at `XRAY_DB_PATH` (`auto_vacuum=INCREMENTAL`): replay, history, retention, `reclaim()`; becomes a null log after 5 consecutive failures. |
| `read-model.ts` | Sessions, grants, logins and catalog snapshots (LRUs of 2,000 / 2,000 / 2,000 / 200); `matchesScope` is the visibility authority. |
| `sse.ts` | `openSseStream`: subscribe, flush, replay, drain - synchronous, so no gap and no duplicate; heartbeat; bounded per-subscriber queue. |
| `routes.ts` | Every route below; JSON bodies capped at 32 kb. |
| `pairing.ts` | `Pairing`: mints and exchanges `BANK-XXXX-XXXX-XX`; the admin-token exchange. |
| `viewer.ts` | Issues and reads the viewer cookie; `resolveScope` turns cookie plus query into one `XrayViewerScope`. |
| `rate-limit.ts`, `bounded.ts` | Fixed-window failure limiter and `BoundedLru`; own copies because blocks may not import each other. |
| `types.ts` | `XrayConfig` (a structural subset of `AppConfig`), `XrayStats`, `PersonaLookup`, `ViewerIdentity`. |

## Public interface (`src/xray/index.ts`)
- `createXray(deps: XrayDeps): Xray`. `XrayDeps`: `config` (`publicBaseUrl`, `xrayDbPath`, `xrayRetentionHours`, `xrayMaxLogRows`, `xrayAdminToken`, `rateLimits.ipPairFailuresPerMin`, `xrayMaxStreamsPerLogin`, `xrayMaxStreams`), `jwt` (`auth.jwt`), `bootId`; optional `version`, `gitSha`, `sdk`, `nodeVersion`, `now`, `lookupPersona`, `onError`, `emitServerStarted`, `heartbeatMs`, `retentionIntervalMs`, `installSignalHandlers`.
- `Xray`: `emitter`, `router`, `pairing`, `readModel`, `log`, `ring`, `stats()`, `flush()`, `runRetention()`, `shutdown(reason?)`.
- Also exported: `RESTORE_WINDOW`, `RETENTION_INTERVAL_MS`, `applyObserverRedaction`, `redactEventData`, `ipPrefixOf`, `isAnthropicEgress`, `maskToLastFour`, `shortHash`; types `XrayConfig`, `XrayStats`, `PersonaLookup`, `ViewerIdentity`, `ReadModel`, `SessionRow`, `EventLog`.

## Routes (`routes.ts`; paths are `XRAY_ROUTES` from `src/contracts/xray-api.ts`)
| Method and path | Auth | Answer |
|---|---|---|
| `GET /xray/s/:code` | none | Exchange, set the cookie, 302 to `/xray/`; 400 malformed, 404 unknown, 410 expired, 429 rate-limited (HTML or JSON by `Accept`). |
| `POST /xray/api/pair` `{code}` | none | The same exchange; `PairResponse`. |
| `POST /xray/api/admin` `{token}` | admin token | Admin cookie; 403 on a bad token (counted as a failure), 429 when limited. |
| `GET /xray/api/me` | cookie | `ViewerMeResponse`; a pairing viewer also gets `grant_ids` and `persona`. |
| `GET /xray/api/sessions` | cookie | `XraySessionsResponse`, grouped by login; `page.next` is always `null`. |
| `GET /xray/api/sessions/:xs` | cookie | Session, grant facts, catalog snapshot, availability, counters; 404 unknown, 403 another login's. |
| `DELETE /xray/api/sessions/:xs` | pairing cookie | Erases one session from the log (`deleteMatching`), the ring (`remove`) and the read model (`forgetSession`); refuses observer mode with 403 (v0.4). |
| `DELETE /xray/api/events` | pairing cookie | The same for the whole login (`forgetLogin`); both emit `xray.events.deleted` afterwards. |
| `GET /xray/api/sessions/:xs/bank` | cookie | The persona card through the injected `lookupBankSummary` (v0.3): 404 `no_persona`, 503 `unavailable` without a bank; the read itself emits nothing. |
| `GET /xray/api/sessions/:xs/events?after=&limit=` | cookie | Flushes the queue first; `limit` default 200, max 500; observer redaction for an admin cookie. |
| `GET /xray/api/catalog?xs=` | cookie | The latest snapshot; 400 without `xs`, 404 without a snapshot. |
| `GET /xray/api/stream` | cookie | SSE; `?xs=` / `?login=me` / `?all=1`. |
| anything else under `/xray/api` | - | 404 `{error, message}`. `/xray/`, the modules and `/xray/fixtures/*` fall through to `dashboard`. |

Scope: a pairing cookie sees its own login only (`all=1` -> 403, another login's `xs` -> 403); an admin cookie sees everything (`login=me` -> 400).

## Consumes
`src/contracts` (events, `xray-api`, `Pairing`, `JwtService`, `COOKIE_NAMES`, `TOKEN_LIFETIMES_SECONDS`, `getTool` for deny-lists), the injected `JwtService`, `lookupPersona` (`bankCore.personas.get`), `better-sqlite3`. Imports no other block.

## Events owned
`server.started`, `server.stopping` (`index.ts`); `xray.pairing.created`, `xray.pairing.rejected` (`pairing.ts`); `xray.viewer.connected`, `xray.viewer.disconnected` (`sse.ts`); `xray.dropped` (`emitter.ts`, when the write queue overflows). A slow subscriber also receives an id-less `xray.dropped` frame written straight to its socket by `sse.ts`, so its `Last-Event-ID` stays on the last event it really got.

## Mechanics
- Ring and log: every event goes to the ring and to a write queue of at most 20,000 (`MAX_PENDING_WRITES`) flushed on `setImmediate`; overflow loses durability only. Ids continue from `max(id)` after a restart.
- Retention (every 10 min): `deleteOlderThan(XRAY_RETENTION_HOURS)`, `trimToMaxRows(XRAY_MAX_LOG_ROWS)`, then `reclaim()` (incremental vacuum, `wal_checkpoint(TRUNCATE)`). `stats()` reports rows, bytes and free pages.
- SSE: `retry: 2000`, a heartbeat comment every 20 s (`SSE_HEARTBEAT_MS`), replay of `id > Last-Event-ID` (header, or the `?last_event_id=` fallback) in chunks of 500 up to 20,000 events, else the last 200 (`INITIAL_REPLAY`); a subscriber queue of 1,000 frames / 4 MB, then drops; `XRAY_MAX_STREAMS_PER_LOGIN` (4) and `XRAY_MAX_STREAMS` (64) answer 429 + `Retry-After: 5`.
- Pairing: 10 characters from a 32-letter alphabet without `0 O 1 I` (50 bits), formatted `BANK-XXXX-XXXX-XX`, bound to the login, valid 24 h, multi-use; only its hash is kept (in-memory LRU of 10,000); `RATE_LIMIT_IP_PAIR_FAILURES` (5) failed exchanges per IP prefix per minute, checked before the lookup; the admin exchange shares the limiter.
- Viewer cookie `xray_viewer`: a JWT with `typ: viewer`, `login_id`, `viewer_kind`, `aud` = `publicBaseUrl`, signed with `OAUTH_SIGNING_KEY`, 24 h, `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`; survives a restart.
- Redaction is a deny-list, default verbatim: sensitive key names and fragments (`SENSITIVE_KEYS`, `SENSITIVE_KEY_FRAGMENTS`, minus `SENSITIVE_KEY_EXCEPTIONS`), `GLOBAL_REDACTION_PATTERNS`, the tool's `redactionDenyList` on `tool.call.started` arguments, `MASKED_NUMBER_KEYS` and Luhn-valid 13-19 digit runs masked to the last four.
- `remote_ip` never stored, only a `/24` (IPv6 `/48`) prefix and `anthropic_egress`; pairing codes hashed; results previewed at 2,048 chars; `rationale` and SQL verbatim (`rationale` capped at 8,192); one event at most 64,000 chars, strings 16,384, depth 12, 500 items, 200 keys.
- The cycle guard is ancestor-scoped: a sub-object shared by several siblings (the catalog's `rationale` property) is walked every time; only a reference back to an ancestor is stored as `[circular]`. The real catalog with one published descriptor per row round-trips unchanged inside the 64,000-char budget (29,355 chars with an empty `_meta`, 31,220 with it populated).
- Observer mode (admin cookie): arguments hidden and `rationale` cut to 80 chars, applied at read time on the stream and on `/sessions/:xs/events`.

## Invariants held here
- 11: viewers see only their login's grants, no session picker, arguments verbatim except the deny-list, IP as a prefix, observer mode redacted harder.
- 13 (under 5): `emit` never throws and never blocks a producer; a broken log degrades the X-ray, never a tool call.
- 3 and 12: 20 s heartbeat, `Last-Event-ID` replay, every stream closed and the queue flushed inside `shutdown()`; the cookie is `Secure` + `HttpOnly`.
- 14: pairing failures rate-limited; every collection bounded (ring bytes, write queue, subscriber queue, LRUs, stream caps).
- 7: tokens, codes, verifiers, `txn` and viewer JWTs never reach the log, by key name and by the JWT pattern.

## How to test
```
npx vitest run src/xray               # 91 tests, 7 files: redaction, emitter, log, pairing, read-model, api, sse
npx eslint src/xray
```
The tests build their own `JwtService` in `__tests__/harness.ts`; `test/import-boundaries.test.ts` forbids importing `src/auth` or `src/testing`.

## Known gaps
- An erase is permanent and immediate: there is no undo, no soft delete and no snapshot, so a viewer who clears its history cannot get it back.
- `GET /xray/api/sessions` has no cursor; the read model keeps at most 2,000 sessions.
- Pairing codes live in memory: a restart invalidates them (the viewer cookie does not).
- Only the pairing and admin exchanges are rate-limited; the read routes rely on the cookie and the stream caps.
- `?last_event_id=` is honoured by `sse.ts` but is absent from `XrayStreamQuery`, and the dashboard never sends it.
- `XRAY_ROUTES.assets` (`/xray/assets`) has no directory behind it; `public/` is flat.
- The bare-number mask is a Luhn filter, so about one random long number in ten is masked too.
- A `[circular]` marker is not listed in `redacted_fields`; only the payload shows it.
- `session.ended` belongs to `mcp`; `server.stopping.sessions_ended` only counts this boot's sessions.
