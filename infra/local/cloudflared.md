# Exposing the laptop to claude.ai with cloudflared

Block `infra`. Decision D-2 (local first), A-36 (the PRM `resource` must match the host the user
typed), CLAUDE.md invariant 4 (single origin, `PUBLIC_HOSTS`).

claude.ai, Claude Desktop and ChatGPT connect from their own servers (Anthropic's egress is
`160.79.104.0/21`), so `localhost` is never reachable. A cloudflared quick tunnel puts a public HTTPS
hostname in front of `localhost:8080` in seconds: no account, no DNS record, no firewall change.
This walk has been done end to end on this Mac; ChatGPT has connected through it, and so has Codex,
a local app with a loopback OAuth callback (`docs/observations/claude-ai.md`).

## 1. Install

```bash
brew install cloudflared     # already installed on this Mac (2026.8.3)
cloudflared --version
```

## 2. Start the server, then the tunnel

Terminal 1, one of:

```bash
npm run dev
npm run build && npm start
docker compose -f infra/local/docker-compose.yml up --build
```

Terminal 2:

```bash
cloudflared tunnel --url http://localhost:8080
# ... Your quick Tunnel has been created! Visit it at ... https://<random-words>.trycloudflare.com
```

Everything below calls that host `<tunnel>.trycloudflare.com`.

## 3. Restart the server with the tunnel host

```bash
PUBLIC_BASE_URL=https://<tunnel>.trycloudflare.com PUBLIC_HOSTS='<tunnel>.trycloudflare.com;localhost:8080' npm run dev
# the container takes the same two variables in front of docker compose
```

`PUBLIC_HOSTS` is `;`-separated (`gcloud run deploy --set-env-vars` splits on commas); keeping
`localhost:8080` in the list keeps local curls and the local dashboard working. Why the PRM `resource` must equal the URL
the client types:

1. The client posts to `https://<tunnel>.trycloudflare.com/mcp` without a token and gets `401` with `WWW-Authenticate: Bearer resource_metadata="https://<tunnel>.trycloudflare.com/.well-known/oauth-protected-resource/mcp"`.
2. It fetches that document and compares its `resource` with the URL it was configured with; a mismatch stops the flow (claude.ai shows an `ofid_...` toast with no detail).
3. The same string becomes the access token `aud`, checked on every `tools/call`.
4. The server derives it from the request `Host` only when that host is listed in `PUBLIC_HOSTS`, otherwise from `PUBLIC_BASE_URL`; until both name the tunnel it answers `http://localhost:8080/mcp`. claude.ai caches discovery for about 5 minutes, so after fixing the variables remove and re-add the connector.

## 4. Verify before touching a client

Do not look the new hostname up from the Mac until `dig +short @1.1.1.1 <tunnel>.trycloudflare.com`
answers: an earlier lookup makes macOS mDNSResponder cache no-such-host, and Chrome and curl on the
Mac then fail while external clients connect. Recover with `sudo dscacheutil -flushcache; sudo
killall -HUP mDNSResponder`, or test with `curl --resolve <tunnel>.trycloudflare.com:443:<ip>`.

```bash
curl -s https://<tunnel>.trycloudflare.com/health
# {"status":"ok","boot_id":"boot_...","version":"0.1.0","origin_policy":"log-only","uptime_s":...}
curl -s https://<tunnel>.trycloudflare.com/.well-known/oauth-protected-resource/mcp | python3 -c "import sys,json;print(json.load(sys.stdin)['resource'])"
# https://<tunnel>.trycloudflare.com/mcp        <- must equal the URL you will paste into the client
curl -s -i -X POST https://<tunnel>.trycloudflare.com/mcp -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | grep -i '^HTTP\|^WWW-Authenticate'
# 401 with WWW-Authenticate: Bearer resource_metadata="https://<tunnel>.trycloudflare.com/.well-known/oauth-protected-resource/mcp", scope="profile ..."
```

`bash infra/smoke.sh https://<tunnel>.trycloudflare.com` runs the whole checklist and the DNS check
runs for real. Checks 6 and 7 describe the Cloud Run service (`gcloud run services describe`, the
IAM policy), not the tunnel: they pass while the service is up and fail while it is paused
(`make pause`), and neither outcome says anything about the tunnel.

## 5. Add it in the client

- claude.ai: Customize > Connectors > Add custom connector. Name `Glass Bank`, URL `https://<tunnel>.trycloudflare.com/mcp` (no trailing slash), Authentication **Always required**, OAuth client **No client ID, register automatically**. Use an individual account for the first test (A-34). No claude.ai client has connected yet (D-9 open): record what it sends in `docs/observations/claude-ai.md`.
- Codex: in `~/.codex/config.toml` add `[mcp_servers.glass-bank]` with `url = "https://<tunnel>.trycloudflare.com/mcp"`, then `codex mcp login glass-bank`.
- Claude Code: `claude mcp add --transport http glass-bank https://<tunnel>.trycloudflare.com/mcp`, then `/mcp` inside Claude Code.

The URL always ends in `/mcp`; `/xray` is the dashboard for humans.

## 6. Limits of a quick tunnel

- The hostname changes on every `cloudflared tunnel --url` run, and the tunnel dies with its process (a reboot ends it): new `PUBLIC_BASE_URL` / `PUBLIC_HOSTS`, a server restart, and the connector URL updated (claude.ai cannot edit authentication settings after adding, so remove and re-add it there). A stable name needs a named tunnel with a Cloudflare account and a domain.
- A macOS reboot also wipes the default `XRAY_DB_PATH=/tmp/xray.sqlite` and `AUTH_DB_PATH=/tmp/auth.sqlite`: the recorded sessions and the registered clients are gone.
- No uptime guarantee: free quick tunnels are rate-limited and can take seconds to become reachable; on a first 502, retry before changing anything.
- It is a public URL: anyone holding it can register a client and use the bank. Keep it short-lived, keep the `RATE_LIMIT_*` defaults, never run it with a real `OAUTH_SIGNING_KEY`.
- Cloudflare terminates TLS: the server sees HTTP with `X-Forwarded-Proto: https`; `trust proxy` is on (invariant 12), so `Secure` cookies and the client IP prefix work as they do behind Cloud Run.
- SSE works over HTTP/1.1 through the tunnel, which the dashboard stream needs; never add HTTP/2 (invariant 3).
