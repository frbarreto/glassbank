/* global location */
/**
 * The HTTP client (block: dashboard).
 *
 * The dashboard talks to the server over the routes of `src/contracts/xray-api.ts` and nothing
 * else (docs/REPO_LAYOUT.md section 3). Route strings are copied here rather than imported,
 * because `public/` imports nothing from `src/`.
 *
 * The base path is detected at runtime so the same files work mounted at `/xray/` in production
 * and served from the root by the tiny dev server in `public/_dev/serve.mjs`.
 */

/** `/xray` in production; `''` when the files are served from the root during development. */
export function detectBase(pathname) {
  const path = String(pathname ?? '/');
  if (path === '/xray' || path.startsWith('/xray/')) return '/xray';
  return '';
}

/**
 * The pseudo login of the public lane (`PUBLIC_LOGIN_ID` in `src/contracts/public.ts`, D-26): every
 * anonymous visitor of `/public/mcp` is filed under it. A copy, checked by `contract-copy.test.mjs`.
 */
export const PUBLIC_LOGIN_ID = 'lgn_public';

/** `?lane=public` (`PUBLIC_LANE_QUERY`): the public lane's reads need no cookie and ignore one. */
export const PUBLIC_LANE = 'public';

/** Appends `lane=public` to a read URL when the page is watching the public lane. */
export function withLane(url, lane) {
  if (lane !== PUBLIC_LANE) return url;
  return `${url}${url.includes('?') ? '&' : '?'}lane=${PUBLIC_LANE}`;
}

/** Every route the dashboard uses, relative to the detected base (`XRAY_ROUTES` in the contract). */
export function routes(base) {
  return {
    fixtures: `${base}/fixtures/events.jsonl`,
    pair: `${base}/api/pair`,
    admin: `${base}/api/admin`,
    me: `${base}/api/me`,
    sessions: `${base}/api/sessions`,
    session: (xs) => `${base}/api/sessions/${encodeURIComponent(xs)}`,
    sessionEvents: (xs) => `${base}/api/sessions/${encodeURIComponent(xs)}/events`,
    /** v0.3: the persona behind a session with its balances, for the persona card. */
    sessionBank: (xs) => `${base}/api/sessions/${encodeURIComponent(xs)}/bank`,
    /** v0.4: `DELETE` erases every event of the viewer's login. `GET` is not served. */
    events: `${base}/api/events`,
    catalog: `${base}/api/catalog`,
    stream: `${base}/api/stream`,
    /** v0.8 (D-27): the log this viewer may read, as a JSONL download. */
    export: `${base}/api/export`,
  };
}

/**
 * One fetch wrapper. Cookies are the only credential (the viewer JWT, ADR-10); no header ever
 * carries a token, and none is ever read back into this page.
 */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: 'bad_response', message: 'The server did not answer with JSON.' };
      }
    }
    return { ok: response.ok, status: response.status, payload };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      payload: {
        error: 'network',
        message: error && error.name === 'AbortError' ? 'The request timed out.' : 'The server could not be reached.',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the client. `base` defaults to the detected mount point; `options.lane === 'public'`
 * turns every read into a public-lane read (v0.7, D-26), which needs no cookie.
 */
export function createApi(
  base = detectBase(typeof location === 'undefined' ? '/' : location.pathname),
  options = {},
) {
  const route = routes(base);
  const lane = options.lane === PUBLIC_LANE ? PUBLIC_LANE : null;
  const read = (url) => withLane(url, lane);
  return {
    base,
    route,
    lane,
    me: () => request(read(route.me)),
    sessions: () => request(read(route.sessions)),
    session: (xs) => request(read(route.session(xs))),
    sessionEvents: (xs, query = {}) => {
      const params = new URLSearchParams();
      if (query.after !== undefined) params.set('after', String(query.after));
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.toString() ? `?${params}` : '';
      return request(read(`${route.sessionEvents(xs)}${suffix}`));
    },
    /** `XraySessionBankResponse`, or `{error, message}` (401, 403, 404 `not_found` / `no_persona`, 503 `unavailable`). */
    sessionBank: (xs) => request(read(route.sessionBank(xs))),
    /**
     * v0.4: erases every event of the viewer's login. `XrayDeleteResponse {deleted, sessions,
     * scope}` on success; `{error, message}` with 401 (no cookie) or 403 (observer mode, which is
     * read-only). A server older than v0.4 answers 404 or 405 and the caller shows that as a
     * plain message rather than breaking the page.
     */
    deleteEvents: () => request(route.events, { method: 'DELETE' }),
    /** v0.4: erases one session. 403 for observer mode, and for an unknown or another login's `xs`. */
    deleteSession: (xs) => request(route.session(xs), { method: 'DELETE' }),
    catalog: (xs) => request(read(`${route.catalog}?xs=${encodeURIComponent(xs)}`)),
    pair: (code) => request(route.pair, { method: 'POST', body: { code } }),
    admin: (token) => request(route.admin, { method: 'POST', body: { token } }),
    /** The SSE URL for one of the three viewer filters of section 5. */
    streamUrl: (filter) => {
      if (filter && filter.xs) return read(`${route.stream}?xs=${encodeURIComponent(filter.xs)}`);
      if (filter && filter.all) return `${route.stream}?all=1`;
      return read(`${route.stream}?login=me`);
    },
    fixturesUrl: () => route.fixtures,
    /**
     * v0.8 (D-27): the JSONL download of every event this viewer may read. A plain link, so the
     * browser sends the cookie itself (or, on the public lane, needs none) and saves the file.
     */
    exportUrl: () => read(route.export),
  };
}

/** Reads `?fixture=1` and the other query switches the dev loop uses. */
export function readQuery(search) {
  const params = new URLSearchParams(String(search ?? ''));
  return {
    fixture: params.get('fixture') === '1',
    /** `all` applies the whole fixture at once; used by the console check and by "Skip to end". */
    autoplay: params.get('autoplay'),
    rate: params.get('rate') ? Number(params.get('rate')) : null,
    xs: params.get('xs'),
    all: params.get('all') === '1',
    /** `?lane=public`: watch the public lane, no pairing code needed (D-26). */
    lane: params.get('lane') === PUBLIC_LANE ? PUBLIC_LANE : null,
  };
}
