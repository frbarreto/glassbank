# auth

Status: done, contracts v0.10, wired in `src/composition.ts` (`createAuth({ config, personas: bankCore.personas, emitter, pairing })`; `auth.router` mounted at `/` and `auth.botAuth.middleware` in front of every route by `src/app.ts`). v0.10 (D-29): the Web Bot Auth check, deployed 2026-09-27 with `BOT_AUTH_CHALLENGE=advertise`.

## Purpose
The mock OAuth 2.1 authorization server (discovery, DCR, browser login and consent, `/token`, `/revoke`) and the resource-server verifier injected into `src/mcp`, on one origin.
Every token is an HS256 JWT signed with `OAUTH_SIGNING_KEY`; the only mutable state is a grant LRU, three expiring id sets and the DCR client table.

## Files
- `index.ts` - `createAuth`: JWT service, client store, six rate limiters, the `AuthRuntime`, the router; re-exports below.
- `routes.ts` - the Express router: discovery, `/register`, `/authorize`, `/login`, `/consent`, `/token`, `/revoke`; every `auth.*` emit lives here.
- `metadata.ts` - RFC 9728 PRM and RFC 8414 AS documents; every URL derives from the validated request `Host`.
- `jwt.ts` - `createJwtService` over `jose`: `sign(typ, claims, ttl)`, `verify(token, expectedTyp)`; `JwtError` reasons `malformed`/`invalid_signature`/`expired`/`wrong_typ`.
- `verify.ts` - `createAccessTokenVerifier`: `typ` must be `access`, `aud` in `acceptableAudiences(PUBLIC_HOSTS)`, grant not revoked; 401 otherwise.
- `clients.ts` - DCR store: bounded LRU (`MAX_DCR_CLIENTS`) over the SQLite table; A-12 reconstruction of an id neither layer knows.
- `client-db.ts` - the `clients` table at `AUTH_DB_PATH` (`better-sqlite3`, WAL); degrades to memory-only on an open failure or 5 consecutive errors.
- `store.ts` - `BoundedLru` and `ExpiringSet` (capacity 100 000, entries evicted at their token's `exp`).
- `rate-limit.ts` - fixed-window limiter over a 10 000-key bounded map; `clientIpOf`, `ipPrefixOf` (`/24`, `/48`).
- `events.ts` - `safeEmitter` (a throwing emitter never reaches an OAuth response) and the `auth.*` payload builders.
- `pages.ts` - server-rendered login, consent, consent-success and error pages; no framework, every value escaped.
- `personas.ts` - `createSpikePersonaDirectory`: the fallback `PersonaDirectory` when none is injected; unused once wired.
- `types.ts` - `AuthConfig`, `AuthRateLimitConfig`, `AuthDeps`, `GrantRecord`, `SpikeLogger`.
- `bot-auth.ts` - `createBotAuth` (D-29): parses `Signature-Input`, `Signature` and `Signature-Agent`, rebuilds the RFC 9421 signature base, fetches the agent's JWKS from `<agent>/.well-known/http-message-signatures-directory` (https only, public addresses only, checked in the socket's own lookup, no redirects, `BOT_AUTH_FETCH_TIMEOUT_MS`, 64 KiB, one fetch in flight per agent, `BOT_AUTH_MAX_DIRECTORIES` cached for `Cache-Control: max-age` or `BOT_AUTH_DIRECTORY_TTL_S`, `BOT_AUTH_MAX_FETCHES_PER_HOUR`), verifies Ed25519 against the key whose RFC 7638 thumbprint or `kid` is the `keyid`, checks `created` / `expires` (60 s skew) and remembers nonces until `expires`. The middleware stores the result with `setSignatureCheck` and, under `BOT_AUTH_CHALLENGE=advertise`, sets `Accept-Signature` on `/mcp` and `/public/mcp`. It never answers and never changes an answer.
- `structured-fields.ts` - the RFC 8941 dictionary, item and inner-list parser and serialiser the signature base needs.

