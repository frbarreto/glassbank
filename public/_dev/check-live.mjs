/* global WebSocket */
/**
 * Exercises the live path against a stub of the X-ray HTTP API (block: dashboard).
 *
 * `check-console.mjs` drives the SPA from the fixture; this one drives it the way production will:
 * `GET /xray/api/me`, `GET /xray/api/sessions`, an SSE stream on `GET /xray/api/stream`, and
 * `POST /xray/api/pair`. The stub implements exactly what `src/contracts/xray-api.ts` specifies
 * and nothing more, so it can be run before the `xray` block exists.
 *
 * What it proves:
 *   1. an unpaired viewer gets the pairing screen, and a valid code opens the dashboard;
 *   2. the SSE client applies `event: xray` frames as they arrive;
 *   3. when the server cuts the stream mid-session (Cloud Run does this hourly), the browser
 *      reconnects on its own with `Last-Event-ID` and the replay closes the gap;
 *   4. the overlapping replay produces no duplicate rows, because the reducer keys on event id.
 *
 * Usage: node public/_dev/check-live.mjs
 * The DevTools port is auto-assigned; set CDP_PORT (9335 by convention here) to pin it.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRequestPath } from './serve.mjs';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 0);
const VALID_CODE = 'BANK-7Q2F-K3MZ-8A';
/** Frames sent before the stub cuts the first connection, to force one reconnect. */
const CUT_AFTER = 120;

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../fixtures/events.jsonl', import.meta.url)),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
};

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

