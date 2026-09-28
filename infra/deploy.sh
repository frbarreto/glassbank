#!/usr/bin/env bash
#
# Glass Bank - build and deploy the Cloud Run service (block: infra, task T0.4).
#
# THIS IS THE ONLY PLACE THE `gcloud run deploy` FLAGS EXIST (CLAUDE.md invariant 12,
# docs/ARCHITECTURE.md section 8 invariant 6). The flag list below is exactly
# docs/DEPLOYMENT.md section 1.2; do not copy it anywhere else, and do not change it without
# changing that document.
#
# Usage:
#   infra/deploy.sh                                  # build with Cloud Build, then deploy
#   DRY_RUN=1 infra/deploy.sh                        # print the full build and deploy commands only
#   ORIGIN_POLICY=allowlist infra/deploy.sh          # the T0.5 switch (A-17)
#   IMAGE_TAG=abc1234 infra/deploy.sh                # redeploy an image that already exists
#   SKIP_BUILD=1 IMAGE_TAG=abc1234 infra/deploy.sh   # deploy only
#
# Invariants encoded here (never relax them):
#   --min-instances=1 --max-instances=1   correctness, not cost: in-process scratch SQLite,
#                                         the event ring buffer and SSE fan-out are per instance
#   --no-cpu-throttling                   heartbeats, TTL eviction and fan-out with no request in flight
#   --timeout=3600                        the SSE stream ceiling
#   --concurrency=250                     each open SSE stream is one in-flight request (A-19)
#   --allow-unauthenticated               claude.ai cannot present Google credentials (A-16)
#   no --use-http2                        SSE rides HTTP/1.1 chunked responses
#   --set-secrets only                    secrets never live in env vars, files or images

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lake-fraude}"
PROJECT_NUMBER="${PROJECT_NUMBER:-520283334162}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mcp-bank}"
AR_REPO="${AR_REPO:-lake-fraude}"          # existing Artifact Registry repository, reused (A-30)
RUNTIME_SA="${RUNTIME_SA:-${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com}"
SIGNING_KEY_SECRET="${SIGNING_KEY_SECRET:-${SERVICE}-oauth-signing-key}"
ADMIN_TOKEN_SECRET="${ADMIN_TOKEN_SECRET:-${SERVICE}-admin-token}"
DRY_RUN="${DRY_RUN:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Readable shell quoting: leave plain arguments alone, single-quote anything with shell syntax
# (the ';' inside FEATURE_FLAGS and PUBLIC_HOSTS, mainly).
shq() {
  local arg
  for arg in "$@"; do
    if [[ "$arg" =~ ^[A-Za-z0-9_@%+=:,./-]+$ ]]; then
      printf '%s ' "$arg"
    else
      printf "'%s' " "${arg//\'/\'\\\'\'}"
    fi
  done
}
show_cmd() { printf '+ '; shq "$@"; printf '\n'; }

run() {
  show_cmd "$@"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  "$@"
}

# ---------------------------------------------------------------------------------------------
# Image tag
#
# CLAUDE.md invariant 12 says image tags are git SHAs. The pipeline (.github/workflows/pipeline.yml)
# passes IMAGE_TAG explicitly: the first 12 characters of the commit SHA, the value derived here.
# In a tree without git history the tag falls back to a UTC timestamp, which is still unique and
# still traceable, and the script says so loudly.
# ---------------------------------------------------------------------------------------------
resolve_tag() {
  if [ -n "${IMAGE_TAG:-}" ]; then
    say "image tag        : $IMAGE_TAG (from IMAGE_TAG)"
    return 0
  fi

  local sha=""
  if command -v git >/dev/null 2>&1; then
    sha="$(git -C "$REPO_ROOT" rev-parse --short=12 HEAD 2>/dev/null || true)"
  fi

  if [ -n "$sha" ]; then
    IMAGE_TAG="$sha"
    # A dirty tree would otherwise reuse a tag for different content.
    if ! git -C "$REPO_ROOT" diff --quiet HEAD -- 2>/dev/null; then
      IMAGE_TAG="${sha}-dirty-$(date -u +%Y%m%d%H%M%S)"
      warn "working tree is dirty; tagging $IMAGE_TAG instead of the bare git SHA."
    fi
    say "image tag        : $IMAGE_TAG (git)"
  else
    IMAGE_TAG="ts-$(date -u +%Y%m%dT%H%M%SZ)"
    warn "no git commit to tag from (this tree has no git history)."
    warn "falling back to a timestamp tag: $IMAGE_TAG. With git history this becomes"
    warn "a git SHA again, as CLAUDE.md invariant 12 requires."
    say "image tag        : $IMAGE_TAG (timestamp fallback)"
  fi
}