## Public interface (`src/auth/index.ts`)
- `createAuth(deps: AuthDeps): Auth` - `{ router, verifyAccessToken, jwt, lookupClient, personas, grants, revokeGrant, newId, clients, botAuth, close }`; `botAuth` is `{ middleware, check(request), stats() }`.
- `createBotAuth`, `ACCEPT_SIGNATURE_VALUE`, `DIRECTORY_PATH`, `jwkThumbprint`, `signatureBase`, `verdictRank` (D-29).
- `DEFAULT_CONSENT_SUCCESS_REDIRECT_MS` (4000; `AuthDeps.consentSuccessRedirectMs: 0` disables the page); `pkceChallengeFor(verifier)` (PKCE S256, for tests and `test/e2e`); `createSpikePersonaDirectory`, `SEEDED_PERSONAS` (the fallback persona directory); `createClientPersistence`, `createNullClientPersistence` (the `AUTH_DB_PATH` table and its no-op stand-in).
- Types: `Auth`, `AuthConfig`, `AuthDeps`, `AuthRateLimitConfig`, `ClientPersistence`, `GrantRecord`, `SpikeLogger`, `SpikeLogRecord`.

## Consumes
- `AuthDeps`: `config: AuthConfig` (structural subset of `AppConfig`: `nodeEnv`, `publicBaseUrl`, `publicHosts`, `oauthSigningKey`, `featureFlags`, `maxDcrClients`, `authDbPath`, `cimdEnabled`, `rateLimits`, and the optional `botAuth*` knobs); optional `personas` (`bankCore.personas`), `emitter` (`xray.emitter`), `pairing` (`xray.pairing`), `consentSuccessRedirectMs`, `now`, `log`, `randomId`. Without `emitter` the block logs to stdout instead.
- `src/contracts`: `OAUTH_ROUTES`, `COOKIE_NAMES`, `TOKEN_LIFETIMES_SECONDS`, the JWT claim schemas, `JwtService`, `VerifyAccessToken`, the callback allowlist, the `PUBLIC_HOSTS` helpers, scopes, `PersonaDirectory`, `Pairing`, `XrayEmitter`. npm: `jose`, `better-sqlite3`, `express`.

## Routes (`routes.ts`; JSON and form bodies capped at 256 kb, their bytes kept by `keepRawBody` for the `raw` block of `http.request`, D-28; `OPTIONS` preflight on discovery, `/register`, `/token`, `/revoke`)
| Route | Answers |
|---|---|
| `GET /.well-known/oauth-protected-resource`, `.../oauth-protected-resource/mcp`, `.../oauth-authorization-server` | the discovery documents; `issuer`, `resource`, `aud` from the validated `Host` (invariant 4); CIMD never advertised (A-37) |
| `POST /register` | RFC 7591 DCR, public clients only (`token_endpoint_auth_method: none`), callback allowlist enforced (A-13); 201 or 400 |
| `GET` and `POST /authorize` | validates client, `redirect_uri`, PKCE S256, `resource`; sets `gb_csrf` (Strict, 10 min); renders the login page carrying a signed `txn` |
| `POST /login` | CSRF + `txn` check; seeded persona, new demo persona or pasted `per_` id; sets `login_id` cookie (Lax, 30 d); renders consent |
| `POST /consent` | CSRF + `txn` check; creates a grant or extends the browser's existing one (ADR-14); 302 with `code`, `state`, `iss`, or the success page |
| `POST /token` | `authorization_code` (PKCE, single-use code, `client_id` and `redirect_uri` bound) and `refresh_token` (rotation); an acceptable `resource` picks the `aud` |
| `POST /revoke` | RFC 7009, always 200; any token of a grant revokes the grant for its refresh lifetime |

## Tokens (`jwt.ts`, `src/contracts/auth.ts`)
Every JWT carries `jti` and `typ`; `verify` rejects a wrong `typ` (ADR-4). `code` 10 min, single use via the consumed set. `access` 1 h, prefixed `mockbank_user_tok_`, `aud` = canonical MCP URL. `refresh` 7 d read-only / 24 h read-write (A-26), rotated on every use. `txn` 10 min, the `/authorize` -> `/login` -> `/consent` state (invariant 15). `login` 30 d, the `login_id` cookie (ADR-14). `viewer` 24 h, minted by `src/xray` through this block's `jwt` instance.

