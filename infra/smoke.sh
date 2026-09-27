#!/usr/bin/env bash
#
# Glass Bank - post-deploy verification (block: infra).
#
# Runs Anthropic's MCP connector troubleshooting checklist plus the deployment invariant
# assertions of docs/DEPLOYMENT.md section 1.3, against any base URL:
#
#   infra/smoke.sh                                   # against the live Cloud Run status.url
#   infra/smoke.sh http://localhost:8080             # against a local `npm run dev` or container
#   infra/smoke.sh https://x.trycloudflare.com       # against the cloudflared tunnel
#
# Checks (each is independent; the script always runs them all and exits 1 if any failed):
#   1  DNS resolves to public IPv4 addresses (no private/CGNAT space, not AAAA-only)
#   2  no redirect from /mcp or the well-known paths to a different host
#   3  POST /mcp without a bearer answers 401 + WWW-Authenticate: Bearer ... resource_metadata=...
#   4  on every PUBLIC_HOSTS entry: PRM at /.well-known/oauth-protected-resource/mcp with a
#      `resource` matching the host queried, PRM at the root path, and AS metadata whose `issuer`
#      matches the host queried and which advertises registration, S256, code + refresh_token
#      and the "none" token endpoint auth method
#   5  /health answers 200 and reports the active Origin policy (never /healthz: Google's front end swallows it on Cloud Run)
#   6  Cloud Run invariants: minScale 1, maxScale 1, cpu-throttling false, timeoutSeconds 3600
#   7  Cloud Run IAM is public (allUsers)
#   8  every discovery endpoint answers well inside Claude's 10 s budget
#   9  30 consecutive POST /register calls from this IP return no 429 (A-43: Anthropic's shared
#      160.79.104.0/21 egress must not be locked out)
#  10  the X-ray dashboard is actually shipped: /xray/ and /xray/app.js answer 200, and the JSON
#      API under /xray/api answers 401 rather than 404 (the container used to carry no public/,
#      so every tool call handed the user an xray_get_session_link URL that led to a 404); and
#      the landing page at / answers 200 and names <base>/mcp (a bare domain used to answer 404)
#  11  the public lane (D-26): POST /public/mcp initializes with no bearer and no challenge, lists
#      the six public tools and none of the signed-in ones, and /xray/api/me?lane=public answers
#      200 with no cookie; skipped when /public/mcp answers 404 (PUBLIC_MCP=false)
#  12  the export (D-27): GET /xray/api/export?lane=public answers 200 as application/x-ndjson with
#      no credential, and GET /xray/api/export with none answers 401
#
# Checks 1, 6 and 7 are skipped when the target is local (localhost / 127.0.0.1 / an http:// URL):
# a laptop has no public A record and there is no Cloud Run service to describe.
#
# Environment knobs:
#   SMOKE_BASE_URL        same as the positional argument
#   SMOKE_HOSTS           ';'- or space-separated host list to check discovery on
#                         (default in the cloud: status.url host + the deterministic run.app host)
#   PROJECT_ID REGION SERVICE PROJECT_NUMBER
#   CURL_TIMEOUT          per-request timeout in seconds (default 15)
#   DISCOVERY_BUDGET_S    discovery latency budget in seconds (default 10)
#   REGISTER_ATTEMPTS     number of /register calls in check 9 (default 30)
#   DRY_RUN=1             print what would be checked and exit 0 without touching the network

# Deliberately no `set -e`: a smoke test must run every check and report all of them, not stop at
# the first failure. Unset variables and broken pipes are still errors.
set -uo pipefail

PROJECT_ID="${PROJECT_ID:-lake-fraude}"
PROJECT_NUMBER="${PROJECT_NUMBER:-520283334162}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-mcp-bank}"
CURL_TIMEOUT="${CURL_TIMEOUT:-15}"
DISCOVERY_BUDGET_S="${DISCOVERY_BUDGET_S:-10}"
REGISTER_ATTEMPTS="${REGISTER_ATTEMPTS:-30}"
DRY_RUN="${DRY_RUN:-0}"

