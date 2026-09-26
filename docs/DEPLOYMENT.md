# Deployment

Operations for Glass Bank: one Cloud Run service `mcp-bank`, project `lake-fraude` (`520283334162`), region `us-central1`, URL `https://mcp-bank-520283334162.us-central1.run.app`. **Deployed on 2026-09-26** by the pipeline (section 15): Cloud Run reports `status.url` `https://mcp-bank-wdm7njj4pa-uc.a.run.app`, and `deploy.sh` added that host to `PUBLIC_HOSTS` next to the deterministic one (A-36), so both answer with the right OAuth identity. `make deploy` (the Cloud Build path) has never run. The demo can still run on the developer's Mac behind a cloudflared tunnel (section 14). gcloud flags live only in `infra/bootstrap.sh`, `infra/ci-bootstrap.sh`, `infra/deploy.sh` and `infra/smoke.sh`; each honours `DRY_RUN=1` (prints its commands, changes nothing, exits 0). Run that first, every time.

## 1. Topology

- One container (`infra/Dockerfile`, `node:22-slim`, `node dist/server.js` on `0.0.0.0:8080`, `public/` and `test/fixtures` included for the dashboard), built by Cloud Build (`infra/cloudbuild.yaml`) into the existing Artifact Registry repository `us-central1-docker.pkg.dev/lake-fraude/lake-fraude/mcp-bank:<tag>` (A-30).
- Exactly one instance (`--min-instances=1 --max-instances=1`): scratch SQLite databases, the event log and DCR table on memory-backed `/tmp`, the SSE fan-out and the consumed/revoked token sets are in-process, so a second instance silently splits state (CLAUDE.md invariant 1).
- `--no-cpu-throttling`: heartbeats, TTL eviction and fan-out run with no request in flight (invariant 2). `--timeout=3600`: the SSE stream ceiling; the dashboard reconnects with `Last-Event-ID` (invariant 3). `--concurrency=250`: each open SSE stream is one request (A-19). No `--use-http2`.
- Cloud Run IAM is public (`--allow-unauthenticated`); every end-user check is MCP OAuth inside the app (invariant 5, A-16). Secrets reach the container only through `--set-secrets` (invariant 12).
- Cost: about US$47/month at list price for 1 vCPU / 1 GiB always on (A-20); deleting the service (section 6) stops it.

## 2. One-time bootstrap - `infra/bootstrap.sh`

```
DRY_RUN=1 ./infra/bootstrap.sh    # print every command, create nothing
./infra/bootstrap.sh              # idempotent: every create is guarded by a describe (no make target)
```

Creates, always with `--project=lake-fraude`: the APIs `run`, `cloudbuild`, `artifactregistry` and `secretmanager` (`gcloud services enable`); the runtime service account `mcp-bank-run@lake-fraude.iam.gserviceaccount.com`; the secrets `mcp-bank-oauth-signing-key` (`openssl rand -base64 48`) and `mcp-bank-admin-token` (`openssl rand -hex 24`) with `--replication-policy=automatic --data-file=-`, values never printed and never overwritten; `roles/secretmanager.secretAccessor` on both for that service account. `ENABLE_SNAPSHOT_BUCKET=1` also creates `gs://lake-fraude-mcp-bank-snapshots` (`--uniform-bucket-level-access`, `roles/storage.objectAdmin`; D-6, off by default, nothing reads it yet). Knobs: `PROJECT_ID`, `REGION`, `SERVICE`, `EXPECT_ACCOUNT`. Ran for real on 2026-09-26.

```
DRY_RUN=1 ./infra/ci-bootstrap.sh # print every command, create nothing
./infra/ci-bootstrap.sh           # idempotent; needs bootstrap.sh first (the runtime service account)
```

`infra/ci-bootstrap.sh` (D-24) creates the deployer `mcp-bank-deployer@lake-fraude.iam.gserviceaccount.com` that GitHub Actions impersonates without a key: `roles/artifactregistry.writer` on the `lake-fraude` repository, `roles/run.admin` on the project (`--condition=None`), `roles/iam.serviceAccountUser` on `mcp-bank-run` only, and `roles/iam.workloadIdentityUser` for `principalSet://iam.googleapis.com/projects/520283334162/locations/global/workloadIdentityPools/github-pool/attribute.repository/frbarreto/glassbank`. The pool `github-pool` and its provider `github-provider` (attribute condition `assertion.repository_owner == 'frbarreto'`) pre-exist and are never modified. Bindings retry through IAM propagation. The script ends by printing the GitHub repository variables the pipeline reads: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `PUBLIC_BASE_URL` (set in section 15). Knobs: `GITHUB_REPO`, `WIF_POOL`, `WIF_PROVIDER`, plus those of `bootstrap.sh`. Ran for real on 2026-09-26.

