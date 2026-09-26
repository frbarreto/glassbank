# infra

Status: scripts complete and verified locally; **nothing is deployed** - `bootstrap.sh` and `deploy.sh` have only ever run with `DRY_RUN=1`, no gcloud resource exists, and the demo runs on the developer's Mac behind a cloudflared quick tunnel.

## Purpose
Build, run, deploy and verify the one container: locally first (`docker compose`, cloudflared), then the Cloud Run service `mcp-bank` in `lake-fraude` / `us-central1` (D-2).
The gcloud flags live in `deploy.sh` and nowhere else.

## Files
| File | What it does |
|---|---|
| `infra/Dockerfile` | Multi-stage `node:22-slim`: `npm ci`, `npm run build`, `npm prune --omit=dev`; the runtime stage copies `dist/`, `node_modules/`, `package.json`, `public/` and `test/fixtures` (the target of the `public/fixtures` symlink); user `node`, `PORT=8080`, `CMD node dist/server.js`. |
| `infra/cloudbuild.yaml` | One `docker build -f infra/Dockerfile -t $_IMAGE .` step and `images: [$_IMAGE]`; never deploys. |
| `infra/bootstrap.sh` | One-time: enable the APIs, create the `mcp-bank-run` service account, Secret Manager `mcp-bank-oauth-signing-key` (`openssl rand -base64 48`) and `mcp-bank-admin-token` (`openssl rand -hex 24`), bind `secretAccessor`; idempotent; never prints a secret. |
| `infra/deploy.sh` | Cloud Build into Artifact Registry `lake-fraude`, `gcloud run deploy` with the canonical flags, then the `status.url` / `PUBLIC_HOSTS` correction. |
| `infra/smoke.sh [BASE_URL]` | Ten checks: DNS, no cross-host redirect, the 401 challenge, discovery on every host, `/healthz`, Cloud Run invariants, public IAM, discovery latency, 30x `/register` without a 429, dashboard served. |
| `infra/local/docker-compose.yml` | The production image on the Mac with `NODE_ENV=production`, every knob as an env passthrough, SQLite on a named volume, 1 CPU / 1 GiB, a `/healthz` probe, 15 s stop grace. |
| `infra/local/cloudflared.md` | Exposing `localhost:8080` over HTTPS: `cloudflared tunnel --url http://localhost:8080`, then restart with the tunnel host in `PUBLIC_BASE_URL` and `PUBLIC_HOSTS`. |
| `infra/vm/README.md` | The Compute Engine alternative (`laf-ingestor`, D-7): gcloud steps, Docker install, run, verify, trade-offs, what is unverified. |
| `infra/vm/docker-compose.yml` | Caddy 2.11 in front of the app on a private network; `PUBLIC_BASE_URL`, `PUBLIC_HOSTS` and `OAUTH_SIGNING_KEY` are required. |
| `infra/vm/Caddyfile` | Option A: a `nip.io` hostname with an HTTP-01 certificate; `flush_interval -1`, HTTP/1.1 upstream. |
| `infra/vm/Caddyfile.ip-cert` | Option B: a Let's Encrypt IP certificate (`shortlived` profile); syntax-checked only. |

`.dockerignore` at the root excludes `docs`, `test` (except `test/fixtures`), `scripts`, `infra/vm`, `infra/local`, `*.md` and every `.sqlite*` file.