## Rate limiters (`index.ts`; 429 + `Retry-After`)
| Knob | Key | Window | Charged on |
|---|---|---|---|
| `RATE_LIMIT_IP_REGISTER` | IP | 1 h | `POST /register` |
| `RATE_LIMIT_IP_AUTHORIZE` | IP | 15 min | `/authorize` |
| `RATE_LIMIT_IP_CONSENT` | IP | 15 min | `POST /login`, `POST /consent` |
| `RATE_LIMIT_IP_TOKEN` | IP | 15 min | `POST /token`, `POST /revoke` |
| `RATE_LIMIT_CLIENT_TOKEN` | `client_id` | 15 min | `POST /token`; only narrows the IP window |
| `RATE_LIMIT_LOGIN_GRANTS` | `login_id` | 24 h | `POST /consent` when a new grant is minted; HTML page + `auth.rejected {rate_limited}`; a grant extension is free |

## DCR persistence and the consent success page
- `clients` table at `AUTH_DB_PATH` (default `/tmp/auth.sqlite`): `/register` writes through and prunes to `4 x MAX_DCR_CLIENTS` rows; the LRU is warmed from it at boot and a miss is re-hydrated; only an id unknown to both layers is reconstructed with the claude.ai callback plus bare loopback URIs (A-12), never written back; survives a restart, not an instance replacement (A-25).
- `POST /consent` renders the success page instead of the 302 only when the form sent `show_success=1` (our consent form does; `test/e2e` and CLIs do not): persona id, granted scopes, a `BANK-XXXX-XXXX-XX` link (minted only when `xray:read` was granted; `target=_blank`), then a `<meta refresh>` or JS-countdown redirect; the page carries the code in its link, so it is sent `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.

## Events owned
All through `safeEmitter`; `client_id` is always the 12-char SHA-256 fingerprint; no token, code, verifier or `txn` ever appears in an `auth.*` event (invariant 7). The requests themselves - discovery, `/register` with its whole DCR body, `/authorize`, `/token`, refusals and 429s included - are recorded by the catch-all `http.request` (`mcp.httpObserver`, D-28), raw and uncorrelated. `auth.challenge`, `auth.verified`, `auth.stepup.requested` and the bearer-token `auth.rejected` belong to the `src/mcp` gate.
- `auth.client.registered` - `POST /register`: `client_id`, `client_name`, `redirect_uris`, `token_endpoint_auth_method`, `application_type`.
- `auth.client.reconstructed` - `/authorize` on an id unknown to LRU and table: `client_id`, `client_name: 'unknown (reconstructed)'`, `redirect_uris`, `reason: 'unknown_client_after_restart'`.
- `auth.login.created` - `POST /login` when a new `login_id` is minted: `login_id`, `persona_id`, `expires_at`, `persona_source` (`seeded`/`generated`/`recovered`), `shared_persona`.
- `auth.grant.created` - `POST /consent`, first grant for this login and client: `grant_id`, `parent_grant_id` (always `null`), `login_id`, `persona_id`, `scopes`, `auth_level`, `client_id`, `client_name`, `expires_at`, `shared_persona`.
- `auth.grant.updated` - `POST /consent` on an existing grant: `grant_id`, `login_id`, `persona_id`, `scopes`, `added_scopes`, `auth_level`, `client_id`, `reason` (`step_up` when a write scope was added, else `re_consent`).
- `auth.token.issued` - `/token` code exchange: `grant_id`, `login_id`, `persona_id`, `scopes`, `auth_level`, `client_id`, `aud`, `expires_at`, `refresh_expires_at`.
- `auth.token.refreshed` - `/token` refresh: as issued minus `aud`, plus `rotated_jti`.
- `auth.token.revoked` - `/revoke`: `grant_id`, `login_id`, `client_id`, `reason: 'revocation_request'`.
- `auth.directory.fetched` - every key-directory fetch of the Web Bot Auth check, failed ones and budget refusals included: `agent`, `url`, `outcome` (`ok`, `http_error`, `timeout`, `too_large`, `bad_json`, `blocked`, `network`, `rate_limited`), `status`, `key_count`, `duration_ms`, `ttl_s`, `error`; uncorrelated. The verdict itself is not an event: it is `http.request.signature`, on the record of the request it was computed from.
- `auth.rejected` - AS-side refusals only: `status`, `error`, `reason` (`malformed`, `no_access_token`, `invalid_signature`, `expired`, `wrong_typ`, `unknown_client`, `invalid_grant`, `revoked_grant`, `rate_limited`), `client_id`; correlation `login_id`/`persona_id`/`grant_id` when known.

## Invariants held here
- Invariant 4: every discovery URL, `iss`, `aud` and `resource` derives from the validated request `Host` (`canonicalBaseUrl`), `PUBLIC_BASE_URL` as fallback.
- Invariant 7: consumed codes, rotated refresh `jti`s and revoked grants live in `ExpiringSet`s evicted at `exp` (restart replay window accepted, A-11); no secret reaches a log line or an event.
- Invariant 12: every cookie `Secure` + `HttpOnly`; `close()` releases the SQLite handle from `GlassBank.shutdown()`. Invariant 14: the six limiters above; grant LRU 2000, `ExpiringSet` 100 000, limiter 10 000 keys, DCR LRU `MAX_DCR_CLIENTS`; `/register` keeps at most 10 URIs of 512 chars and clamps text fields to 256.
- Invariant 15: the `txn` JWT carries the flow; `gb_csrf` is `SameSite=Strict` double-submit (`login_id` is `Lax` so claude.ai's cross-site navigation keeps it, A-41); `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `no-store` on every browser page.
- Invariant 5 outranks 13: a throwing emitter, a broken SQLite table or a failing pairing service never fails an OAuth response. A-12, A-13: the callback allowlist plus mandatory PKCE S256 is the security boundary; `/authorize` never redirects to an unvalidated URI. A-37: `scopes_supported` follows `FEATURE_FLAGS`.