/** The stub API. `state` records what the browser did so the assertions can read it back. */
function createStubServer() {
  const state = { streams: 0, lastEventIds: [], replayed: [], cut: false };

  const json = (response, status, body, headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const paired = String(request.headers.cookie ?? '').includes('xray_viewer=');

    if (url.pathname === '/xray/api/pair') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const code = JSON.parse(body || '{}').code;
      if (code !== VALID_CODE) {
        json(response, 400, { error: 'unknown_code', message: 'no such code' });
        return;
      }
      json(
        response,
        200,
        { ok: true, viewer_kind: 'pairing', login_id: 'lgn_5d2c7a', expires_at: '2026-09-09T14:00:00.000Z' },
        { 'Set-Cookie': 'xray_viewer=stub; Path=/; HttpOnly; SameSite=Lax' },
      );
      return;
    }

    if (url.pathname.startsWith('/xray/api/')) {
      if (!paired) {
        json(response, 401, { error: 'not_paired', message: 'exchange a pairing code first' });
        return;
      }
      if (url.pathname === '/xray/api/me') {
        json(response, 200, {
          viewer_kind: 'pairing',
          login_id: 'lgn_5d2c7a',
          grant_ids: ['grt_8a1e33'],
          persona: { id: 'per_a1b2', name: 'Ava Bennett', kind: 'retail', shared: true },
          expires_at: '2026-09-09T14:00:00.000Z',
        });
        return;
      }
      if (url.pathname === '/xray/api/sessions') {
        json(response, 200, { data: [], page: { next: null } });
        return;
      }
      if (url.pathname === '/xray/api/stream') {
        const since = Number(request.headers['last-event-id'] ?? 0);
        state.streams += 1;
        state.lastEventIds.push(since);
        const pending = FIXTURE.filter((event) => event.id > since);
        state.replayed.push(pending.length);

        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        response.write('retry: 300\n\n');

        let index = 0;
        const timer = setInterval(() => {
          if (index >= pending.length) {
            response.write(': ping\n\n');
            return;
          }
          const event = pending[index];
          index += 1;
          response.write(`event: xray\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
          // The first connection is cut part-way through, the way Cloud Run cuts a stream at
          // 60 minutes. The browser must resume from Last-Event-ID and lose nothing.
          if (state.streams === 1 && event.id >= CUT_AFTER) {
            state.cut = true;
            clearInterval(timer);
            response.destroy();
          }
        }, 4);

        request.on('close', () => clearInterval(timer));
        return;
      }
      json(response, 404, { error: 'not_found', message: url.pathname });
      return;
    }

    const target = resolveRequestPath(request.url);
    if (!target) {
      response.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error('not a file');
      response.writeHead(200, {
        'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  });

  return { server, state };
}

async function waitForDevTools(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await sleep(120);
  }
  throw new Error('Chrome did not expose a DevTools endpoint');
}

function createCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let nextId = 1;
  const ready = new Promise((done, fail) => {
    socket.addEventListener('open', () => done());
    socket.addEventListener('error', () => fail(new Error('websocket error')));
  });
  socket.addEventListener('message', (message) => {
    const frame = JSON.parse(message.data);
    if (frame.id && pending.has(frame.id)) {
      const { resolve: done, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.error) reject(new Error(frame.error.message));
      else done(frame.result);
      return;
    }
    for (const listener of listeners) listener(frame);
  });
  return {
    ready,
    on: (listener) => listeners.push(listener),
    send(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
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
    close: () => socket.close(),
  };
}

async function main() {
  const problems = [];
  const notes = [];
  const cleanup = createCleanup();
  const { server, state } = createStubServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  cleanup.add(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const port = server.address().port;
  const profile = await mkdtemp(join(tmpdir(), 'xray-live-'));
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
      '--window-size=1680,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  cleanup.add(async () => {
    chrome.kill('SIGKILL');
    // A helper process outliving the one we killed can recreate the profile directory.
    await sleep(300);
  });

  let cdp = null;
  try {
    const version = await waitForDevTools(await waitForDebugPort(profile));
    cdp = createCdp(version.webSocketDebuggerUrl);
    cleanup.add(() => cdp.close());
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.on((frame) => {
      if (frame.sessionId !== sessionId) return;
      if (frame.method === 'Runtime.exceptionThrown') {
        problems.push(
          `uncaught exception: ${frame.params.exceptionDetails?.exception?.description ?? '?'}`,
        );
      }
      if (frame.method === 'Runtime.consoleAPICalled' && frame.params.type === 'error') {
        problems.push(
          `console.error: ${(frame.params.args ?? []).map((a) => a.value ?? a.description).join(' ')}`,
        );
      }
    });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        throw new Error(`evaluate failed: ${result.exceptionDetails.text}`);
      }
      return result.result.value;
    };

    // --- 1. the front door -----------------------------------------------------------------
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/xray/` }, sessionId);
    await sleep(800);
    const gate = await evaluate('!document.getElementById("gate").hidden');
    if (!gate) problems.push('a viewer with no cookie did not get the pairing screen');
    notes.push(`unpaired viewer sees the pairing screen: ${gate}`);

    // The submit button is disabled until the code is complete, and the repaint that enables it
    // runs on an animation frame, so the harness has to wait for it exactly like a person would.
    const typeCode = (code) =>
      evaluate(
        '(async () => {' +
          "  const input = document.getElementById('pair-input');" +
          '  input.value = ' +
          JSON.stringify(code) +
          ';' +
          "  input.dispatchEvent(new Event('input', { bubbles: true }));" +
          '  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 60)));' +
          '  const button = document.querySelector(\'[data-action="submit-pairing"]\');' +
          "  if (!button || button.disabled) return 'the submit button stayed disabled';" +
          '  button.click();' +
          '  return null;' +
          '})()',
      );

    const typedWrong = await typeCode('BANK-AAAA-BBBB-CC');
    if (typedWrong) problems.push(typedWrong);
    await sleep(500);
    const rejected = await evaluate(
      'document.querySelector(".pair-error") ? document.querySelector(".pair-error").textContent : null',
    );
    notes.push(`a wrong code is refused in English: ${JSON.stringify(rejected)}`);
    if (!rejected || !/code/i.test(rejected)) problems.push('a wrong pairing code produced no message');

    const typedRight = await typeCode(VALID_CODE);
    if (typedRight) problems.push(typedRight);

    // --- 2 to 4. the stream, its cut, and the replay ---------------------------------------
    let applied = 0;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await sleep(100);
      applied = (await evaluate('window.__xray ? window.__xray.events : 0')) ?? 0;
      if (applied >= 200) break;
    }
    const report = JSON.parse(
      (await evaluate(
        'JSON.stringify({events: window.__xray.events, dup: window.__xray.store.getCounters().duplicates, state: window.__xray.view.connection.state, calls: window.__xray.store.getCalls().length, mode: window.__xray.view.timelineMode, rows: document.querySelectorAll(".row").length, steps: document.querySelectorAll(".call-row").length, episodes: document.querySelectorAll(".episode").length, erase: document.querySelectorAll(\'[data-action="ask-erase"]\').length})',
      )) ?? '{}',
    );
    notes.push(
      `applied ${report.events} events, ${report.calls} calls, ${report.episodes} episodes and ${report.steps} steps drawn (${report.mode} mode), ${report.rows} rows (events mode)`,
    );
    notes.push(`erase controls offered to this paired viewer: ${report.erase}`);
    notes.push(
      `stream connections: ${state.streams}, Last-Event-ID values seen: ${JSON.stringify(
        state.lastEventIds,
      )}, replayed per connection: ${JSON.stringify(state.replayed)}`,
    );
    notes.push(`duplicate events dropped by the reducer: ${report.dup}`);

    if (report.events !== 200) problems.push(`expected 200 events over SSE, saw ${report.events}`);
    if (!state.cut) problems.push('the stub never cut the stream, so no reconnect was exercised');
    if (state.streams < 2) problems.push('the browser did not reconnect after the cut');
    // The browser resumes from the last frame it fully parsed, which is the frame before the one
    // the cut truncated - so anything close to CUT_AFTER proves the header was sent.
    if (!(state.lastEventIds[1] > 0) || state.lastEventIds[1] < CUT_AFTER - 5) {
      problems.push(
        `the reconnect did not carry Last-Event-ID (saw ${JSON.stringify(state.lastEventIds)})`,
      );
    }
    if (report.state !== 'open') problems.push(`connection state is ${report.state}, expected open`);
    if (report.mode !== 'chain') problems.push(`expected chain mode by default, saw ${report.mode}`);
    if (report.episodes < 4) problems.push(`the chain drew only ${report.episodes} episodes`);
    if (report.steps !== 26) problems.push(`the chain drew ${report.steps} steps, expected 26`);
    // A paired viewer may erase its own history: one control per session plus the login-wide one.
    if (report.erase < 2) problems.push(`expected the erase controls, saw ${report.erase}`);
    // 24 `tool.call.started` plus the two calls that were denied before they ever started.
    if (report.calls !== 26) problems.push(`expected 26 calls, saw ${report.calls}`);
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
  console.log('\nPASS: pairing, live SSE, a mid-stream cut and the Last-Event-ID replay all work.');
  process.exit(0);
}

main();
