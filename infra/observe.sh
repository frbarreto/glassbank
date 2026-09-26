#!/usr/bin/env bash
#
# Glass Bank - uptime check and alert on /health (block: infra; go-live Phase 4,
# docs/DEPLOYMENT.md section 17).
#
# Creates, idempotently and inside the Cloud Monitoring free tier:
#   - an email notification channel ("Glass Bank alerts")
#   - an uptime check "glass-bank-health": GET https://<HOST>/health every 5 minutes, 10 s timeout,
#     expects 200 and the text "status":"ok"
#   - an alert policy "Glass Bank /health down": opens an incident and emails the channel when the
#     check has been failing for 10 minutes (the console's default shape for uptime alerts)
#
# Usage:
#   infra/observe.sh             # create what is missing, print the three resource names
#   DRY_RUN=1 infra/observe.sh   # print every command, change nothing
#
# Knobs: PROJECT_ID, PROJECT_NUMBER, REGION, SERVICE, HOST (default: the deterministic run.app host,
# which never changes), ALERT_EMAIL (default: the active gcloud account; never written to the repo),
# EXPECT_ACCOUNT. Needs the gcloud beta component for the channel command.
#
# `make pause` disables the alert policy before deleting the service and `make resume` re-enables it
# (infra/pause.sh), so a planned pause sends no email.

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lake-fraude}"
PROJECT_NUMBER="${PROJECT_NUMBER:-520283334162}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mcp-bank}"
HOST="${HOST:-${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app}"
CHECK_NAME="${CHECK_NAME:-glass-bank-health}"
CHANNEL_NAME="${CHANNEL_NAME:-Glass Bank alerts}"
POLICY_NAME="${POLICY_NAME:-Glass Bank /health down}"
DRY_RUN="${DRY_RUN:-0}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
show_cmd() { printf '+ '; printf '%q ' "$@"; printf '\n'; }
run() {
  show_cmd "$@"
  if [ "$DRY_RUN" = "1" ]; then return 0; fi
  "$@"
}

preflight() {
  step "Preflight"
  command -v gcloud >/dev/null 2>&1 || die "gcloud is not on PATH."
  local account
  account="$(gcloud config get-value account 2>/dev/null || true)"
  [ "$account" = "(unset)" ] && account=""
  ALERT_EMAIL="${ALERT_EMAIL:-$account}"
  say "gcloud account   : ${account:-<none>}"
  say "project          : $PROJECT_ID"
  say "checked URL      : https://$HOST/health"
  say "alert email      : $([ -n "$ALERT_EMAIL" ] && echo "<set, not printed>" || echo "<none>")"
  say "DRY_RUN          : $DRY_RUN"
  if [ -z "$ALERT_EMAIL" ] && [ "$DRY_RUN" != "1" ]; then
    die "no ALERT_EMAIL and no active gcloud account to derive it from."
  fi
  if [ -n "${EXPECT_ACCOUNT:-}" ] && [ "$account" != "$EXPECT_ACCOUNT" ]; then
    die "active account '$account' is not the expected '$EXPECT_ACCOUNT'."
  fi
}

ensure_channel() {
  step "Notification channel"
  CHANNEL=""
  if [ "$DRY_RUN" != "1" ]; then
    # This API applies the filter server-side: snake_case fields, double-quoted strings.
    CHANNEL="$(gcloud beta monitoring channels list --project="$PROJECT_ID" \
      --filter="display_name=\"$CHANNEL_NAME\" AND type=\"email\"" --format='value(name)' 2>/dev/null | head -1 || true)"
  fi
  if [ -n "$CHANNEL" ]; then
    say "already exists: $CHANNEL"
    return 0
  fi
  # The email address is passed on the command line only; it is never stored in the repository.
  show_cmd gcloud beta monitoring channels create --project="$PROJECT_ID" \
    --display-name="$CHANNEL_NAME" --type=email --channel-labels=email_address='<ALERT_EMAIL>' --format='value(name)'
  if [ "$DRY_RUN" = "1" ]; then
    CHANNEL="projects/$PROJECT_ID/notificationChannels/<new>"
    return 0
  fi
  CHANNEL="$(gcloud beta monitoring channels create --project="$PROJECT_ID" \
    --display-name="$CHANNEL_NAME" --type=email --channel-labels="email_address=$ALERT_EMAIL" --format='value(name)')"
  say "created: $CHANNEL"
}

