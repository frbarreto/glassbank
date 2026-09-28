/* global WebSocket */
/**
 * The dashboard against the real server, in a real browser (blocks: app, dashboard).
 *
 * `npm run e2e:session` proves the JSON the X-ray API returns; `public/_dev/check-console.mjs`
 * proves the SPA renders the recorded fixture; `public/_dev/check-live.mjs` proves the SSE client
 * against a stub. Nothing covered the seam between them: a browser paired to a real session,
 * fetching real routes. That is where a wrong route, a bad fetch or a double-counted total shows
 * up, and all three did.
 *
 * It boots `dist/server.js` on its own port with its own SQLite files, runs the whole OAuth walk,
 * drives nine tool calls including a write, exchanges the pairing code the `xray_get_session_link`
 * tool returns, then opens the paired dashboard in headless Chrome and asserts on the DOM.
 *
 * Usage: npm run build && npm run e2e:dashboard
 *        SHOTS=<directory> npm run e2e:dashboard   # also writes live-light.png and live-dark.png
 *
 * Needs Chrome (CHROME_PATH overrides the default location), so it is not part of `npm run check`.
 * The DevTools port is auto-assigned; set CDP_PORT (9336 by convention here) to pin it.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8095;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = Number(process.env.CDP_PORT ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrome writes the port it really took into this file, but only when it was asked for port 0. */
async function waitForDebugPort(profile, timeoutMs = 20_000) {
  if (CDP_PORT) return CDP_PORT;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const first = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      if (Number(first) > 0) return Number(first);
    } catch {
      // Chrome has not written the file yet.
    }
    await sleep(120);
  }
  throw new Error('Chrome did not write DevToolsActivePort into its profile');
}

/** `finally` does not run on a signal, and an orphaned Chrome keeps its profile and its memory. */
function createCleanup() {
  const jobs = [];
  let ran = false;
  const run = async () => {
    if (ran) return;
    ran = true;
    for (const job of [...jobs].reverse()) {
      try {
        await job();
      } catch {
        // Release the rest anyway.
      }
    }
  };
  const bail = (code) => (reason) => {
    if (reason instanceof Error) console.error(reason.stack ?? reason.message);
    run().finally(() => process.exit(code));
  };
  process.once('SIGINT', bail(130));
  process.once('SIGTERM', bail(143));
  process.once('uncaughtException', bail(1));
  process.once('unhandledRejection', bail(1));
  return { add: (job) => jobs.push(job), run };
}

const problems = [];
const notes = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS ' : '  FAIL '} ${label}${detail ? ` (${detail})` : ''}`);
  if (!ok) problems.push(label);
};

const jar = new Map();
async function http(path, init = {}) {
  const headers = new Headers(init.headers);
  if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  const response = await fetch(new URL(path, BASE), { ...init, headers, redirect: 'manual' });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    jar.set(pair.slice(0, index), pair.slice(index + 1));
  }
  return response;
}
const hidden = (html, name) => {
  const m = new RegExp(`name="${name}"\\s+value="([^"]*)"`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null;
};
const form = (fields) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const i of Array.isArray(v) ? v : [v]) p.append(k, i);
  return p;
};

