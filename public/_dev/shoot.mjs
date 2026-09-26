/**
 * Screenshots of the dashboard in both themes (block: dashboard).
 *
 * The same headless-Chrome plumbing as check-console.mjs, used to look at the page rather than to
 * assert on it: it opens `?fixture=1&autoplay=all`, selects a call, and writes a PNG per view.
 *
 * Usage: node public/_dev/shoot.mjs [output-directory]
 * The DevTools port is auto-assigned; set CDP_PORT (9334 by convention here) to pin it.
 */
/* global WebSocket */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { listen } from './serve.mjs';

const CHROME =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = Number(process.env.CDP_PORT ?? 0);
const OUT = resolve(process.argv[2] ?? join(tmpdir(), 'xray-shots'));

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
    }
  });
  return {
    ready,
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
  await mkdir(OUT, { recursive: true });
  const cleanup = createCleanup();
  const { server, port } = await listen(0);
  cleanup.add(() => {
    server.closeAllConnections?.();
    server.close();
  });
  const profile = await mkdtemp(join(tmpdir(), 'xray-shot-'));
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
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
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

  try {
    const version = await waitForDevTools(await waitForDebugPort(profile));
    const cdp = createCdp(version.webSocketDebuggerUrl);
    cleanup.add(() => cdp.close());
    await cdp.ready;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 1680, height: 1000, deviceScaleFactor: 2, mobile: false },
      sessionId,
    );

    const evaluate = (expression) =>
      cdp
        .send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
        .then((result) => result.result.value);

    const setTheme = (theme) =>
      cdp.send(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: theme }] },
        sessionId,
      );

    const shoot = async (name) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(join(OUT, `${name}.png`));
    };

    await setTheme('light');
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${port}/xray/?fixture=1&autoplay=all` },
      sessionId,
    );
    await sleep(1400);
    // The spine as it arrives: one line per call, the model's arguments on the left of the arrow
    // and the server's bytes on the right, and nothing opened.
    await shoot('00a-spine-light');
    await setTheme('dark');
    await sleep(250);
    await shoot('00b-spine-dark');
    await setTheme('light');
    await sleep(200);
    // One row open: the triptych - the request as it arrived, what happened inside, the result as
    // it left - with the interior unfolded so the cards under the two wire panes are visible.
    await evaluate(
      '(() => { const heads = document.querySelectorAll(".call-head"); if (heads[2]) heads[2].click(); })()',
    );
    await sleep(200);
    await evaluate(
      '(() => { const inside = document.querySelector(".inside-toggle"); if (inside) inside.click(); })()',
    );
    await sleep(300);
    await shoot('01-chain-light');
    await setTheme('dark');
    await sleep(250);
    await shoot('02-chain-dark');
    // The same page scrolled down, where several episodes and the threads inside them are visible.
    await setTheme('light');
    await evaluate(
      '(() => { const s = document.getElementById("timeline-scroll"); if (s) s.scrollTop = s.scrollHeight * 0.45; })()',
    );
    await sleep(250);
    await shoot('01b-chain-episodes-light');
    await setTheme('dark');
    await sleep(250);
    await shoot('02b-chain-episodes-dark');
    await setTheme('light');
    // The legend as a lens: one voice read on its own, the other four pushed back but still there.
    await evaluate(
      'document.querySelector(\'[data-action="set-actor-focus"][data-arg="model"]\').click()',
    );
    await sleep(250);
    await shoot('01d-chain-focus-model');
    await evaluate(
      'document.querySelector(\'[data-action="set-actor-focus"][data-arg="model"]\').click()',
    );
    await evaluate(
      'document.querySelector(\'[data-action="set-actor-focus"][data-arg="page"]\').click()',
    );
    await sleep(250);
    // The one lens that lights the connectors instead of the bands: what this page worked out itself.
    await shoot('01e-chain-focus-page');
    await evaluate(
      'document.querySelector(\'[data-action="set-actor-focus"][data-arg="page"]\').click()',
    );
    await sleep(150);
    await evaluate(
      'document.querySelector(\'[data-action="set-actor-focus"][data-arg="model"]\').click()',
    );
    await sleep(200);
    // Depth `open`: every call showing its three panes at once, which is the density the depth
    // control exists to let a reader choose.
    await evaluate('(() => { const s = document.getElementById("timeline-scroll"); if (s) s.scrollTop = 0; })()');
    await evaluate("window.__xray.act('set-depth', 'open')");
    await sleep(400);
    await shoot('01f-chain-depth-open');
    await evaluate("window.__xray.act('set-depth', 'calls')");
    await sleep(250);
    // The row-per-event mode is still there behind the segmented control.
    await evaluate('document.querySelector(\'[data-action="set-timeline-mode"][data-arg="events"]\').click()');
    await sleep(300);
    await shoot('01c-events-light');
    await evaluate('document.querySelector(\'[data-action="set-timeline-mode"][data-arg="chain"]\').click()');
    await sleep(250);
    // The erase controls never appear over the fixture, because there is no server to ask; flip the
    // view into live mode for one frame so the two of them can be looked at.
    await evaluate(
      '(() => { window.__xray.view.mode = "live"; window.__xray.view.erase = {scope: null, busy: false, note: null, error: null}; window.__xray.render(); })()',
    );
    await sleep(250);
    await shoot('11-erase-controls');
    await evaluate(
      '(() => { window.__xray.view.erase = {scope: "login", busy: false, note: null, error: null}; window.__xray.render(); })()',
    );
    await sleep(250);
    await shoot('12-erase-confirm');
    await evaluate('(() => { window.__xray.view.mode = "fixture"; window.__xray.render(); })()');
    await sleep(200);
    // The Call inspector over the biggest envelope in the recording (`catalog.tools_listed`, 5.3 KB
    // over 17 tools): the JSON viewer, scrolled to its head and with one tool opened by hand, so the
    // shot shows a shut branch and an open one side by side.
    await evaluate(
      '(() => { const events = window.__xray.store.getEvents(); let best = events[0]; let chars = 0; for (const event of events) { const size = JSON.stringify(event).length; if (size > chars) { chars = size; best = event; } } window.__xray.act("select-event", best.id); })()',
    );
    await sleep(300);
    await evaluate(
      '(() => { const shut = document.querySelector("#panel-detail .jv-toggle[aria-expanded=false]"); if (shut) shut.click(); })()',
    );
    await sleep(250);
    await evaluate(
      '(() => { const viewer = document.querySelector("#panel-detail .jv"); if (viewer) viewer.scrollIntoView({block: "start"}); })()',
    );
    await sleep(250);
    await shoot('03a-call-json-light');
    await setTheme('dark');
    await sleep(250);
    await shoot('03b-call-json-dark');
    await setTheme('light');
    await sleep(200);
    for (const [tab, name] of [
      ['tools', '03-possibility'],
      ['auth', '04-session-auth'],
      ['intent', '05-intent'],
      ['sql', '06-sql'],
      ['health', '07-health'],
    ]) {
      await evaluate(`document.querySelector('[data-action="select-tab"][data-arg="${tab}"]').click()`);
      await sleep(250);
      await shoot(name);
    }
    // The Possibility space with execute_query opened: the description verbatim, the parameter
    // table with the rationale row in the model colour, annotations, _meta and the digest verdict.
    await evaluate('document.querySelector(\'[data-action="select-tab"][data-arg="tools"]\').click()');
    await sleep(300);
    await evaluate(
      '(() => { const button = document.querySelector(\'#panel-detail .tool-item[data-tool="execute_query"] .tool-item-toggle\'); if (button) button.click(); })()',
    );
    await sleep(300);
    await evaluate(
      '(() => { const item = document.querySelector(\'#panel-detail .tool-item[data-tool="execute_query"]\'); if (item) item.scrollIntoView({block: "start"}); })()',
    );
    await sleep(250);
    await shoot('03c-possibility-tool-open');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/xray/` }, sessionId);
    await sleep(900);
    await shoot('08-pairing-dark');
    await setTheme('light');
    await sleep(250);
    await shoot('09-pairing-light');

    // One phone-width frame, because the layout collapses to a single column there.
    await setTheme('light');
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
      sessionId,
    );
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${port}/xray/?fixture=1&autoplay=all` },
      sessionId,
    );
    await sleep(1400);
    await shoot('10-phone');
    // The same width with a call open: the three panes stack and nothing scrolls sideways.
    await evaluate(
      '(() => { const heads = document.querySelectorAll(".call-head"); if (heads[2]) heads[2].click(); })()',
    );
    await sleep(400);
    await shoot('10b-phone-open');
  } finally {
    await cleanup.run();
  }
  process.exit(0);
}

main();