# ---------------------------------------------------------------------------------------------
# Public identity
#
# PUBLIC_HOSTS lists every hostname the service answers on, ';'-separated because --set-env-vars
# splits on commas. Cloud Run serves the same service on the deterministic
# <service>-<project-number>.<region>.run.app form and on the legacy *.a.run.app form that
# status.url may report (A-36), and a user may type either.
# ---------------------------------------------------------------------------------------------
DETERMINISTIC_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
DETERMINISTIC_HOST="${DETERMINISTIC_URL#https://}"

# Appends a host to a ';'-separated list unless it is already there.
append_host() {
  local list="$1" host="$2" item
  [ -n "$host" ] || { printf '%s' "$list"; return 0; }
  if [ -z "$list" ]; then printf '%s' "$host"; return 0; fi
  local IFS=';'
  for item in $list; do
    if [ "$item" = "$host" ]; then printf '%s' "$list"; return 0; fi
  done
  printf '%s;%s' "$list" "$host"
}

preflight() {
  step "Preflight"
  command -v gcloud >/dev/null 2>&1 || die "gcloud is not on PATH."
  [ -f "$REPO_ROOT/infra/cloudbuild.yaml" ] || die "missing $REPO_ROOT/infra/cloudbuild.yaml"
  [ -f "$REPO_ROOT/infra/Dockerfile" ] || die "missing $REPO_ROOT/infra/Dockerfile"

  local account configured_project
  account="$(gcloud config get-value account 2>/dev/null || true)"
  configured_project="$(gcloud config get-value project 2>/dev/null || true)"
  [ "$account" = "(unset)" ] && account=""
  [ "$configured_project" = "(unset)" ] && configured_project=""

  say "repo root        : $REPO_ROOT"
  say "gcloud account   : ${account:-<none>}"
  say "gcloud project   : ${configured_project:-<none>}"
  say "target project   : $PROJECT_ID ($PROJECT_NUMBER)"
  say "target region    : $REGION"
  say "service          : $SERVICE"
  say "runtime SA       : $RUNTIME_SA"
  say "DRY_RUN          : $DRY_RUN"

  if [ -z "$account" ] && [ "$DRY_RUN" != "1" ]; then
    die "no active gcloud account. Run: gcloud auth login"
  fi
  if [ -n "${EXPECT_ACCOUNT:-}" ] && [ "$account" != "$EXPECT_ACCOUNT" ]; then
    die "active account '$account' is not the expected '$EXPECT_ACCOUNT'."
  fi

  resolve_tag

  IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}:${IMAGE_TAG}"
  # An explicit PUBLIC_BASE_URL (the custom hostname, docs/DEPLOYMENT.md section 16) is kept as the
  # canonical base; only the default is replaced by status.url in correct_public_hosts (A-36).
  PUBLIC_BASE_URL_EXPLICIT=0
  [ -n "${PUBLIC_BASE_URL:-}" ] && PUBLIC_BASE_URL_EXPLICIT=1
  # Unset (a deploy or `make resume` from the Mac): follow the custom hostname mapped to this service
  # (infra/domain.sh, D-25), so a manual deploy keeps the identity the pipeline gives it. The
  # mapping outlives the service, so this also holds right after `make pause`.
  if [ "$PUBLIC_BASE_URL_EXPLICIT" = "0" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      say "# would look up a domain mapping for $SERVICE and use it as PUBLIC_BASE_URL"
    else
      local mapped
      mapped="$(gcloud beta run domain-mappings list --project="$PROJECT_ID" --region="$REGION" \
        --filter="spec.routeName=$SERVICE" --format='value(metadata.name)' 2>/dev/null | head -1 || true)"
      if [ -n "$mapped" ]; then
        PUBLIC_BASE_URL="https://$mapped"
        PUBLIC_BASE_URL_EXPLICIT=1
        say "domain mapping   : $mapped (used as PUBLIC_BASE_URL)"
      fi
    fi
  fi
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-$DETERMINISTIC_URL}"
  PUBLIC_HOSTS="${PUBLIC_HOSTS:-$DETERMINISTIC_HOST}"
  PUBLIC_HOSTS="$(append_host "$PUBLIC_HOSTS" "${PUBLIC_BASE_URL#https://}")"
  # log-only on purpose: whether claude.ai sends an Origin header at all is unknown (A-17) and
  # over-strict Origin validation is a leading cause of initialize timeouts. Flip this to allowlist
  # after the observed values land in docs/observations/claude-ai.md.
  ORIGIN_POLICY="${ORIGIN_POLICY:-log-only}"
  case "$ORIGIN_POLICY" in
    log-only|allowlist) : ;;
    *) die "ORIGIN_POLICY must be 'log-only' or 'allowlist', got '$ORIGIN_POLICY'." ;;
  esac

  # advertise: every /mcp and /public/mcp answer carries Accept-Signature, inviting a client to sign
  # with Web Bot Auth. The verdict is recorded and never changes an answer (D-29).
  BOT_AUTH_CHALLENGE="${BOT_AUTH_CHALLENGE:-advertise}"
  case "$BOT_AUTH_CHALLENGE" in
    off|advertise) : ;;
    *) die "BOT_AUTH_CHALLENGE must be 'off' or 'advertise', got '$BOT_AUTH_CHALLENGE'." ;;
  esac

  say "image            : $IMAGE"
  say "PUBLIC_BASE_URL  : $PUBLIC_BASE_URL"
  say "PUBLIC_HOSTS     : $PUBLIC_HOSTS"
  say "ORIGIN_POLICY    : $ORIGIN_POLICY"
  say "BOT_AUTH_CHALLENGE: $BOT_AUTH_CHALLENGE"
}

