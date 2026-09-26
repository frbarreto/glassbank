#!/usr/bin/env bash
#
# Glass Bank - map the custom hostname to the Cloud Run service (block: infra; decision D-25,
# docs/DEPLOYMENT.md section 16).
#
# Two projects are involved and only two resources are ever touched:
#   - the domain mapping, next to the service, in PROJECT_ID (lake-fraude);
#   - one CNAME record for DOMAIN in the Cloud DNS zone of the domain, in DNS_PROJECT
#     (abovethefog, zone abovethefog-app). The zone's apex, `www` and every other record are
#     never read for writing, never modified, never deleted.
#
# Usage:
#   infra/domain.sh            # create the mapping and the record if missing, then print the status
#   infra/domain.sh status     # print the mapping status (certificate provisioning) and the record
#   DRY_RUN=1 infra/domain.sh  # print every command, change nothing
#
# Afterwards: set the GitHub repository variable PUBLIC_BASE_URL=https://<DOMAIN> and redeploy
# (push to main, or dispatch the pipeline with the current image tag), so the OAuth metadata and
# the pairing links name the hostname (invariant 4, A-36). The run.app host stays in PUBLIC_HOSTS.
#
# Knobs: PROJECT_ID, REGION, SERVICE, DOMAIN, DNS_PROJECT, DNS_ZONE, TTL, EXPECT_ACCOUNT.
# Needs the gcloud beta component (`gcloud components install beta`).

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-lake-fraude}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mcp-bank}"
# DOMAIN, not HOSTNAME: bash pre-sets HOSTNAME to the machine name.
HOSTNAME_TO_MAP="${DOMAIN:-glassbank-mcp.abovethefog.app}"
DNS_PROJECT="${DNS_PROJECT:-abovethefog}"
DNS_ZONE="${DNS_ZONE:-abovethefog-app}"
TTL="${TTL:-300}"
DRY_RUN="${DRY_RUN:-0}"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
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
  say "gcloud account   : ${account:-<none>}"
  say "service          : $SERVICE ($PROJECT_ID / $REGION)"
  say "hostname         : $HOSTNAME_TO_MAP"
  say "DNS zone         : $DNS_ZONE in $DNS_PROJECT (ttl $TTL)"
  say "DRY_RUN          : $DRY_RUN"
  if [ -n "${EXPECT_ACCOUNT:-}" ] && [ "$account" != "$EXPECT_ACCOUNT" ]; then
    die "active account '$account' is not the expected '$EXPECT_ACCOUNT'."
  fi

  # Never touch the apex or www: the site that lives there is not ours to change (D-25).
  local zone_dns
  if [ "$DRY_RUN" = "1" ]; then
    zone_dns="<zone dnsName>"
  else
    zone_dns="$(gcloud dns managed-zones describe "$DNS_ZONE" --project="$DNS_PROJECT" --format='value(dnsName)')" \
      || die "Cloud DNS zone $DNS_ZONE not found in $DNS_PROJECT."
    zone_dns="${zone_dns%.}"
    say "zone dnsName     : $zone_dns"
    case "$HOSTNAME_TO_MAP" in
      "$zone_dns"|"www.$zone_dns") die "refusing to touch $HOSTNAME_TO_MAP: the apex and www are off limits." ;;
      *."$zone_dns") : ;;
      *) die "$HOSTNAME_TO_MAP is not inside the zone $zone_dns." ;;
    esac
  fi

  if [ "$DRY_RUN" != "1" ]; then
    gcloud components list --filter='id:beta' --format='value(state.name)' 2>/dev/null | grep -qi installed \
      || die "the gcloud beta component is missing: gcloud components install beta"
    gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1 \
      || die "service $SERVICE not found in $PROJECT_ID / $REGION; deploy first (pipeline or make deploy)."
    local apex="${HOSTNAME_TO_MAP#*.}"
    if ! gcloud domains list-user-verified --format='value(id)' 2>/dev/null | grep -qx "$apex"; then
      warn "$apex is not listed by 'gcloud domains list-user-verified' for this account; the mapping may be refused."
    fi
  fi
}

