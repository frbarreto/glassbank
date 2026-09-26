/* global EventSource */
/**
 * Event sources (block: dashboard).
 *
 * Two implementations behind one interface, so the panels and the reducer never know which one is
 * running:
 *
 * - `createLiveSource` wraps `EventSource` on `GET /xray/api/stream`. The browser reconnects on its
 *   own and sends `Last-Event-ID`, which is what makes Cloud Run's 60-minute cut invisible
 *   (docs/XRAY_EVENT_MODEL.md section 5). When the browser gives up (`readyState === CLOSED`) this
 *   module rebuilds the connection with capped exponential backoff; that new connection has no
 *   `Last-Event-ID`, so the server replays its default window and the reducer drops what it
 *   already holds by event id.
 * - `createFixtureSource` replays `test/fixtures/events.jsonl` on the fixture clock, with play,
 *   pause, step, rate and skip-to-end. It is what `?fixture=1` uses, and it needs no server.
 */

export const RECONNECT_BASE_MS = 2000;
export const RECONNECT_MAX_MS = 30_000;

/** `2000, 4000, 8000, ... 30000` with a little jitter so many viewers do not sync up. */
export function backoffMs(attempt) {
  const raw = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.min(RECONNECT_MAX_MS, Math.round(raw * (0.85 + Math.random() * 0.3)));
}

/** The live SSE client. `onEvent(envelope)`, `onState({state, attempts, nextRetryAt, lastError})`. */
export function createLiveSource({ url, onEvent, onState }) {
  let source = null;
  let attempts = 0;
  let timer = null;
  let stopped = false;

  function report(state, extra = {}) {
    onState({ state, attempts, ...extra });
  }

  function open() {
    if (stopped) return;
    clearTimeout(timer);
    timer = null;
    report(attempts === 0 ? 'connecting' : 'reconnecting');
    try {
      source = new EventSource(url, { withCredentials: true });
    } catch (error) {
      scheduleRetry(String(error && error.message ? error.message : error));
      return;
    }

    source.addEventListener('open', () => {
      attempts = 0;
      report('open');
    });

    // The server names every frame `event: xray` (SSE_EVENT_NAME).
    source.addEventListener('xray', (message) => {
      let envelope;
      try {
        envelope = JSON.parse(message.data);
      } catch {
        return;
      }
      onEvent(envelope);
    });

    source.addEventListener('error', () => {
      // readyState CONNECTING means the browser is retrying by itself and will send
      // Last-Event-ID; only a CLOSED socket needs us to rebuild it.
      if (!source) return;
      if (source.readyState === 2) {
        source.close();
        source = null;
        scheduleRetry('the stream was closed by the server');
      } else {
        report('reconnecting', { lastError: 'the connection dropped' });
      }
    });
  }

  function scheduleRetry(lastError) {
    if (stopped) return;
    attempts += 1;
    const wait = backoffMs(attempts);
    report('reconnecting', { nextRetryAt: Date.now() + wait, lastError });
    timer = setTimeout(open, wait);
  }

  return {
    kind: 'live',
    start() {
      stopped = false;
      open();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      if (source) source.close();
      source = null;
      report('idle');
    },
    /** Explicit "Reconnect now": drops the socket and opens a fresh one immediately. */
    reconnect() {
      clearTimeout(timer);
      if (source) source.close();
      source = null;
      attempts = 0;
      open();
    },
  };
}

/** Parses a JSONL body, skipping blank lines; a malformed line is reported, never thrown. */
export function parseJsonl(text, onBadLine) {
  const events = [];
  const lines = String(text ?? '').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      if (onBadLine) onBadLine(index + 1, error);
    }
  }
  return events;
}

/**
 * The fixture player. Events are released on the fixture's own clock scaled by `rate`, so a
 * 7-minute recording plays in about 20 seconds at 20x and every gap stays proportional.
 */
export function createFixtureSource({ url, onEvent, onState, onProgress, rate = 20 }) {
  let events = [];
  let cursor = 0;
  let playing = false;
  let currentRate = rate;
  let timer = null;
  let originEpoch = 0;
  let startedAt = 0;
  let lastReleasedEpoch = 0;

  function report(extra = {}) {
    onState({
      state: 'fixture',
      attempts: 0,
      playing,
      rate: currentRate,
      cursor,
      total: events.length,
      // The dashboard clock follows the recording, not the wall clock, so "3 s ago" and the
      // elapsed time in the "now" strip mean what they say while a fixture is replaying.
      clock: playing ? fixtureNow() : lastReleasedEpoch || originEpoch || Date.now(),
      clockAt: Date.now(),
      ...extra,
    });
  }

  function fixtureNow() {
    if (!events.length) return 0;
    const elapsed = (Date.now() - startedAt) * currentRate;
    return originEpoch + elapsed;
  }

  function emitUpTo(limitEpoch) {
    let released = 0;
    while (cursor < events.length) {
      const event = events[cursor];
      const at = Date.parse(event.ts);
      if (Number.isFinite(at) && at > limitEpoch) break;
      onEvent(event);
      if (Number.isFinite(at)) lastReleasedEpoch = at;
      cursor += 1;
      released += 1;
    }
    if (onProgress) onProgress(cursor, events.length);
    return released;
  }

  function tick() {
    if (!playing) return;
    emitUpTo(fixtureNow());
    if (cursor >= events.length) {
      playing = false;
      report({ finished: true });
      return;
    }
    report();
    timer = setTimeout(tick, 60);
  }

  function rebase() {
    startedAt = Date.now();
    originEpoch = cursor < events.length ? Date.parse(events[cursor].ts) - 1 : Date.now();
  }

  return {
    kind: 'fixture',
    async start(options = {}) {
      report({ loading: true });
      let text;
      try {
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`the fixture answered ${response.status}`);
        text = await response.text();
      } catch (error) {
        onState({
          state: 'closed',
          attempts: 0,
          lastError: `The sample data could not be loaded: ${
            error && error.message ? error.message : error
          }`,
        });
        return;
      }
      events = parseJsonl(text);
      cursor = 0;
      if (options.applyAll) {
        emitUpTo(Number.POSITIVE_INFINITY);
        playing = false;
        report({ finished: true });
        return;
      }
      playing = true;
      rebase();
      report();
      tick();
    },
    stop() {
      playing = false;
      clearTimeout(timer);
      timer = null;
      report();
    },
    play() {
      if (playing || cursor >= events.length) return;
      playing = true;
      rebase();
      report();
      tick();
    },
    pause() {
      playing = false;
      clearTimeout(timer);
      timer = null;
      report();
    },
    /** Releases exactly one event; the way to stop just after a `tool.call.started`. */
    step() {
      this.pause();
      if (cursor >= events.length) return;
      const event = events[cursor];
      onEvent(event);
      const at = Date.parse(event.ts);
      if (Number.isFinite(at)) lastReleasedEpoch = at;
      cursor += 1;
      if (onProgress) onProgress(cursor, events.length);
      report();
    },
    setRate(value) {
      currentRate = Number(value) || 1;
      if (playing) rebase();
      report();
    },
    skipToEnd() {
      this.pause();
      emitUpTo(Number.POSITIVE_INFINITY);
      report({ finished: true });
    },
    restart() {
      this.pause();
      cursor = 0;
      report({ restarted: true });
    },
    reconnect() {
      this.play();
    },
    get total() {
      return events.length;
    },
    get cursor() {
      return cursor;
    },
  };
}
