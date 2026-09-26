#!/usr/bin/env bash
#
# Glass Bank - pause and resume the Cloud Run service (block: infra; D-25, docs/DEPLOYMENT.md section 6).
#
#   infra/pause.sh pause    delete the service: stops the bill; secrets, IAM, images and the
#                           domain mapping stay. There is no softer pause: --min-instances=0 would
#                           stop the heartbeats, TTL eviction and SSE fan-out (invariant 2).
#   infra/pause.sh resume   redeploy the newest image in Artifact Registry (or RESUME_TAG) through
#                           infra/deploy.sh, which owns every gcloud run flag. The run.app URL is
#                           derived from the service name and project number, so it comes back
#                           identical; the custom hostname follows once the mapping re-attaches.
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

say()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
show_cmd() { printf '+ '; printf '%q ' "$@"; printf '\n'; }
run() {
  show_cmd "$@"
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  "$@"
}

service_exists() {
  gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1
}

pause() {
  if [ "$DRY_RUN" != "1" ] && ! service_exists; then
    say "already paused: no service $SERVICE in $PROJECT_ID / $REGION."
    return 0
  fi
  run gcloud run services delete "$SERVICE" --project="$PROJECT_ID" --region="$REGION" --quiet
  say "paused. Resume with: make resume   (or infra/pause.sh resume)"
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
  say "if a custom hostname was mapped (D-25), confirm it answers; if not, re-run infra/domain.sh."
}

case "${1:-}" in
  pause)  pause ;;
  resume) resume ;;
  *) die "usage: infra/pause.sh pause|resume" ;;
esac