# ---------------------------------------------------------------------------------------------
# Build
#
# `gcloud builds submit --tag` only builds a Dockerfile at the context root, and the Dockerfile
# belongs to infra/, so a config file names it instead (infra/cloudbuild.yaml).
# ---------------------------------------------------------------------------------------------
build() {
  step "Build (Cloud Build -> Artifact Registry)"
  if [ "$SKIP_BUILD" = "1" ]; then
    say "SKIP_BUILD=1: reusing $IMAGE"
    return 0
  fi
  ( cd "$REPO_ROOT" && run gcloud builds submit \
      --project="$PROJECT_ID" \
      --region="$REGION" \
      --config=infra/cloudbuild.yaml \
      --substitutions="_IMAGE=$IMAGE" \
      . )
}

# ---------------------------------------------------------------------------------------------
# Deploy - the canonical flag list
# ---------------------------------------------------------------------------------------------
deploy() {
  step "Deploy (Cloud Run)"
  local env_vars secrets
  env_vars="NODE_ENV=production"
  env_vars="$env_vars,PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
  env_vars="$env_vars,PUBLIC_HOSTS=$PUBLIC_HOSTS"
  env_vars="$env_vars,ORIGIN_POLICY=$ORIGIN_POLICY"
  env_vars="$env_vars,BOT_AUTH_CHALLENGE=$BOT_AUTH_CHALLENGE"
  env_vars="$env_vars,FEATURE_FLAGS=${FEATURE_FLAGS:-writes;transfers}"
  env_vars="$env_vars,XRAY_DB_PATH=${XRAY_DB_PATH:-/tmp/xray.sqlite}"
  env_vars="$env_vars,AUTH_DB_PATH=${AUTH_DB_PATH:-/tmp/auth.sqlite}"
  env_vars="$env_vars,LOG_LEVEL=${LOG_LEVEL:-info}"

  secrets="OAUTH_SIGNING_KEY=${SIGNING_KEY_SECRET}:latest,XRAY_ADMIN_TOKEN=${ADMIN_TOKEN_SECRET}:latest"

  run gcloud run deploy "$SERVICE" \
    --project="$PROJECT_ID" \
    --image="$IMAGE" \
    --region="$REGION" --platform=managed \
    --service-account="$RUNTIME_SA" \
    --allow-unauthenticated --ingress=all \
    --port=8080 \
    --cpu=1 --memory=1Gi --no-cpu-throttling \
    --min-instances=1 --max-instances=1 \
    --concurrency=250 --timeout=3600 \
    --cpu-boost --execution-environment=gen2 \
    --set-env-vars="$env_vars" \
    --set-secrets="$secrets"
}