PASSED=0
FAILED=0
SKIPPED=0

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
pass() { PASSED=$((PASSED + 1)); printf '  PASS  %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf '  FAIL  %s\n' "$*"; }
skip() { SKIPPED=$((SKIPPED + 1)); printf '  SKIP  %s\n' "$*"; }
info() { printf '        %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 2; }

# check_that <pass message> <fail message> <command...>
check_that() {
  local ok_msg="$1" bad_msg="$2"; shift 2
  if "$@"; then pass "$ok_msg"; else fail "$bad_msg"; fi
}

# ---------------------------------------------------------------------------------------------
# HTTP helpers. Every call is best-effort: a transport failure becomes status 000 and an empty
# body, so one broken endpoint never aborts the run.
# ---------------------------------------------------------------------------------------------
# Fixed paths, not variables assigned inside the call: `http` runs in a command substitution, so
# any variable it assigns would be lost with the subshell. The files survive; the variables do not.
BODY="$WORK_DIR/body"        # body of the last response
HEADERS="$WORK_DIR/headers"  # headers of the last response

http() {
  # http <method> <url> [curl args...] -> echoes the status code
  local method="$1" url="$2"; shift 2
  : > "$BODY"
  : > "$HEADERS"
  local -a args=(-s --max-time "$CURL_TIMEOUT" -o "$BODY" -D "$HEADERS" -w '%{http_code}')
  if [ "$method" = "HEAD" ]; then
    # -X HEAD alone makes curl wait for a body that never arrives; --head is the correct flag.
    args+=(--head)
  else
    args+=(-X "$method")
  fi
  local code
  code="$(curl "${args[@]}" "$@" "$url" 2>/dev/null)" || code=""
  printf '%s' "${code:-000}"
}

http_time() {
  # http_time <url> -> echoes total seconds as a decimal
  local t
  t="$(curl -s -o /dev/null --max-time "$CURL_TIMEOUT" -w '%{time_total}' "$1" 2>/dev/null)" || t=""
  printf '%s' "${t:-999}"
}

header_value() {
  # header_value <name> -> echoes the (last) value of that response header, lowercased name match
  local name="$1"
  [ -f "$HEADERS" ] || return 0
  tr -d '\r' < "$HEADERS" \
    | awk -v want="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" \
      'BEGIN{IGNORECASE=1} { line=$0; idx=index(line, ":");
         if (idx > 0) { key=tolower(substr(line,1,idx-1));
           if (key==want) { v=substr(line, idx+1); sub(/^[ \t]+/, "", v); last=v } } }
       END { if (last != "") print last }'
}

json_string() {
  # json_string <file> <key> -> echoes the string value of a top-level key, or nothing
  local file="$1" key="$2"
  [ -s "$file" ] || return 0
  if command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$key" 'if type=="object" and has($k) and (.[$k]|type=="string") then .[$k] else empty end' \
      "$file" 2>/dev/null
  else
    grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null \
      | head -1 | sed 's/^.*:[[:space:]]*"//; s/"$//'
  fi
}

json_array_has() {
  # json_array_has <file> <key> <value> -> exit 0 when the array under <key> contains <value>
  local file="$1" key="$2" value="$3"
  [ -s "$file" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg k "$key" --arg v "$value" \
      '((.[$k] // []) | if type=="array" then index($v) != null else false end)' \
      "$file" >/dev/null 2>&1
  else
    # Fallback without jq: the value must appear somewhere in the document. Looser, but the
    # documents involved are small and flat.
    grep -q "\"$value\"" "$file"
  fi
}

json_has_key() {
  local file="$1" key="$2"
  [ -s "$file" ] || return 1
  if command -v jq >/dev/null 2>&1; then
    jq -e --arg k "$key" 'has($k)' "$file" >/dev/null 2>&1
  else
    grep -q "\"$key\"[[:space:]]*:" "$file"
  fi
}

# ---------------------------------------------------------------------------------------------
# Target resolution
# ---------------------------------------------------------------------------------------------
BASE_URL="${1:-${SMOKE_BASE_URL:-}}"
DETERMINISTIC_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"

resolve_target() {
  if [ -z "$BASE_URL" ]; then
    if [ "$DRY_RUN" = "1" ]; then
      BASE_URL="$DETERMINISTIC_URL"
    elif command -v gcloud >/dev/null 2>&1; then
      BASE_URL="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" \
        --region="$REGION" --format='value(status.url)' 2>/dev/null)" || BASE_URL=""
      if [ -z "$BASE_URL" ]; then
        # Not deployed yet, or no access. Fall back to the deterministic URL so the checks below
        # report the real problem instead of the script refusing to start.
        printf 'WARNING: could not read status.url for %s in %s; falling back to %s\n' \
          "$SERVICE" "$REGION" "$DETERMINISTIC_URL" >&2
        BASE_URL="$DETERMINISTIC_URL"
      fi
    fi
  fi
  [ -n "$BASE_URL" ] || die "no base URL. Pass one: infra/smoke.sh http://localhost:8080"

  BASE_URL="${BASE_URL%/}"
  case "$BASE_URL" in
    http://*)  SCHEME="http";  HOST="${BASE_URL#http://}"  ;;
    https://*) SCHEME="https"; HOST="${BASE_URL#https://}" ;;
    *) die "base URL must start with http:// or https://, got '$BASE_URL'." ;;
  esac
  HOSTNAME_ONLY="${HOST%%:*}"

  # Local target: no public DNS, no Cloud Run service behind it.
  IS_LOCAL=0
  case "$HOSTNAME_ONLY" in
    localhost|127.0.0.1|::1|*.localhost|*.local|0.0.0.0) IS_LOCAL=1 ;;
  esac
  [ "$SCHEME" = "http" ] && IS_LOCAL=1

  if [ -n "${SMOKE_HOSTS:-}" ]; then
    HOSTS="$(printf '%s' "$SMOKE_HOSTS" | tr ';' ' ')"
  elif [ "$IS_LOCAL" = "1" ]; then
    HOSTS="$HOST"
  else
    # Both run.app forms must serve a PRM whose resource matches the host queried (A-36).
    HOSTS="$HOST"
    local deterministic_host="${DETERMINISTIC_URL#https://}"
    [ "$deterministic_host" = "$HOST" ] || HOSTS="$HOSTS $deterministic_host"
  fi
}

