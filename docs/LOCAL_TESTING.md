# Local testing: how to run Glass Bank and see what it does

Everything runs on the Mac with no cloud account, in the order below; every command and response was
run against the built artefact (`node dist/server.js`). If 8080 is taken, use another port (section 3).

## 1. Prerequisites

- Node >= 22 (`.nvmrc` is 22; 23.10 on this Mac works) and npm: `npm ci`.
- Docker only for section 9, Google Chrome only for `public/_dev/*.mjs`, cloudflared only for section 10.

## 2. Prove the build

| Command | Expected |
|---|---|
| `npm run check` | tsc clean, eslint clean, 1296 tests in 60 files (includes `public/__tests__`) |
| `npm run build` | `tsc -p tsconfig.build.json` writes `dist/server.js`, what the container runs |
| `npm run e2e` | `e2e:oauth` 55 checks (port 8899) + `e2e:session` 96 checks (port 8897) = 151; each spawns its own `tsx src/server.ts` with private SQLite files |
| `npm run e2e:dashboard` | 28 checks (port 8095, boots `dist/server.js`, so build first): the whole OAuth walk, nine tool calls including a write, then headless Chrome paired to that session asserting the chain (one line per call, a call opening into REQUEST / INSIDE / RESPONSE, every party named), the persona card and the erase. Needs Chrome; `SHOTS=<dir>` also writes screenshots |
| `npm run smoke:worker-sqlite` | 6/6, exit 0: `worker.terminate()` cannot stop native SQLite, the forked runner plus `SIGKILL` can (ADR-9, A-39) |
| `npx vitest run src/<block>` | one block against `src/testing/fakes.ts`; `npx vitest run public` is the 280 dashboard tests |

## 3. Start the server

```bash
npm run dev                  # tsx watch src/server.ts
npm run build && npm start   # node dist/server.js - exactly what the container runs
PORT=8093 PUBLIC_BASE_URL=http://localhost:8093 PUBLIC_HOSTS=localhost:8093 XRAY_DB_PATH=/tmp/lt-xray.sqlite AUTH_DB_PATH=/tmp/lt-auth.sqlite npm run dev   # another port, private state
```

Both listen on `http://localhost:8080`. No `.env` is needed: every knob in `.env.example` has a
development default (production refuses the default `OAUTH_SIGNING_KEY`). The first stdout line is
`{"event":"server.started","boot_id":"boot_...","origin_policy":"log-only","feature_flags":["writes","transfers"],...}`.

## 4. Look at it from outside

```bash
curl -s http://localhost:8080/ | grep -c '/mcp'   # the landing page names the MCP URL
curl -s http://localhost:8080/health
# {"status":"ok","boot_id":"boot_b710a378-...","version":"0.1.0","origin_policy":"log-only","uptime_s":21}
curl -s -i -X POST http://localhost:8080/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
# HTTP/1.1 401 Unauthorized
# WWW-Authenticate: Bearer resource_metadata="http://localhost:8080/.well-known/oauth-protected-resource/mcp", scope="profile accounts:read transactions:read cards:read transfers:read bills:read payees:read xray:read"
# {"detail":"No access token provided"}
curl -s http://localhost:8080/.well-known/oauth-protected-resource/mcp
# {"resource":"http://localhost:8080/mcp","authorization_servers":["http://localhost:8080"],"scopes_supported":[<the 10 scopes>],"bearer_methods_supported":["header"],...}
curl -s http://localhost:8080/.well-known/oauth-authorization-server
# {"issuer":"http://localhost:8080","authorization_endpoint":".../authorize","token_endpoint":".../token","registration_endpoint":".../register","revocation_endpoint":".../revoke","code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],...}
```

The 401 with `WWW-Authenticate` starts OAuth in every MCP client; a `200` here breaks every connector
(CLAUDE.md invariant 5). `resource` and `issuer` follow the request `Host` only when it is listed in
`PUBLIC_HOSTS`; any other host, a forged `Host: evil.example.com` included, gets `PUBLIC_BASE_URL`
(invariant 4). `GET` and `DELETE /mcp` answer 405 (invariant 6).

## 5. Log in

```bash
npm run login              # read-only grant: write tools answer the 403 step-up
npm run login -- --write   # also requests cards:write and transfers:write
```