# ---------------------------------------------------------------------------------------------
# status.url correction
#
# The PRM `resource` must equal what a user types. Cloud Run reports the hostname it actually
# serves in status.url; if that is not the deterministic form, add it to PUBLIC_HOSTS and, unless
# PUBLIC_BASE_URL was set explicitly (the custom hostname), make it the fallback base URL. Claude
# caches discovery documents for about five minutes per URL, so a mismatch here is sticky (A-36).
# ---------------------------------------------------------------------------------------------
correct_public_hosts() {
  step "PUBLIC_HOSTS / status.url correction"

  if [ "$DRY_RUN" = "1" ]; then
    show_cmd gcloud run services describe "$SERVICE" --project="$PROJECT_ID" \
      --region="$REGION" --format='value(status.url)'
    if [ "$PUBLIC_BASE_URL_EXPLICIT" = "1" ]; then
      say "# then, only if status.host is missing from PUBLIC_HOSTS (PUBLIC_BASE_URL is explicit and kept):"
      show_cmd gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
        --update-env-vars="PUBLIC_BASE_URL=$PUBLIC_BASE_URL,PUBLIC_HOSTS=$PUBLIC_HOSTS;<status.host>"
    else
      say "# then, only if status.url differs from PUBLIC_BASE_URL ($PUBLIC_BASE_URL):"
      show_cmd gcloud run services update "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
        --update-env-vars="PUBLIC_BASE_URL=<status.url>,PUBLIC_HOSTS=$PUBLIC_HOSTS;<status.host>"
    fi
    STATUS_URL="$PUBLIC_BASE_URL"
    return 0
  fi

  STATUS_URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" \
    --region="$REGION" --format='value(status.url)')"
  [ -n "$STATUS_URL" ] || die "could not read status.url for $SERVICE."
  local status_host="${STATUS_URL#https://}"
  say "status.url       : $STATUS_URL"

  local wanted_hosts wanted_base
  wanted_hosts="$(append_host "$PUBLIC_HOSTS" "$status_host")"
  wanted_base="$STATUS_URL"
  if [ "$PUBLIC_BASE_URL_EXPLICIT" = "1" ]; then
    wanted_base="$PUBLIC_BASE_URL"
    say "PUBLIC_BASE_URL was set explicitly; keeping $wanted_base as the canonical base."
  fi

  if [ "$wanted_base" = "$PUBLIC_BASE_URL" ] && [ "$wanted_hosts" = "$PUBLIC_HOSTS" ]; then
    say "no correction needed."
    return 0
  fi

  say "correcting PUBLIC_BASE_URL -> $wanted_base and PUBLIC_HOSTS -> $wanted_hosts"
  run gcloud run services update "$SERVICE" \
    --project="$PROJECT_ID" --region="$REGION" \
    --update-env-vars="PUBLIC_BASE_URL=$wanted_base,PUBLIC_HOSTS=$wanted_hosts"
  PUBLIC_BASE_URL="$wanted_base"
  PUBLIC_HOSTS="$wanted_hosts"
}

summary() {
  step "Deployed"
  cat <<EOF
MCP endpoint     : ${STATUS_URL}/mcp
Dashboard        : ${STATUS_URL}/xray
Health           : ${STATUS_URL}/health
Origin policy    : ${ORIGIN_POLICY}
PUBLIC_BASE_URL  : ${PUBLIC_BASE_URL}
PUBLIC_HOSTS     : ${PUBLIC_HOSTS}
Image            : ${IMAGE}

Verify:  infra/smoke.sh ${STATUS_URL}
EOF
  if [ "$DRY_RUN" = "1" ]; then
    say ""
    say "DRY_RUN=1: nothing was built or deployed. The URLs above are the deterministic form."
  fi
}

main() {
  preflight
  build
  deploy
  correct_public_hosts
  summary
}

main "$@"