mapping_exists() {
  gcloud beta run domain-mappings describe --domain="$HOSTNAME_TO_MAP" \
    --project="$PROJECT_ID" --region="$REGION" >/dev/null 2>&1
}

create_mapping() {
  step "Domain mapping in $PROJECT_ID"
  if [ "$DRY_RUN" != "1" ] && mapping_exists; then
    say "already exists: mapping for $HOSTNAME_TO_MAP"
    return 0
  fi
  run gcloud beta run domain-mappings create --service="$SERVICE" --domain="$HOSTNAME_TO_MAP" \
    --project="$PROJECT_ID" --region="$REGION"
}

create_record() {
  step "CNAME record in $DNS_PROJECT / $DNS_ZONE"
  local rrtype rrdata
  if [ "$DRY_RUN" = "1" ]; then
    rrtype="CNAME"; rrdata="ghs.googlehosted.com."
    say "# the mapping's status.resourceRecords say what to create; for a subdomain it is:"
  else
    rrtype="$(gcloud beta run domain-mappings describe --domain="$HOSTNAME_TO_MAP" \
      --project="$PROJECT_ID" --region="$REGION" --format='value(status.resourceRecords[0].type)')"
    rrdata="$(gcloud beta run domain-mappings describe --domain="$HOSTNAME_TO_MAP" \
      --project="$PROJECT_ID" --region="$REGION" --format='value(status.resourceRecords[0].rrdata)')"
    [ -n "$rrtype" ] && [ -n "$rrdata" ] || die "the mapping reports no resource record yet; wait a minute and re-run."
    [ "$rrtype" = "CNAME" ] || die "expected a CNAME record for a subdomain, the mapping asks for $rrtype $rrdata."
    say "mapping asks for : $rrtype $rrdata"
    local existing
    existing="$(gcloud dns record-sets describe "$HOSTNAME_TO_MAP." --zone="$DNS_ZONE" --project="$DNS_PROJECT" \
      --type=CNAME --format='value(rrdatas[0])' 2>/dev/null || true)"
    if [ -n "$existing" ]; then
      if [ "$existing" = "$rrdata" ]; then
        say "already exists: $HOSTNAME_TO_MAP. CNAME $existing"
      else
        die "$HOSTNAME_TO_MAP. already has CNAME $existing (wanted $rrdata); not overwriting an existing record."
      fi
      return 0
    fi
  fi
  run gcloud dns record-sets create "$HOSTNAME_TO_MAP." --zone="$DNS_ZONE" --project="$DNS_PROJECT" \
    --type="$rrtype" --ttl="$TTL" --rrdatas="$rrdata"
}

status() {
  step "Status"
  if [ "$DRY_RUN" = "1" ]; then
    show_cmd gcloud beta run domain-mappings describe --domain="$HOSTNAME_TO_MAP" \
      --project="$PROJECT_ID" --region="$REGION" --format='yaml(status.conditions)'
    return 0
  fi
  gcloud beta run domain-mappings describe --domain="$HOSTNAME_TO_MAP" \
    --project="$PROJECT_ID" --region="$REGION" --format='yaml(status.conditions,status.mappedRouteName)' || true
  say ""
  say "record           : $(gcloud dns record-sets describe "$HOSTNAME_TO_MAP." --zone="$DNS_ZONE" --project="$DNS_PROJECT" --type=CNAME --format='value(rrdatas[0])' 2>/dev/null || echo '<none>')"
  say "resolves to      : $(dig +short "$HOSTNAME_TO_MAP" @1.1.1.1 2>/dev/null | tr '\n' ' ')"
  cat <<EOS

Certificate provisioning usually takes 15 minutes, up to an hour ("CertificateProvisioned" above).
Then:  curl -sI https://$HOSTNAME_TO_MAP/health | head -1
       gh variable set PUBLIC_BASE_URL --repo frbarreto/glassbank --body "https://$HOSTNAME_TO_MAP"
       and redeploy (push to main, or dispatch the pipeline with the current image tag).
EOS
}

main() {
  case "${1:-}" in
    status) preflight; status ;;
    "")     preflight; create_mapping; create_record; status ;;
    *)      die "usage: infra/domain.sh [status]" ;;
  esac
}

main "$@"