`scripts/local-login.mjs` checks `/health`, opens a loopback listener on a random port
(`CALLBACK_PORT` fixes it), registers a public native client at `/register`, prints the `/authorize`
URL to open, waits for the callback, exchanges the code with PKCE S256 and writes
`.glass-bank-token.json` (gitignored: `base_url`, `client_id`, `access_token`, `refresh_token`,
`scope`, `expires_in`, `token_type`). `BASE_URL=http://localhost:8093 npm run login` targets another
server. Every run registers a new client, so a `--write` run mints a second grant of the same login;
only a re-consent for the same `client_id` from the same browser extends the grant (ADR-14).

In the browser: the login page (Ava Stone and Noah Reid, retail; Harbor Supply Co., business;
"Create a demo customer"; a field for a `per_` id), the consent page (read scopes pre-checked, write
scopes unchecked; unticking a read scope hides the matching tools), then the success page with the
persona id and the dashboard pairing link, which redirects to the callback.

Then define one helper (protocol versions `2025-06-18` and `2025-11-25` are both accepted):

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('.glass-bank-token.json'))['access_token'])")
call() { curl -s -X POST http://localhost:8080/mcp -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'mcp-protocol-version: 2025-06-18' -d "$1"; }
```

Responses are JSON-RPC: comments show `result.content[0].text`; `result.structuredContent` has the same facts as JSON; `result.isError: true` marks a tool error.

## 6. The read flow: load -> process -> query -> clear

```bash
call '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # 17 tools: published JSON schema, annotations, _meta
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_current_user","arguments":{"rationale":"showing the user who they are"}}}'
# You are connected to Glass Bank as Ava Stone (per_ava_stone), a retail customer. ...
# Authorization level: read_only. Scopes: profile accounts:read ... xray:read.
# X-ray session: xs_mttx14mu1. Server boot id: boot_b710a378-... (a different boot id means the server restarted ...)
call '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"load_accounts","arguments":{"rationale":"the user asked for their balances"}}}'
# Stored data in memory database with table name: load_accounts_448c1578030340fea59327cb6ba95da7.
#  Available columns are: id, name, account_type, currency, balance_cents, available_balance_cents, credit_limit_cents, account_number_last4, routing_number_last4, status, opened_at
TABLE=load_accounts_448c1578030340fea59327cb6ba95da7   # yours differs
call "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"process_data\",\"arguments\":{\"table_name\":\"$TABLE\",\"cols\":[\"id\",\"name\",\"account_type\",\"status\"],\"rationale\":\"building a SQL table\"}}}"
# Table load_accounts_448c... created      structuredContent {"rows":4,"columns_selected":["id","name","account_type","status"]}
call "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"execute_query\",\"arguments\":{\"table_name\":\"$TABLE\",\"query\":\"SELECT \\\"name\\\", \\\"account_type\\\", \\\"status\\\" FROM \\\"$TABLE\\\" ORDER BY \\\"name\\\"\",\"rationale\":\"listing the accounts\"}}}"
# [{"name":"Everyday Checking","account_type":"checking","status":"open"},{"name":"Everyday Rewards Card","account_type":"credit_card","status":"open"},...]
call "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"clear_table\",\"arguments\":{\"table_name\":\"$TABLE\",\"rationale\":\"the analysis is finished\"}}}"
# Table load_accounts_448c... cleared
```

`load_*` never returns rows; amounts are integer USD cents (D-1); persona data is deterministic from
its seed. The model writes the SQL, so the guard treats it as hostile (invariant 8): `ATTACH DATABASE
'/tmp/evil.db' AS evil` answers `isError: true` with `Ran into an error: the statement keyword
"ATTACH" is not allowed in a scratch query. ...`, as do `UPDATE`, `PRAGMA`, `VACUUM` and
multi-statement input; a query that never returns is `SIGKILL`ed at `QUERY_TIMEOUT_MS`.
`get_tool_availability` under a read-only grant reports `lock_or_unlock_card: listed but unavailable -
missing_scopes (still needs cards:write)`: write tools stay listed on purpose. A call without
`rationale` still succeeds and emits `intent.missing` (ADR-8).

## 7. The write flow

The step-up, with the read-only token:

```bash
curl -s -i -X POST http://localhost:8080/mcp -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"lock_or_unlock_card","arguments":{"card_id":"card_ava_stone_001","action":"lock","rationale":"user asked to lock the card"}}}'
# HTTP/1.1 403 Forbidden
# WWW-Authenticate: Bearer error="insufficient_scope", scope="cards:write transfers:write", resource_metadata="http://localhost:8080/.well-known/oauth-protected-resource/mcp"
# {"error":"insufficient_scope","error_description":"The tool lock_or_unlock_card needs cards:write, which this connection has not been granted. ..."}
```

A real client re-opens consent for those scopes. Here: `npm run login -- --write`, re-read `TOKEN`, then:

```bash
call '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"lock_or_unlock_card","arguments":{"card_id":"card_ava_stone_001","action":"lock","rationale":"the user said they lost the card"}}}'
# Card ending 0800 (card_ava_stone_001) is now locked. An audit entry was appended (aud_a000001).
call '{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"create_transfer","arguments":{"from_account_id":"acc_ava_stone_001","to":{"payee_id":"pay_ava_stone_004"},"amount":125000,"currency":"USD","memo":"contractor deposit","rationale":"the user asked to send 1,250 dollars to a contractor"}}}'
# Preview only: no money has moved and nothing is scheduled yet.
# From acc_ava_stone_001 to payee pay_ava_stone_004 over the wire rail.
# Amount: 125000 cents ($1,250.00) / Fee: 2500 cents ($25.00) / Total: 127500 cents ($1,275.00)
# ... call create_transfer again with the same arguments plus confirm set to true and expected_total_amount set to 127500. The preview expires at <15 minutes from now>.
call '{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"create_transfer","arguments":{"from_account_id":"acc_ava_stone_001","to":{"payee_id":"pay_ava_stone_004"},"amount":125000,"currency":"USD","memo":"contractor deposit","confirm":true,"expected_total_amount":127500,"rationale":"the user approved the preview"}}}'
# Transfer tr_c000005 is completed. Sent 125000 cents ($1,250.00) from acc_ava_stone_001 to payee pay_ava_stone_004 over the wire rail.
# Fee: 2500 cents ($25.00). Total taken from the account: 127500 cents ($1,275.00). An audit entry was appended (aud_a000004).
```

Repeat the confirm and you get `Ran into an error: no open preview matches this transfer: ...`:
previews are single-use, expire after 15 minutes and are bound to the login. Writes live in a
per-login overlay over the shared seed (ADR-15) and do not survive a restart (A-15): compare `boot_id`.

## 8. Watch your own session

```bash
call '{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"xray_get_session_link","arguments":{"rationale":"the user asked to watch what the connector is doing"}}}'
# Open this to watch what happens behind the scenes: http://localhost:8080/xray/s/BANK-NPF9-R5KG-R3
# Pairing code: BANK-NPF9-R5KG-R3 (type it at http://localhost:8080/xray if the link is not clickable).
# The link covers every session of this login, works more than once and expires at <24 h from now>.
```

Open the link in a browser: it answers `302 /xray/` and sets the `xray_viewer` cookie (24 h,
`HttpOnly; Secure`, bound to the login, never to one grant). The page shows every request, tool call
with its arguments and rationale, SQL statement, bank operation and audit id, live over SSE. The same
data over HTTP:

```bash
CODE=BANK-NPF9-R5KG-R3
curl -s -c /tmp/xray.cookies "http://localhost:8080/xray/s/$CODE" > /dev/null
curl -s -b /tmp/xray.cookies http://localhost:8080/xray/api/me         # viewer_kind, login_id, grant_ids, persona
curl -s -b /tmp/xray.cookies http://localhost:8080/xray/api/sessions   # {"data":[{"xs":"xs_...","grant_id":"grt_...","call_count":3,"boot_id":"boot_...",...}],"page":...}
XS=$(curl -s -b /tmp/xray.cookies http://localhost:8080/xray/api/sessions | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['xs'])")
curl -s -b /tmp/xray.cookies "http://localhost:8080/xray/api/sessions/$XS/events?limit=500"   # session.started, http.request, tool.call.*, intent.*, bank.op ...
curl -s -N -b /tmp/xray.cookies -H 'accept: text/event-stream' "http://localhost:8080/xray/api/stream?login=me"   # retry: 2000, then event: xray / id: / data: lines
```

Without the cookie every `/xray/api/*` route answers 401 and there is no session picker (invariant
11); `POST /xray/api/pair {"code":...}` is the same exchange for the code box, and `POST /xray/api/admin
{"token":...}` with `XRAY_ADMIN_TOKEN` opens the redacted observer view. `http://localhost:8080/xray/?fixture=1`
replays `test/fixtures/events.jsonl` with no server traffic (`&rate=100` speeds it up). Dashboard
checks: `npx vitest run public` (280 tests) and `node public/_dev/check-console.mjs` (headless Chrome
on an auto-assigned DevTools port, `CDP_PORT` pins it; interrupting the run still kills Chrome and
removes its profile).

## 9. Run the container

```bash
docker compose -f infra/local/docker-compose.yml up --build   # infra/Dockerfile, NODE_ENV=production, port ${HOST_PORT:-8080}
bash infra/smoke.sh http://localhost:8080                     # 24 passed, 0 failed, 3 skipped (checks 1, 6, 7 need public DNS or gcloud)
docker compose -f infra/local/docker-compose.yml down -v      # also drops the SQLite files on the mcp-bank-data volume
```

## 10. Reach it from the internet

claude.ai, Claude Desktop and ChatGPT connect from their own servers, so `localhost` is never reachable:
[../infra/local/cloudflared.md](../infra/local/cloudflared.md) has the quick tunnel and the `PUBLIC_BASE_URL` / `PUBLIC_HOSTS` restart it needs.
Its sections 4 and 6 cover the Mac DNS cache, the new hostname per run and what a reboot wipes.

## 11. Connect a real MCP client

The URL a client gets always ends in `/mcp`, never `/xray` (the dashboard is for humans).

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:8080/mcp --method tools/list
# {"error":{"code":"auth_required","message":"Interactive OAuth requires a TTY on stdin or stderr (or MCP_AUTO_OPEN_ENABLED=true). ..."}}
npx @modelcontextprotocol/inspector --cli --transport http --server-url http://localhost:8080/mcp \
  --header "Authorization: Bearer $TOKEN" --method tools/list        # the 17 tools as JSON
npx @modelcontextprotocol/inspector --transport http --server-url http://localhost:8080/mcp   # browser UI; it runs the login pages itself
claude mcp add --transport http glass-bank http://localhost:8080/mcp   # Claude Code; then /mcp inside Claude Code to log in
```

Codex (it has connected through a tunnel; it registers a fresh client per connection, sends
`initialize` twice, and calls `tools/list` and `resources/list`): in `~/.codex/config.toml` add
`[mcp_servers.glass-bank]` with `url = "https://<tunnel>.trycloudflare.com/mcp"`, then `codex mcp login glass-bank`.

## 12. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A client never finishes logging in | `POST /mcp` is not a 401 with `WWW-Authenticate`, or the PRM `resource` differs from the URL typed into the client | section 4; set `PUBLIC_BASE_URL` and `PUBLIC_HOSTS` to the host the client uses |
| `403 insufficient_scope` on a write tool | read-only grant | `npm run login -- --write`; a real client re-consents |
| A tool is missing from `tools/list` | a read scope was unticked, or `FEATURE_FLAGS` lacks `writes` / `transfers` | `get_tool_availability` names the reason |
| A locked card is active again, a transfer is gone | the server restarted; overlays are in memory (A-15) | compare `boot_id` from `get_current_user` or the session list |
| The pairing link is refused | codes live in memory and expire after 24 h; a restart drops them | call `xray_get_session_link` again; the viewer cookie survives |
| `execute_query` says the table does not exist | idle eviction after `TABLE_TTL_MINUTES` (30) or a `QUERY_TIMEOUT_MS` (2000) kill, both `etl.*` events | run `load_*` again |
| 429 from `/register`, `/authorize`, `/token`, `tools/call` or pairing | a `RATE_LIMIT_*` knob (invariant 14) | wait for the window or raise the knob locally |
| `EADDRINUSE` on 8080 | another instance owns the port | start on another port (section 3) |
| Inspector `--cli` reports `auth_required` | no TTY for the browser leg | pass `--header "Authorization: Bearer $TOKEN"` or set `MCP_AUTO_OPEN_ENABLED=true` |
| Anything else | | the dashboard first, then the server log: one `http.request` JSON line per request with method, path, status, host, user agent, `mcp_protocol_version_header`, `rpc_methods`, `rate_limited` and `origin_decision` |
