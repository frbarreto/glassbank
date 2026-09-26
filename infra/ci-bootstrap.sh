#!/usr/bin/env bash
#
# Glass Bank - one-time CI/CD bootstrap (block: infra; decisions D-21 and D-24).
#
# GitHub Actions deploys this service without any stored key: the workflow exchanges its GitHub
# OIDC token, through the project's existing Workload Identity pool, for a short-lived token of the
# deployer service account created here. This script gives that account exactly what the pipeline
# (.github/workflows/pipeline.yml) needs and nothing else:
#
#   roles/artifactregistry.writer   on the Artifact Registry repository   push mcp-bank:<sha>
#   roles/run.admin                 on the project                        create/update the service,
#                                                                         set its public invoker policy
#   roles/iam.serviceAccountUser    on the runtime service account only   deploy with --service-account
#   roles/iam.workloadIdentityUser  on the deployer, for one repository   let that repo impersonate it
#
# Prerequisites: infra/bootstrap.sh has run (the runtime service account must exist), and the
# Workload Identity pool and provider already exist (they are shared with other projects of this
# account and are never created or modified here).
#
# Usage:
#   infra/ci-bootstrap.sh              # create what is missing, print the GitHub variables to set
#   DRY_RUN=1 infra/ci-bootstrap.sh    # print every command that would run, change nothing
#
# Knobs (defaults match docs/DEPLOYMENT.md): PROJECT_ID, PROJECT_NUMBER, REGION, SERVICE, AR_REPO,
# GITHUB_REPO (owner/name), WIF_POOL, WIF_PROVIDER, EXPECT_ACCOUNT.
#
# CLAUDE.md invariant 12: no key file is ever created; secrets never leave Secret Manager.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lake-fraude}"
PROJECT_NUMBER="${PROJECT_NUMBER:-520283334162}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mcp-bank}"
AR_REPO="${AR_REPO:-lake-fraude}"
GITHUB_REPO="${GITHUB_REPO:-frbarreto/glassbank}"
WIF_POOL="${WIF_POOL:-github-pool}"
WIF_PROVIDER="${WIF_PROVIDER:-github-provider}"
DRY_RUN="${DRY_RUN:-0}"

DEPLOYER_SA_NAME="${DEPLOYER_SA_NAME:-${SERVICE}-deployer}"
DEPLOYER_SA="${DEPLOYER_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${RUNTIME_SA:-${SERVICE}-run@${PROJECT_ID}.iam.gserviceaccount.com}"
POOL_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}"
PROVIDER_NAME="${POOL_NAME}/providers/${WIF_PROVIDER}"
# The principal set is one repository, matched exactly on GitHub's `repository` claim (case included).
PRINCIPAL="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${GITHUB_REPO}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
show_cmd() { printf '+ '; printf '%q ' "$@"; printf '\n'; }

run() {
  show_cmd "$@"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  "$@"
}

# A newly created service account takes up to a minute to become visible to IAM policy writes on
# other resources ("Service account ... does not exist" right after a successful create). Retry the
# binding a few times, ten seconds apart, before giving up.
run_retry() {
  local attempt
  show_cmd "$@"
  if [ "$DRY_RUN" = "1" ]; then
    return 0
  fi
  for attempt in 1 2 3 4 5 6; do
    if "$@"; then
      return 0
    fi
    if [ "$attempt" = "6" ]; then
      return 1
    fi
    warn "attempt $attempt failed; retrying in 10 s (IAM propagation)."
    sleep 10
  done
}

# Existence probe. Under DRY_RUN=1 nothing is called (usable with no credentials) and the resource
# is reported missing so the create command prints.
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

preflight() {
  step "Preflight"
  command -v gcloud >/dev/null 2>&1 || die "gcloud is not on PATH."

  local account
  account="$(gcloud config get-value account 2>/dev/null || true)"
  [ "$account" = "(unset)" ] && account=""

  say "gcloud account   : ${account:-<none>}"
  say "target project   : $PROJECT_ID ($PROJECT_NUMBER)"
  say "region           : $REGION"
  say "deployer SA      : $DEPLOYER_SA"
  say "runtime SA       : $RUNTIME_SA"
  say "AR repository    : ${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}"
  say "WIF provider     : $PROVIDER_NAME"
  say "GitHub repo      : $GITHUB_REPO"
  say "DRY_RUN          : $DRY_RUN"

  if [ -z "$account" ] && [ "$DRY_RUN" != "1" ]; then
    die "no active gcloud account. Run: gcloud auth login"
  fi
  if [ -n "${EXPECT_ACCOUNT:-}" ] && [ "$account" != "$EXPECT_ACCOUNT" ]; then
    die "active account '$account' is not the expected '$EXPECT_ACCOUNT'."
  fi
}