let child;
let chrome;
let profile;
let dbDir;
const cleanup = createCleanup();
try {
  dbDir = await mkdtemp(join(tmpdir(), 'glass-bank-live-'));
  cleanup.add(() => rm(dbDir, { recursive: true, force: true }));
  child = spawn('node', ['dist/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE,
      PUBLIC_HOSTS: `127.0.0.1:${PORT}`,
      XRAY_DB_PATH: join(dbDir, 'xray.sqlite'),
      AUTH_DB_PATH: join(dbDir, 'auth.sqlite'),
      FEATURE_FLAGS: 'writes;transfers',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  cleanup.add(async () => {
    child.kill('SIGTERM');
    await sleep(400);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  for (let i = 0; i < 60; i += 1) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* not up */ }
    await sleep(250);
  }

  // --- OAuth -----------------------------------------------------------------------------
  const registration = await http('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'live check', redirect_uris: ['http://127.0.0.1:60200/callback'],
      token_endpoint_auth_method: 'none', application_type: 'native',
    }),
  });
  const client = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
  const scopes = ['profile', 'accounts:read', 'transactions:read', 'cards:read', 'cards:write',
    'transfers:read', 'transfers:write', 'bills:read', 'payees:read', 'xray:read'].join(' ');
  const authorizeUrl = `/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
    `&redirect_uri=${encodeURIComponent('http://127.0.0.1:60200/callback')}&state=s1` +
    `&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent(scopes)}` +
    `&resource=${encodeURIComponent(`${BASE}/mcp`)}`;
  const authorizePage = await http(authorizeUrl);
  let html = await authorizePage.text();
  if (html.includes('name="persona_choice"') || html.includes('/login')) {
    const login = await http('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ txn: hidden(html, 'txn'), csrf: hidden(html, 'csrf'), persona_choice: 'per_ava_stone' }),
    });
    html = await login.text();
  }
  const consent = await http('/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ txn: hidden(html, 'txn'), csrf: hidden(html, 'csrf'), decision: 'allow', scope: scopes.split(' ') }),
  });
  const code = new URL(consent.headers.get('location')).searchParams.get('code');
  const tokenResponse = await http('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:60200/callback',
      client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }),
  });
  const tokens = await tokenResponse.json();
  check('OAuth produced an access token', typeof tokens.access_token === 'string', `status ${tokenResponse.status}`);

  // --- drive the bank the way a client would ---------------------------------------------
  let rpcId = 1;
  const rpc = async (method, params) => {
    const response = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
    });
    const text = await response.text();
    const line = text.startsWith('event:') ? text.split('\n').find((l) => l.startsWith('data:'))?.slice(5) : text;
    return JSON.parse(line ?? text).result ?? {};
  };
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-check', version: '1.0.0' } });
  await rpc('tools/list', {});
  await call('get_current_user', { rationale: 'confirm which customer this connection is for' });
  const load = await call('load_transactions', { from_date: '2026-08-01', to_date: '2026-09-01', rationale: 'look at last month of spending' });
  const table = load.structuredContent?.table_name;
  const textOf = (result) => (result.content ?? []).map((c) => c.text ?? '').join('\n');
  await call('process_data', { table_name: table, cols: ['merchant_name', 'amount_cents'], rationale: 'build the table for the query' });
  const merchants = await call('execute_query', { table_name: table, query: `SELECT "merchant_name", SUM("amount_cents") AS cents FROM "${table}" GROUP BY 1 ORDER BY 2 LIMIT 5`, rationale: 'the five biggest merchants' });
  check('execute_query returned rows out of the seeded bank', JSON.parse(textOf(merchants)).length > 0, textOf(merchants).slice(0, 100));
  // A load_* tool returns no rows (Ramp convention), so the card id comes back through SQL.
  const cards = await call('load_cards', { rationale: 'find the card the user wants frozen' });
  const cardTable = cards.structuredContent?.table_name;
  await call('process_data', { table_name: cardTable, cols: ['id', 'last4', 'status'], rationale: 'prepare the card list' });
  const cardRows = JSON.parse(textOf(await call('execute_query', { table_name: cardTable, query: `SELECT "id", "status" FROM "${cardTable}" WHERE "status" = 'active' LIMIT 1`, rationale: 'pick the active card to freeze' })));
  const cardId = cardRows[0]?.id;
  const locked = await call('lock_or_unlock_card', { card_id: cardId, action: 'lock', rationale: 'the user lost the card and asked to freeze it' });
  check('a write tool ran, so the overlay differs from the seed', locked.isError !== true, (locked.content ?? []).map((c) => c.text ?? '').join(' ').slice(0, 200));
  const link = await call('xray_get_session_link', { rationale: 'show the user what is happening behind the scenes' });
  const linkText = (link.content ?? []).map((c) => c.text ?? '').join(' ');
  const pairing = /BANK-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2}/.exec(linkText)?.[0];
  check('xray_get_session_link returned a pairing code', Boolean(pairing), linkText.slice(0, 80));

  // --- the browser -----------------------------------------------------------------------
  profile = await mkdtemp(join(tmpdir(), 'xray-live-'));
  cleanup.add(() => rm(profile, { recursive: true, force: true }));
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--window-size=1680,1000', 'about:blank'], { stdio: 'ignore' });
  cleanup.add(async () => {
    chrome.kill('SIGKILL');
    // A helper process outliving the one we killed can recreate the profile directory.
    await sleep(300);
  });
  const debugPort = await waitForDebugPort(profile);
  let version;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`); if (r.ok) { version = await r.json(); break; } } catch { /* not up */ }
    await sleep(150);
  }
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  cleanup.add(() => socket.close());
  const pending = new Map();
  let nextId = 1;
  await new Promise((done, fail) => { socket.addEventListener('open', done); socket.addEventListener('error', () => fail(new Error('ws'))); });
  socket.addEventListener('message', (m) => {
    const frame = JSON.parse(m.data);
    if (frame.id && pending.has(frame.id)) { const p = pending.get(frame.id); pending.delete(frame.id); if (frame.error) p.reject(new Error(frame.error.message));
      else p.resolve(frame.result);
    }
  });
  const send = (method, params = {}, sessionId) => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 20000); });
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const consoleErrors = [];
  socket.addEventListener('message', (m) => {
    const f = JSON.parse(m.data);
    if (f.method === 'Runtime.consoleAPICalled' && f.params?.type === 'error') consoleErrors.push((f.params.args ?? []).map((a) => a.value ?? a.description).join(' '));
    if (f.method === 'Runtime.exceptionThrown') consoleErrors.push(f.params?.exceptionDetails?.text ?? 'exception');
  });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId).then((r) => r.result.value);

  await send('Page.navigate', { url: `${BASE}/xray/s/${pairing}` }, sessionId);
  await sleep(3000);
  const paint = JSON.parse(await evaluate('JSON.stringify({ready: !!window.__xray && window.__xray.view.ready, events: window.__xray?.events ?? 0, episodes: document.querySelectorAll(".episode").length, threads: document.querySelectorAll(".chain-thread").length, steps: document.querySelectorAll(".call-row").length, connectors: document.querySelectorAll(".chain-link").length, context: document.querySelectorAll(".flow-context").length, persona: document.querySelector(".persona-card")?.textContent ?? "", bankErr: window.__xray?.view?.bank?.error ?? null, headerCalls: Number((document.querySelector(".header-stats").textContent.match(/(\\d+)\\s*calls/) ?? [0, 0])[1]), sessionCalls: Number((document.querySelector(".session-row")?.textContent.match(/(\\d+)\\s*calls/) ?? [0, 0])[1]), wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, depth: window.__xray?.view?.depth ?? "", panes: document.querySelectorAll(".call-open").length, rows: document.querySelectorAll(".call-row").length})'));
  check('the pairing link opened the dashboard', paint.ready === true, `events ${paint.events}`);
  // The page arrives at the macro line: one derived line per call, nothing expanded (`open-state.js`).
  check('the chain drew one line per tool call, none expanded', paint.steps === 9 && paint.depth === 'calls' && paint.panes === 0 && paint.rows === 9, `${paint.steps} rows, ${paint.panes} panes`);
  check('the steps are grouped into episodes', paint.episodes >= 2 && paint.episodes <= 9, `${paint.episodes} episodes`);
  // The four-call ETL run shares one scratch table, so it must render as one thread with three
  // connectors: that is the derivation the whole view exists to show.
  check('a linked chain renders as one thread with connectors', paint.threads < paint.steps && paint.connectors >= 3, `${paint.threads} threads, ${paint.connectors} connectors`);
  // C1 (contracts v0.10): each session is one block; what happened before its first call is the
  // connection line at its head, and opening it shows those steps as context rows.
  const blocks = JSON.parse(await evaluate('JSON.stringify({sessions: document.querySelectorAll(".session-block").length, connection: (document.querySelector(".session-connection") || {}).textContent || "", badge: (document.querySelector(".session-head .identity-badge") || {}).textContent || ""})'));
  check('the session is one block headed by its connection', blocks.sessions === 1 && /session started/.test(blocks.connection) && /tools\/list/.test(blocks.connection), `${blocks.sessions} blocks; ${blocks.connection}`);
  check('the session head says the client name is a claim', /claims .* · unsigned/.test(blocks.badge), blocks.badge);
  await evaluate("(() => { const toggle = document.querySelector('.connection-toggle'); if (toggle) toggle.click(); })()");
  await sleep(400);
  const contextRows = await evaluate('document.querySelectorAll(".flow-context").length');
  check('context rows explain what happened between the episodes', contextRows >= 3, `${contextRows} rows once the connection is open`);
  await evaluate("(() => { const toggle = document.querySelector('.connection-toggle'); if (toggle) toggle.click(); })()");
  await sleep(300);
  check('the page never scrolls sideways', paint.wide === false, `scrollWidth over clientWidth: ${paint.wide}`);
  const eraseControls = await evaluate('document.querySelectorAll("[data-action=ask-erase]").length');
  check('the erase controls are offered to a paired viewer', eraseControls >= 1, `${eraseControls} controls`);
  check('the persona card fetched the live bank with no error', paint.bankErr === null, String(paint.bankErr));
  check('the persona card names the customer', /Ava Stone/i.test(paint.persona), paint.persona.replace(/\s+/g, ' ').slice(0, 120));
  check('the persona card shows money', /\$[\d,]+\.\d\d/.test(paint.persona), (/\$[\d,]+\.\d\d/.exec(paint.persona) ?? [''])[0]);
  // The seed persona has 3 active and 1 locked card; the lock above must move one across, which is
  // the proof that the card reads the login's overlay (ADR-15) and not the shared seed.
  check('the persona card reflects the card just locked, not the shared seed', /2 active/.test(paint.persona) && /2 locked/.test(paint.persona), (/\d+ cards[^t]*/.exec(paint.persona.replace(/\s+/g, ' ')) ?? [''])[0]);
  notes.push(`persona card: ${paint.persona.replace(/\s+/g, ' ').slice(0, 200)}`);

  // The head is the control that opens and closes the step in place; `is-selected` marks the
  // inspector's subject now, so every probe below anchors on the open row itself.
  await evaluate('document.querySelector(".call-head").click()');
  await sleep(400);
  const afterClick = JSON.parse(await evaluate('JSON.stringify({open: document.querySelectorAll(".call-head[aria-expanded=true]").length, panes: document.querySelectorAll(".call-open").length})'));
  // Scoped to the one call just opened, before the depth control opens the other eight.
  const oneCall = JSON.parse(await evaluate('JSON.stringify({rationale: document.querySelectorAll(\'.call-open [data-path="params.arguments.rationale"]\').length, footers: document.querySelectorAll(".call-open .wire-footer").length})'));
  // Complaint 1: the model's sentence sits inside the arguments it arrived in, exactly once.
  check('the rationale is drawn inside params.arguments, once', oneCall.rationale === 1, `${oneCall.rationale} rationale rows`);
  check('both wire panes say they were rebuilt from the record', oneCall.footers === 2, `${oneCall.footers} footers`);
  // The depth control is the way down to what happened inside every call at once.
  await evaluate('window.__xray.act("set-depth", "inside")');
  await sleep(600);
  // `.call` wraps the row and the pane as siblings, so the pane is only in scope from the wrapper.
  const openRow = '(() => { const head = document.querySelector(".call-head[aria-expanded=true]"); return head ? head.closest(".call") : null; })()';
  // Input, interior and output, in that order and in that vocabulary: the whole point of the pane.
  const titles = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('.call-open .wire-title, .call-open .inside-title')].map((n) => n.textContent.split(' \\u00b7 ')[0].trim()))`));
  check('a call opens where it is and reads request, inside, response in that order', afterClick.open === 1 && afterClick.panes === 1 && titles.join('|').toUpperCase().startsWith('REQUEST|INSIDE|RESPONSE'), `${afterClick.panes} pane on the click; titles ${titles.join(' / ')}`);
  // The check the two correlation defects would have failed. `bank.op`, `etl.*` and `sql.*` are
  // emitted by the tools block; if their `request_id` is not the call's JSON-RPC id, the store
  // cannot nest them and the "ran" column is empty on every real call while still full in the
  // fixture and in the unit tests. Asserting on the engine bands is asserting that a live server
  // can actually show what it did (CLAUDE.md invariants 6 and 13).
  const board = JSON.parse(await evaluate('JSON.stringify({engineCards: document.querySelectorAll(".inside-cards [data-actor=engine]").length, actors: [...new Set([...document.querySelectorAll("[data-actor]")].map((n) => n.dataset.actor))].filter((a) => a !== "page").sort()})'));
  check('the interior says what actually ran, not just what was asked', board.engineCards >= 5, `${board.engineCards} engine cards`);
  check('every party of a call is named in the panes', board.actors.join(",") === 'agent,engine,model,server', board.actors.join(","));
  const episodeText = await evaluate('document.querySelector(".episode").textContent');
  check(
    'the grouping is labelled as this dashboard\'s, not as fact',
    /Grouped by this dashboard/i.test(episodeText),
    (/Grouped by this dashboard[^.]*\./i.exec(episodeText) ?? ['no honesty line found'])[0].slice(0, 110),
  );
  check('the session card agrees with the header on how many calls there were', paint.headerCalls === paint.sessionCalls && paint.headerCalls === 9, `header ${paint.headerCalls}, session ${paint.sessionCalls}`);
  // The sentence is drawn once as data: the `rationale` value inside the arguments it arrived in.
  // The raw envelopes are excluded because they are the record itself, byte for byte, not another
  // framing of it - repeating the sentence as prose in several places is what this redesign ended.
  const quoted = await evaluate(
    `(() => { const s = ${openRow}; if (!s) return -1; const q = s.querySelector(".wire-rationale-row .wire-quote"); if (!q) return 0; const text = q.textContent.replace(/^\u201C|\u201D$/g, "").trim(); if (!text) return 0; const copy = s.cloneNode(true); copy.querySelectorAll(".wire-raw, .card-raw, .jv").forEach((n) => n.remove()); return copy.textContent.split(text).length - 1; })()`,
  );
  check('the model sentence is drawn once as data, and nowhere else outside the raw record', quoted === 1, `${quoted} occurrences`);
  // Screenshots before the erase, or they would all show an empty page.
  if (process.env.SHOTS) {
    // A shot directory that does not exist yet is the normal case, not an error worth ending on.
    await mkdir(process.env.SHOTS, { recursive: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1100, deviceScaleFactor: 2, mobile: false }, sessionId);
    for (const theme of ['light', 'dark']) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, sessionId);
      await sleep(400);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(join(process.env.SHOTS, `live-${theme}.png`), Buffer.from(data, 'base64'));
      notes.push(`shot: ${join(process.env.SHOTS, `live-${theme}.png`)}`);
    }
  }

  // The raw envelope was the reported bug: a fixed-height `<pre class="code">` with no `id`, whose
  // scrollTop every repaint of the panel reset to 0. It is a tree now (public/json-view.js), and
  // the invariant that replaced the box is checked here against a real envelope off a real server:
  // nothing inside the detail panel may scroll unless `mount.js` can put it back, and it can only
  // do that by `id`. `catalog.tools_listed` is the biggest envelope any session produces.
  const envelope = JSON.parse(await evaluate('JSON.stringify((() => { const events = window.__xray.store.getEvents(); const big = events.filter((e) => e.type === "catalog.tools_listed").pop() ?? events[events.length - 1]; window.__xray.act("select-event", big.id); return {id: big.id, type: big.type}; })())'));
  await sleep(400);
  const rawEnvelope = JSON.parse(await evaluate('JSON.stringify((() => { const panel = document.getElementById("panel-detail"); const traps = []; for (const el of panel.querySelectorAll("*")) { const style = getComputedStyle(el); const down = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1; const across = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1; if ((down || across) && !el.id) traps.push(el.tagName.toLowerCase() + "." + (el.className || "no-class")); } return {rows: panel.querySelectorAll(".jv-node").length, shut: panel.querySelectorAll(".jv-toggle[aria-expanded=false]").length, title: (panel.querySelector(".jv-title") || {}).textContent || "", traps}; })())'));
  check(
    'the raw envelope is a tree, and nothing in it scrolls without an id',
    rawEnvelope.rows > 1 && rawEnvelope.traps.length === 0 && /Raw envelope/.test(rawEnvelope.title),
    `${rawEnvelope.rows} rows (${rawEnvelope.shut} folded) of ${envelope.type} ${envelope.id}, untracked scrollers: ${rawEnvelope.traps.join(', ') || 'none'}`,
  );

  // Erasing, last of all, because it destroys what every check above read.
  const beforeErase = await evaluate('window.__xray.store.getSessions().length');
  await evaluate('document.querySelector("[data-action=ask-erase]").click()');
  await sleep(250);
  const armed = await evaluate('!!document.querySelector("[data-action=confirm-erase]")');
  check('erasing needs a second click', armed === true && beforeErase > 0, `armed ${armed}, sessions ${beforeErase}`);
  await evaluate('document.querySelector("[data-action=confirm-erase]").click()');
  await sleep(1200);
  const afterErase = JSON.parse(await evaluate('JSON.stringify({sessions: window.__xray.store.getSessions().length, steps: document.querySelectorAll(".call-row").length})'));
  check('the erase emptied the view', afterErase.sessions === 0 && afterErase.steps === 0, JSON.stringify(afterErase));
  // Asked from inside the page, so it carries the viewer cookie the browser holds (it is HttpOnly
  // and unreadable from here): this is what proves the erase reached the server, not just the view.
  const serverAfter = await evaluate(
    'fetch("/xray/api/sessions", {credentials: "same-origin"}).then((r) => r.json()).then((j) => JSON.stringify(j))',
  );
  check(
    'the erase reached the server, not just the page',
    (JSON.parse(serverAfter).data ?? []).length === 0,
    String(serverAfter).slice(0, 120),
  );

  check('no console error on the live page', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
} finally {
  await cleanup.run();
}
for (const note of notes) console.log(`  note: ${note}`);
console.log(problems.length === 0 ? '\nLIVE CHECK PASSED' : `\nLIVE CHECK FAILED: ${problems.length}`);
process.exit(problems.length === 0 ? 0 : 1);
