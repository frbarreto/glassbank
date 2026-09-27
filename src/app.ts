/**
 * Composition root (block: app).
 *
 * Builds the Express 5 application: `trust proxy`, a request id, JSON body parsing, `/health`, the
 * landing page at `/`,
 * and the mount points every later block plugs into. It contains no domain logic and no global
 * mutable state; blocks are injected (docs/blocks/app.md, docs/REPO_LAYOUT.md section 3).
 *
 * `src/composition.ts` builds the blocks and mounts the auth, mcp and xray routers at the marked
 * points; this file owns only the shell and the mount order.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import type { AppConfig } from './config/index.js';
import { PUBLIC_MCP_PATH, canonicalBaseUrl, keepRawBody } from './contracts/index.js';

/** Everything the composition root injects. All optional while the blocks do not exist yet. */
export interface AppDeps {
  /** Identifies this process; changes on every restart and redeploy (docs/DEPLOYMENT.md 1.4). */
  readonly bootId?: string;
  /** Package version reported by `/health`; read from package.json when omitted. */
  readonly version?: string;
  /** Mounted at `/` by T0.3+: /authorize, /token, /register, /revoke, /.well-known/*. */
  readonly authRouter?: RequestHandler;
  /** Mounted at `/mcp` by T0.3+: the bearer gate and the Streamable HTTP transport. */
  readonly mcpRouter?: RequestHandler;
  /**
   * Mounted at `PUBLIC_MCP_PATH` (`/public/mcp`, D-26): the sign-in-free lane. Absent when
   * `PUBLIC_MCP=false`, and then the landing page does not mention it.
   */
  readonly publicMcpRouter?: RequestHandler;
  /** Mounted at `/xray` by L6/L7: the pairing landing page, the JSON API and the SSE stream. */
  readonly xrayRouter?: RequestHandler;
  /**
   * Absolute path to the dashboard's static root (`public/`), served under `/xray` *behind* the
   * X-ray router. Absent, the placeholder page below is served instead, so the scaffold and any
   * test that only wires `auth` and `mcp` still answers something at `/xray`.
   */
  readonly dashboardRoot?: string;
  /**
   * v0.9 (D-28): the catch-all `http.request` producer (`McpHandle.httpObserver`), mounted in front
   * of every route so no request escapes the record, discovery and OAuth included.
   */
  readonly httpObserver?: RequestHandler;
}

/** What `/health` answers. Field names are snake_case because they are a wire contract. */
export interface HealthResponse {
  readonly status: 'ok';
  readonly boot_id: string;
  readonly version: string;
  readonly origin_policy: AppConfig['originPolicy'];
  readonly uptime_s: number;
}

/** Reads the package version next to the running entry point; never fatal. */
export function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && 'version' in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A stable, greppable id for this process. */
export function newBootId(): string {
  return `boot_${randomUUID()}`;
}

/**
 * Attaches a request id to every request and echoes it back.
 * An inbound `x-request-id` is trusted for correlation only; it never influences authorisation.
 */
function requestIdMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const inbound = req.get('x-request-id');
    const requestId =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 200
        ? inbound
        : randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
  };
}

