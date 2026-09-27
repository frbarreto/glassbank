#!/usr/bin/env bash
#
# Glass Bank - download the X-ray event log as JSONL (block: infra; D-27, docs/DEPLOYMENT.md section 18).
#
#   infra/export.sh                                # the live service, every event
#   infra/export.sh http://localhost:8080          # a local server started with XRAY_ADMIN_TOKEN set
#   EXPORT_QUERY='lane=public' infra/export.sh     # the public lane only; needs no token
#   EXPORT_QUERY='after=1234' infra/export.sh      # only what is newer than a previous export
#
# Calls GET <base>/xray/api/export (contracts v0.8) and writes
# exports/xray-<host>-<UTC stamp>[-<query>].jsonl (git-ignored): one event per line, oldest first,
# verbatim as the server stored it. Then prints how many events the file holds and the last id,
# which is the `after=` of the next export.
#
# The admin token comes from XRAY_ADMIN_TOKEN when it is set, otherwise from the Secret Manager
# secret the deploy mounts (mcp-bank-admin-token). It reaches curl on stdin, never on a command
# line (`ps` would show it), and is never written to disk. The in-memory log is lost on every
# restart, push to main and `make pause`: run this first when a session is worth keeping.
#
# DRY_RUN=1 prints the commands and downloads nothing. Knobs: EXPORT_BASE_URL (same as the
# argument), EXPORT_QUERY, EXPORT_DIR, PROJECT_ID, ADMIN_TOKEN_SECRET, CURL_TIMEOUT.

set -euo pipefail

BASE_URL="${1:-${EXPORT_BASE_URL:-https://glassbank-mcp.abovethefog.app}}"
BASE_URL="${BASE_URL%/}"
EXPORT_QUERY="${EXPORT_QUERY:-}"
PROJECT_ID="${PROJECT_ID:-lake-fraude}"
ADMIN_TOKEN_SECRET="${ADMIN_TOKEN_SECRET:-mcp-bank-admin-token}"
CURL_TIMEOUT="${CURL_TIMEOUT:-300}"
DRY_RUN="${DRY_RUN:-0}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_DIR="${EXPORT_DIR:-$REPO_ROOT/exports}"

say()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

host="$(printf '%s' "$BASE_URL" | sed -E 's#^[a-z]+://##; s#[/:].*$##')"
url="$BASE_URL/xray/api/export${EXPORT_QUERY:+?$EXPORT_QUERY}"
# The query goes into the name (`...-lane-public.jsonl`), so two exports in one second never collide.
scope="$(printf '%s' "$EXPORT_QUERY" | tr -c 'A-Za-z0-9' '-' | sed -E 's/-+/-/g; s/^-//; s/-$//')"
out="$EXPORT_DIR/xray-$host-$(date -u +%Y%m%dT%H%M%SZ)${scope:+-$scope}.jsonl"
is_local=0
case "$BASE_URL" in http://*|*://localhost*|*://127.0.0.1*) is_local=1 ;; esac

# The public lane is readable by anyone (D-26); everything else needs the admin token.
needs_token=1
case "&$EXPORT_QUERY&" in *'&lane=public&'*) needs_token=0 ;; esac

token=""
if [ "$needs_token" = 1 ]; then
  if [ -n "${XRAY_ADMIN_TOKEN:-}" ]; then
    token="$XRAY_ADMIN_TOKEN"
  elif [ "$is_local" = 1 ]; then
    die "a local server has no Secret Manager token: start it with XRAY_ADMIN_TOKEN=<32+ chars>, run this with the same XRAY_ADMIN_TOKEN, or use EXPORT_QUERY='lane=public'."
  else
    say "+ gcloud secrets versions access latest --secret=$ADMIN_TOKEN_SECRET --project=$PROJECT_ID"
    if [ "$DRY_RUN" != "1" ]; then
      token="$(gcloud secrets versions access latest --secret="$ADMIN_TOKEN_SECRET" --project="$PROJECT_ID")" \
        || die "could not read the admin token from Secret Manager (gcloud auth login?)"
    fi
  fi
fi

say "+ curl $url -> $out$([ "$needs_token" = 1 ] && printf ' (Authorization: Bearer <admin token>, on stdin)')"
[ "$DRY_RUN" = "1" ] && exit 0

mkdir -p "$EXPORT_DIR"
code="$(printf 'Authorization: Bearer %s\n' "$token" \
  | curl -sS --max-time "$CURL_TIMEOUT" $([ "$needs_token" = 1 ] && printf -- '-H @-') \
      -o "$out" -w '%{http_code}' "$url")" || { rm -f "$out"; die "curl could not reach $url"; }

if [ "$code" != "200" ]; then
  body="$(head -c 400 "$out" 2>/dev/null || true)"
  rm -f "$out"
  case "$code" in
    404) die "404 from $url: a server older than contracts v0.8, or the service is paused (make resume). $body" ;;
    *)   die "$code from $url: $body" ;;
  esac
fi

events="$(wc -l < "$out" | tr -d ' ')"
last_id="$(tail -n 1 "$out" | sed -nE 's/^\{"id":([0-9]+),.*/\1/p')"
say "$events events -> $out"
[ -n "$last_id" ] && say "last id $last_id: EXPORT_QUERY='after=$last_id' fetches only what comes next."
exit 0