# ---------------------------------------------------------------------------------------------
# 1. DNS: public IPv4 only
# ---------------------------------------------------------------------------------------------
check_dns() {
  step "1. DNS - public IPv4 A records only"
  if [ "$IS_LOCAL" = "1" ]; then
    skip "local target $HOSTNAME_ONLY: a laptop has no public A record (claude.ai can never reach it; use cloudflared)"
    return
  fi
  if ! command -v dig >/dev/null 2>&1; then
    skip "dig is not installed"
    return
  fi

  local a_records aaaa_records addr private_found=0
  a_records="$(dig +short A "$HOSTNAME_ONLY" 2>/dev/null | grep -E '^[0-9]+\.' || true)"
  aaaa_records="$(dig +short AAAA "$HOSTNAME_ONLY" 2>/dev/null | grep -E ':' || true)"

  if [ -z "$a_records" ]; then
    if [ -n "$aaaa_records" ]; then
      fail "$HOSTNAME_ONLY is AAAA-only; Anthropic's runtime needs a public IPv4 address"
    else
      fail "$HOSTNAME_ONLY does not resolve at all"
    fi
    return
  fi

  for addr in $a_records; do
    case "$addr" in
      10.*|127.*|169.254.*|192.168.*) private_found=1 ;;
      172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) private_found=1 ;;
      100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) private_found=1 ;;
    esac
    info "A $addr"
  done

  if [ "$private_found" = "1" ]; then
    fail "$HOSTNAME_ONLY resolves into private or CGNAT space; it is not reachable from Anthropic's runtime"
  else
    pass "$HOSTNAME_ONLY resolves to public IPv4 only"
  fi
}

# ---------------------------------------------------------------------------------------------
# 2. No cross-host redirect
# ---------------------------------------------------------------------------------------------
check_no_cross_host_redirect() {
  step "2. No redirect to a different host"
  local path code location target_host
  for path in /mcp /.well-known/oauth-protected-resource/mcp /.well-known/oauth-authorization-server; do
    code="$(http HEAD "$BASE_URL$path")"
    case "$code" in
      3??)
        location="$(header_value location)"
        target_host="$location"
        target_host="${target_host#http://}"
        target_host="${target_host#https://}"
        target_host="${target_host%%/*}"
        if [ -z "$target_host" ] || [ "$target_host" = "$HOST" ]; then
          pass "$path -> $code, same host ($location)"
        else
          fail "$path -> $code redirects to another host: $location (a top cause of connector failures)"
        fi
        ;;
      000) fail "$path -> no response (connection failed)" ;;
      *)   pass "$path -> $code, no redirect" ;;
    esac
  done
}

