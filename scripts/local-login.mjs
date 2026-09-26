/**
 * Log in to a locally running Glass Bank and get a usable access token.
 *
 * The browser pages (`/authorize` -> `/login` -> `/consent`) cannot be opened directly: they only
 * render inside a real OAuth authorization request, which needs a registered client and a PKCE
 * challenge. This script does that handshake for you, prints the URL to open, catches the
 * callback on a loopback listener, exchanges the code, and writes the token to
 * `.glass-bank-token.json` so the other local commands can use it.
 *
 * Usage (with `npm run dev` already running in another terminal):
 *
 *   node scripts/local-login.mjs              # read-only grant (write tools return 403: the step-up demo)
 *   node scripts/local-login.mjs --write      # also request cards:write and transfers:write
 *   BASE_URL=http://127.0.0.1:8080 node scripts/local-login.mjs
 *
 * Nothing here is a secret worth protecting: the bank is fake and the tokens are local. The token
 * file is gitignored anyway.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const TOKEN_FILE = resolve(REPO_ROOT, '.glass-bank-token.json');

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
// 0 means "any free port". The callback allowlist matches loopback URIs port-agnostically (A-13),
// so the port never has to be fixed, and a run left waiting cannot block the next one.
const CALLBACK_PORT = Number(process.env.CALLBACK_PORT ?? 0);

const READ_SCOPES = [
  'profile',
  'accounts:read',
  'transactions:read',
  'cards:read',
  'transfers:read',
  'bills:read',
  'payees:read',
  'xray:read',
];
const WRITE_SCOPES = ['cards:write', 'transfers:write'];

const wantsWrite = process.argv.includes('--write');
const scopes = wantsWrite ? [...READ_SCOPES, ...WRITE_SCOPES] : READ_SCOPES;

const base64url = (buffer) => buffer.toString('base64url');
const verifier = base64url(randomBytes(32));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = base64url(randomBytes(16));

function fail(message, detail) {
  console.error(`\n  ${message}`);
  if (detail) console.error(`  ${detail}`);
  process.exit(1);
}

async function main() {
  // 1. Is the server actually up? A clear message beats a fetch stack trace.
  try {
    const health = await fetch(`${BASE_URL}/healthz`);
    if (!health.ok) fail(`${BASE_URL}/healthz answered ${health.status}.`);
  } catch {
    fail(
      `No server at ${BASE_URL}.`,
      'Start one in another terminal with:  npm run dev',
    );
  }

  // 2. Open the loopback listener first, so the redirect URI names a port we know is free.
  let settle;
  const callbackReceived = new Promise((resolvePromise, rejectPromise) => {
    settle = { resolve: resolvePromise, reject: rejectPromise };
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      response.writeHead(404).end('not found');
      return;
    }
    const returnedCode = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Glass Bank</title>` +
        `<body style="font:16px system-ui;padding:3rem;max-width:40rem">` +
        (returnedCode
          ? `<h1>Signed in</h1><p>Go back to the terminal: your access token is printed there.</p>`
          : `<h1>Authorization failed</h1><p>${error ?? 'no code returned'}</p>`) +
        `</body>`,
    );
    server.close();
    if (url.searchParams.get('state') !== state) {
      settle.reject(new Error('the callback carried the wrong state'));
    } else if (returnedCode) {
      settle.resolve(returnedCode);
    } else {
      settle.reject(new Error(error ?? 'the callback carried no code'));
    }
  });
  server.on('error', (error) =>
    settle.reject(new Error(`cannot open the callback listener: ${error.message}`)),
  );
  await new Promise((ready) => server.listen(CALLBACK_PORT, '127.0.0.1', ready));
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;

  // 3. Register as a public client, exactly the way Claude does.
  const registration = await fetch(`${BASE_URL}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Glass Bank local login',
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  if (registration.status !== 201) {
    server.close();
    fail(
      `POST /register answered ${registration.status}.`,
      await registration.text(),
    );
  }
  const client = await registration.json();

  const authorizeUrl =
    `${BASE_URL}/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(client.client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&scope=${encodeURIComponent(scopes.join(' '))}` +
    `&resource=${encodeURIComponent(`${BASE_URL}/mcp`)}`;

  console.log('');
  console.log('  Open this in your browser and sign in:');
  console.log('');
  console.log(`  ${authorizeUrl}`);
  console.log('');
  console.log(`  Scopes requested: ${scopes.join(' ')}`);
  if (!wantsWrite) {
    console.log(
      '  (read-only: calling a write tool returns the 403 step-up. Add --write to grant them.)',
    );
  }
  console.log('  Waiting for the callback...');

  // 4. Wait for the consent page to redirect back here.
  const code = await callbackReceived.catch((error) => fail(error.message));

  // 5. Exchange the code, proving possession of the PKCE verifier.
  const tokenResponse = await fetch(`${BASE_URL}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${BASE_URL}/mcp`,
    }),
  });
  if (!tokenResponse.ok) {
    fail(`POST /token answered ${tokenResponse.status}.`, await tokenResponse.text());
  }
  const tokens = await tokenResponse.json();

  writeFileSync(
    TOKEN_FILE,
    `${JSON.stringify({ base_url: BASE_URL, client_id: client.client_id, ...tokens }, null, 2)}\n`,
  );

  console.log('');
  console.log('  Signed in.');
  console.log('');
  console.log(`  Access token : ${tokens.access_token}`);
  console.log(`  Scopes       : ${tokens.scope}`);
  console.log(`  Expires in   : ${tokens.expires_in}s`);
  console.log(`  Saved to     : ${TOKEN_FILE}`);
  console.log('');
  console.log('  Try it:');
  console.log('');
  console.log(`  TOKEN=$(python3 -c "import json;print(json.load(open('.glass-bank-token.json'))['access_token'])")`);
  console.log('');
  console.log(`  curl -s -X POST ${BASE_URL}/mcp \\`);
  console.log(`    -H "authorization: Bearer $TOKEN" \\`);
  console.log(`    -H 'content-type: application/json' \\`);
  console.log(`    -H 'accept: application/json, text/event-stream' \\`);
  console.log(`    -H 'mcp-protocol-version: 2025-06-18' \\`);
  console.log(`    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_current_user","arguments":{"rationale":"seeing who I am"}}}'`);
  console.log('');
}

main().catch((error) => fail(error.message));