/** The placeholder dashboard page served until block `dashboard` lands. English only. */
const XRAY_PLACEHOLDER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Glass Bank X-ray</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; color: #1b1b1f; background: #fafafa; }
      main { max-width: 34rem; margin: 0 auto; }
      code { background: #ececf0; padding: 0.1rem 0.3rem; border-radius: 3px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Glass Bank X-ray</h1>
      <p>The dashboard is not built yet.</p>
      <p>
        This placeholder is served by the scaffold (task T0.1). The live session view, the event
        stream and the pairing flow arrive with the <code>xray</code> and <code>dashboard</code> blocks.
      </p>
      <p>The server is running: <a href="/health">/health</a>.</p>
    </main>
  </body>
</html>
`;

/**
 * The status an error asks for, when it carries one. body-parser sets `status`/`statusCode`;
 * anything else is a genuine 500. A 4xx outside 400-499 is treated as 500 so a bogus value on a
 * random error object cannot turn a server fault into a client one.
 */
function statusOfError(error: unknown): number {
  if (error === null || typeof error !== 'object') return 500;
  const candidate = (error as { status?: unknown; statusCode?: unknown });
  const raw = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return 500;
  return raw >= 400 && raw <= 499 ? raw : 500;
}

/** Escapes the five HTML metacharacters; the landing page interpolates only the base URL. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The page a person sees at `/`: what this server is, the MCP URL to paste into a client, and the
 * way into the X-ray dashboard. `base` is the canonical base URL for the host the visitor typed
 * (`canonicalBaseUrl`, invariant 4), so the URL printed here is the PRM `resource` a client will
 * be told. No script, no state, no form. English only.
 */
export function landingPageHtml(base: string, options: { readonly publicLane?: boolean } = {}): string {
  const b = escapeHtml(base.replace(/\/+$/, ''));
  const publicSection =
    options.publicLane === true
      ? `
  <section aria-labelledby="browse">
    <h2 id="browse">Browse without signing in</h2>
    <p>A second MCP URL answers with no login: the bank's profile, its products with every plan and price, and its branches. Add it as its own connector; anything about a customer still needs the URL above.</p>
    <code class="url">${b}${PUBLIC_MCP_PATH}</code>
    <p>Every call to it, with the reason the agent gave, is shown on a public dashboard anyone can open.</p>
    <p><a class="button secondary" href="${b}/xray/?lane=public">Watch the public lane</a></p>
  </section>
`
      : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glass Bank</title>
<style>
  :root { color-scheme: light dark; --bg: #f5f7f9; --fg: #16202b; --muted: #5b6b7a; --line: #d6dde5; --card: #ffffff; --accent: #0e6e6a; --code: #eef2f6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f151b; --fg: #e6edf3; --muted: #93a3b3; --line: #27333f; --card: #161e26; --accent: #5cc8c0; --code: #1c2630; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 0 16px 48px; }
  main { max-width: 720px; margin: 0 auto; }
  header { padding: 40px 0 8px; }
  h1 { font-size: 34px; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 19px; margin: 0 0 10px; }
  p { margin: 0 0 12px; }
  .lede { color: var(--muted); font-size: 17px; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 18px 20px; margin: 18px 0; }
  code { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
  .url { display: block; font-size: 16px; padding: 10px 12px; margin: 6px 0 14px; user-select: all; }
  ol, ul { margin: 0 0 12px; padding-left: 22px; }
  li { margin-bottom: 6px; }
  a { color: var(--accent); }
  .button { display: inline-block; background: var(--accent); color: var(--bg); text-decoration: none; font-weight: 600; padding: 9px 16px; border-radius: 6px; margin: 4px 8px 4px 0; }
  .button.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); }
  footer { color: var(--muted); font-size: 14px; margin-top: 24px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Glass Bank</h1>
    <p class="lede">A fictional bank you can connect to any MCP client, with an X-ray view of everything the server sees. Every customer, card and transfer here is fake.</p>
  </header>

  <section aria-labelledby="connect">
    <h2 id="connect">Connect an MCP client</h2>
    <p>MCP server URL:</p>
    <code class="url">${b}/mcp</code>
    <ol>
      <li><strong>claude.ai</strong>: Customize &gt; Connectors &gt; Add custom connector. Paste the URL above and leave the OAuth client fields empty. A mock bank login opens: pick a demo customer and approve the scopes.</li>
      <li><strong>Claude Code</strong>: <code>claude mcp add --transport http glassbank ${b}/mcp</code>, then <code>/mcp</code> to log in.</li>
      <li><strong>Other clients</strong> (Codex, MCP Inspector): Streamable HTTP with OAuth 2.1 and dynamic client registration, at the same URL.</li>
    </ol>
    <p>Opening <code>/mcp</code> in a browser answers 405: it speaks MCP over POST only.</p>
  </section>
${publicSection}
  <section aria-labelledby="xray">
    <h2 id="xray">Watch it from the inside</h2>
    <p>The X-ray dashboard shows which tools were listed and called, with their arguments, rationale and results. Once a client is connected, ask it for the X-ray link (the <code>xray_get_session_link</code> tool) to watch your own session live.</p>
    <p><a class="button" href="${b}/xray/?fixture=1">Replay a recorded session</a><a class="button secondary" href="${b}/xray/">Open the dashboard</a></p>
  </section>

  <footer>
    <p>Server status: <a href="${b}/health">/health</a>.</p>
  </footer>
</main>
</body>
</html>
`;
}