# ---------------------------------------------------------------------------------------------
# 3. The 401 challenge on POST /mcp
# ---------------------------------------------------------------------------------------------
check_401_challenge() {
  step "3. POST /mcp without a bearer token"
  local code challenge
  code="$(http POST "$BASE_URL/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')"

  if [ "$code" != "401" ]; then
    fail "expected 401, got $code (CLAUDE.md invariant 5: never 200 + isError for a missing token)"
    info "body: $(head -c 300 "$BODY" 2>/dev/null | tr -d '\n')"
    return
  fi
  pass "401 on an unauthenticated initialize"

  challenge="$(header_value www-authenticate)"
  if [ -z "$challenge" ]; then
    fail "no WWW-Authenticate header on the 401"
    return
  fi
  info "WWW-Authenticate: $challenge"
  case "$challenge" in
    Bearer*|bearer*) pass "challenge uses the Bearer scheme" ;;
    *) fail "challenge is not a Bearer challenge: $challenge" ;;
  esac
  case "$challenge" in
    *resource_metadata=*) pass "challenge carries resource_metadata" ;;
    *) fail "challenge has no resource_metadata parameter; Claude cannot find the PRM" ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# 4. Discovery documents on every hostname
# ---------------------------------------------------------------------------------------------
check_discovery_documents() {
  step "4. Discovery documents on every hostname"
  local host base code resource issuer
  for host in $HOSTS; do
    base="$SCHEME://$host"
    say "  --- $base"

    # 4a. PRM at the resource-specific path.
    code="$(http GET "$base/.well-known/oauth-protected-resource/mcp")"
    if [ "$code" != "200" ]; then
      fail "$base/.well-known/oauth-protected-resource/mcp -> $code (expected 200)"
    else
      resource="$(json_string "$BODY" resource)"
      if [ "$resource" = "$base/mcp" ]; then
        pass "PRM /mcp resource = $resource"
      else
        fail "PRM /mcp resource is '$resource', expected '$base/mcp' (A-36: it must match the host queried)"
      fi
      check_that "PRM lists $base as its authorization server" \
        "PRM does not list $base in authorization_servers" \
        json_array_has "$BODY" authorization_servers "$base"
    fi

    # 4b. PRM at the root path (Claude probes both).
    code="$(http GET "$base/.well-known/oauth-protected-resource")"
    if [ "$code" = "200" ]; then
      pass "PRM root path -> 200"
    else
      fail "$base/.well-known/oauth-protected-resource -> $code (expected 200)"
    fi

    # 4c. Authorization server metadata.
    code="$(http GET "$base/.well-known/oauth-authorization-server")"
    if [ "$code" != "200" ]; then
      fail "$base/.well-known/oauth-authorization-server -> $code (expected 200)"
      continue
    fi
    issuer="$(json_string "$BODY" issuer)"
    if [ "$issuer" = "$base" ]; then
      pass "AS issuer = $issuer"
    else
      fail "AS issuer is '$issuer', expected '$base'"
    fi
    check_that "AS advertises registration_endpoint (DCR)" \
      "AS has no registration_endpoint; claude.ai registers dynamically" \
      json_has_key "$BODY" registration_endpoint
    check_that "AS advertises PKCE S256" \
      "AS does not advertise S256 in code_challenge_methods_supported" \
      json_array_has "$BODY" code_challenge_methods_supported S256
    check_that "AS advertises the authorization_code grant" \
      "AS does not advertise the authorization_code grant" \
      json_array_has "$BODY" grant_types_supported authorization_code
    check_that "AS advertises the refresh_token grant" \
      "AS does not advertise the refresh_token grant" \
      json_array_has "$BODY" grant_types_supported refresh_token
    check_that "AS advertises the 'none' token endpoint auth method (public clients)" \
      "AS does not advertise 'none' in token_endpoint_auth_methods_supported" \
      json_array_has "$BODY" token_endpoint_auth_methods_supported none
  done
}