## 3. Deploy - `infra/deploy.sh` (`make deploy`)

```
DRY_RUN=1 ./infra/deploy.sh                       # print the build and deploy commands, change nothing
./infra/deploy.sh                                 # build, deploy, correct PUBLIC_HOSTS, print the URLs
IMAGE_TAG=<tag> ./infra/deploy.sh                 # build and deploy under a chosen tag
SKIP_BUILD=1 IMAGE_TAG=<tag> ./infra/deploy.sh    # deploy only: reuse an image that already exists
```

In the cloud the pipeline (section 15) builds and pushes the image itself and then runs this script with `SKIP_BUILD=1 IMAGE_TAG=<sha12>` (D-24); the Cloud Build path below is the manual fallback from the Mac.

Steps, every one with `--project=lake-fraude --region=us-central1`:

1. Build: `gcloud builds submit --config=infra/cloudbuild.yaml --substitutions=_IMAGE=<image> .` (the Dockerfile lives under `infra/`, so `--tag` cannot be used).
2. Deploy: `gcloud run deploy mcp-bank --image=<image> --platform=managed --service-account=mcp-bank-run@lake-fraude.iam.gserviceaccount.com --allow-unauthenticated --ingress=all --port=8080 --cpu=1 --memory=1Gi --no-cpu-throttling --min-instances=1 --max-instances=1 --concurrency=250 --timeout=3600 --cpu-boost --execution-environment=gen2 --set-env-vars=... --set-secrets=OAUTH_SIGNING_KEY=mcp-bank-oauth-signing-key:latest,XRAY_ADMIN_TOKEN=mcp-bank-admin-token:latest`.
3. `--set-env-vars` carries exactly `NODE_ENV=production`, `PUBLIC_BASE_URL`, `PUBLIC_HOSTS`, `ORIGIN_POLICY`, `FEATURE_FLAGS`, `XRAY_DB_PATH`, `AUTH_DB_PATH` and `LOG_LEVEL`; each defaults as in section 11 (`PUBLIC_BASE_URL` and `PUBLIC_HOSTS` to the deterministic `run.app` form) and is overridable from the shell. `;` separates list values because `--set-env-vars` splits on commas. `ORIGIN_POLICY` must be `log-only` or `allowlist`. No other knob passes through.
4. Correction (A-36): `gcloud run services describe mcp-bank --format='value(status.url)'`; if `status.url` differs from `PUBLIC_BASE_URL`, `gcloud run services update mcp-bank --update-env-vars=PUBLIC_BASE_URL=<status.url>,PUBLIC_HOSTS=<list>;<status.host>`, so the PRM `resource` equals what users type on either hostname.
5. Prints the MCP endpoint (`<url>/mcp`, what users paste, no trailing slash), `/xray`, `/health`, the Origin policy and the image.
6. Image tag rule (invariant 12): `git rev-parse --short=12 HEAD`; a dirty tree gets `<sha>-dirty-<utc-timestamp>`; in a tree without git history the script warns and uses `ts-<utc-timestamp>`; `IMAGE_TAG` overrides all three.