/** Builds the application. Pure: no listening, no timers, no process-level handlers. */
export function createApp(config: AppConfig, deps: AppDeps = {}): Express {
  const bootId = deps.bootId ?? newBootId();
  const version = deps.version ?? readPackageVersion();
  const startedAt = Date.now();

  const app = express();

  // Cloud Run terminates TLS in front of the container: real client IPs, Secure cookies and the
  // /24 remote-ip prefix all depend on `trust proxy` being on (CLAUDE.md invariant 12).
  //
  // The hop count is 1, never `true`. With `true` Express takes the *leftmost* X-Forwarded-For
  // entry, which is whatever the caller typed, so every per-IP limit of invariant 14 was
  // defeated by rotating a header and the `remote_ip_prefix` of invariant 11 was
  // attacker-controlled. With a fixed hop count Express takes the entry the last trusted proxy
  // appended - on Cloud Run and behind a cloudflared tunnel that is the real client address.
  // A-36 note for L4: record the observed chain in docs/observations/claude-ai.md on the first
  // real connection, and make this a `TRUST_PROXY_HOPS` knob if the chain is ever longer.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.locals.bootId = bootId;
  app.locals.version = version;

  app.use(requestIdMiddleware());

  // Before every route, `/health` and the landing page included: each request that reaches the
  // process is reported once, with its `raw` block (v0.9, D-28). It only listens; it never answers.
  if (deps.httpObserver) app.use(deps.httpObserver);

  // /health is the public name. On Cloud Run, Google's front end answers /healthz itself with a
  // 404 and never forwards it (observed on the first deploy, 2026-09-26); /healthz stays as an alias
  // for local tooling (compose health checks, e2e scripts). Contract: XRAY_ROUTES.health, v0.6.
  app.get(['/health', '/healthz'], (_req: Request, res: Response) => {
    const body: HealthResponse = {
      status: 'ok',
      boot_id: bootId,
      version,
      origin_policy: config.originPolicy,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    };
    res.status(200).json(body);
  });

  // The landing page. Registered before the auth router, so nothing mounted at the root can shadow
  // it. The host is picked the way `src/mcp/gate.ts` picks it (X-Forwarded-Host, then Host) and
  // resolved by the contract's `canonicalBaseUrl`, so the MCP URL printed is the one the OAuth
  // metadata of that host advertises (invariant 4). Framing is refused like every browser page.
  app.get('/', (req: Request, res: Response) => {
    const forwarded = req.headers['x-forwarded-host'];
    const candidate = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const raw = (typeof candidate === 'string' && candidate.length > 0 ? candidate : req.headers.host) ?? null;
    const host = raw === null ? null : (raw.split(',')[0]?.trim() ?? null);
    const base = canonicalBaseUrl(host, config);
    res
      .status(200)
      .set({
        'cache-control': 'no-cache',
        'x-frame-options': 'DENY',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        'referrer-policy': 'no-referrer',
      })
      .type('html')
      .send(landingPageHtml(base, { publicLane: deps.publicMcpRouter !== undefined }));
  });

  // --- MOUNT POINT: auth (block auth, T0.3 / L5) -----------------------------------------------
  // /.well-known/oauth-protected-resource(/mcp), /.well-known/oauth-authorization-server,
  // /authorize, /login, /consent, /token, /register, /revoke. Mounted at the root, before /mcp.
  if (deps.authRouter) app.use(deps.authRouter);

  // --- MOUNT POINT: mcp (block mcp, T0.3 / L4) -------------------------------------------------
  // The bearer gate runs before the SDK transport; GET and DELETE on /mcp answer 405
  // (CLAUDE.md invariants 5 and 6).
  if (deps.mcpRouter) app.use('/mcp', deps.mcpRouter);

  // --- MOUNT POINT: the public lane (block mcp, D-26) -----------------------------------------
  // No bearer gate: the six public tools only. Its own JSON parser (256 kb) and its own limits.
  if (deps.publicMcpRouter) app.use(PUBLIC_MCP_PATH, deps.publicMcpRouter);

  // Body parsing is deliberately mounted after `auth` and `mcp`: each of those installs its own
  // parser with its own limit (256 kb and 4 mb), and body-parser skips a request whose body has
  // already been read. A global parser in front of them made both of those dead code and put one
  // 1 mb limit on everything. These two are the fallback for every route that declares none.
  app.use(express.json({ limit: '1mb', verify: keepRawBody }));
  app.use(express.urlencoded({ extended: false, limit: '1mb', verify: keepRawBody }));

  // --- MOUNT POINT: xray + dashboard (blocks xray and dashboard, L6 / L7) ----------------------
  // The X-ray router claims exactly `/xray/s/:code` and `/xray/api/*` (XRAY_ROUTES); it answers
  // 404 for an unknown `/xray/api/*` path and passes everything else on. The dashboard's static
  // files are therefore mounted *behind* it, so no static file can ever shadow the JSON API.
  if (deps.xrayRouter) app.use('/xray', deps.xrayRouter);

  if (deps.dashboardRoot) {
    // `_dev/` (the dev server and the two headless-Chrome checks) and `__tests__/` are part of the
    // block's source tree, not of the page. Nothing there is secret; nothing there is servable.
    app.use('/xray', (req: Request, res: Response, next: NextFunction) => {
      const first = req.path.split('/').filter(Boolean)[0];
      if (first === '_dev' || first === '__tests__') {
        res.status(404).json({ error: 'not_found', error_description: 'No such dashboard file.' });
        return;
      }
      next();
    });
    app.use(
      '/xray',
      express.static(deps.dashboardRoot, {
        index: 'index.html',
        dotfiles: 'ignore',
        // `public/fixtures` is a symlink to `test/fixtures`, which is how `?fixture=1` finds
        // events.jsonl in a source checkout (docs/REPO_LAYOUT.md section 1).
        // The SPA is one page with no client-side routes, so nothing needs an HTML fallback.
        fallthrough: true,
        setHeaders: (response, filePath) => {
          // The page and the recorded fixture change on every deploy and on every recording;
          // revalidating is cheaper than explaining a stale dashboard.
          if (filePath.endsWith('.html') || filePath.endsWith('.jsonl')) {
            response.setHeader('cache-control', 'no-cache');
          }
        },
      }),
    );
  } else if (!deps.xrayRouter) {
    // Express 5 runs with strict routing off, so one route serves both /xray and /xray/.
    app.get('/xray', (_req: Request, res: Response) => {
      res.status(200).type('html').send(XRAY_PLACEHOLDER_HTML);
    });
  }

  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', error_description: `No route for ${req.path}.` });
  });

  // Express 5 error handler: four parameters are required for Express to recognise it.
  //
  // body-parser carries the right status on the error it raises (413 for an over-limit payload,
  // 400 for malformed JSON); hardcoding 500 told a client "the server is broken" when the truth
  // was "your request was too big". An internal error's message is never echoed: a 5xx answers
  // with a fixed string so nothing leaks through the wire.
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = statusOfError(error);
    const message = error instanceof Error ? error.message : 'Unknown error.';
    res.status(status).json(
      status >= 500
        ? { error: 'internal_error', error_description: 'Internal server error.' }
        : {
            error: status === 413 ? 'payload_too_large' : 'invalid_request',
            error_description: message,
          },
    );
  });

  return app;
}
