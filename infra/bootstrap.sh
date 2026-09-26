#!/usr/bin/env bash
#
# Glass Bank - one-time project bootstrap (block: infra, task T0.4).
#
# Creates everything the Cloud Run service needs before the first deploy, exactly as specified in
# docs/DEPLOYMENT.md section 1.1:
#
#   - the required Google APIs
#   - the runtime service account  mcp-bank-run@<project>.iam.gserviceaccount.com
#   - Secret Manager secrets       mcp-bank-oauth-signing-key, mcp-bank-admin-token
#   - roles/secretmanager.secretAccessor on both secrets for the runtime service account
#
# The script is idempotent: every mutation is guarded by a describe, and the IAM bindings are
# no-ops when they already exist. It never prints a secret value.
#
# Usage:
#   infra/bootstrap.sh                 # create what is missing
#   DRY_RUN=1 infra/bootstrap.sh       # print every command that would run, change nothing
#
# Environment knobs (all optional, defaults match docs/DEPLOYMENT.md):
#   PROJECT_ID (lake-fraude)  REGION (us-central1)  SERVICE (mcp-bank)
#   EXPECT_ACCOUNT            require this gcloud account to be active
#   ENABLE_SNAPSHOT_BUCKET=1  also create the Phase 3 snapshot bucket (Decision D-6, off by default)
#
# CLAUDE.md invariant 12: secrets live only in Secret Manager, never in files or images.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lake-fraude}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mcp-bank}"
DRY_RUN="${DRY_RUN:-0}"

RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-${SERVICE}-run}"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
SIGNING_KEY_SECRET="${SIGNING_KEY_SECRET:-${SERVICE}-oauth-signing-key}"
ADMIN_TOKEN_SECRET="${ADMIN_TOKEN_SECRET:-${SERVICE}-admin-token}"
SNAPSHOT_BUCKET_NAME="${SNAPSHOT_BUCKET_NAME:-${PROJECT_ID}-${SERVICE}-snapshots}"

REQUIRED_APIS=(
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
)

# ---------------------------------------------------------------------------------------------
# Output helpers. Everything the script would execute is printed with a leading '+'.
# ---------------------------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Prints a command in copy-pasteable form.
show_cmd() { printf '+ '; printf '%q ' "$@"; printf '\n'; }

# Runs a mutating command, or prints it under DRY_RUN=1.
run() {
  show_cmd "$@"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  "$@"
}

