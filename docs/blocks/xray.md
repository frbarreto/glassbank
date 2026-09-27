# xray

Status: done; built by `src/composition.ts` (`createXray`), mounted at `/xray`, its `emitter` injected into every producer; contracts v0.9 (the public lane readable with `?lane=public`, D-26; the log downloadable as JSONL at `/xray/api/export`, D-27; the log stores what arrives and redacts on the way out, D-28).

## Purpose
The server half of the X-ray: the `XrayEmitter` every block writes to (it stores what it is given, D-28), the read-time redaction, the ring buffer and SQLite log, the SSE stream, the JSON read model, pairing codes and the viewer cookie.
Every path is wrapped: an X-ray failure degrades the dashboard, never a request.

## Files
| File | What it does |
|---|---|
| `index.ts` | `createXray(deps)`: opens the log, restores ids, per-`xs` `seq` and the read model from the last 5,000 rows, emits `server.started`, runs retention every 10 min, `shutdown()`. |
| `emitter.ts` | The pipeline: id and `seq`, a deep copy of the payload (`snapshot`), validate against the open schemas (defaults filled, nothing dropped; the lenient envelope as fallback), ring push, fan-out, SQLite write batched on `setImmediate`, then the byte cap (`maxLogBytes`); never throws, never redacts. |
| `redaction.ts` | Read time only (D-28): `viewEvent` (the one exit of a stored event), the deny-list walker (ancestor-scoped cycle guard), the per-type rules, `redactRawRequest` (the `raw` block of `http.request`: credential headers and query parameters, IPs in forwarding headers, the JSON-RPC or form body), `applyObserverRedaction` (admin viewers). |
| `ring.ts` | The last 10,000 events or 48 MB (`RING_BYTES_BUDGET`) in memory; O(1) push; replay source when the log is degraded. |
| `log.ts` | SQLite WAL log at `XRAY_DB_PATH` (`auto_vacuum=INCREMENTAL`): replay, history, retention, `storedBytes()` and `trimToMaxBytes()` (whole events, oldest first, the newest always kept), `reclaim()`; becomes a null log after 5 consecutive failures. |
| `read-model.ts` | Sessions, grants, logins and catalog snapshots (LRUs of 2,000 / 2,000 / 2,000 / 200); `matchesScope` is the visibility authority. |
| `sse.ts` | `openSseStream`: subscribe, flush, replay, drain - synchronous, so no gap and no duplicate; heartbeat; bounded per-subscriber queue. |
| `routes.ts` | Every route below; JSON bodies capped at 32 kb; the stream budget shared by the SSE streams and the export; the export's paged JSONL writer (`EXPORT_PAGE_ROWS`). |
| `pairing.ts` | `Pairing`: mints and exchanges `BANK-XXXX-XXXX-XX`; the admin-token exchange. |
| `viewer.ts` | Issues and reads the viewer cookie; `resolveScope` turns cookie plus query into one `XrayViewerScope`; `wantsPublicLane` and `publicLaneViewer` (the cookie-less `public` reader, D-26). |
| `rate-limit.ts`, `bounded.ts` | Fixed-window failure limiter and `BoundedLru`; own copies because blocks may not import each other. |
| `types.ts` | `XrayConfig` (a structural subset of `AppConfig`), `XrayStats`, `PersonaLookup`, `ViewerIdentity`. |

