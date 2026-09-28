/**
 * Renders the whole fixture in a real browser and fails on any console error (block: dashboard).
 *
 * docs/REPO_LAYOUT.md section 7 asks the dashboard to "render the full fixture without console
 * errors". The Vitest suite proves the reducer and the panel trees on Node; this proves the page
 * itself, in Chrome, over the Chrome DevTools Protocol: it starts the dev static server, opens
 * `?fixture=1`, waits for all 200 events to be applied, then checks the chain (episodes, threads,
 * connectors, a row that toggles both ways, the three panes it opens in the order REQUEST /
 * INSIDE / RESPONSE, two rows open at once, Escape closing the last one, the four depths, what
 * the deepest one costs to repaint, the spine's scrollers and a 390 px pass with three rows
 * open), switches to the events mode for the row counts and the filters,
 * clicks through every tab, opens the biggest envelope in the recording in the JSON viewer (where
 * it proves that nothing inside the detail panel scrolls without an `id`, that an opened branch
 * survives a repaint and that Raw swaps the tree for the exact text), pauses, steps the player and
 * switches the theme - collecting
 * `Runtime.exceptionThrown`, `Runtime.consoleAPICalled(error)` and `Log.entryAdded(error)` the
 * whole time. Any of them fails the run.
 *
 * Usage: node public/_dev/check-console.mjs
 * Requires Google Chrome; set CHROME_PATH to point at another binary. The DevTools port is
 * auto-assigned; set CDP_PORT (9333 by convention here) to pin it and attach a debugger.
 */
/* global WebSocket */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listen } from './serve.mjs';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 0);
const EXPECTED_EVENTS = 200;
/**
 * The repaint budget of the deepest depth: every call open, with its interior, repainted whole.
 * Measured at 30-50 ms on the 200-event recording; the ceiling is the point at which the plan's
 * fallback (a per-episode HTML cache) would be needed instead.
 */
const REPAINT_CEILING_MS = 250;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Chrome writes the port it really took into this file, but only when it was asked for port 0. */
async function waitForDebugPort(profile, timeoutMs = 20_000) {
  if (DEBUG_PORT) return DEBUG_PORT;
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

async function waitForDevTools(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // Chrome has not opened the port yet.
    }
    await sleep(120);
  }
  throw new Error(`Chrome did not expose a DevTools endpoint on port ${port}`);
}

