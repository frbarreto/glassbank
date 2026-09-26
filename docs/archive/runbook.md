# Runbook - Glass Bank (`mcp-bank`)

Block: `infra`. Owner: T0.4, then the L8 agent.
Service: Cloud Run `mcp-bank`, project `lake-fraude` (`520283334162`), region `us-central1`.
Everything here is executed through `infra/`; nobody types gcloud flags by hand
(CLAUDE.md invariant 12, `docs/ARCHITECTURE.md` section 8 invariant 6).

Every script honours `DRY_RUN=1`: it prints the exact commands it would run and exits 0 without
changing anything. Use it first, every time.

```
infra/bootstrap.sh    one-time: service account, secrets, IAM
infra/deploy.sh       build + deploy + the PUBLIC_HOSTS correction   <- the ONLY place the flags live
infra/smoke.sh [URL]  verification; exits non-zero on any failure
```

Quick reference:

| I want to | Go to |
|---|---|
| Ship a change | [1. Deploy](#1-deploy) |
| Undo a bad deploy | [2. Roll back](#2-roll-back) |
| Stop paying for the demo | [3. Pause and resume](#3-pause-and-resume-the-demo) |
| Replace a leaked or old signing key | [4. Rotate the signing key](#4-rotate-the-oauth-signing-key) |
| Turn Origin checking on or off | [5. Switch the Origin policy](#5-switch-the-origin-policy) |
| Change a rate limit or a cap | [6. Tune the caps](#6-tune-the-caps) |
| Work out why claude.ai will not connect | [7. Diagnose a connector failure](#7-diagnose-a-connector-failure) |

---

## 0. One-time bootstrap

Run once per project, before the first deploy. It is idempotent: re-running it creates nothing that
already exists and never touches an existing secret's value.

```bash
DRY_RUN=1 infra/bootstrap.sh    # read what it will do
infra/bootstrap.sh
```

Creates: the runtime service account `mcp-bank-run@lake-fraude.iam.gserviceaccount.com`, the
secrets `mcp-bank-oauth-signing-key` (base64 of 48 random bytes) and `mcp-bank-admin-token` (48 hex
characters), and `roles/secretmanager.secretAccessor` on both for that service account. It enables
`run`, `cloudbuild`, `artifactregistry` and `secretmanager`. It never prints a secret value.

---

## 1. Deploy

```bash
DRY_RUN=1 infra/deploy.sh       # inspect the build and deploy commands
infra/deploy.sh                 # build with Cloud Build, deploy, correct PUBLIC_HOSTS
infra/smoke.sh                  # verify against the live status.url
```

`deploy.sh` prints the MCP endpoint, the dashboard URL, the health URL and the active Origin policy
when it finishes. Add the MCP endpoint to claude.ai exactly as printed, with no trailing slash.

**Image tags.** The tag is `git rev-parse --short=12 HEAD`. Decision D-10 keeps this repository on
local git only, and until the first commit exists `git rev-parse` fails; the script then falls back
to a UTC timestamp tag (`ts-20260908T183358Z`) and says so loudly. A dirty working tree gets
`<sha>-dirty-<timestamp>` so one tag never covers two different builds. Once the repository has
commits, tags are git SHAs again, as CLAUDE.md invariant 12 requires.

**What a deploy costs users.** Everything in memory is lost: scratch SQLite tables, the event ring
buffer, the consumed/revoked token sets, the DCR client table **and every bank write** - a card
locked before the deploy is unlocked afterwards (A-15). Tokens keep working, because verification is
stateless. The dashboard shows a `server.started` marker and `get_current_user` returns a new
`boot_id`, so a user can see why their state reset. During the switchover two instances briefly
coexist with separate memory; that is accepted.

**Deploy only, without rebuilding** (for example to change an environment variable through a full
redeploy):

```bash
SKIP_BUILD=1 IMAGE_TAG=<existing-tag> infra/deploy.sh
```

---

## 2. Roll back

Rolling back is a traffic change, not a deploy: the previous revision still exists.

```bash
# List revisions, newest first
gcloud run revisions list --service=mcp-bank --region=us-central1 \
  --format='table(metadata.name, status.conditions[0].lastTransitionTime, spec.containers[0].image)'

# Send all traffic to a known-good revision
gcloud run services update-traffic mcp-bank --region=us-central1 \
  --to-revisions=<previous-revision>=100

infra/smoke.sh
```

A rollback restarts the instance, so it costs users exactly what a deploy costs them (see above).

To pin traffic back to the newest revision afterwards:

```bash
gcloud run services update-traffic mcp-bank --region=us-central1 --to-latest
```

If the bad revision cannot even start, traffic never moved to it and there is nothing to roll back;
fix the image and deploy again.

---

## 3. Pause and resume the demo

The service is billed for a pinned always-on instance (about US$47/month, A-20). To stop paying
without losing the URL, the secrets or the service account:

```bash
gcloud run services delete mcp-bank --region=us-central1
```

Resume:

```bash
infra/deploy.sh
infra/smoke.sh
```

The `run.app` URL is derived from the service name and the project number, so it comes back
identical and connectors keep pointing at the right place. What does not come back: every grant's
in-memory state, and any refresh token whose replay-protection entry lived in memory. Users may need
to reconnect once.

A softer pause - keep the service, stop the always-on instance - is not available without breaking
an invariant: `--min-instances=0` would let Cloud Run idle the instance out, and the SSE heartbeats,
TTL eviction and fan-out that run with no request in flight would stop. Delete the service instead.

---

## 4. Rotate the OAuth signing key

The signing key backs every JWT the server issues: authorization codes, access tokens, refresh
tokens, viewer cookies, `txn` browser-state tokens and login cookies (CLAUDE.md invariant 7).
Rotating it invalidates all of them at once.

```bash
# 1. Add a new version. The value never touches the disk, the shell history or the logs.
openssl rand -base64 48 | gcloud secrets versions add mcp-bank-oauth-signing-key --data-file=-

# 2. The service is deployed with :latest, so it picks the new version up on the next start.
#    A redeploy is the way to restart it.
infra/deploy.sh
infra/smoke.sh
```

**Consequences, in the order users will notice them.** Every access and refresh token stops
verifying, so claude.ai gets a 401 on its next call and re-runs OAuth. Every dashboard viewer cookie
stops verifying, so pairing links must be reopened. Browser flows that were mid-`/authorize` fail
and must be restarted. If a connector cannot recover on its own, the user removes it in claude.ai
and adds it again - authentication settings cannot be edited after adding - and pastes their `per_`
id on the login page to keep their generated dataset.

Announce it if anyone is watching a demo. Verify afterwards that the new key is actually in use:
`/healthz` reports a fresh `boot_id`, and a full OAuth walk through MCP Inspector succeeds.

Rotating the **admin token** is the same shape and much cheaper - only observer-mode dashboard
sessions break:

```bash
openssl rand -hex 24 | gcloud secrets versions add mcp-bank-admin-token --data-file=-
infra/deploy.sh
```

Disable an old version once the new one is confirmed working:

```bash
gcloud secrets versions list mcp-bank-oauth-signing-key
gcloud secrets versions disable <old-version> --secret=mcp-bank-oauth-signing-key
```

---

## 5. Switch the Origin policy

`ORIGIN_POLICY` has two values (A-17, CLAUDE.md invariant 10):

- `log-only` - every Origin is allowed; rejections are only recorded. **The Phase 0 default.**
- `allowlist` - absent Origin allowed, `https://claude.ai`, `https://claude.com` and the service's
  own origin allowed, other browser-looking origins rejected. **The production target**, switched
  on at T0.5.

Over-strict Origin validation is one of the leading causes of `initialize` timeouts from claude.ai,
and whether claude.ai sends an `Origin` header at all is still unverified. So the order matters:
run in `log-only`, record the Origin values actually observed in `docs/observations/claude-ai.md`,
and only then tighten.

```bash
# Tighten (the T0.5 step)
ORIGIN_POLICY=allowlist infra/deploy.sh

# Loosen again, immediately, if connections start failing
ORIGIN_POLICY=log-only infra/deploy.sh
```

`deploy.sh` refuses any other value. The active policy is visible without a deploy:

```bash
curl -s https://mcp-bank-520283334162.us-central1.run.app/healthz | jq -r .origin_policy
```

and `infra/smoke.sh` prints it in its own section at the end of every run.

Loosening back to `log-only` is always safe and is the correct first move whenever connections
break right after a tightening.

---

## 6. Tune the caps

Every abuse cap and rate limit is an environment variable, precisely so a demo under load can be
tuned without a code change (ADR-16, `docs/DEPLOYMENT.md` section 3). Two ways to change one:

```bash
# A. Through a full redeploy - preferred, because deploy.sh stays the single source of truth
RATE_LIMIT_IP_REGISTER=200 SKIP_BUILD=1 IMAGE_TAG=<current-tag> infra/deploy.sh

# B. In place, for an urgent single knob (this creates a new revision too)
gcloud run services update mcp-bank --region=us-central1 \
  --update-env-vars=RATE_LIMIT_IP_REGISTER=200
```

Prefer A. Anything set only through B is invisible to `deploy.sh` and will be silently reverted by
the next full deploy, because `--set-env-vars` replaces the whole set.

Which knob to reach for:

| Symptom | Knob | Default | Direction |
|---|---|---|---|
| claude.ai users get 429 on connect | `RATE_LIMIT_IP_REGISTER` | 60/h | up - all of Anthropic shares `160.79.104.0/21` (A-43) |
| OAuth loops, 429 on `/authorize` | `RATE_LIMIT_IP_AUTHORIZE` | 300/15 min | up |
| A single conversation is throttled | `RATE_LIMIT_GRANT_TOOL_CALLS` | 120/min | up |
| Memory climbing, many scratch tables | `MAX_SCRATCH_DBS`, `MAX_TABLES_PER_GRANT`, `TABLE_TTL_MINUTES` | 200 / 10 / 30 | down |
| Memory climbing, many personas | `MAX_MATERIALISED_PERSONAS`, `MAX_PERSONA_OVERLAYS`, `PERSONA_OVERLAY_TTL_HOURS` | 200 / 1000 / 24 | down |
| Model queries time out too often | `QUERY_TIMEOUT_MS` | 2000 | up, carefully - it is a CPU budget on a shared singleton |
| Query results truncated too aggressively | `MAX_QUERY_ROWS` | 100 | up, carefully - rows land in the model's context |
| Event log growing | `XRAY_RETENTION_HOURS` | 72 | down |
| Registration table growing | `MAX_DCR_CLIENTS` | 1000 | down |

Raising a cap raises the memory ceiling of a public, passwordless service on a 1 GiB singleton.
Raise one knob at a time, watch `/healthz` and the Cloud Run memory metric, and write down what you
changed. After tuning, always re-run:

```bash
infra/smoke.sh
```

**Never** change these through the caps route - they are correctness, not tuning:
`--min-instances`, `--max-instances`, `--no-cpu-throttling`, `--timeout`, and there is never a
`--use-http2`.

---

## 7. Diagnose a connector failure

Start here, in this order:

```bash
infra/smoke.sh                        # the whole checklist; failures name the invariant they broke
gcloud run services logs read mcp-bank --region=us-central1 --limit=200
```

The failures Anthropic sees most often, and what each looks like in `smoke.sh`:

| `smoke.sh` failure | Cause |
|---|---|
| check 1, private or AAAA-only address | the host is not reachable from Anthropic's runtime; `localhost` and tunnels-that-died look like this |
| check 2, redirect to another host | a cross-host redirect; Claude will not follow it |
| check 3, not 401, or no `resource_metadata` | the bearer gate is answering `200 + isError`, or the challenge is malformed; the flow never starts |
| check 4, `resource` does not match the host queried | the PRM identity is wrong for one of the hostnames (A-36); Claude caches this for ~5 minutes, so fix it and then remove and re-add the connector |
| check 6, an invariant drifted | someone deployed outside `infra/deploy.sh` |
| check 7, `allUsers` not bound | Cloud Run IAM is not public; claude.ai gets a Google 403 before the app is reached |
| check 8, over the 10 s budget | discovery is too slow; Claude gives up |
| check 9, any 429 | the per-IP limit is locking out Anthropic's shared egress - see section 6 |

A failure id from claude.ai starts with `ofid_` and appears in the error toast URL. Record anything
new you learn in `docs/observations/claude-ai.md`; that file is what turns a one-off failure into a
check in `smoke.sh`.

Local reproduction is always cheaper than a cloud round trip (Decision D-2):

```bash
docker compose -f infra/local/docker-compose.yml up --build
infra/smoke.sh http://localhost:8080
```

and, to reproduce something that only happens with a real Claude account,
`infra/local/cloudflared.md`.