check_prerequisites() {
  step "Prerequisites (never created here)"
  if [ "$DRY_RUN" = "1" ]; then
    show_cmd gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
      --workload-identity-pool="$WIF_POOL" --location=global --project="$PROJECT_ID"
    show_cmd gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID"
    return 0
  fi
  local condition
  condition="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
    --workload-identity-pool="$WIF_POOL" --location=global --project="$PROJECT_ID" \
    --format='value(attributeCondition)' 2>/dev/null)" \
    || die "Workload Identity provider $PROVIDER_NAME not found; it must exist before this script runs."
  say "provider condition: ${condition:-<none>}"
  case "$condition" in
    *"${GITHUB_REPO%%/*}"*) : ;;
    *) warn "the provider's attribute condition does not mention the owner '${GITHUB_REPO%%/*}'; tokens from $GITHUB_REPO will be rejected until it does." ;;
  esac
  gcloud iam service-accounts describe "$RUNTIME_SA" --project="$PROJECT_ID" >/dev/null 2>&1 \
    || die "runtime service account $RUNTIME_SA not found; run infra/bootstrap.sh first."
}

create_deployer() {
  step "Deployer service account"
  if exists "service account $DEPLOYER_SA" \
      gcloud iam service-accounts describe "$DEPLOYER_SA" --project="$PROJECT_ID"; then
    say "already exists: $DEPLOYER_SA"
    return 0
  fi
  run gcloud iam service-accounts create "$DEPLOYER_SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="$SERVICE GitHub Actions deployer ($GITHUB_REPO)"
  if [ "$DRY_RUN" != "1" ]; then
    say "waiting for $DEPLOYER_SA to become visible to IAM ..."
    local attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
      if gcloud iam service-accounts describe "$DEPLOYER_SA" --project="$PROJECT_ID" >/dev/null 2>&1; then
        break
      fi
      sleep 5
    done
  fi
}

# Every add-iam-policy-binding below is idempotent: re-adding an existing binding is a no-op.
bind_roles() {
  step "IAM: push images"
  run_retry gcloud artifacts repositories add-iam-policy-binding "$AR_REPO" \
    --project="$PROJECT_ID" --location="$REGION" \
    --member="serviceAccount:$DEPLOYER_SA" \
    --role="roles/artifactregistry.writer"

  step "IAM: deploy the service (create it, update it, keep it public)"
  # --condition=None: the binding is unconditional, and gcloud must not prompt when other bindings
  # in the project policy carry conditions.
  run_retry gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$DEPLOYER_SA" \
    --role="roles/run.admin" \
    --condition=None

  step "IAM: act as the runtime service account (only that one)"
  run_retry gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:$DEPLOYER_SA" \
    --role="roles/iam.serviceAccountUser"

  step "IAM: let the GitHub repository impersonate the deployer"
  run_retry gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER_SA" \
    --project="$PROJECT_ID" \
    --member="$PRINCIPAL" \
    --role="roles/iam.workloadIdentityUser"
}

summary() {
  step "Done"
  if [ "$DRY_RUN" = "1" ]; then
    say "DRY_RUN=1: nothing was created. Re-run without DRY_RUN to apply."
  fi
  cat <<EOS

Deployer service account : $DEPLOYER_SA
Impersonated by          : $PRINCIPAL

GitHub repository variables the pipeline reads (Settings > Secrets and variables > Actions > Variables,
or the gh commands below; none of these is a secret):

  gh variable set GCP_PROJECT_ID   --repo $GITHUB_REPO --body "$PROJECT_ID"
  gh variable set GCP_WIF_PROVIDER --repo $GITHUB_REPO --body "$PROVIDER_NAME"
  gh variable set GCP_DEPLOYER_SA  --repo $GITHUB_REPO --body "$DEPLOYER_SA"
  gh variable set PUBLIC_BASE_URL  --repo $GITHUB_REPO --body ""     # set to the custom hostname once it is mapped (infra/domain.sh)

If the first pipeline deploy fails with a permission error, the two most likely additions are
roles/secretmanager.viewer on the two mcp-bank secrets and roles/serviceusage.serviceUsageConsumer
on the project, both for $DEPLOYER_SA.
EOS
}

main() {
  preflight
  check_prerequisites
  create_deployer
  bind_roles
  summary
}

main "$@"