ensure_check() {
  step "Uptime check"
  CHECK=""
  if [ "$DRY_RUN" != "1" ]; then
    CHECK="$(gcloud monitoring uptime list-configs --project="$PROJECT_ID" \
      --filter="displayName='$CHECK_NAME'" --format='value(name)' 2>/dev/null | head -1 || true)"
  fi
  if [ -n "$CHECK" ]; then
    say "already exists: $CHECK"
    return 0
  fi
  run gcloud monitoring uptime create "$CHECK_NAME" --project="$PROJECT_ID" \
    --resource-type=uptime-url --resource-labels="host=$HOST,project_id=$PROJECT_ID" \
    --protocol=https --port=443 --path=/health --validate-ssl=true \
    --period=5 --timeout=10 --status-codes=200 \
    --matcher-type=contains-string --matcher-content='"status":"ok"'
  if [ "$DRY_RUN" = "1" ]; then
    CHECK="projects/$PROJECT_ID/uptimeCheckConfigs/<new>"
    return 0
  fi
  CHECK="$(gcloud monitoring uptime list-configs --project="$PROJECT_ID" \
    --filter="displayName='$CHECK_NAME'" --format='value(name)' | head -1)"
  [ -n "$CHECK" ] || die "the uptime check was not found after creation."
  say "created: $CHECK"
}

ensure_policy() {
  step "Alert policy"
  POLICY=""
  if [ "$DRY_RUN" != "1" ]; then
    POLICY="$(gcloud monitoring policies list --project="$PROJECT_ID" \
      --filter="displayName='$POLICY_NAME'" --format='value(name)' 2>/dev/null | head -1 || true)"
  fi
  if [ -n "$POLICY" ]; then
    say "already exists: $POLICY"
    return 0
  fi
  local check_id tmp
  check_id="${CHECK##*/}"
  tmp="$(mktemp)"
  cat > "$tmp" <<EOS
{
  "displayName": "$POLICY_NAME",
  "combiner": "OR",
  "enabled": true,
  "documentation": {
    "mimeType": "text/markdown",
    "content": "The uptime check on https://$HOST/health has failed for 10 minutes. Diagnose: docs/DEPLOYMENT.md section 10. Roll back: section 5. Paused on purpose (make pause)? Expected; disable this policy meanwhile."
  },
  "conditions": [
    {
      "displayName": "/health uptime check failing",
      "conditionThreshold": {
        "filter": "metric.type=\\"monitoring.googleapis.com/uptime_check/check_passed\\" AND resource.type=\\"uptime_url\\" AND metric.label.check_id=\\"$check_id\\"",
        "aggregations": [
          {
            "alignmentPeriod": "1200s",
            "perSeriesAligner": "ALIGN_NEXT_OLDER",
            "crossSeriesReducer": "REDUCE_COUNT_FALSE",
            "groupByFields": ["resource.label.*"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 1,
        "duration": "600s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "notificationChannels": ["$CHANNEL"]
}
EOS
  say "# policy body ($tmp):"
  sed 's/^/#   /' "$tmp"
  run gcloud monitoring policies create --project="$PROJECT_ID" --policy-from-file="$tmp"
  rm -f "$tmp"
  if [ "$DRY_RUN" = "1" ]; then
    POLICY="projects/$PROJECT_ID/alertPolicies/<new>"
    return 0
  fi
  POLICY="$(gcloud monitoring policies list --project="$PROJECT_ID" \
    --filter="displayName='$POLICY_NAME'" --format='value(name)' | head -1)"
  say "created: $POLICY"
}

summary() {
  step "Done"
  cat <<EOS
Channel : $CHANNEL
Check   : $CHECK    (https://$HOST/health every 5 minutes)
Policy  : $POLICY

Console: https://console.cloud.google.com/monitoring/uptime?project=$PROJECT_ID
Silence while paused:  gcloud monitoring policies update $POLICY --project=$PROJECT_ID --no-enabled
EOS
}

main() {
  preflight
  ensure_channel
  ensure_check
  ensure_policy
  summary
}

main "$@"