/** A minimal CDP client over the global WebSocket (Node 22+). */
function createCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let nextId = 1;

  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener('open', () => resolveReady());
    socket.addEventListener('error', (event) => rejectReady(new Error(`websocket error: ${event.type}`)));
  });

  socket.addEventListener('message', (message) => {
    let frame;
    try {
      frame = JSON.parse(message.data);
    } catch {
      return;
    }
    if (frame.id && pending.has(frame.id)) {
      const { resolve: done, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(`${frame.error.message} (${frame.error.code})`));
      else done(frame.result);
      return;
    }
    for (const listener of listeners) listener(frame);
  });

  return {
    ready,
    on(listener) {
      listeners.push(listener);
    },
    send(method, params = {}, sessionId) {
      const id = nextId++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      socket.send(JSON.stringify(payload));
      return new Promise((done, reject) => {
        pending.set(id, { resolve: done, reject });
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP timeout on ${method}`));
          }
        }, 20_000);
      });
    },
    close() {
      socket.close();
    },
  };
}

function describeArg(argument) {
  if (!argument) return '';
  if (argument.value !== undefined) return String(argument.value);
  return argument.description ?? argument.type ?? '';
}

async function main() {
  const problems = [];
  const notes = [];
  const cleanup = createCleanup();
  const { server, port } = await listen(0);
  cleanup.add(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const profile = await mkdtemp(join(tmpdir(), 'xray-chrome-'));
  cleanup.add(() => rm(profile, { recursive: true, force: true }));

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--remote-allow-origins=*',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--mute-audio',
      '--window-size=1680,1050',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  chrome.stderr.on('data', () => {});
  cleanup.add(async () => {
    chrome.kill('SIGKILL');
    // A helper process outliving the one we killed can recreate the profile directory.
    await sleep(300);
  });

  let cdp = null;
  try {
    const version = await waitForDevTools(await waitForDebugPort(profile));
    notes.push(`browser: ${version.Browser}`);
    cdp = createCdp(version.webSocketDebuggerUrl);
    cleanup.add(() => cdp.close());
    await cdp.ready;

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

    cdp.on((frame) => {
      if (frame.sessionId !== sessionId) return;
      if (frame.method === 'Runtime.exceptionThrown') {
        const details = frame.params.exceptionDetails ?? {};
        problems.push(
          `uncaught exception: ${
            details.exception?.description ?? details.text ?? 'unknown'
          } (${details.url ?? ''}:${details.lineNumber ?? '?'})`,
        );
      }
      if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'error') {
        problems.push(
          `console.error: ${(frame.params.args ?? []).map(describeArg).join(' ')}`,
        );
      }
      if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'warning') {
        notes.push(`console.warn: ${(frame.params.args ?? []).map(describeArg).join(' ')}`);
      }
      if (frame.method === 'Log.entryAdded' && frame.params.entry.level === 'error') {
        const entry = frame.params.entry;
        // Pass 3 opens the live path with no API behind it on purpose: the dashboard must fall
        // back to the pairing screen, and the failed `/xray/api/*` fetch is the expected input,
        // not a defect. Every other failed resource is a real problem.
        if (String(entry.url ?? '').includes('/api/')) {
          notes.push(`expected API failure: ${entry.text} ${entry.url}`);
          return;
        }
        problems.push(`log: ${entry.text} ${entry.url ?? ''}`);
      }
    });

    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        throw new Error(
          `evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
        );
      }
      return result.result.value;
    };

    // --- pass 1: apply the whole fixture at once ------------------------------------------
    const url = `http://127.0.0.1:${port}/xray/?fixture=1&autoplay=all`;
    await cdp.send('Page.navigate', { url }, sessionId);

    let applied = 0;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep(100);
      applied = (await evaluate('window.__xray ? window.__xray.events : 0')) ?? 0;
      if (applied >= EXPECTED_EVENTS) break;
    }
    notes.push(`events applied: ${applied}`);
    if (applied !== EXPECTED_EVENTS) {
      problems.push(`expected ${EXPECTED_EVENTS} events to be applied, saw ${applied}`);
    }

    // Chain mode is the default: episodes of connected steps with the context rows between them.
    const chainPaint = JSON.parse(
      await evaluate(
        'JSON.stringify({mode: window.__xray.view.timelineMode, depth: window.__xray.view.depth, episodes: document.querySelectorAll(".episode").length, threads: document.querySelectorAll(".chain-thread").length, rows: document.querySelectorAll(".call-row").length, panes: document.querySelectorAll(".call-open").length, ids: [...document.querySelectorAll(".call-id")].map((n) => n.textContent).length, connectors: document.querySelectorAll(".chain-link").length, headers: document.querySelectorAll(".chain-thread-head").length, context: document.querySelectorAll(".flow-context").length, inside: document.querySelectorAll(".episode .flow-context").length, workflow: [...document.querySelectorAll(".episode-workflow")].map((n) => n.textContent).join(" ~ "), rule: [...document.querySelectorAll(".episode-rule")].map((n) => n.textContent).join(" ~ "), why: document.querySelectorAll(".episode-why-body").length, connectorText: (document.querySelector(".chain-link-label") || {}).textContent || "", rowText: (document.querySelector(\'[data-call-key="xs_7b4d10#5"]\') || {}).textContent || "", overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, persona: !!document.querySelector(".persona-card"), personaText: (document.querySelector(".persona-card") || {}).textContent || ""})',
      ),
    );
    notes.push(
      `chain mode: ${chainPaint.episodes} episodes, ${chainPaint.threads} threads, ${chainPaint.rows} rows, ${chainPaint.connectors} connectors, ${chainPaint.context} context rows`,
    );
    notes.push(
      `first paint at depth ${chainPaint.depth}: ${chainPaint.panes} open panes, ${chainPaint.ids} JSON-RPC ids`,
    );
    notes.push(`first connector: ${chainPaint.connectorText}`);
    notes.push(`row #5: ${chainPaint.rowText}`);
    if (chainPaint.mode !== 'chain') problems.push(`expected chain mode by default, saw ${chainPaint.mode}`);
    if (chainPaint.episodes < 4) problems.push(`chain mode drew only ${chainPaint.episodes} episodes`);
    if (chainPaint.rows !== 26) problems.push(`expected 26 rows, saw ${chainPaint.rows}`);
    if (chainPaint.connectors < 8) problems.push(`chain mode drew only ${chainPaint.connectors} connectors`);
    if (chainPaint.threads <= chainPaint.episodes) {
      problems.push(`expected more threads than episodes, saw ${chainPaint.threads} in ${chainPaint.episodes}`);
    }
    if (!chainPaint.headers) problems.push('no thread named the artefact its calls share');
    if (chainPaint.context < 10) problems.push(`chain mode drew only ${chainPaint.context} context rows`);
    if (chainPaint.inside !== 0) problems.push(`${chainPaint.inside} context rows were drawn inside an episode`);
    // The default depth is one line per call: the page must arrive readable, not saturated.
    if (chainPaint.depth !== 'calls') problems.push(`expected depth calls by default, saw ${chainPaint.depth}`);
    if (chainPaint.panes !== 0) problems.push(`${chainPaint.panes} panes were drawn before anything was opened`);
    if (chainPaint.ids !== 26) problems.push(`expected 26 JSON-RPC ids, one per row, saw ${chainPaint.ids}`);
    // The row is recorded bytes on both sides: the model's arguments, then the server's result.
    if (!/load_cards_51e8a3b6/.test(chainPaint.rowText)) {
      problems.push('the row did not print the arguments the model wrote');
    }
    if (!/397 chars/.test(chainPaint.rowText)) {
      problems.push('the row did not say how much of the result this recording holds');
    }
    // "6 rows" is this page's reading of the result; it belongs to the connector, not to the
    // server's half of the row.
    if (/6 rows/.test(chainPaint.rowText)) problems.push('a page-derived caption is on the row');
    if (!/inferred by this server/.test(chainPaint.workflow)) {
      problems.push('the episode header did not mark the workflow as inferred');
    }
    if (!/Grouped by this dashboard, not by the server, which never sees the conversation/.test(chainPaint.rule)) {
      problems.push('the episode header did not say whose grouping this is');
    }
    if (chainPaint.why !== 0) problems.push('an episode opened straight into its grouping rule');
    if (!/passes/.test(chainPaint.connectorText)) {
      problems.push(`the connector did not name what it passes: ${chainPaint.connectorText}`);
    }
    if (chainPaint.overflow > 0) problems.push(`the page scrolls sideways by ${chainPaint.overflow}px`);
    if (!chainPaint.persona) problems.push('the persona card was not rendered');
    if (!/recorded sample/.test(chainPaint.personaText)) {
      problems.push('the persona card did not say balances need a live server in fixture mode');
    }

    // C1 and C2 (contracts v0.10): one block per session, its connection folded into one line, the
    // proof of who connected in its head, and in / out said in words on every row.
    const sessionPaint = JSON.parse(
      await evaluate(
        'JSON.stringify({sessions: [...document.querySelectorAll(".session-block")].map((n) => n.dataset.xs), connections: document.querySelectorAll(".session-connection").length, connectionRows: document.querySelectorAll(".session-connection .flow-context").length, badges: [...document.querySelectorAll(".session-head .identity-badge")].map((n) => n.textContent), io: [...document.querySelectorAll(".call-row .io-label")].map((n) => n.textContent), crossed: [...document.querySelectorAll(".session-block")].filter((block) => [...block.querySelectorAll(".call-row")].some((row) => !row.dataset.callKey.startsWith(block.dataset.xs + "#"))).length})',
      ),
    );
    notes.push(
      `sessions: ${sessionPaint.sessions.join(", ")}; ${sessionPaint.connections} connection lines; badges ${sessionPaint.badges.join(" | ")}`,
    );
    if (sessionPaint.sessions.join(',') !== 'xs_3f1c9a,xs_7b4d10') {
      problems.push(`expected the two recorded sessions as blocks, saw ${sessionPaint.sessions.join(", ")}`);
    }
    if (sessionPaint.crossed !== 0) problems.push(`${sessionPaint.crossed} session block(s) drew another session's call`);
    if (sessionPaint.connections !== 2) problems.push(`expected 2 connection lines, saw ${sessionPaint.connections}`);
    if (sessionPaint.connectionRows !== 0) problems.push('a connection opened before anyone asked');
    if (!sessionPaint.badges.every((text) => /claims .* · unsigned/.test(text))) {
      problems.push(`an unsigned session was not drawn as a claim: ${sessionPaint.badges.join(" | ")}`);
    }
    if (sessionPaint.io.length !== 52 || sessionPaint.io.some((text, index) => text !== (index % 2 === 0 ? 'in' : 'out'))) {
      problems.push(`expected "in" and "out" on each of the 26 rows, saw ${sessionPaint.io.length} labels`);
    }

    // A head is a toggle now: it opens the call, closes the same call, and two stay open at once.
    const heads = `[...document.querySelectorAll('.call-head')]`;
    const spine = `JSON.stringify({panes: document.querySelectorAll('.call-open').length, cards: document.querySelectorAll('.inside-cards').length, open: document.querySelectorAll('.call-head[aria-expanded=true]').length, rows: document.querySelectorAll('.call-row').length, titles: [...document.querySelectorAll('.call-open .wire-title')].map((n) => n.textContent.split(' \u00b7 ')[0]), footers: document.querySelectorAll('.call-open .wire-footer').length, rationale: document.querySelectorAll('.call-open [data-path="params.arguments.rationale"]').length})`;
    await evaluate(`${heads}[0].click()`);
    await sleep(160);
    const opened = JSON.parse(await evaluate(spine));
    notes.push(
      `one head clicked: ${opened.panes} pane, panes in order ${opened.titles.join(" / ")}, ${opened.footers} wire footers, ${opened.rationale} rationale row`,
    );
    if (opened.panes !== 1) problems.push(`clicking a head drew ${opened.panes} panes, expected 1`);
    if (opened.cards !== 0) problems.push('a call opened straight into its interior at depth calls');
    if (opened.rows !== 26) problems.push(`opening a call changed the row count to ${opened.rows}`);
    if (opened.titles.join('|') !== 'REQUEST|INSIDE|RESPONSE') {
      problems.push(`the three panes were not REQUEST / INSIDE / RESPONSE (saw ${opened.titles.join(" / ")})`);
    }
    // A pane with no footer is a claim with no provenance, which is what this layout exists to
    // prevent: both wire panes say what they were rebuilt from.
    if (opened.footers !== 2) problems.push(`an open call drew ${opened.footers} wire footers, expected 2`);
    if (opened.rationale !== 1) {
      problems.push(`the rationale was drawn ${opened.rationale} times, expected once, in arrival order`);
    }
    const trace = await evaluate("(document.querySelector('.call-open .call-trace') || {}).textContent || ''");
    notes.push(`tracking line: ${trace}`);
    if (!/login .*grant .*session .*request #/.test(trace)) {
      problems.push(`an open call did not print its tracking ids: ${trace}`);
    }
    await evaluate(`${heads}[0].click()`);
    await sleep(160);
    const closedAgain = JSON.parse(await evaluate(spine));
    if (closedAgain.panes !== 0) {
      problems.push(`clicking the same head again left ${closedAgain.panes} panes open`);
    }
    await evaluate(`${heads}[0].click()`);
    await evaluate(`${heads}[1].click()`);
    await sleep(200);
    const twoOpen = JSON.parse(await evaluate(spine));
    notes.push(`two heads open: ${twoOpen.panes} panes, ${twoOpen.open} controls say expanded`);
    if (twoOpen.panes !== 2 || twoOpen.open !== 2) {
      problems.push(`two calls did not stay open together (${twoOpen.panes} panes)`);
    }

    // Escape closes the block opened last, and only that one.
    await evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))",
    );
    await sleep(200);
    const afterEscape = JSON.parse(await evaluate(spine));
    notes.push(`after Escape: ${afterEscape.panes} panes`);
    if (afterEscape.panes !== 1) {
      problems.push(`Escape left ${afterEscape.panes} panes open, expected the last one closed`);
    }

    // Collapse all is the way back to the macro line from anywhere.
    await evaluate("window.__xray.act('collapse-all', 'all')");
    await sleep(250);
    const collapsed = JSON.parse(await evaluate(spine));
    notes.push(`collapse all: ${collapsed.panes} panes, ${collapsed.rows} rows`);
    if (collapsed.panes !== 0 || collapsed.rows !== 26) {
      problems.push(`collapse all left ${collapsed.panes} panes over ${collapsed.rows} rows`);
    }

    // Opening a block stops the tail-follow, and the page's own scrollIntoView must not re-arm it:
    // without the guard, opening the last row puts the scroller at the bottom and the next event
    // scrolls the reader off what they just opened.
    await evaluate(
      '(() => { const all = document.querySelectorAll(".call-head"); all[all.length - 1].click(); })()',
    );
    await sleep(250);
    const follow = await evaluate('window.__xray.view.follow');
    notes.push(`tail-follow after opening the last call: ${follow}`);
    if (follow !== false) problems.push('opening a call re-armed the tail-follow');

    // The depth control is the way back to the macro line, and the way down to every interior.
    await evaluate("window.__xray.act('set-depth', 'open')");
    await sleep(250);
    const depthOpen = JSON.parse(await evaluate(spine));
    notes.push(`depth open: ${depthOpen.panes} panes, ${depthOpen.cards} interiors`);
    if (depthOpen.panes !== 26) problems.push(`depth open drew ${depthOpen.panes} panes, expected 26`);
    if (depthOpen.cards !== 0) problems.push(`depth open drew ${depthOpen.cards} interiors, expected 0`);
    await evaluate("window.__xray.act('set-depth', 'inside')");
    await sleep(300);
    const depthInside = JSON.parse(await evaluate(spine));
    notes.push(`depth inside: ${depthInside.panes} panes, ${depthInside.cards} interiors`);
    // The rate-limited call ran nothing at all inside, so it is the one row with no cards; the
    // denied `create_transfer` still has the step-up the gate emitted.
    if (depthInside.cards !== 25) {
      problems.push(`depth inside drew ${depthInside.cards} interiors, expected 25`);
    }

    // What the deepest depth costs. The repaint gate skips an unchanged spine, so each sample
    // toggles the actor lens, which is a full repaint of every open call.
    const timing = JSON.parse(
      await evaluate(`(async () => {
        const samples = [];
        for (let index = 0; index < 5; index += 1) {
          const started = performance.now();
          window.__xray.act('set-actor-focus', index % 2 === 0 ? 'model' : 'server');
          await new Promise((done) => requestAnimationFrame(() => done()));
          document.body.offsetHeight;
          samples.push(Math.round(performance.now() - started));
        }
        window.__xray.act('set-actor-focus', 'server');
        return {samples, average: Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)};
      })().then((result) => JSON.stringify(result))`),
    );
    notes.push(`repaint at depth inside: ${timing.average} ms average of ${timing.samples.join(", ")} ms`);
    if (timing.average > REPAINT_CEILING_MS) {
      problems.push(
        `a repaint at depth inside took ${timing.average} ms on average, over the ${REPAINT_CEILING_MS} ms ceiling`,
      );
    }
    await sleep(200);

    // Every value is attributed, and the legend is the key to it. A pane that lost its actors
    // would still render, so the count of distinct rails is what has to be checked.
    const whoPaint = JSON.parse(
      await evaluate(
        'JSON.stringify({chips: [...document.querySelectorAll(".actor-chip")].map((n) => n.textContent), marks: document.querySelectorAll("[data-actor]").length, actors: [...new Set([...document.querySelectorAll("[data-actor]")].map((n) => n.dataset.actor))].sort(), implied: document.querySelectorAll(".wire-row.is-implied").length, rationale: document.querySelectorAll(".wire-rationale-row").length})',
      ),
    );
    notes.push(
      `who did what: ${whoPaint.marks} attributed marks by ${whoPaint.actors.join(", ")}, ${whoPaint.implied} implied rows`,
    );
    if (whoPaint.chips.length !== 5) {
      problems.push(`expected five actors in the legend, saw ${whoPaint.chips.length}`);
    }
    if (whoPaint.marks < 200) problems.push(`the spine drew only ${whoPaint.marks} attributed marks`);
    for (const actor of ["agent", "model", "server", "engine", "page"]) {
      if (!whoPaint.actors.includes(actor)) problems.push(`nothing was attributed to ${actor}`);
    }
    // `method` is implied by the event type and is never drawn as a recorded value.
    if (whoPaint.implied !== 26) problems.push(`${whoPaint.implied} implied rows, expected one per call`);
    if (whoPaint.rationale < 20) problems.push("no rationale was drawn as the model's own words");

    // Focusing one voice pushes the others back and removes none of them.
    await evaluate('document.querySelector(\'[data-action="set-actor-focus"][data-arg="model"]\').click()');
    await sleep(250);
    const focused = JSON.parse(
      await evaluate(
        'JSON.stringify({total: document.querySelectorAll("[data-actor]").length, dimmed: document.querySelectorAll("[data-actor].is-dimmed").length, dimmedModel: document.querySelectorAll(\'[data-actor="model"].is-dimmed\').length})',
      ),
    );
    if (focused.total !== whoPaint.marks) {
      problems.push(`focusing an actor changed the number of marks: ${whoPaint.marks} -> ${focused.total}`);
    }
    if (focused.dimmed === 0 || focused.dimmed >= focused.total) {
      problems.push(`focusing the model dimmed ${focused.dimmed} of ${focused.total} marks`);
    }
    if (focused.dimmedModel !== 0) problems.push("focusing the model dimmed the model's own marks");
    await evaluate('document.querySelector(\'[data-action="set-actor-focus"][data-arg="model"]\').click()');
    await sleep(150);

    // The same invariant the detail panel has, over the whole spine with every call open: only an
    // element with an `id` gets its scroll offset back after a repaint (`public/mount.js`).
    const spineTrapProbe = `JSON.stringify((() => {
      const panel = document.getElementById('panel-timeline');
      const traps = [];
      const tracked = [];
      for (const el of panel.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        const down = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        const across = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
        if (!down && !across) continue;
        const axes = (down ? 'down' : '') + (down && across ? '+' : '') + (across ? 'across' : '');
        if (el.id) tracked.push(el.id + ' (' + axes + ')');
        else {
          traps.push(
            (el.tagName.toLowerCase() + '.' + (el.className || 'no-class')).slice(0, 60) +
              ' (' + axes + ')',
          );
        }
      }
      return {
        tracked,
        traps: traps.slice(0, 6),
        trapCount: traps.length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })())`;
    const spineTraps = JSON.parse(await evaluate(spineTrapProbe));
    notes.push(
      `spine at 1680: tracked scrollers ${spineTraps.tracked.join(", ") || "none"}, ${spineTraps.trapCount} untracked`,
    );
    if (spineTraps.trapCount) {
      problems.push(
        `${spineTraps.trapCount} scroller(s) inside #panel-timeline carry no id, so a repaint loses their position: ${spineTraps.traps.join(", ")}`,
      );
    }
    if (spineTraps.overflow > 0) {
      problems.push(`the spine scrolls the page sideways by ${spineTraps.overflow}px at depth inside`);
    }

    // The phone width, with three calls open: the page may not scroll sideways there either.
    await evaluate("window.__xray.act('set-depth', 'calls')");
    await sleep(200);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId,
    );
    await sleep(400);
    await evaluate(`${heads}[0].click()`);
    await evaluate(`${heads}[1].click()`);
    await evaluate(`${heads}[2].click()`);
    await sleep(400);
    const phone = JSON.parse(await evaluate(spineTrapProbe));
    const phoneOpen = JSON.parse(await evaluate(spine));
    notes.push(
      `phone 390px: ${phoneOpen.panes} panes open, overflow ${phone.overflow}px, ${phone.trapCount} untracked scrollers`,
    );
    if (phoneOpen.panes !== 3) problems.push(`the phone width drew ${phoneOpen.panes} open panes, expected 3`);
    if (phone.overflow > 0) {
      problems.push(`at 390px three open calls scroll the page sideways by ${phone.overflow}px`);
    }
    if (phone.trapCount) {
      problems.push(`at 390px ${phone.trapCount} scroller(s) carry no id: ${phone.traps.join(", ")}`);
    }
    await evaluate(`${heads}[0].click()`);
    await evaluate(`${heads}[1].click()`);
    await evaluate(`${heads}[2].click()`);
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    await sleep(300);

    // D-31, D-32: the Account and the Overview take the whole width, draw from the sample account
    // and from the recording counted in the page, and fit a phone.
    await evaluate("window.__xray.act('set-page', 'account')");
    await sleep(900);
    const account = JSON.parse(
      await evaluate(
        'JSON.stringify({layout: document.getElementById("layout").hidden, title: (document.querySelector(".page-account .page-title") || {}).textContent || "", tiles: document.querySelectorAll(".account-tiles .stat").length, months: document.querySelectorAll(".chart-flow .chart-month").length, categories: document.querySelectorAll(".category-bar").length, audit: document.querySelectorAll(".audit-entry").length, lines: document.querySelectorAll(".statement-table tbody tr").length, cards: document.querySelectorAll(".bank-card").length})',
      ),
    );
    notes.push(
      `account: ${account.title}, ${account.tiles} tiles, ${account.months} months, ${account.categories} category bars, ${account.audit} agent changes, ${account.lines} statement rows, ${account.cards} cards`,
    );
    if (!account.layout) problems.push('the three-column layout stayed on screen under the Account view');
    if (account.tiles !== 6 || account.months !== 12 || account.categories !== 8 || account.audit !== 2) {
      problems.push(`the Account view is incomplete: ${JSON.stringify(account)}`);
    }
    await evaluate("window.__xray.act('account-filter', 'direction', 'in')");
    await sleep(300);
    const filteredIn = await evaluate('[...document.querySelectorAll(".statement-table td.is-out")].length');
    if (filteredIn !== 0) problems.push(`the "money in" filter still drew ${filteredIn} outgoing lines`);
    await evaluate("window.__xray.act('account-filter-clear')");
    await evaluate("window.__xray.act('set-page', 'overview')");
    await sleep(700);
    const overview = JSON.parse(
      await evaluate(
        'JSON.stringify({tiles: document.querySelectorAll(".overview-tiles .stat").length, buckets: document.querySelectorAll(".chart-calls .chart-bucket").length, tools: document.querySelectorAll(".overview-table tbody tr").length, coverage: (document.querySelector(".overview-coverage") || {}).textContent || ""})',
      ),
    );
    notes.push(`overview: ${overview.tiles} tiles, ${overview.buckets} time buckets, ${overview.tools} table rows`);
    if (overview.tiles !== 9 || overview.buckets < 1 || overview.tools < 5) {
      problems.push(`the Overview is incomplete: ${JSON.stringify(overview)}`);
    }
    if (!/Counted by this page from the recording/.test(overview.coverage)) {
      problems.push('the Overview did not say it counted the recording in the page');
    }
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId,
    );
    await sleep(300);
    const overviewPhone = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    await evaluate("window.__xray.act('set-page', 'account')");
    await sleep(500);
    const accountPhone = await evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    if (overviewPhone > 0 || accountPhone > 0) {
      problems.push(`at 390px the Overview scrolls sideways by ${overviewPhone}px and the Account by ${accountPhone}px`);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    await evaluate("window.__xray.act('set-page', 'chain')");
    await sleep(300);

    // The erase controls never appear in fixture mode: there is no server to ask.
    const eraseInFixture = await evaluate(
      'document.querySelectorAll(\'[data-action="ask-erase"], [data-action="hide-events"]\').length',
    );
    if (eraseInFixture !== 0) {
      problems.push(`${eraseInFixture} erase controls were drawn in fixture mode`);
    }

    // The row-per-event mode, for the row counts and the filters below.
    await evaluate('window.__xray.act("set-timeline-mode", "events")');
    await sleep(120);
    const rendered = await evaluate(
      'JSON.stringify({mode: window.__xray.view.timelineMode, rows: document.querySelectorAll(".row").length, boots: document.querySelectorAll(".boot-divider").length, sessions: document.querySelectorAll(".session-row").length, tabs: document.querySelectorAll(".tab").length, now: !!document.querySelector(".now-strip")})',
    );
    notes.push(`first paint: ${rendered}`);
    const paint = JSON.parse(rendered);
    if (paint.mode !== 'events') problems.push(`expected events mode after the switch, saw ${paint.mode}`);
    if (paint.rows < 100) problems.push(`the timeline drew only ${paint.rows} rows`);
    if (paint.sessions !== 2) problems.push(`expected 2 session rows, saw ${paint.sessions}`);
    if (paint.boots !== 3) problems.push(`expected 3 server markers, saw ${paint.boots}`);
    if (paint.tabs !== 6) problems.push(`expected 6 detail tabs, saw ${paint.tabs}`);
    if (!paint.now) problems.push('the now strip was not rendered');

    // --- drive every panel ---------------------------------------------------------------
    const click = async (selector) => {
      const ok = await evaluate(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`,
      );
      if (!ok) problems.push(`nothing matched ${selector}`);
      await sleep(90);
    };

    for (const tab of ['call', 'tools', 'auth', 'intent', 'sql', 'health']) {
      await click(`[data-action="select-tab"][data-arg="${tab}"]`);
      const size = await evaluate('document.getElementById("panel-detail").textContent.length');
      notes.push(`tab ${tab}: ${size} characters`);
      if (!size || size < 80) problems.push(`tab ${tab} rendered almost nothing (${size} chars)`);
    }

    // A tool call, then one of its nested events, then an unknown-shaped raw event.
    await click('.row-ok');
    await click('[data-action="select-tab"][data-arg="call"]');
    const callText = await evaluate('document.getElementById("panel-detail").textContent');
    if (!/Stated intent|Arguments/.test(callText ?? '')) {
      problems.push('selecting a call row did not open the call inspector');
    }
    await click('.boot-divider');

    // Filters across every session, then the session picker, pause, theme and the transport.
    await click('[data-action="toggle-filter-token"][data-arg="status:error"]');
    await sleep(120);
    const filtered = await evaluate('document.querySelectorAll(".row").length');
    notes.push(`rows with status:error: ${filtered}`);
    if (!filtered) problems.push('the status:error filter hid every row');
    await click('[data-action="toggle-filter-token"][data-arg="kind:sql"]');
    await sleep(120);
    const both = await evaluate('document.querySelectorAll(".row").length');
    notes.push(`rows with status:error kind:sql: ${both}`);
    if (both !== 2) problems.push(`expected 2 rejected statements, saw ${both}`);
    await click('[data-action="clear-filter"]');
    await sleep(90);
    const cleared = await evaluate('document.querySelectorAll(".row").length');
    if (cleared < 100) problems.push(`clearing the filter left only ${cleared} rows`);
    await click('.session-row');
    await click('[data-action="toggle-pause"]');
    await click('[data-action="jump-live"]');
    await click('[data-action="cycle-theme"]');
    await click('[data-action="cycle-theme"]');
    await click('[data-action="select-session"][data-arg=""]');

    // Back to chain mode: the Bytes button opens the inspector, and a filter narrows the steps.
    await click('[data-action="set-timeline-mode"][data-arg="chain"]');
    await sleep(120);
    await click('.call-bytes');
    const stepText = await evaluate('document.getElementById("panel-detail").textContent');
    if (!/Stated intent|Arguments/.test(stepText ?? '')) {
      problems.push('the Bytes button of a call row did not open the call inspector');
    }
    const bytesOpened = await evaluate('document.querySelectorAll(".call-open").length');
    if (bytesOpened !== 0) problems.push('the Bytes button expanded the call as well as selecting it');
    await click('[data-action="toggle-filter-token"][data-arg="status:error"]');
    await sleep(120);
    const errorRows = await evaluate('document.querySelectorAll(".call-row").length');
    notes.push(`chain rows with status:error: ${errorRows}`);
    if (!errorRows || errorRows >= chainPaint.rows) {
      problems.push(`the status:error filter left ${errorRows} of ${chainPaint.rows} rows`);
    }
    await click('[data-action="clear-filter"]');
    await sleep(90);
    const modeStored = await evaluate('localStorage.getItem("glass-bank-xray-timeline-mode")');
    if (modeStored !== 'chain') problems.push(`the timeline mode was not remembered (saw ${modeStored})`);

    // --- the JSON viewer, and the scroll trap that used to sit in the inspector ------------
    // The reported bug: the Raw envelope could not be dragged down. The detail panel was remounted
    // four times a second, `mount.js` can only put an inner scroller back when it carries an `id`,
    // and the old `<pre class="code">` carried none - so 5,864 px of envelope inside a 350 px box
    // went back to scrollTop 0 on every repaint. The case that broke is the biggest envelope in
    // the recording, so this asks the store for it rather than naming an id the fixture may move
    // (today it is event 21, `catalog.tools_listed`, 17 tools).
    const biggest = JSON.parse(
      await evaluate(
        'JSON.stringify((() => { const events = window.__xray.store.getEvents(); let best = events[0]; let chars = 0; for (const event of events) { const size = JSON.stringify(event).length; if (size > chars) { chars = size; best = event; } } window.__xray.act("select-event", best.id); return {id: best.id, type: best.type, chars}; })())',
      ),
    );
    await sleep(200);
    notes.push(`biggest envelope: event ${biggest.id} ${biggest.type}, ${biggest.chars} characters`);
    if (biggest.chars < 3000) {
      problems.push(`the biggest envelope in the fixture is only ${biggest.chars} characters; this proves nothing`);
    }
    // Every scroller inside the panel, and whether `mount.js` could ever put it back. A box with
    // `overflow: visible` spills into the panel and scrolls nothing, which is what the viewer is
    // supposed to do; a box with `overflow: hidden` (the visually-hidden `.section-title`, an
    // ellipsis clip) holds no position a reader can move. Only `auto` and `scroll` can be dragged,
    // and only an element with an `id` gets its offset restored after a repaint.
    const trapProbe = `JSON.stringify((() => {
      const panel = document.getElementById('panel-detail');
      const traps = [];
      const tracked = [];
      for (const el of panel.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        const down = /auto|scroll/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
        const across = /auto|scroll/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1;
        if (!down && !across) continue;
        const axes = (down ? 'down' : '') + (down && across ? '+' : '') + (across ? 'across' : '');
        if (el.id) tracked.push(el.id + ' (' + axes + ')');
        else {
          traps.push(
            (el.tagName.toLowerCase() + '.' + (el.className || 'no-class')).slice(0, 60) +
              ' (' + axes + ')',
          );
        }
      }
      const raw = panel.querySelector('.jv-raw');
      const tree = panel.querySelector('.jv-tree');
      return {
        viewers: panel.querySelectorAll('.jv').length,
        rows: panel.querySelectorAll('.jv-node').length,
        shut: panel.querySelectorAll('.jv-toggle[aria-expanded=false]').length,
        open: panel.querySelectorAll('.jv-toggle[aria-expanded=true]').length,
        title: (panel.querySelector('.jv-title') || {}).textContent || '',
        rawId: raw ? raw.id : '',
        rawHidden: raw ? raw.hidden : null,
        rawChars: raw ? raw.textContent.length : 0,
        treeHidden: tree ? tree.hidden : null,
        panelContent: panel.scrollHeight,
        panelBox: panel.clientHeight,
        tracked,
        traps: traps.slice(0, 6),
        trapCount: traps.length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })())`;
    const viewer = JSON.parse(await evaluate(trapProbe));
    notes.push(
      `json viewer: ${viewer.viewers} viewer(s), ${viewer.rows} rows, ${viewer.open} open, ${viewer.shut} shut, title "${viewer.title}"`,
    );
    notes.push(
      `detail panel: ${viewer.panelContent}px of content in a ${viewer.panelBox}px box, tracked scrollers ${viewer.tracked.join(", ") || "none"}`,
    );
    if (!/Raw envelope/.test(viewer.title)) {
      problems.push(`the inspector did not draw the raw envelope viewer (title "${viewer.title}")`);
    }
    if (viewer.viewers < 1) problems.push('the inspector drew no JSON viewer for an event');
    if (viewer.rows < 20) {
      problems.push(`the viewer drew only ${viewer.rows} rows for a ${biggest.chars}-character envelope`);
    }
    if (viewer.open < 1) problems.push('every branch arrived shut, so the envelope cannot be read at all');
    if (viewer.shut < 5) {
      problems.push(`only ${viewer.shut} branches were folded away; a big envelope must arrive skimmable`);
    }
    if (viewer.panelContent <= viewer.panelBox + 1) {
      problems.push('the detail panel did not overflow its box, so nothing below proves the scroller');
    }
    // The invariant the whole change exists to establish.
    if (viewer.trapCount) {
      problems.push(
        `${viewer.trapCount} scroller(s) inside #panel-detail carry no id, so a repaint loses their position: ${viewer.traps.join(", ")}`,
      );
    }
    if (viewer.overflow > 0) problems.push(`the inspector scrolls the page sideways by ${viewer.overflow}px`);

    // Opening a branch must survive a repaint: what is open lives in `view.json`, not in the DOM.
    // This is the regression test for the reported bug - before the fix, four repaints a second
    // threw away everything the reader had done to the panel.
    const openedArg = await evaluate(
      '(() => { const shut = document.querySelector("#panel-detail .jv-toggle[aria-expanded=false]"); if (!shut) return ""; shut.click(); return shut.dataset.arg || ""; })()',
    );
    const stateOf = (arg) =>
      evaluate(
        `(() => { const want = ${JSON.stringify(arg)}; const el = [...document.querySelectorAll("#panel-detail .jv-toggle")].find((n) => n.dataset.arg === want); return el ? el.getAttribute("aria-expanded") : "gone"; })()`,
      );
    await sleep(200);
    if (!openedArg) problems.push('the envelope viewer offered no shut branch to open');
    const afterClick = openedArg ? await stateOf(openedArg) : 'none';
    if (afterClick !== 'true') problems.push(`clicking a shut branch left it ${afterClick}`);
    await evaluate('window.__xray.render()');
    await sleep(300);
    const afterRender = openedArg ? await stateOf(openedArg) : 'none';
    notes.push(`opened branch ${openedArg}: ${afterClick} -> ${afterRender} after a repaint`);
    if (afterRender !== 'true') {
      problems.push(`a repaint closed the branch that was opened by hand (${afterRender})`);
    }

    // And the panel's own scroll offset survives the repaint a click causes, which is the symptom
    // that was reported: the reader drags the envelope down and it snaps back.
    const scrolled = await evaluate(
      '(() => { const panel = document.getElementById("panel-detail"); panel.scrollTop = Math.round((panel.scrollHeight - panel.clientHeight) * 0.5); return panel.scrollTop; })()',
    );
    await evaluate(
      '(() => { const shut = document.querySelector("#panel-detail .jv-toggle[aria-expanded=false]"); if (shut) shut.click(); })()',
    );
    await sleep(300);
    const scrollAfter = await evaluate('document.getElementById("panel-detail").scrollTop');
    notes.push(`panel scroll across a repaint: ${scrolled} -> ${scrollAfter}`);
    if (!scrolled) problems.push('the detail panel could not be scrolled at all');
    else if (Math.abs(scrollAfter - scrolled) > 2) {
      problems.push(`a repaint moved the panel from ${scrolled} to ${scrollAfter}`);
    }

    // Raw swaps the tree for the exact text. The text is always in the DOM behind the tree, under
    // an id, because that is what the Copy button reads and what `mount.js` can put back.
    if (!viewer.rawId.endsWith('-raw')) problems.push(`the raw block has no id (saw "${viewer.rawId}")`);
    if (viewer.rawHidden !== true) problems.push('the raw text was not hidden behind the tree');
    if (viewer.treeHidden === true) problems.push('the tree was hidden before Raw was ever clicked');
    if (viewer.rawChars < 2000) problems.push(`the hidden raw text held only ${viewer.rawChars} characters`);
    const rawClicked = await evaluate(
      '(() => { const button = [...document.querySelectorAll("#panel-detail .jv-action")].find((n) => (n.dataset.arg || "").endsWith("!raw")); if (!button) return false; button.click(); return true; })()',
    );
    if (!rawClicked) problems.push('the viewer offered no Raw button');
    await sleep(250);
    const rawView = JSON.parse(await evaluate(trapProbe));
    notes.push(
      `raw mode: ${rawView.rawChars} characters in #${rawView.rawId}, tree hidden ${rawView.treeHidden}, scrollers ${rawView.tracked.join(", ") || "none"}, ${rawView.trapCount} of them untracked`,
    );
    if (rawView.rawHidden !== false || rawView.treeHidden !== true) {
      problems.push(`Raw did not swap the tree for the text (raw hidden ${rawView.rawHidden}, tree hidden ${rawView.treeHidden})`);
    }
    if (rawView.trapCount) {
      problems.push(`raw mode left ${rawView.trapCount} scroller(s) with no id: ${rawView.traps.join(", ")}`);
    }
    if (rawView.overflow > 0) problems.push(`raw mode scrolls the page sideways by ${rawView.overflow}px`);
    await evaluate(
      '(() => { const button = [...document.querySelectorAll("#panel-detail .jv-action")].find((n) => (n.dataset.arg || "").endsWith("!raw")); if (button) button.click(); })()',
    );
    await sleep(200);

    // --- the Possibility space: what the client was told for each tool ------------------------
    // Every full listing is re-hashed in this browser as it is applied (`view.schemaChecks`); the
    // page is served from 127.0.0.1, a secure context, so crypto.subtle exists and all 17 recorded
    // schemas of the listing on screen must come back intact.
    await evaluate("window.__xray.act('select-tab', 'tools')");
    const verdictProbe =
      'JSON.stringify({rows: document.querySelectorAll("#panel-detail .tool-item").length, verified: document.querySelectorAll("#panel-detail .tool-item-head [data-check=verified]").length, pending: document.querySelectorAll("#panel-detail .tool-item-head [data-check=pending]").length, mismatch: document.querySelectorAll("#panel-detail .tool-item-head [data-check=mismatch]").length, unavailable: document.querySelectorAll("#panel-detail .tool-item-head [data-check=unavailable]").length, head: (document.querySelector("#panel-detail .listing-head") || {}).textContent || "", secure: window.isSecureContext})';
    let verdicts = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(100);
      verdicts = JSON.parse(await evaluate(verdictProbe));
      if (verdicts.rows > 0 && verdicts.pending === 0) break;
    }
    notes.push(
      `possibility space: ${verdicts.rows} tools, ${verdicts.verified} verified, ${verdicts.mismatch} mismatch, ${verdicts.unavailable} unavailable, ${verdicts.pending} pending (secure context ${verdicts.secure})`,
    );
    notes.push(`listing header: ${verdicts.head}`);
    if (verdicts.rows !== 17) problems.push(`the Possibility space drew ${verdicts.rows} tools, expected 17`);
    if (verdicts.verified !== 17) {
      problems.push(
        `expected 17 intact recorded schemas, saw ${verdicts.verified} verified, ${verdicts.mismatch} mismatch, ${verdicts.unavailable} unavailable, ${verdicts.pending} pending`,
      );
    }
    if (!/tools\/list #\d+/.test(verdicts.head) || !/17 of 17 sent/.test(verdicts.head)) {
      problems.push(`the listing header did not name its listing and what was sent: ${verdicts.head}`);
    }
    if (!/not wording or schemas/.test(verdicts.head)) {
      problems.push('the listing header did not say what content_hash does not cover');
    }
    // The re-list line is drawn only when the latest tools/list of the session on screen carried no
    // rows; a catalog.availability after a full listing must not make the page claim otherwise.
    const relist = JSON.parse(
      await evaluate(`JSON.stringify((() => {
        const xray = window.__xray;
        const xs = xray.view.selectedXs || (xray.store.getSessions()[0] || {}).xs || null;
        const listings = xray.store.getEvents({ xs }).filter((event) => event.type === 'catalog.tools_listed');
        const last = listings[listings.length - 1];
        return {
          xs,
          lastListing: last ? last.id : null,
          carriedRows: Boolean(last && last.data && Array.isArray(last.data.tools) && last.data.tools.length),
          line: (document.querySelector('#panel-detail .listing-resolved') || {}).textContent || '',
        };
      })())`),
    );
    notes.push(
      `re-list line on ${relist.xs}: latest tools/list #${relist.lastListing} carried rows ${relist.carriedRows}; line "${relist.line}"`,
    );
    if (relist.carriedRows && relist.line) {
      problems.push(`the page says a re-list carried no rows, but tools/list #${relist.lastListing} did: ${relist.line}`);
    }
    if (!relist.carriedRows && relist.lastListing !== null && !relist.line) {
      problems.push(`tools/list #${relist.lastListing} carried no rows and the page did not say where the rows came from`);
    }
    const toolOpened = await evaluate(
      '(() => { const button = document.querySelector(\'#panel-detail .tool-item[data-tool="execute_query"] .tool-item-toggle\'); if (!button) return false; button.click(); return true; })()',
    );
    if (!toolOpened) problems.push('execute_query offered no control to open its descriptor');
    await sleep(250);
    const toolCardProbe = `JSON.stringify((() => {
      const card = document.querySelector('#panel-detail .tool-item[data-tool="execute_query"] .tool-card');
      if (!card) return {card: false};
      const rows = [...card.querySelectorAll('.param-table tr.param-row')];
      const rationale = card.querySelector('.param-row.is-rationale');
      const root = getComputedStyle(document.documentElement).getPropertyValue('--who-model').trim();
      return {
        card: true,
        params: rows.map((row) => row.dataset.param + '=' + row.querySelector('.param-required').textContent),
        rationaleRequired: rationale ? rationale.querySelector('.param-required').textContent : '',
        rationaleColour: rationale ? getComputedStyle(rationale).getPropertyValue('--who').trim() === root : false,
        answer: (card.querySelector('.param-answer') || {}).textContent || '',
        description: (card.querySelector('.tool-card-description') || {}).textContent || '',
        full: (card.querySelector('.schema-check-full') || {}).textContent || '',
        follow: window.__xray.view.follow,
      };
    })())`;
    const toolCard = JSON.parse(await evaluate(toolCardProbe));
    notes.push(
      `execute_query opened: ${toolCard.card ? toolCard.params.join(', ') : 'no card'}; ${toolCard.answer}`,
    );
    if (!toolCard.card) {
      problems.push('opening execute_query drew no descriptor card');
    } else {
      if (toolCard.params.join('|') !== 'table_name=yes|query=yes|rationale=yes') {
        problems.push(`the parameter table of execute_query read ${toolCard.params.join(', ')}`);
      }
      if (toolCard.rationaleRequired !== 'yes') problems.push('the rationale row did not say it is required');
      if (!toolCard.rationaleColour) problems.push('the rationale row does not wear the model colour');
      if (!/answered by params\.arguments\.rationale on every tools\/call/.test(toolCard.answer)) {
        problems.push(`the rationale row lost its sentence: ${toolCard.answer}`);
      }
      if (toolCard.description.length < 400) {
        problems.push(`the description was drawn with only ${toolCard.description.length} characters`);
      }
      if (!/^recorded schema is intact: re-hashes to the digest recorded beside it, computed in this browser$/.test(toolCard.full)) {
        problems.push(`the open card's verdict read "${toolCard.full}"`);
      }
    }
    // An open descriptor is view state: it survives a repaint, and it scrolls nothing without an id.
    // `render()` alone repaints nothing here (the detail signature is unchanged), so the probe marks
    // the card, leaves the tab and comes back, which remounts #panel-detail; a card still carrying
    // the mark would mean nothing was redrawn.
    await evaluate(
      '(() => { const card = document.querySelector(\'#panel-detail .tool-item[data-tool="execute_query"] .tool-card\'); if (card) card.setAttribute("data-probe-stale", "1"); })()',
    );
    await evaluate("window.__xray.act('select-tab', 'call')");
    await sleep(200);
    await evaluate("window.__xray.act('select-tab', 'tools')");
    await sleep(250);
    const toolCardAgain = JSON.parse(await evaluate(toolCardProbe));
    const remounted = await evaluate(
      '(() => { const card = document.querySelector(\'#panel-detail .tool-item[data-tool="execute_query"] .tool-card\'); return card ? !card.hasAttribute("data-probe-stale") : false; })()',
    );
    notes.push(`descriptor card after leaving the tab and coming back: open ${toolCardAgain.card}, remounted ${remounted}`);
    if (!toolCardAgain.card) problems.push('a repaint closed the descriptor card that was opened by hand');
    else if (!remounted) problems.push('the tab round trip did not remount the detail panel, so nothing was repainted');
    const toolTraps = JSON.parse(await evaluate(trapProbe));
    if (toolTraps.trapCount) {
      problems.push(
        `the open descriptor left ${toolTraps.trapCount} scroller(s) with no id: ${toolTraps.traps.join(", ")}`,
      );
    }
    if (toolTraps.overflow > 0) {
      problems.push(`the open descriptor scrolls the page sideways by ${toolTraps.overflow}px`);
    }
    await evaluate(
      '(() => { const button = document.querySelector(\'#panel-detail .tool-item[data-tool="execute_query"] .tool-item-toggle\'); if (button) button.click(); })()',
    );
    await sleep(200);
    await evaluate("window.__xray.act('select-tab', 'call')");
    await sleep(150);

    // --- pass 2: the timed player, a step, and the empty state ---------------------------
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${port}/xray/?fixture=1&rate=100` },
      sessionId,
    );
    await sleep(900);
    const playing = await evaluate('window.__xray ? window.__xray.events : -1');
    notes.push(`timed replay applied ${playing} events in ~0.9 s at 100x`);
    if (playing < 1) problems.push('the timed fixture player released no events');
    await click('[data-action="fixture-toggle"]');
    await click('[data-action="fixture-step"]');
    await click('[data-action="fixture-skip"]');
    await sleep(200);
    const afterSkip = await evaluate('window.__xray ? window.__xray.events : 0');
    if (afterSkip !== EXPECTED_EVENTS) {
      problems.push(`skip to end left ${afterSkip} events, expected ${EXPECTED_EVENTS}`);
    }

    // --- pass 3: the live path with no server, which must land on the pairing screen -----
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/xray/` }, sessionId);
    await sleep(900);
    const gate = await evaluate(
      'JSON.stringify({gate: !document.getElementById("gate").hidden, input: !!document.getElementById("pair-input")})',
    );
    notes.push(`unpaired view: ${gate}`);
    const gateState = JSON.parse(gate);
    if (!gateState.gate || !gateState.input) {
      problems.push('an unpaired viewer did not get the pairing screen');
    }
  } catch (error) {
    problems.push(`harness error: ${error && error.message ? error.message : error}`);
  } finally {
    await cleanup.run();
  }

  for (const note of notes) console.log(`  ${note}`);
  if (problems.length) {
    console.error('\nFAIL');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\nPASS: the full fixture rendered and every panel was driven with no console error.');
  process.exit(0);
}

main();