# Existence probe. Under DRY_RUN=1 nothing is called at all (the script stays usable with no
# network and no credentials) and the resource is reported missing so the create command prints.
exists() {
  local description="$1"; shift
  if [ "$DRY_RUN" = "1" ]; then
    printf '# would check: %s -> ' "$description"
    printf '%q ' "$@"
    printf '\n'
    return 1
  fi
  "$@" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------------------------
preflight() {
  step "Preflight"
  command -v gcloud >/dev/null 2>&1 || die "gcloud is not on PATH."
  command -v openssl >/dev/null 2>&1 || die "openssl is not on PATH (needed to generate secrets)."

  local account configured_project
  account="$(gcloud config get-value account 2>/dev/null || true)"
  configured_project="$(gcloud config get-value project 2>/dev/null || true)"
  [ "$account" = "(unset)" ] && account=""
  [ "$configured_project" = "(unset)" ] && configured_project=""

  say "gcloud account   : ${account:-<none>}"
  say "gcloud project   : ${configured_project:-<none>}"
  say "target project   : $PROJECT_ID"
  say "target region    : $REGION"
  say "runtime SA       : $RUNTIME_SA"
  say "secrets          : $SIGNING_KEY_SECRET, $ADMIN_TOKEN_SECRET"
  say "DRY_RUN          : $DRY_RUN"

  if [ -z "$account" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      warn "no active gcloud account; continuing because DRY_RUN=1."
    else
      die "no active gcloud account. Run: gcloud auth login"
    fi
  fi

  if [ -n "${EXPECT_ACCOUNT:-}" ] && [ "$account" != "$EXPECT_ACCOUNT" ]; then
    die "active account '$account' is not the expected '$EXPECT_ACCOUNT'."
  fi

  if [ -n "$configured_project" ] && [ "$configured_project" != "$PROJECT_ID" ]; then
    warn "gcloud is configured for '$configured_project' but this script targets '$PROJECT_ID'."
    warn "Every command below passes --project=$PROJECT_ID explicitly, so the active config is not used."
  fi
}

# ---------------------------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------------------------
enable_apis() {
  step "APIs (gcloud services enable is idempotent)"
  run gcloud services enable "${REQUIRED_APIS[@]}" --project="$PROJECT_ID"
}

create_service_account() {
  step "Runtime service account"
  if exists "service account $RUNTIME_SA" \
      gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID"; then
    say "already exists: $RUNTIME_SA"
    return 0
  fi
  run gcloud iam service-accounts create "$RUNTIME_SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="$SERVICE Cloud Run runtime"
}

# create_secret <name> <generator-shown-in-dry-run> <generator command...>
# The generated value is piped straight into gcloud; it is never stored in a variable, a file or
# the shell history, and never printed.
create_secret() {
  local name="$1"; shift
  local pretty="$1"; shift

  if exists "secret $name" gcloud secrets describe "$name" --project="$PROJECT_ID"; then
    say "already exists: secret $name (value untouched; rotate with 'gcloud secrets versions add')"
    return 0
  fi

  printf '+ %s | ' "$pretty"
  printf '%q ' gcloud secrets create "$name" --project="$PROJECT_ID" \
    --replication-policy=automatic --data-file=-
  printf '\n'

  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi

  "$@" | gcloud secrets create "$name" --project="$PROJECT_ID" \
    --replication-policy=automatic --data-file=-
}

create_secrets() {
  step "Secret Manager secrets"
  # 48 random bytes, base64: the HS256 signing key for codes, access, refresh, viewer, txn and
  # login JWTs (CLAUDE.md invariant 7).
  create_secret "$SIGNING_KEY_SECRET" "openssl rand -base64 48" openssl rand -base64 48
  # 24 random bytes, hex: the dashboard observer-mode admin token (CLAUDE.md invariant 11).
  create_secret "$ADMIN_TOKEN_SECRET" "openssl rand -hex 24" openssl rand -hex 24
}

bind_secret_access() {
  step "IAM: roles/secretmanager.secretAccessor for the runtime service account"
  # add-iam-policy-binding is idempotent: re-adding an existing binding leaves the policy unchanged.
  local secret
  for secret in "$SIGNING_KEY_SECRET" "$ADMIN_TOKEN_SECRET"; do
    run gcloud secrets add-iam-policy-binding "$secret" \
      --project="$PROJECT_ID" \
      --member="serviceAccount:$RUNTIME_SA" \
      --role="roles/secretmanager.secretAccessor"
  done
}

create_snapshot_bucket() {
  [ "${ENABLE_SNAPSHOT_BUCKET:-0}" = "1" ] || return 0
  step "Optional snapshot bucket (Decision D-6, Phase 3)"
  if exists "bucket gs://$SNAPSHOT_BUCKET_NAME" \
      gcloud storage buckets describe "gs://$SNAPSHOT_BUCKET_NAME" --project="$PROJECT_ID"; then
    say "already exists: gs://$SNAPSHOT_BUCKET_NAME"
  else
    run gcloud storage buckets create "gs://$SNAPSHOT_BUCKET_NAME" \
      --project="$PROJECT_ID" --location="$REGION" --uniform-bucket-level-access
  fi
  run gcloud storage buckets add-iam-policy-binding "gs://$SNAPSHOT_BUCKET_NAME" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:$RUNTIME_SA" \
    --role="roles/storage.objectAdmin"
}

summary() {
  step "Done"
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY_RUN=1: nothing was created. Re-run without DRY_RUN to apply."
  fi
  cat <<EOF

Runtime service account : $RUNTIME_SA
Signing key secret      : $SIGNING_KEY_SECRET   -> OAUTH_SIGNING_KEY
Admin token secret      : $ADMIN_TOKEN_SECRET   -> XRAY_ADMIN_TOKEN
Artifact Registry repo  : ${REGION}-docker.pkg.dev/$PROJECT_ID/lake-fraude (reused, A-30)

Next: infra/deploy.sh   (the only place the gcloud run deploy flags live)
EOF
}

main() {
  preflight
  enable_apis
  create_service_account
  create_secrets
  bind_secret_access
  create_snapshot_bucket
  summary
}

main "$@"
