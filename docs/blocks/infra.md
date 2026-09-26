# infra

Status: **deployed** on 2026-09-26 by `.github/workflows/pipeline.yml` (first run: check, e2e, image and deploy green; the live smoke exposed the `/healthz` interception and the check-6 parser bug, both fixed in the same change). `bootstrap.sh` and `ci-bootstrap.sh` ran for real; `make deploy` (Cloud Build) has never run. `domain.sh` ran on 2026-09-26: mapping and CNAME for `glassbank-mcp.abovethefog.app` created, certificate pending; then `PUBLIC_BASE_URL` and a redeploy (`docs/DEPLOYMENT.md` section 16).

## Purpose
Build, run, deploy and verify the one container: locally first (`docker compose`, cloudflared), then the Cloud Run service `mcp-bank` in `lake-fraude` / `us-central1` (D-2).
The gcloud flags live in `deploy.sh` and nowhere else.

## Files
| File | What it does |
|---|---|
| `infra/Dockerfile` | Multi-stage `node:22-slim`: `npm ci`, `npm run build`, `npm prune --omit=dev`; the runtime stage copies `dist/`, `node_modules/`, `package.json`, `public/` and `test/fixtures` (the target of the `public/fixtures` symlink); user `node`, `PORT=8080`, `CMD node dist/server.js`. |
| `infra/cloudbuild.yaml` | One `docker build -f infra/Dockerfile -t $_IMAGE .` step and `images: [$_IMAGE]`; never deploys. |
| `infra/bootstrap.sh` | One-time: enable the APIs, create the `mcp-bank-run` service account, Secret Manager `mcp-bank-oauth-signing-key` (`openssl rand -base64 48`) and `mcp-bank-admin-token` (`openssl rand -hex 24`), bind `secretAccessor`; idempotent; never prints a secret. Ran for real on 2026-09-26. |
| `infra/ci-bootstrap.sh` | One-time (D-24): the deployer service account `mcp-bank-deployer` that GitHub Actions impersonates through the existing Workload Identity pool `github-pool`: `artifactregistry.writer` on the `lake-fraude` repository, `run.admin` on the project, `serviceAccountUser` on `mcp-bank-run`, `workloadIdentityUser` for `principalSet://.../attribute.repository/frbarreto/glassbank`; retries bindings through IAM propagation; prints the GitHub variables to set; idempotent; `DRY_RUN=1`. Ran for real on 2026-09-26. |
| `.github/workflows/pipeline.yml` | GitHub Actions (D-22 to D-24, `docs/DEPLOYMENT.md` section 15): `check`, `e2e`, `image` (build, boot, local smoke, SIGTERM exit check, push `mcp-bank:<sha12>` on `main`), `deploy` (`SKIP_BUILD=1 ./infra/deploy.sh`, then `smoke.sh`, job summary). Push to `main` deploys; `pull_request` never; `workflow_dispatch` redeploys an `image_tag` and sets `origin_policy`. Keyless through `mcp-bank-deployer`. |
| `infra/domain.sh` | D-25: `gcloud beta run domain-mappings create` for `DOMAIN` (default `glassbank-mcp.abovethefog.app`) in `lake-fraude`, then the one CNAME record in Cloud DNS zone `abovethefog-app` (project `abovethefog`); refuses the apex and `www`; `status` prints certificate provisioning; `DRY_RUN=1`. |
| `infra/observe.sh` | Email notification channel, uptime check `glass-bank-health` on `/health` every 5 minutes, alert policy after 10 minutes of failures (`docs/DEPLOYMENT.md` section 17); idempotent; `DRY_RUN=1`. Ran for real on 2026-09-26. |
| `infra/pause.sh` | `pause` deletes the service (stops the bill); `resume` redeploys the newest Artifact Registry image (or `RESUME_TAG`) through `deploy.sh`; `make pause` / `make resume`; `DRY_RUN=1`. |
| `infra/deploy.sh` | Cloud Build into Artifact Registry `lake-fraude`, `gcloud run deploy` with the canonical flags, then the `status.url` / `PUBLIC_HOSTS` correction. |
| `infra/smoke.sh [BASE_URL]` | Ten checks: DNS, no cross-host redirect, the 401 challenge, discovery on every host, `/health`, Cloud Run invariants, public IAM, discovery latency, 30x `/register` without a 429, dashboard served. |
| `infra/local/docker-compose.yml` | The production image on the Mac with `NODE_ENV=production`, every knob as an env passthrough, SQLite on a named volume, 1 CPU / 1 GiB, a `/health` probe, 15 s stop grace. |
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
DRY_RUN=1 ./infra/ci-bootstrap.sh              # prints the deployer service account commands
DRY_RUN=1 ./infra/pause.sh pause               # prints the delete; `resume` prints the redeploy of the newest image
DRY_RUN=1 ./infra/domain.sh                    # prints the mapping and the CNAME commands; `status` prints the certificate state
DRY_RUN=1 ./infra/observe.sh                   # prints the channel, uptime check and alert policy commands
ruby -ryaml -e 'YAML.load_file(".github/workflows/pipeline.yml")'   # the workflow parses
git push origin main                           # runs the pipeline: check, e2e, image, deploy + smoke; follow with `gh run watch`
```
The cloud path has run only through the pipeline (`SKIP_BUILD=1`); `make deploy && make smoke` from the Mac has not.

## Known gaps
- `make deploy` (the Cloud Build path) has never run; every deploy so far came from the pipeline.
- `deploy.sh` does not pass `GIT_SHA` to the container, so `server.started.git_sha` would be `null` in the cloud too.
- The local image is arm64; Cloud Build produces amd64 from the same Dockerfile, untested locally.
- `--platform=managed` is a hidden, default flag in current gcloud.
- `smoke.sh` needs `jq` for strict JSON assertions; without it array checks are substring matches.
- The VM path is unproven: no gcloud command run, no certificate issued, the two containers never started together.
