/**
 * A static server for the dashboard lane (block: dashboard).
 *
 * The SPA is served by the `xray` block in production; this is the development loop, so the page
 * can be opened and driven from `test/fixtures/events.jsonl` with no server built yet. It serves
 * `public/` at the root **and** under `/xray/`, which is where the real router mounts it, so the
 * base-path detection in `api.js` is exercised both ways.
 *
 * Usage: node public/_dev/serve.mjs [port]
 *        then open http://127.0.0.1:8081/xray/?fixture=1
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Maps a request path to a file inside `public/`, or `null` when it escapes the directory. */
export function resolveRequestPath(urlPath) {
  let path = decodeURIComponent(String(urlPath).split('?')[0]);
  if (path === '/xray' || path.startsWith('/xray/')) path = path.slice('/xray'.length) || '/';
  if (path.endsWith('/')) path += 'index.html';
  const target = normalize(join(PUBLIC_DIR, path));
  // `public/fixtures` is a symlink to `test/fixtures`, so compare against the request path, not
  // the realpath, and refuse anything that climbs out with `..`.
  if (!target.startsWith(PUBLIC_DIR)) return null;
  return target;
}

const server = createServer(async (request, response) => {
  const target = resolveRequestPath(request.url ?? '/');
  if (!target) {
    response.writeHead(403, { 'Content-Type': 'text/plain' });
    response.end('forbidden');
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
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`not found: ${request.url}`);
  }
});

const port = Number(process.argv[2] ?? process.env.PORT ?? 8081);

/** Started for its own sake when run directly; imported by check-console.mjs as a helper. */
export function listen(requestedPort = port) {
  return new Promise((resolvePromise) => {
    server.listen(requestedPort, '127.0.0.1', () => {
      resolvePromise({ server, port: server.address().port });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  listen().then(({ port: actual }) => {
    console.log(`Glass Bank X-ray (dev): http://127.0.0.1:${actual}/xray/?fixture=1`);
    console.log(`                        http://127.0.0.1:${actual}/?fixture=1`);
  });
}
