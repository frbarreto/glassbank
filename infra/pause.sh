#!/usr/bin/env bash
#
# Glass Bank - pause and resume the Cloud Run service (block: infra; D-25, docs/DEPLOYMENT.md section 6).
#
#   infra/pause.sh pause    delete the service: stops the bill; secrets, IAM, images, the domain
#                           mapping and the uptime check stay, and the alert policy is disabled so
#                           the planned outage sends no email. A push to main while paused does not
#                           deploy (the pipeline skips a push when the service is absent). There is
#                           no softer pause: --min-instances=0 would stop the heartbeats, TTL
#                           eviction and SSE fan-out (invariant 2).
#   infra/pause.sh resume   redeploy the newest image in Artifact Registry (or RESUME_TAG) through
#                           infra/deploy.sh, which owns every gcloud run flag and picks the mapped
#                           hostname as PUBLIC_BASE_URL; then re-enable the alert policy. The run.app
#                           URL is derived from the service name and project number, so it comes back
#                           identical. The pipeline's "Run workflow" button resumes too.
#
# DRY_RUN=1 prints the commands and changes nothing. Knobs: PROJECT_ID, REGION, SERVICE, AR_REPO,
# RESUME_TAG, plus everything infra/deploy.sh reads (ORIGIN_POLICY, PUBLIC_BASE_URL, ...).

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lake-fraude}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mcp-bank}"
AR_REPO="${AR_REPO:-lake-fraude}"
DRY_RUN="${DRY_RUN:-0}"
IMAGE_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POLICY_NAME="${POLICY_NAME:-Glass Bank /health down}"   # created by infra/observe.sh

say()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
show_cmd() { printf '+ '; printf '%q ' "$@"; printf '\n'; }
run() {
  show_cmd "$@"
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  "$@"
}

# Enables or disables the uptime alert policy, if infra/observe.sh created one.
set_alert() {
  local flag="$1" policy=""
  if [ "$DRY_RUN" != "1" ]; then
    policy="$(gcloud monitoring policies list --project="$PROJECT_ID" \
      --filter="displayName='$POLICY_NAME'" --format='value(name)' 2>/dev/null | head -1 || true)"
    [ -n "$policy" ] || { say "no alert policy named '$POLICY_NAME'; nothing to toggle."; return 0; }
  else
    policy="<policy named '$POLICY_NAME'>"
  fi
  run gcloud monitoring policies update "$policy" --project="$PROJECT_ID" "$flag" --quiet
}

service_exists() {
  gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1
}

pause() {
  if [ "$DRY_RUN" != "1" ] && ! service_exists; then
    say "already paused: no service $SERVICE in $PROJECT_ID / $REGION."
    return 0
  fi
  set_alert --no-enabled
  run gcloud run services delete "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --quiet
  say "paused: the service is deleted and billing for it has stopped."
  say "resume with: make resume   (or GitHub > Actions > pipeline > Run workflow)"
}

resume() {
  local tag="${RESUME_TAG:-}"
  if [ -z "$tag" ]; then
    show_cmd gcloud artifacts docker images list "$IMAGE_PATH" --project="$PROJECT_ID" \
      --include-tags --sort-by=~UPDATE_TIME --limit=1 --format='value(tags)'
    if [ "$DRY_RUN" = "1" ]; then
      tag="<newest tag in Artifact Registry>"
    else
      tag="$(gcloud artifacts docker images list "$IMAGE_PATH" --project="$PROJECT_ID" \
        --include-tags --sort-by=~UPDATE_TIME --limit=1 --format='value(tags)' | cut -d, -f1)"
      [ -n "$tag" ] || die "no image found under $IMAGE_PATH; push one through the pipeline or run make deploy."
    fi
  fi
  say "resuming $SERVICE from $IMAGE_PATH:$tag"
  SKIP_BUILD=1 IMAGE_TAG="$tag" DRY_RUN="$DRY_RUN" "$REPO_ROOT/infra/deploy.sh"
  set_alert --enabled
  say "resumed. Check: ./infra/smoke.sh <base URL printed above>"
}

case "${1:-}" in
  pause)  pause ;;
  resume) resume ;;
  *) die "usage: infra/pause.sh pause|resume" ;;
esac