# ---------------------------------------------------------------------------------------------
# 5. /health
# ---------------------------------------------------------------------------------------------
ACTIVE_ORIGIN_POLICY=""
check_healthz() {
  step "5. /health"
  local code status
  code="$(http GET "$BASE_URL/health")"
  if [ "$code" != "200" ]; then
    fail "/health -> $code (expected 200)"
    return
  fi
  status="$(json_string "$BODY" status)"
  if [ "$status" = "ok" ]; then
    pass "/health -> 200, status=ok"
  else
    fail "/health -> 200 but status='$status' (expected 'ok')"
  fi
  info "boot_id: $(json_string "$BODY" boot_id)  version: $(json_string "$BODY" version)"
  ACTIVE_ORIGIN_POLICY="$(json_string "$BODY" origin_policy)"
}

# ---------------------------------------------------------------------------------------------
# 6 and 7. Cloud Run invariants and public IAM (docs/DEPLOYMENT.md section 1.3)
# ---------------------------------------------------------------------------------------------
check_cloud_run_invariants() {
  step "6. Cloud Run invariants (min=max=1, no CPU throttling, timeout 3600)"
  if [ "$IS_LOCAL" = "1" ]; then
    skip "local target: there is no Cloud Run service to describe"
    return
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    skip "gcloud is not installed"
    return
  fi

  local yaml matches
  yaml="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --format=yaml 2>/dev/null)" || yaml=""
  if [ -z "$yaml" ]; then
    fail "cannot describe Cloud Run service $SERVICE in $REGION (not deployed, or no access)"
    return
  fi

  # The documented assertion: exactly the four invariant lines must be present.
  matches="$(printf '%s\n' "$yaml" \
    | grep -Ec 'autoscaling\.knative\.dev/(minScale|maxScale): .1.|run\.googleapis\.com/cpu-throttling: .false.|timeoutSeconds: 3600')" || matches=0
  if [ "$matches" -eq 4 ]; then
    pass "all four invariant lines present (minScale 1, maxScale 1, cpu-throttling false, timeoutSeconds 3600)"
  else
    fail "expected 4 invariant lines, found $matches"
  fi

  # Individual values, so a failure says which one drifted.
  local min_scale max_scale throttling timeout
  min_scale="$(printf '%s\n' "$yaml" | grep -E 'autoscaling\.knative\.dev/minScale:' | head -1 | sed "s/.*: *['\"]*//; s/['\"]*$//")"
  max_scale="$(printf '%s\n' "$yaml" | grep -E 'autoscaling\.knative\.dev/maxScale:' | head -1 | sed "s/.*: *['\"]*//; s/['\"]*$//")"
  throttling="$(printf '%s\n' "$yaml" | grep -E 'run\.googleapis\.com/cpu-throttling:' | head -1 | sed "s/.*: *['\"]*//; s/['\"]*$//")"
  # The service's own field: the default startup probe also has a timeoutSeconds line (240), which
  # a grep over the YAML picked up on the first deploy (2026-09-26).
  timeout="$(gcloud run services describe "$SERVICE" --project="$PROJECT_ID" --region="$REGION" \
    --format='value(spec.template.spec.timeoutSeconds)' 2>/dev/null || true)"
  info "minScale=$min_scale maxScale=$max_scale cpu-throttling=$throttling timeoutSeconds=$timeout"

  [ "$min_scale" = "1" ] || fail "minScale is '$min_scale', must be 1 (correctness: in-process state)"
  [ "$max_scale" = "1" ] || fail "maxScale is '$max_scale', must be 1 (a second instance splits state)"
  [ "$throttling" = "false" ] || fail "cpu-throttling is '$throttling', must be false (SSE heartbeats and TTL eviction)"
  [ "$timeout" = "3600" ] || fail "timeoutSeconds is '$timeout', must be 3600"

  if printf '%s\n' "$yaml" | grep -q 'use-http2\|h2c'; then
    fail "HTTP/2 appears to be enabled; SSE must ride HTTP/1.1 chunked responses"
  else
    pass "no HTTP/2 on the service"
  fi
}