## Public interface (`src/xray/index.ts`)
- `createXray(deps: XrayDeps): Xray`. `XrayDeps`: `config` (`publicBaseUrl`, `xrayDbPath`, `xrayRetentionHours`, `xrayMaxLogRows`, `xrayMaxLogBytes?` (default `DEFAULT_MAX_LOG_BYTES`, 256 MiB), `xrayAdminToken`, `rateLimits.ipPairFailuresPerMin`, `xrayMaxStreamsPerLogin`, `xrayMaxStreams`, `xrayMaxPublicStreams`), `jwt` (`auth.jwt`), `bootId`; optional `version`, `gitSha`, `sdk`, `nodeVersion`, `now`, `lookupPersona`, `onError`, `emitServerStarted`, `heartbeatMs`, `retentionIntervalMs`, `installSignalHandlers`.
- `Xray`: `emitter`, `router`, `pairing`, `readModel`, `log`, `ring`, `stats()`, `flush()`, `runRetention()`, `shutdown(reason?)`.
- Also exported: `RESTORE_WINDOW`, `RETENTION_INTERVAL_MS`, `DEFAULT_MAX_LOG_BYTES`, `viewEvent`, `applyObserverRedaction`, `redactEventData`, `ipPrefixOf`, `isAnthropicEgress`, `maskToLastFour`, `shortHash`; types `XrayConfig`, `XrayStats`, `PersonaLookup`, `ViewerIdentity`, `ReadModel`, `SessionRow`, `EventLog`.

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
| `GET /xray/api/sessions/:xs/events?after=&limit=` | cookie | Flushes the queue first; `limit` default 200, max 500; every event through `viewEvent` (observer redaction for an admin cookie). |
| `GET /xray/api/catalog?xs=` | cookie | The latest snapshot; 400 without `xs`, 404 without a snapshot. |
| `GET /xray/api/stream` | cookie | SSE; `?xs=` / `?login=me` / `?all=1`. |
| `GET /xray/api/export?after=` | cookie, or `Authorization: Bearer <XRAY_ADMIN_TOKEN>` | v0.8 (D-27): JSONL (`application/x-ndjson`), `Content-Disposition: attachment; filename="glass-bank-xray-<UTC stamp>.jsonl"`, `Cache-Control: no-store`. Every event the scope may read with `id > after`, oldest first, up to the newest id when the request arrived; for the admin (cookie or bearer) the log as stored - raw headers, bodies and addresses included - and for a pairing or public-lane reader the `viewEvent` view (D-28). Same scope switches as `stream`. A wrong bearer -> 403, counted on the pairing limiter (429 once spent); no credential -> 401. |
| anything else under `/xray/api` | - | 404 `{error, message}`. `/xray/`, the modules and `/xray/fixtures/*` fall through to `dashboard`. |