## How to test
- `npx vitest run src/auth` - 113 tests in 9 files (metadata, the OAuth walk, stores, ids, events, DCR persistence across a restart, success page, grant cap, and `bot-auth.test.ts`: the RFC 9421 B.2.6 Ed25519 vector, the RFC 8037 thumbprint, every verdict, the directory cache and budget, the invitation, the address guard).
- `npx vitest run src/__tests__/web-bot-auth.test.ts` - a real signed `initialize` through the whole graph with the key directory on loopback: `verified`, the directory fetch on the record, the identity on the session list, a tampered copy `invalid_signature` and answered all the same.
- `npm run e2e:oauth` - DCR -> authorize -> login -> consent -> token -> refresh -> replays against the real server.
- `bash infra/smoke.sh http://localhost:8080` - discovery on every `PUBLIC_HOSTS` entry, the 401 challenge, 30 `/register` calls without a 429.

## Known gaps
- `parent_grant_id` is always `null`: a re-consent extends the grant (ADR-14); the "new grant with a parent" branch does not exist.
- Deliberate deviations: an unrecognised `resource` falls back to the canonical MCP URL instead of `invalid_target` (RFC 8707) until a real client's value is observed; refresh-token reuse refuses the replay but does not revoke the family (a public demo's tokens leak from transcripts).
- The per-IP and per-client 429s emit no `auth.*` event, only the catch-all `http.request` with status 429 (D-28); the stdout logger is a no-op whenever an emitter is injected, so `auth.metadata_served`, `auth.client.rejected` and `auth.rate_limited` are never printed in a wired server. Only the grant cap emits `auth.rejected {rate_limited}`.
- `auth.client.registered` keeps five DCR fields; the whole registration body is in the `raw.body` of its `http.request`, not joined to it by any id. `auth.client.reconstructed {evicted_from_lru}` and `auth.token.revoked {grant_revoked, reuse_detected}` are contract values nothing emits.
- Web Bot Auth (D-29): only Ed25519 is checked (`alg` otherwise is `unsupported`); `;sf`, `;bs`, `;req`, `;tr` and `@query-param` components are `unsupported`; the directory's own signature (directory draft section 5.2) is not checked, so the key set is trusted as served over https. No real MCP client has been seen signing yet (`docs/observations/claude-ai.md`). The directory fetch passes the address check inside the socket's lookup, but an IP literal in the `Signature-Agent` URL is checked before the socket opens.
- Pairing codes live in `src/xray` memory, so a restart invalidates the link the success page printed.
- Grant LRU (2000) and `ExpiringSet` capacity (100 000) are constants, not env knobs; `ExpiringSet.forcedEvictions` above zero means a replay window re-opened inside `exp` and is surfaced nowhere. An unknown `client_id` costs one SQLite `SELECT` per `/authorize` or `lookupClient` call.
