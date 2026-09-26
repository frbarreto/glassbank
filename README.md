# Glass Bank

[![pipeline](https://github.com/frbarreto/glassbank/actions/workflows/pipeline.yml/badge.svg)](https://github.com/frbarreto/glassbank/actions/workflows/pipeline.yml)

A public remote MCP server for a fictional bank, plus an X-ray dashboard that shows in real time everything the server observes about a session: which tools were listed and called, with which arguments and rationale, what came back, how long it took, the auth and session facts behind it, and which of five actors - client app, model, this server, our engine, this page - authored each value.

Every bank operation is mocked. Data is generated deterministically from a seed and lives in memory, with a per-grant SQLite scratch database for the Ramp-style "load, then SQL" pattern. The tool surface, scope model and OAuth shape follow Ramp's public MCP work; the observability layer is ours.

**State (2026-09-26):** **deployed** on Cloud Run (service `mcp-bank`, project `lake-fraude`) by the GitHub Actions pipeline of https://github.com/frbarreto/glassbank on every push to `main`; live at **https://glassbank-mcp.abovethefog.app** (`/mcp`, `/xray`, `/health`; the `run.app` URL also answers). `npm run check` green, contracts v0.6. Next: real clients (Codex and ChatGPT connected earlier through a tunnel; no claude.ai account yet), then `ORIGIN_POLICY=allowlist`. See [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## Try it

```bash
npm ci
npm run build && npm start        # http://localhost:8080  (/mcp, /authorize, /.well-known/*, /xray)
npm run login -- --write          # opens the mock login and consent pages, writes .glass-bank-token.json
npm run e2e                       # 151 scripted checks: OAuth, read flow, write flow, step-up, dashboard API
```

Open `http://localhost:8080/xray/?fixture=1` to see the dashboard replay a recorded session, or connect a real MCP client to `http://localhost:8080/mcp` and ask it for `xray_get_session_link`. [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md) is the full walkthrough; [infra/local/cloudflared.md](infra/local/cloudflared.md) exposes the laptop to a remote client.

## How it fits together

```mermaid
flowchart LR
  C["MCP client (claude.ai, Claude Code, Codex, Inspector)"] -->|"OAuth 2.1 + MCP over HTTPS"| S
  B["Browser"] -->|"HTTPS + SSE"| S
  subgraph S["one process, one origin, one Cloud Run instance"]
    A["mcp-server: mock OAuth AS, /mcp transport, 17 tools, bank-core, scratch SQLite"]
    X["xray: event log, SSE stream, JSON API, static dashboard under /xray"]
    A -. "XrayEvent (in-process emitter)" .-> X
  end
```

## Documents

| Document | Answers |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Conventions, invariants, verified commands, and the full document index |
| [docs/LOCAL_TESTING.md](docs/LOCAL_TESTING.md) | Running it and driving it end to end |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Blocks, stack, auth sequence, decisions (ADR-x) |
| [docs/TOOL_CATALOG.md](docs/TOOL_CATALOG.md), [docs/XRAY_EVENT_MODEL.md](docs/XRAY_EVENT_MODEL.md) | The 17 tools; the event contract and dashboard |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Cloud Run `mcp-bank` in `lake-fraude` / `us-central1`, operations, env knobs |
| [docs/blocks/](docs/blocks/) | One page per block |
| [docs/RAMP_REFERENCE.md](docs/RAMP_REFERENCE.md), [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | What was copied from Ramp; numbered assumptions and decisions |

MIT licensed; Ramp's notice and the copied fragments are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Everything in the repository is in English.