Scope: a pairing cookie sees its own login only (`all=1` -> 403, another login's `xs` -> 403); an admin cookie sees everything (`login=me` -> 400).

The public lane (v0.7, D-26): `?lane=public` on `me`, `sessions`, `sessions/:xs`, `sessions/:xs/events`, `sessions/:xs/bank`, `catalog` and `stream` needs no cookie and ignores one, so a browser can keep a paired tab beside a public one. The reader is `viewer_kind: 'public'` bound to `PUBLIC_LOGIN_ID`: it sees the anonymous visitors of `/public/mcp` and nothing else (another login's `xs` -> 403, `all=1` -> 403), both `DELETE` routes answer 403, and events come with the deny-list view but no observer masking, because every public tool told the agent its calls are shown publicly; `raw` shows no credential header and IPs as a prefix only. Its streams and exports count against `XRAY_MAX_PUBLIC_STREAMS` (16), inside `XRAY_MAX_STREAMS`. `me` answers `{viewer_kind: 'public', login_id: 'lgn_public', grant_ids, persona: null}`.

## Consumes
`src/contracts` (events, `xray-api`, `Pairing`, `JwtService`, `COOKIE_NAMES`, `TOKEN_LIFETIMES_SECONDS`, `getTool` for deny-lists), the injected `JwtService`, `lookupPersona` (`bankCore.personas.get`), `better-sqlite3`. Imports no other block.

## Events owned
`server.started`, `server.stopping` (`index.ts`); `xray.pairing.created`, `xray.pairing.rejected` (`pairing.ts`); `xray.viewer.connected`, `xray.viewer.disconnected` (`sse.ts`); `xray.dropped` (`emitter.ts`, when the write queue overflows). A slow subscriber also receives an id-less `xray.dropped` frame written straight to its socket by `sse.ts`, so its `Last-Event-ID` stays on the last event it really got.

## Mechanics
- Ring and log: every event goes to the ring and to a write queue of at most 20,000 (`MAX_PENDING_WRITES`) flushed on `setImmediate`; overflow loses durability only. Ids continue from `max(id)` after a restart.
- Byte cap (D-28): events are stored whole, so after every write batch `trimToMaxBytes(XRAY_MAX_LOG_BYTES)` drops the oldest whole events once the stored envelopes pass the cap (UTF-8 bytes, counted on append, recounted after a delete).
- Retention (every 10 min): `deleteOlderThan(XRAY_RETENTION_HOURS)`, `trimToMaxRows(XRAY_MAX_LOG_ROWS)`, `trimToMaxBytes(XRAY_MAX_LOG_BYTES)`, then `reclaim()` (incremental vacuum, `wal_checkpoint(TRUNCATE)`). `stats()` reports rows, bytes and free pages.
- SSE: `retry: 2000`, a heartbeat comment every 20 s (`SSE_HEARTBEAT_MS`), replay of `id > Last-Event-ID` (header, or the `?last_event_id=` fallback) in chunks of 500 up to 20,000 events, else the last 200 (`INITIAL_REPLAY`); a subscriber queue of 1,000 frames / 4 MB, then drops; `XRAY_MAX_STREAMS_PER_LOGIN` (4) and `XRAY_MAX_STREAMS` (64) answer 429 + `Retry-After: 5`.
- Pairing: 10 characters from a 32-letter alphabet without `0 O 1 I` (50 bits), formatted `BANK-XXXX-XXXX-XX`, bound to the login, valid 24 h, multi-use; only its hash is kept (in-memory LRU of 10,000); `RATE_LIMIT_IP_PAIR_FAILURES` (5) failed exchanges per IP prefix per minute, checked before the lookup; the admin exchange shares the limiter.
- Viewer cookie `xray_viewer`: a JWT with `typ: viewer`, `login_id`, `viewer_kind`, `aud` = `publicBaseUrl`, signed with `OAUTH_SIGNING_KEY`, 24 h, `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`; survives a restart.
- Redaction runs on the way out, never on the way in (D-28): `viewEvent` for the stream, the session page and a non-admin export, cached per stored event and viewer kind; the stored event is never modified. It is a deny-list, default verbatim: sensitive key names and fragments (`SENSITIVE_KEYS`, `SENSITIVE_KEY_FRAGMENTS`, minus `SENSITIVE_KEY_EXCEPTIONS`), `GLOBAL_REDACTION_PATTERNS`, the tool's `redactionDenyList` on `tool.call.started` arguments, `MASKED_NUMBER_KEYS` and Luhn-valid 13-19 digit runs masked to the last four.
- In `raw`: headers whose folded name is sensitive (`authorization`, `cookie`, `x-api-key`, ...) show `[redacted]`; every address in a forwarding header (`IP_HEADERS`) and `remote_address` is cut to its prefix; sensitive query parameters are hidden; a JSON body is walked (per-tool deny-list on `tools/call` `params.arguments`, `code` of an OAuth token request), a form body by parameter, other text by pattern; `Signature`, `Signature-Input`, `Signature-Agent` and `_meta.progressToken` stay.
- Shown IP addresses are a `/24` (IPv6 `/48`) prefix; pairing codes hashed; results previewed at 2,048 chars; `rationale` and SQL verbatim (`rationale` capped at 8,192); one event at most 64,000 chars, strings 16,384, depth 12, 500 items, 200 keys.
- The cycle guard is ancestor-scoped: a sub-object shared by several siblings (the catalog's `rationale` property) is walked every time; only a reference back to an ancestor is stored as `[circular]`. The real catalog with one published descriptor per row round-trips unchanged inside the 64,000-char budget (29,355 chars with an empty `_meta`, 31,220 with it populated).
- Observer mode (admin cookie): arguments hidden (in the raw `tools/call` body too) and `rationale` cut to 80 chars, on the stream and on `/sessions/:xs/events`.
- Export (D-27): `pipeline.flush()` first, then pages of 1,000 rows (`EXPORT_PAGE_ROWS`) through `log.readAfter` with the stream's coarse SQL filter and `matchesScope` as the authority, or `ring.after` when the log is degraded. The upper bound is `log.maxId()` at the start, so a busy server cannot keep an export open. The loop yields with `setImmediate` between pages and waits for `drain`, so the event loop is never held and the log is never buffered whole. An export holds one slot of the stream budget (`XRAY_MAX_STREAMS`, and `XRAY_MAX_STREAMS_PER_LOGIN` or `XRAY_MAX_PUBLIC_STREAMS`) until it ends, and `shutdown()` cuts it like a stream. The bearer path calls `pairing.exchangeAdminToken` (constant time) and shares `RATE_LIMIT_IP_PAIR_FAILURES`.

## Invariants held here
- 11: viewers see only their login's grants, no session picker, arguments verbatim except the deny-list, IP as a prefix, observer mode redacted harder; the public lane is the one login anyone may read, and it holds only the anonymous calls of `/public/mcp` (D-26); the export follows the same scopes; for the admin it is the log as stored, the operator's copy (D-27, D-28).
- 13 (under 5): `emit` never throws and never blocks a producer; a broken log degrades the X-ray, never a tool call.
- 3 and 12: 20 s heartbeat, `Last-Event-ID` replay, every stream closed and the queue flushed inside `shutdown()`; the cookie is `Secure` + `HttpOnly`.
- 14: pairing and admin-bearer failures rate-limited; every collection bounded (log rows and bytes, ring bytes, write queue, subscriber queue, LRUs, stream caps, which also bound the exports).
- 7 and 13 (D-28): the log stores what arrived, a bearer token inside `raw.headers` included; no viewer surface shows a token, code, verifier, `txn` or viewer JWT (by header name, key name and the JWT pattern); only the admin export returns them.

## How to test
```
npx vitest run src/xray               # 117 tests, 10 files: redaction, emitter, log, pairing, read-model, api, sse, public-lane, export, raw-ingest
npx eslint src/xray
```
The tests build their own `JwtService` in `__tests__/harness.ts`; `test/import-boundaries.test.ts` forbids importing `src/auth` or `src/testing`.

## Known gaps
- An erase is permanent and immediate: there is no undo and no soft delete. Only an export taken beforehand keeps a copy.
- An export emits no event, like every other read route, so the log does not show who downloaded it.
- Nothing reads an export back in: the dashboard's `?fixture=1` replays only `test/fixtures/events.jsonl`, although an export uses the same line format.
- `GET /xray/api/sessions` has no cursor; the read model keeps at most 2,000 sessions.
- Pairing codes live in memory: a restart invalidates them (the viewer cookie does not).
- Only the pairing and admin exchanges are rate-limited; the read routes rely on the cookie and the stream caps, and the public lane's reads on nothing but the stream cap (they are in-memory reads of public data).
- A public reader's own `xray.viewer.connected` / `disconnected` land in the public lane, so every reader sees the others arrive.
- `?last_event_id=` is honoured by `sse.ts` but is absent from `XrayStreamQuery`, and the dashboard never sends it.
- `XRAY_ROUTES.assets` (`/xray/assets`) has no directory behind it; `public/` is flat.
- The bare-number mask is a Luhn filter, so about one random long number in ten is masked too.
- A `[circular]` marker is not listed in `redacted_fields`; only the payload shows it.
- The admin export holds live credentials as they arrived (bearer tokens valid up to 1 h, refresh tokens, cookies) and full IP addresses: treat a downloaded file as a secret (D-28).
- Redaction runs per viewer on every read, so a large `raw` body costs a walk each time it is shown; the stream renders an event once per viewer kind (a `WeakMap` cache), page reads walk again.
- Past `XRAY_MAX_LOG_BYTES` the trim emits no event; the log just starts later (`stats()` shows rows and bytes).
- `session.ended` belongs to `mcp`; `server.stopping.sessions_ended` only counts this boot's sessions.