check_public_iam() {
  step "7. Cloud Run IAM is public"
  if [ "$IS_LOCAL" = "1" ]; then
    skip "local target: no Cloud Run IAM policy"
    return
  fi
  if ! command -v gcloud >/dev/null 2>&1; then
    skip "gcloud is not installed"
    return
  fi
  local policy
  policy="$(gcloud run services get-iam-policy "$SERVICE" --project="$PROJECT_ID" \
    --region="$REGION" 2>/dev/null)" || policy=""
  if printf '%s\n' "$policy" | grep -q allUsers; then
    pass "allUsers holds roles/run.invoker (A-16: claude.ai cannot present Google credentials)"
  else
    fail "allUsers is not bound; claude.ai will get a Google 403 before the app is ever reached"
  fi
}

# ---------------------------------------------------------------------------------------------
# 8. Discovery latency
# ---------------------------------------------------------------------------------------------
check_discovery_timing() {
  step "8. Discovery latency under ${DISCOVERY_BUDGET_S}s (Claude's budget)"
  local path elapsed
  for path in /.well-known/oauth-protected-resource/mcp \
              /.well-known/oauth-protected-resource \
              /.well-known/oauth-authorization-server; do
    elapsed="$(http_time "$BASE_URL$path")"
    if awk -v t="$elapsed" -v b="$DISCOVERY_BUDGET_S" 'BEGIN { exit !(t < b) }'; then
      pass "$path answered in ${elapsed}s"
    else
      fail "$path took ${elapsed}s, over the ${DISCOVERY_BUDGET_S}s budget"
    fi
  done
}

# ---------------------------------------------------------------------------------------------
# 9. /register must not rate-limit a shared egress
# ---------------------------------------------------------------------------------------------
check_register_rate_limit() {
  step "9. ${REGISTER_ATTEMPTS}x POST /register must not return 429 (A-43)"
  local i code count_429=0 count_ok=0 count_other=0 first_other=""
  for ((i = 1; i <= REGISTER_ATTEMPTS; i++)); do
    code="$(http POST "$BASE_URL/register" \
      -H 'content-type: application/json' \
      -d '{"redirect_uris":["http://127.0.0.1/callback"],"token_endpoint_auth_method":"none","application_type":"native"}')"
    case "$code" in
      429) count_429=$((count_429 + 1)) ;;
      200|201) count_ok=$((count_ok + 1)) ;;
      *) count_other=$((count_other + 1)); [ -z "$first_other" ] && first_other="$code" ;;
    esac
  done
  info "created=$count_ok  429=$count_429  other=$count_other${first_other:+ (first other status: $first_other)}"
  if [ "$count_429" -eq 0 ]; then
    pass "no 429 in $REGISTER_ATTEMPTS registrations"
  else
    fail "$count_429 of $REGISTER_ATTEMPTS registrations were rate-limited; RATE_LIMIT_IP_REGISTER is too low for Anthropic's shared 160.79.104.0/21 egress"
  fi
  if [ "$count_ok" -eq 0 ]; then
    fail "no registration succeeded; dynamic client registration is not working"
  fi
}

# ---------------------------------------------------------------------------------------------
# 10. The dashboard is in the image
# ---------------------------------------------------------------------------------------------
check_dashboard() {
  step "10. X-ray dashboard is served"
  local path code
  # The SPA shell and one of its modules: a runtime stage without `public/` answers 404 for both
  # while /health and the whole JSON API stay green, which is exactly how this shipped unnoticed.
  for path in /xray/ /xray/app.js; do
    code="$(http GET "$BASE_URL$path")"
    if [ "$code" = "200" ]; then
      pass "$path -> 200"
    else
      fail "$path -> $code (expected 200; is public/ in the image? see infra/Dockerfile)"
    fi
  done

  # The JSON API must be reachable and refuse an unpaired viewer, not 404.
  code="$(http GET "$BASE_URL/xray/api/me")"
  case "$code" in
    401|403) pass "/xray/api/me -> $code (unpaired viewer refused, invariant 11)" ;;
    404) fail "/xray/api/me -> 404; the X-ray router is not mounted" ;;
    200) fail "/xray/api/me -> 200 without a viewer cookie; the dashboard must never be public" ;;
    *) fail "/xray/api/me -> $code (expected 401 or 403)" ;;
  esac

  # The landing page: what a person sees when they type the bare domain.
  code="$(http GET "$BASE_URL/")"
  if [ "$code" = "200" ] && grep -qF "$BASE_URL/mcp" "$BODY"; then
    pass "/ -> 200, the landing page names $BASE_URL/mcp"
  else
    fail "/ -> $code; the landing page is missing or does not name $BASE_URL/mcp"
  fi
}