**What a deploy costs users.** Any instance restart (deploy, rollback, Cloud Run's own restarts; A-15) loses the scratch tables, the event log and the DCR client table (both on memory-backed `/tmp`), the consumed/revoked token sets, and every bank write - card locks, transfers and audit entries live in the in-memory overlay, so a locked card is unlocked afterwards (invariant 16). Access and refresh tokens keep verifying (invariant 7), so clients continue without re-authenticating. The dashboard shows `server.started` and `get_current_user` returns the new `boot_id`. Two instances briefly coexist during the switchover; accepted.

## 4. Verify - `infra/smoke.sh [URL]` (`make smoke`)

`./infra/smoke.sh` targets `status.url` (falling back to the deterministic URL); `bash infra/smoke.sh http://localhost:8080` targets a local server and gives 23 passed, 0 failed, 3 skipped (checks 1, 6 and 7 need public DNS or gcloud). It runs every check, prints the active Origin policy and exits 1 if any check failed. Knobs: `SMOKE_BASE_URL`, `SMOKE_HOSTS` (`;`- or space-separated), `CURL_TIMEOUT` (15 s), `DISCOVERY_BUDGET_S` (10), `REGISTER_ATTEMPTS` (30), `DRY_RUN=1`.

| # | Asserts |
|---|---|
| 1 | The hostname resolves to public IPv4 A records only: no private or CGNAT space, not AAAA-only. |
| 2 | `HEAD` on `/mcp`, `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` never redirects to another host. |
| 3 | `POST /mcp` without a bearer answers 401 with `WWW-Authenticate: Bearer ... resource_metadata=...` (invariant 5). |
| 4 | On every host (the `status.url` host and the deterministic one, A-36): PRM `resource` == `<base>/mcp` and lists `<base>` in `authorization_servers`; root PRM 200; AS `issuer` == `<base>` and advertises `registration_endpoint`, `S256`, `authorization_code`, `refresh_token` and `none`. |
| 5 | `/health` answers 200 with `status: ok`; prints `boot_id`, `version` and `origin_policy`. Never `/healthz`: Google's front end intercepts exactly that path on Cloud Run and answers its own 404 (observed 2026-09-26); the app keeps it as an alias for local tooling. |
| 6 | `gcloud run services describe --format=yaml` shows minScale 1, maxScale 1, cpu-throttling false, timeoutSeconds 3600 and no HTTP/2. |
| 7 | `gcloud run services get-iam-policy` binds `allUsers` (public invoker, A-16). |
| 8 | Each of the three discovery documents answers inside `DISCOVERY_BUDGET_S`. |
| 9 | `REGISTER_ATTEMPTS` consecutive `POST /register` from one IP: no 429 and at least one success (A-43). |
| 10 | `/xray/` and `/xray/app.js` answer 200; `/xray/api/me` answers 401 or 403, never 404 or 200 (invariant 11). |

## 5. Roll back

A rollback moves traffic; the previous revision still exists. It restarts the instance, so it costs users what a deploy costs (section 3). A revision that never became ready never took traffic: fix the image and deploy again.

```
gcloud run revisions list --service=mcp-bank --region=us-central1
gcloud run services update-traffic mcp-bank --region=us-central1 --to-revisions=<revision>=100
./infra/smoke.sh
gcloud run services update-traffic mcp-bank --region=us-central1 --to-latest   # afterwards, back to the newest revision
```

## 6. Pause and resume

```
gcloud run services delete mcp-bank --region=us-central1   # stops the bill; secrets, IAM and the service account stay
./infra/deploy.sh && ./infra/smoke.sh                       # resume; the run.app URL derives from name + project number, so it is identical
```

`make pause` / `make resume` (`infra/pause.sh`) wrap these two commands; `resume` redeploys the newest image in Artifact Registry (or `RESUME_TAG`) and never rebuilds. There is no softer pause: `--min-instances=0` would let the instance idle out and stop the heartbeats, TTL eviction and fan-out (invariant 2). Resuming costs users what a deploy costs; they may need to reconnect once.

## 7. Rotate the signing key and the admin token

The signing key signs every JWT the server issues (`code`, `access`, `refresh`, `viewer`, `txn`, `login`; invariant 7), so rotating it invalidates all of them at once. The service reads version `:latest`, resolved at instance start; the redeploy is the restart.

```
openssl rand -base64 48 | gcloud secrets versions add mcp-bank-oauth-signing-key --data-file=-
openssl rand -hex 24    | gcloud secrets versions add mcp-bank-admin-token --data-file=-         # breaks only observer-mode dashboard sessions
SKIP_BUILD=1 IMAGE_TAG=<current-tag> ./infra/deploy.sh && ./infra/smoke.sh
gcloud secrets versions list mcp-bank-oauth-signing-key
gcloud secrets versions disable <old-version> --secret=mcp-bank-oauth-signing-key                # once the new key is confirmed
```

After a key rotation every client gets 401 and re-runs OAuth, every viewer cookie stops verifying (reopen the pairing link), and browser flows mid-`/authorize` restart. A connector that does not recover is removed and re-added in claude.ai (its auth settings cannot be edited); pasting the `per_` id on the login page keeps the generated dataset. `/health` shows a fresh `boot_id`. Announce it if anyone is watching a demo.

## 8. Switch the Origin policy

`ORIGIN_POLICY` (A-17, invariant 10; decided in `src/mcp/gate.ts`): an absent `Origin`, `https://claude.ai`, `https://claude.com` and the service's own base URL are always allowed. Any other value is allowed and recorded as `origin_decision: logged` under `log-only`, and rejected with reason `origin_rejected` under `allowlist`. The live value is `log-only`: no claude.ai client has connected yet, so what it sends as `Origin` is unobserved. `allowlist` is the production target, switched on after the observed values are in `docs/observations/claude-ai.md`. Over-strict Origin checking is a leading cause of `initialize` timeouts, so loosening back is the first move whenever connections break after a tightening. `/health` and `smoke.sh` both report the live value.

```
ORIGIN_POLICY=allowlist SKIP_BUILD=1 IMAGE_TAG=<current-tag> ./infra/deploy.sh   # tighten
ORIGIN_POLICY=log-only  SKIP_BUILD=1 IMAGE_TAG=<current-tag> ./infra/deploy.sh   # loosen
```

## 9. Tune the caps

Every cap and rate limit is an env var (section 11; invariant 14), but `deploy.sh` forwards only the eight variables of section 3, so in the cloud every other knob runs at its code default. To change one: `gcloud run services update mcp-bank --project=lake-fraude --region=us-central1 --update-env-vars=RATE_LIMIT_IP_REGISTER=200` (a new revision, so a restart). The next `deploy.sh` uses `--set-env-vars`, which replaces the whole set and reverts it; a knob that must persist needs a line in `deploy.sh` (block `infra`). Raise one knob at a time on a public 1 GiB singleton, watch `/health` and the Cloud Run memory metric, re-run `smoke.sh`. Never change `--min-instances`, `--max-instances`, `--no-cpu-throttling` or `--timeout` this way, and never add `--use-http2`.

| Symptom | Knob | Default | Direction |
|---|---|---|---|
| claude.ai users get 429 on connect | `RATE_LIMIT_IP_REGISTER` | 60/h | up - all of Anthropic shares `160.79.104.0/21` (A-43) |
| 429 on `/authorize` during OAuth | `RATE_LIMIT_IP_AUTHORIZE` | 300/15 min | up |
| 429 on `/token` or `/revoke` | `RATE_LIMIT_IP_TOKEN`, `RATE_LIMIT_CLIENT_TOKEN` | 300, 120 per 15 min | up |
| One conversation is throttled | `RATE_LIMIT_GRANT_TOOL_CALLS` | 120/min | up |
| Memory climbing, many scratch tables | `MAX_SCRATCH_DBS`, `MAX_TABLES_PER_GRANT`, `TABLE_TTL_MINUTES` | 200, 10, 30 | down |
| Memory climbing, many personas | `MAX_MATERIALISED_PERSONAS`, `MAX_PERSONA_OVERLAYS`, `PERSONA_OVERLAY_TTL_HOURS` | 200, 1000, 24 | down |
| Model queries time out too often | `QUERY_TIMEOUT_MS` | 2000 | up, carefully - CPU on a shared singleton |
| Results truncated too aggressively | `MAX_QUERY_ROWS` | 100 | up, carefully - rows land in the model's context |
| Event log growing | `XRAY_RETENTION_HOURS`, `XRAY_MAX_LOG_ROWS` | 72, 200000 | down |
| Registration table growing | `MAX_DCR_CLIENTS` | 1000 | down |
| Dashboard streams refused with 429 | `XRAY_MAX_STREAMS_PER_LOGIN`, `XRAY_MAX_STREAMS` | 4, 64 | up, inside `--concurrency=250` |

## 10. Diagnose a connector failure

Start with `./infra/smoke.sh` (failures name the invariant they broke), then `gcloud run services logs read mcp-bank --region=us-central1 --limit=200`.

| `smoke.sh` failure | Cause |
|---|---|
| 1 - private, CGNAT or AAAA-only address | the host is unreachable from Anthropic's runtime; `localhost` and dead tunnels look like this |
| 2 - redirect to another host | a cross-host redirect; Claude does not follow it |
| 3 - not 401, or no `resource_metadata` | the bearer gate answers `200 + isError` or a malformed challenge; the flow never starts |
| 4 - `resource` or `issuer` differs from the host queried | the PRM identity is wrong for one hostname (A-36); Claude caches discovery for about five minutes, so fix it, then remove and re-add the connector |
| 6 - an invariant line missing | something was deployed outside `infra/deploy.sh` |
| 7 - `allUsers` not bound | Cloud Run IAM is not public; claude.ai gets a Google 403 before the app is reached |
| 8 - over the 10 s budget | discovery too slow; Claude gives up |
| 9 - any 429 | the per-IP limit locks out Anthropic's shared egress (section 9) |
| 10 - `/xray/*` 404 | `public/` missing from the image (`infra/Dockerfile`) or the X-ray router not mounted |

A claude.ai failure id starts with `ofid_` (in the error toast URL). Record every new observation in `docs/observations/claude-ai.md`. Reproduce locally first: `docker compose -f infra/local/docker-compose.yml up --build`, then `bash infra/smoke.sh http://localhost:8080`, then a tunnel (section 14).

## 11. Environment

Parsed once in `src/config/index.ts` (zod; one `ConfigError` lists every problem); `.env.example` carries exactly the same 38 names and a test asserts the parity. Defaults below are the code's; `.env.example` differs only where noted. `*` = set by `deploy.sh`; `(secret)` = injected by `--set-secrets`; `PORT` is injected by Cloud Run.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` * | `development` | `development`, `test` or `production`; production refuses both dev-only secret values below |
| `PORT` | `8080` | listen port, always on `0.0.0.0` (invariant 12) |
| `LOG_LEVEL` * | `info` | `debug`, `info`, `warn` or `error` |
| `PUBLIC_BASE_URL` * | `http://localhost:8080` | fallback canonical base URL when the request `Host` is not in `PUBLIC_HOSTS`; also pairing URLs |
| `PUBLIC_HOSTS` * | empty (`.env.example`: `localhost:8080`) | `;`-separated hostnames the service answers on; the base URL's host is always added; PRM `resource`, issuer and `aud` follow a listed `Host` (invariant 4, A-36) |
| `ORIGIN_POLICY` * | `log-only` | `log-only` or `allowlist` (section 8) |
| `FEATURE_FLAGS` * | `writes;transfers` | `;`-separated flags; write tools are listed only while their flag is on (D-3) |
| `OAUTH_SIGNING_KEY` (secret) | `dev-only-insecure-signing-key-change-me-32+` | HS256 key for every JWT, at least 32 chars; the default is refused in production |
| `XRAY_ADMIN_TOKEN` (secret) | unset (`.env.example`: `dev-only-insecure-admin-token-change-me-32+`) | observer-mode token, at least 32 chars; unset disables observer mode; the `.env.example` value is refused in production |
| `XRAY_DB_PATH` * | `/tmp/xray.sqlite` | event-log SQLite file (WAL); `/tmp` is memory-backed on Cloud Run |
| `XRAY_RETENTION_HOURS` | `72` | events older than this are deleted |
| `XRAY_MAX_LOG_ROWS` | `200000` | hard row cap on the event log |
| `XS_IDLE_GAP_MINUTES` | `15` | silence after which a grant's next request starts a new X-ray session `xs` |
| `XRAY_MAX_STREAMS_PER_LOGIN` | `4` | concurrent dashboard SSE streams per login (then 429 + `Retry-After`) |
| `XRAY_MAX_STREAMS` | `64` | concurrent dashboard SSE streams per process |
| `AUTH_DB_PATH` * | `/tmp/auth.sqlite` | SQLite file for the DCR client table |
| `MAX_DCR_CLIENTS` | `1000` | bounded LRU of registered OAuth clients |
| `CIMD_ENABLED` | `false` | reserved for `client_id_metadata_document_supported`; parsed but read by no block yet (A-37) |
| `MAX_TABLES_PER_GRANT` | `10` | scratch tables one grant may hold |
| `MAX_SCRATCH_DBS` | `200` | scratch `:memory:` databases before LRU eviction |
| `MAX_QUERY_ROWS` | `100` | row cap on an `execute_query` result |
| `TABLE_TTL_MINUTES` | `30` | idle time before a scratch table is evicted |
| `QUERY_TIMEOUT_MS` | `2000` | budget for one model-authored query; the forked SQL runner is `SIGKILL`ed at it (invariant 8, ADR-9) |
| `MAX_CONCURRENT_ETL_OPS` | `2` | ETL operations running at once |
| `ETL_WORKER_POOL_SIZE` | `4` | forked SQL runner processes in the pool |
| `MAX_QUERY_TIMEOUTS` | `3` | hard timeouts one grant may cause before its queries are refused up front |
| `MAX_MATERIALISED_PERSONAS` | `200` | bounded LRU of materialised personas |
| `MAX_PERSONA_OVERLAYS` | `1000` | bounded LRU of per-login copy-on-write overlays (invariant 16, ADR-15) |
| `PERSONA_OVERLAY_TTL_HOURS` | `24` | idle time before an overlay resets to the shared seed |
| `RATE_LIMIT_IP_REGISTER` | `60` | `POST /register` per IP per hour |
| `RATE_LIMIT_IP_AUTHORIZE` | `300` | `/authorize` per IP per 15 min |
| `RATE_LIMIT_IP_TOKEN` | `300` | `/token` and `/revoke` per IP per 15 min (the unforgeable half: `client_id` comes from the body) |
| `RATE_LIMIT_IP_CONSENT` | `60` | `POST /consent` per IP per 15 min |
| `RATE_LIMIT_IP_PAIR_FAILURES` | `5` | failed pairing-code exchanges per IP per minute |
| `RATE_LIMIT_CLIENT_TOKEN` | `120` | `/token` per `client_id` or `grant_id` per 15 min |
| `RATE_LIMIT_GRANT_TOOL_CALLS` | `120` | `tools/call` per grant per minute |
| `RATE_LIMIT_LOGIN_GRANTS` | `20` | new grants per `login_id` per day; a step-up that extends a grant is free (ADR-14) |
| `SNAPSHOT_BUCKET` | unset | GCS bucket for event-log snapshots (D-6); parsed, read by nothing yet |

## 12. VM alternative

`infra/vm/` holds a Caddy-plus-app `docker-compose.yml` and two Caddyfiles (a `nip.io` hostname, or a Let's Encrypt IP-address certificate) so the same image can run on a Compute Engine VM; `infra/vm/README.md` has the gcloud, host and compose steps and the trade-offs. None of it has been run: D-2 chose Cloud Run, D-7 keeps `laf-ingestor` terminated, and `.dockerignore` excludes the directory from the image.

## 13. Adding the connector in claude.ai

1. Customize > Connectors > Add custom connector. Name `Glass Bank`; URL exactly as `deploy.sh` printed it (`.../mcp`, no trailing slash); Authentication **Always required**; OAuth client **No client ID, register automatically** (DCR). Use an individual Free/Pro/Max account for the first test (A-34). Auth settings cannot be edited afterwards: remove and re-add instead.
2. The popup is the mock login: pick a shared persona, paste a `per_` id, or **Create a demo customer**; it sets the 30-day `login_id` cookie.
3. Consent lists the scopes: read scopes pre-checked, `cards:write` and `transfers:write` unchecked. A later 403 `insufficient_scope` re-opens consent, and the same browser extends the same grant (invariant 15).
4. Enable the connector in a chat and ask for balances; "show me what is happening behind the scenes" calls `xray_get_session_link`, which returns `<url>/xray/s/BANK-XXXX-XXXX-XX`, bound to the login rather than one grant (invariant 11).
5. Claude Code: `claude mcp add --transport http glass-bank <url>/mcp`, then `/mcp` to log in.
6. No claude.ai or Claude Code client has connected yet; Codex and ChatGPT have, through the tunnel (`docs/observations/claude-ai.md`).

## 14. Local testing through a tunnel

`infra/local/cloudflared.md`: `cloudflared tunnel --url http://localhost:8080`, restart the server with `PUBLIC_BASE_URL=https://<tunnel>.trycloudflare.com PUBLIC_HOSTS='<tunnel>.trycloudflare.com;localhost:8080'` (listing `localhost:8080` keeps the local dashboard working), run `bash infra/smoke.sh https://<tunnel>.trycloudflare.com`, then add the tunnel URL in claude.ai exactly as in section 13.

## 15. CI/CD - `.github/workflows/pipeline.yml`

GitHub Actions on https://github.com/frbarreto/glassbank (D-21 to D-24). Keyless: each job exchanges its GitHub OIDC token through the Workload Identity provider for `mcp-bank-deployer` (section 2, `infra/ci-bootstrap.sh`); nothing secret is stored in GitHub. Repository variables: `GCP_PROJECT_ID`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`, `PUBLIC_BASE_URL` (unset until the hostname is mapped, D-25).

| Trigger | Jobs | Deploys |
|---|---|---|
| push to `main` | `check` (`npm run check`), `e2e` (`npm run build && npm run e2e`), `image` (build `infra/Dockerfile`, boot it with `NODE_ENV=production` and random secrets, `infra/smoke.sh http://localhost:8080`, stop it and assert exit 0, push `mcp-bank:<sha12>`), then `deploy` | yes |
| `pull_request` | `check`, `e2e`, `image` without the push | no |
| `workflow_dispatch` | `image_tag` empty: as a push; `image_tag=<sha12>`: `deploy` only (the rollback, section 5); `origin_policy` selects `log-only` or `allowlist` (section 8) | yes, from `main` only |

`deploy` runs `SKIP_BUILD=1 IMAGE_TAG=<sha12> ORIGIN_POLICY=<input> PUBLIC_BASE_URL=<variable> ./infra/deploy.sh`, then `./infra/smoke.sh` (with `SMOKE_BASE_URL` and `SMOKE_HOSTS` covering the custom hostname and the `run.app` host once `PUBLIC_BASE_URL` is set), and writes the deploy summary and the smoke counts to the job summary. `<sha12>` is the value `deploy.sh` derives locally, so `make deploy` of the same commit reuses the tag. Runs on `main` queue behind each other; superseded pull-request runs are cancelled. Fork pull requests get no OIDC token, so they can never deploy.

## 16. Custom hostname - `infra/domain.sh`

`glassbank-mcp.abovethefog.app` (D-25) is a Cloud Run domain mapping on the service (a preview feature; free; managed certificate) plus one CNAME in the Cloud DNS zone `abovethefog-app` of project `abovethefog`, where the domain lives. The zone's apex and `www` point at Firebase Hosting and are never touched; the script refuses them. The domain is verified for the deploying Google account (`gcloud domains list-user-verified`). Needs the gcloud beta component.

```
DRY_RUN=1 ./infra/domain.sh      # print the two commands
./infra/domain.sh                # create the mapping and the record if missing, then print the status
./infra/domain.sh status         # certificate provisioning, the record, what the name resolves to
```

Ran on 2026-09-26 19:23 UTC: mapping created (`DomainRoutable: True`), `glassbank-mcp.abovethefog.app. CNAME ghs.googlehosted.com.` created, certificate pending (Cloud Run re-checks DNS on an hourly interval). Once `https://glassbank-mcp.abovethefog.app/health` answers: `gh variable set PUBLIC_BASE_URL --repo frbarreto/glassbank --body "https://glassbank-mcp.abovethefog.app"`, then redeploy (a push, or a dispatch with the current tag), so `deploy.sh` puts both hostnames in `PUBLIC_HOSTS` and the pairing links use the hostname (invariant 4, A-36). The `run.app` URL keeps working. `make pause` keeps the mapping; after `make resume`, `./infra/domain.sh status` shows whether it re-attached.

## 17. Uptime check and alert - `infra/observe.sh`

Cloud Monitoring, inside the free tier: an email notification channel "Glass Bank alerts" (the address is the active gcloud account, passed on the command line and never written to the repository), the uptime check `glass-bank-health` (GET `https://mcp-bank-520283334162.us-central1.run.app/health` every 5 minutes, 10 s timeout, expects 200 and `"status":"ok"`), and the alert policy "Glass Bank /health down" (an incident plus an email after 10 minutes of failures). Idempotent; `DRY_RUN=1` prints. Created on 2026-09-26. `make pause` trips it by design: silence it meanwhile with `gcloud monitoring policies update <policy name> --project=lake-fraude --no-enabled` and re-enable it after `make resume`. Console: https://console.cloud.google.com/monitoring/uptime?project=lake-fraude