## Public interface (scripts and their env inputs)
- `infra/bootstrap.sh`: `PROJECT_ID` (lake-fraude), `REGION` (us-central1), `SERVICE` (mcp-bank), `EXPECT_ACCOUNT`, `ENABLE_SNAPSHOT_BUCKET=1`, `DRY_RUN=1`. No `make` target.
- `infra/deploy.sh` (`make deploy`): `PROJECT_ID`, `PROJECT_NUMBER` (520283334162), `REGION`, `SERVICE`, `AR_REPO`, `RUNTIME_SA`, `IMAGE_TAG`, `SKIP_BUILD=1`, `PUBLIC_BASE_URL`, `PUBLIC_HOSTS`, `ORIGIN_POLICY` (log-only), `FEATURE_FLAGS`, `XRAY_DB_PATH`, `AUTH_DB_PATH`, `LOG_LEVEL`, `DRY_RUN=1`. The tag is the short git SHA (`-dirty-<ts>` on a dirty tree), else `ts-<UTC>` with a warning.
- `infra/smoke.sh` (`make smoke`): a positional base URL or `SMOKE_BASE_URL` (default: the live `status.url`), `SMOKE_HOSTS`, `CURL_TIMEOUT` (15), `DISCOVERY_BUDGET_S` (10), `REGISTER_ATTEMPTS` (30), `DRY_RUN=1`; exit 1 on any failure; checks 1, 6 and 7 are skipped for a local or `http://` target.
- `docker compose -f infra/local/docker-compose.yml up --build`: `HOST_PORT`, `PUBLIC_BASE_URL`, `PUBLIC_HOSTS`, `OAUTH_SIGNING_KEY`, `XRAY_ADMIN_TOKEN` and every `src/config` knob.

Deploy flags, never relaxed: `--min-instances=1 --max-instances=1 --no-cpu-throttling --timeout=3600 --concurrency=250 --cpu=1 --memory=1Gi --cpu-boost --execution-environment=gen2 --allow-unauthenticated --ingress=all --port=8080 --platform=managed`; env through `--set-env-vars` (`NODE_ENV=production`, `PUBLIC_BASE_URL`, `PUBLIC_HOSTS`, `ORIGIN_POLICY`, `FEATURE_FLAGS`, `XRAY_DB_PATH`, `AUTH_DB_PATH`, `LOG_LEVEL`); secrets only through `--set-secrets`; no `--use-http2`.

## Consumes
`docs/DEPLOYMENT.md` (the flag and knob tables), Secret Manager, Artifact Registry `lake-fraude`, Cloud Build; `docs/DEPLOYMENT.md` also carries the operations runbook (rollback, pause, key rotation, cap tuning, diagnosis).

## Events owned
None.

## Invariants held here
- 1, 2, 3: `--max-instances=1`, `--no-cpu-throttling`, `--timeout=3600`, no HTTP/2; `smoke.sh` check 6 asserts all four on the live service.
- 4: `PUBLIC_HOSTS` carries the deterministic `run.app` host plus whatever `status.url` reports; check 4 asserts the PRM `resource` and the issuer on every host.
- 5: `--allow-unauthenticated`, asserted by check 7. 10: `ORIGIN_POLICY` defaults to `log-only`. 12: `0.0.0.0:8080`, a non-root image, git-SHA tags, secrets only via `--set-secrets`.

## How to test
```
DRY_RUN=1 ./infra/deploy.sh                    # exit 0: prints the build, deploy and correction commands, creates nothing
DRY_RUN=1 ./infra/bootstrap.sh                 # prints every gcloud command
DRY_RUN=1 ./infra/smoke.sh                     # resolves the target and exits 0 without a request
bash infra/smoke.sh http://localhost:8080      # against a running server: 23 passed, 0 failed, 3 skipped
bash infra/smoke.sh https://<tunnel-host>      # 24 passed, 5 failed: all five are the undeployed Cloud Run service (infra/local/cloudflared.md)
docker compose -f infra/local/docker-compose.yml up --build   # the shipped image, NODE_ENV=production
```
The cloud path (`make deploy && make smoke`) has never run.

## Known gaps
- Nothing deployed: no service, secrets, service account or recorded `run.app` hostnames.
- `deploy.sh` does not pass `GIT_SHA` to the container, so `server.started.git_sha` would be `null` in the cloud too.
- Image tags fall back to a timestamp until the first commit exists.
- The local image is arm64; Cloud Build produces amd64 from the same Dockerfile, untested locally.
- `--platform=managed` is a hidden, default flag in current gcloud.
- `smoke.sh` needs `jq` for strict JSON assertions; without it array checks are substring matches.
- The VM path is unproven: no gcloud command run, no certificate issued, the two containers never started together.