# ---------------------------------------------------------------------------------------------
# 11. The public lane (D-26)
# ---------------------------------------------------------------------------------------------
check_public_lane() {
  step "11. The public lane at /public/mcp"
  local code
  code="$(http POST "$BASE_URL/public/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"glass-bank-smoke","version":"0.1.0"}}}')"
  if [ "$code" = "404" ]; then
    skip "/public/mcp -> 404: the public lane is switched off (PUBLIC_MCP=false)"
    return
  fi
  if [ "$code" = "200" ] && grep -qF '"glass-bank-public"' "$BODY" && [ -z "$(header_value www-authenticate)" ]; then
    pass "initialize -> 200 with no bearer and no challenge"
  else
    fail "initialize -> $code; the public lane must answer 200 without a bearer and without WWW-Authenticate"
    info "body: $(head -c 300 "$BODY" 2>/dev/null | tr -d '\n')"
  fi

  code="$(http POST "$BASE_URL/public/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')"
  if [ "$code" = "200" ] && grep -qF '"search_prices"' "$BODY" && ! grep -qF '"load_accounts"' "$BODY"; then
    pass "tools/list -> the public tools, none of the signed-in ones"
  else
    fail "tools/list -> $code; expected the six public tools and no signed-in tool"
  fi

  code="$(http GET "$BASE_URL/xray/api/me?lane=public")"
  if [ "$code" = "200" ] && grep -qF '"lgn_public"' "$BODY"; then
    pass "/xray/api/me?lane=public -> 200 with no cookie"
  else
    fail "/xray/api/me?lane=public -> $code; the public lane of the dashboard is not served"
  fi
}

check_export() {
  step "12. The X-ray export at /xray/api/export"
  local code
  code="$(http GET "$BASE_URL/xray/api/export?lane=public")"
  if [ "$code" = "200" ] && header_value content-type | grep -qF 'application/x-ndjson'; then
    pass "/xray/api/export?lane=public -> 200 application/x-ndjson with no credential"
  else
    fail "/xray/api/export?lane=public -> $code ($(header_value content-type)); expected 200 application/x-ndjson"
  fi
  code="$(http GET "$BASE_URL/xray/api/export")"
  if [ "$code" = "401" ]; then
    pass "/xray/api/export without a credential -> 401"
  else
    fail "/xray/api/export without a credential -> $code; the full log must need the admin token or a viewer cookie"
  fi
}

# ---------------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------------
main() {
  resolve_target

  say "Glass Bank smoke test"
  say "base URL     : $BASE_URL"
  say "hosts        : $HOSTS"
  say "mode         : $([ "$IS_LOCAL" = 1 ] && echo 'local (gcloud and DNS checks skipped)' || echo "cloud ($PROJECT_ID / $REGION / $SERVICE)")"

  if [ "$DRY_RUN" = "1" ]; then
    say ""
    say "DRY_RUN=1: would run checks 1-11 against $BASE_URL and hosts '$HOSTS'."
    say "Nothing was requested."
    exit 0
  fi

  check_dns
  check_no_cross_host_redirect
  check_401_challenge
  check_discovery_documents
  check_healthz
  check_cloud_run_invariants
  check_public_iam
  check_discovery_timing
  check_register_rate_limit
  check_dashboard
  check_public_lane
  check_export

  step "Origin policy"
  if [ -n "$ACTIVE_ORIGIN_POLICY" ]; then
    say "  active ORIGIN_POLICY = $ACTIVE_ORIGIN_POLICY"
    case "$ACTIVE_ORIGIN_POLICY" in
      log-only)  say "  Current default (A-17). Switch to allowlist once real claude.ai Origin values are recorded." ;;
      allowlist) say "  Production target (CLAUDE.md invariant 10)." ;;
      *)         say "  Unexpected value; expected log-only or allowlist." ;;
    esac
  else
    say "  unknown: /health did not report origin_policy"
  fi

  step "Summary"
  say "  passed  : $PASSED"
  say "  failed  : $FAILED"
  say "  skipped : $SKIPPED"
  if [ "$FAILED" -gt 0 ]; then
    say ""
    say "SMOKE FAILED"
    exit 1
  fi
  say ""
  say "SMOKE PASSED"
}

main
