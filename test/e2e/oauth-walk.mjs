/**
 * The scripted end-to-end OAuth + MCP walk (T0.3 deliverable D).
 *
 * Starts the spike server, then does everything a real client does, with no browser:
 *
 *   1. discovery: PRM (both paths) and RFC 8414 authorization-server metadata
 *   2. the unauthenticated 401 and its `WWW-Authenticate` challenge
 *   3. dynamic client registration
 *   4. GET /authorize, POST /login, POST /consent - driven by parsing the rendered forms
 *   5. POST /token with PKCE S256, then a refresh, then the replays that must be `invalid_grant`
 *   6. an MCP client from the SDK over Streamable HTTP: initialize, tools/list, and a real
 *      `get_current_user` call
 *   7. the 403 `insufficient_scope` step-up for a write tool under a read-only grant
 *
 * Exit code 0 means every step passed. Any failure prints what was expected and what came back.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const PORT = Number(process.env.E2E_PORT ?? 8899);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://127.0.0.1:60123/callback';

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const jar = new Map();

async function http(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (jar.size > 0) {
    headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
  }
  const response = await fetch(new URL(path, BASE_URL), { ...init, headers, redirect: 'manual' });
  for (const raw of response.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return response;
}

function hidden(html, name) {
  const match = new RegExp(`name="${name}"\\s+value="([^"]*)"`).exec(html);
  if (!match) throw new Error(`the page carried no hidden field "${name}"`);
  return match[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function form(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

async function startServer() {
  // The real entry point, not a stand-in: `src/server.ts` is what `npm start` and the container
  // run, so the walk exercises the composition root itself (docs/BUILD_PLAN.md I1).
  const child = spawn(
    'npx',
    ['tsx', 'src/server.ts'],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        PUBLIC_BASE_URL: BASE_URL,
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
        // Private SQLite files, so a walk never reads or evicts a developer's local state.
        AUTH_DB_PATH: join(tmpdir(), `glass-bank-e2e-auth-${process.pid}.sqlite`),
        XRAY_DB_PATH: join(tmpdir(), `glass-bank-e2e-xray-${process.pid}.sqlite`),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const serverLog = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => serverLog.push(chunk));

  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('the spike server did not start in 30 s')), 30_000);
    child.stdout.on('data', (chunk) => {
      serverLog.push(chunk);
      if (chunk.includes('"event":"server.started"')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`the spike server exited with code ${code}:\n${serverLog.join('')}`));
    });
  });

  return { child, serverLog };
}

async function main() {
  const { child, serverLog } = await startServer();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  const state = randomBytes(8).toString('hex');

  try {
    section('1. Discovery');
    const health = await http('/healthz');
    check('/healthz answers 200', health.status === 200);

    const prmRoot = await http('/.well-known/oauth-protected-resource');
    const prmMcp = await http('/.well-known/oauth-protected-resource/mcp');
    check('PRM served at the bare path', prmRoot.status === 200, `status ${prmRoot.status}`);
    check('PRM served at /mcp', prmMcp.status === 200, `status ${prmMcp.status}`);
    const prm = await prmMcp.json();
    check('PRM resource is the canonical MCP URL', prm.resource === `${BASE_URL}/mcp`, prm.resource);
    check(
      'PRM authorization_servers points at this origin',
      Array.isArray(prm.authorization_servers) && prm.authorization_servers[0] === BASE_URL,
      JSON.stringify(prm.authorization_servers),
    );

    const asResponse = await http('/.well-known/oauth-authorization-server');
    const as = await asResponse.json();
    check('AS metadata issuer is this origin', as.issuer === BASE_URL, as.issuer);
    check('AS metadata advertises S256', (as.code_challenge_methods_supported ?? []).includes('S256'));
    check(
      'AS metadata advertises the registration endpoint',
      as.registration_endpoint === `${BASE_URL}/register`,
      as.registration_endpoint,
    );
    check(
      'AS metadata advertises public clients',
      (as.token_endpoint_auth_methods_supported ?? []).includes('none'),
    );

    section('2. The unauthenticated challenge');
    const challenge401 = await http('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    check('POST /mcp without a token answers 401', challenge401.status === 401, `status ${challenge401.status}`);
    const challengeBody = await challenge401.json();
    check(
      'the 401 body is Ramp’s',
      challengeBody.detail === 'No access token provided',
      JSON.stringify(challengeBody),
    );
    const wwwAuthenticate = challenge401.headers.get('www-authenticate') ?? '';
    check(
      'the challenge carries resource_metadata',
      wwwAuthenticate.includes(`resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`),
      wwwAuthenticate,
    );
    check('the challenge carries the read-only scope hint', wwwAuthenticate.includes('scope="profile'));

    for (const method of ['GET', 'DELETE']) {
      const response = await http('/mcp', { method });
      check(`${method} /mcp answers 405`, response.status === 405, `status ${response.status}`);
    }

    section('3. Dynamic client registration');
    const registration = await http('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Glass Bank e2e walk',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
      }),
    });
    check('POST /register answers 201', registration.status === 201, `status ${registration.status}`);
    const client = await registration.json();
    check('the registered client has an id and no secret', Boolean(client.client_id) && !client.client_secret);

    section('4. The browser leg, driven programmatically');
    const authorizeUrl =
      `/authorize?response_type=code&client_id=${encodeURIComponent(client.client_id)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}` +
      `&code_challenge=${challenge}&code_challenge_method=S256` +
      `&scope=${encodeURIComponent('profile accounts:read transactions:read cards:read transfers:read bills:read payees:read xray:read')}` +
      `&resource=${encodeURIComponent(`${BASE_URL}/mcp`)}`;
    const loginPage = await http(authorizeUrl);
    check('GET /authorize renders the login page', loginPage.status === 200, `status ${loginPage.status}`);
    check('the login page refuses framing', loginPage.headers.get('x-frame-options') === 'DENY');
    const loginHtml = await loginPage.text();
    check('the login page offers the seeded personas', loginHtml.includes('per_ava_stone'));
    check('the login page offers a demo customer', loginHtml.includes('Create a demo customer'));
    check('the login page accepts an existing per_ id', loginHtml.includes('name="persona_id"'));

    const consentPage = await http('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        txn: hidden(loginHtml, 'txn'),
        csrf: hidden(loginHtml, 'csrf'),
        choice: 'per_ava_stone',
      }),
    });
    check('POST /login renders the consent page', consentPage.status === 200, `status ${consentPage.status}`);
    check('the login POST sets the login_id cookie', jar.has('login_id'));
    const consentHtml = await consentPage.text();
    check('the consent page pre-checks read scopes', consentHtml.includes('value="accounts:read" checked'));

    const callback = await http('/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        txn: hidden(consentHtml, 'txn'),
        csrf: hidden(consentHtml, 'csrf'),
        scope: ['profile', 'accounts:read', 'transactions:read', 'cards:read', 'transfers:read', 'bills:read', 'payees:read', 'xray:read'],
        decision: 'approve',
      }),
    });
    check('POST /consent redirects to the callback', callback.status === 302, `status ${callback.status}`);
    const location = new URL(callback.headers.get('location'));
    check('the callback carries the state', location.searchParams.get('state') === state);
    check('the callback carries iss (RFC 9207)', location.searchParams.get('iss') === BASE_URL);
    const code = location.searchParams.get('code');
    check('the callback carries a code', Boolean(code));

    section('5. Token exchange, refresh and replay');
    const tokenResponse = await http('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        resource: `${BASE_URL}/mcp`,
      }),
    });
    check('POST /token answers 200', tokenResponse.status === 200, `status ${tokenResponse.status}`);
    const tokens = await tokenResponse.json();
    check(
      'the access token carries the mockbank_user_tok_ prefix',
      String(tokens.access_token).startsWith('mockbank_user_tok_'),
    );
    check('a refresh token was issued', Boolean(tokens.refresh_token));

    const codeReplay = await http('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
      }),
    });
    const codeReplayBody = await codeReplay.json();
    check('a replayed code answers invalid_grant', codeReplayBody.error === 'invalid_grant', JSON.stringify(codeReplayBody));

    // OAuth 2.1: a public client sends `client_id` on every token request, and the AS binds the
    // refresh token to the client it was issued to.
    const refreshed = await http('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    });
    const refreshedTokens = await refreshed.json();
    check('the refresh token can be exchanged', refreshed.status === 200, JSON.stringify(refreshedTokens));
    check('the refresh token rotated', refreshedTokens.refresh_token !== tokens.refresh_token);

    const wrongClient = await http('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: refreshedTokens.refresh_token,
        client_id: 'mcpb_someone_else',
      }),
    });
    const wrongClientBody = await wrongClient.json();
    check(
      'a refresh token presented with another client_id is invalid_grant',
      wrongClient.status === 400 && wrongClientBody.error === 'invalid_grant',
      JSON.stringify(wrongClientBody),
    );

    const noClient = await http('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: refreshedTokens.refresh_token }),
    });
    check(
      'a refresh exchange without client_id is invalid_grant (OAuth 2.1)',
      noClient.status === 400,
      `status ${noClient.status}`,
    );

    const refreshReplay = await http('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id,
      }),
    });
    const refreshReplayBody = await refreshReplay.json();
    check(
      'a replayed refresh token answers invalid_grant',
      refreshReplayBody.error === 'invalid_grant',
      JSON.stringify(refreshReplayBody),
    );

    const codeAsBearer = await http('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${code}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    check('a code presented as a bearer answers 401', codeAsBearer.status === 401, `status ${codeAsBearer.status}`);
    check(
      'and it is invalid_token, not a hint about the wrong endpoint',
      (codeAsBearer.headers.get('www-authenticate') ?? '').includes('error="invalid_token"'),
    );

    section('6. An MCP client from the SDK over Streamable HTTP');
    const accessToken = refreshedTokens.access_token;
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    });
    const mcpClient = new Client({ name: 'glass-bank-e2e', version: '0.1.0' });
    await mcpClient.connect(transport);

    const serverCapabilities = mcpClient.getServerCapabilities();
    check('the server declares tools', Boolean(serverCapabilities.tools));
    check('the server declares prompts', Boolean(serverCapabilities.prompts));
    check('the server declares resources', Boolean(serverCapabilities.resources));
    const instructions = mcpClient.getInstructions() ?? '';
    check('InitializeResult carries the instructions', instructions.includes('Glass Bank is a fictional bank'));

    const toolList = await mcpClient.listTools();
    check('tools/list returns the catalog', toolList.tools.length === 17, `got ${toolList.tools.length}`);
    check(
      'every published schema requires rationale (ADR-8)',
      toolList.tools.every((tool) => (tool.inputSchema.required ?? []).includes('rationale')),
    );
    check(
      'write tools stay listed under a read-only grant (ADR-13)',
      toolList.tools.some((tool) => tool.name === 'create_transfer'),
    );

    const prompts = await mcpClient.listPrompts();
    check('prompts/list answers an empty list', Array.isArray(prompts.prompts) && prompts.prompts.length === 0);
    const resources = await mcpClient.listResources();
    check('resources/list answers an empty list', Array.isArray(resources.resources) && resources.resources.length === 0);

    const currentUser = await mcpClient.callTool({
      name: 'get_current_user',
      arguments: { rationale: 'introduce the demo customer at the start of the conversation' },
    });
    const text = currentUser.content.map((item) => item.text).join('\n');
    check('get_current_user returned a real result', !currentUser.isError, text);
    check('the result names the persona', text.includes('Ava Stone'), text);
    check('the result carries structured content', Boolean(currentUser.structuredContent?.persona_id));
    console.log(`\n  get_current_user ->\n${text.split('\n').map((line) => `    ${line}`).join('\n')}`);

    const withoutRationale = await mcpClient.callTool({ name: 'get_current_user', arguments: {} });
    check(
      'a call with no rationale still reaches the handler (ADR-8)',
      !withoutRationale.isError,
      JSON.stringify(withoutRationale).slice(0, 200),
    );

    await mcpClient.close();

    section('7. The 403 step-up (ADR-13)');
    const stepUp = await http('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'lock_or_unlock_card', arguments: { rationale: 'the user asked to lock the card' } },
      }),
    });
    check('a write tool under a read-only grant answers 403', stepUp.status === 403, `status ${stepUp.status}`);
    check(
      'the 403 challenge is the documented one',
      stepUp.headers.get('www-authenticate') ===
        `Bearer error="insufficient_scope", scope="cards:write transfers:write", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
      stepUp.headers.get('www-authenticate') ?? '',
    );
  } catch (error) {
    failures.push(`walk threw: ${error instanceof Error ? error.stack : String(error)}`);
    console.error(error);
    console.error(serverLog.join(''));
  } finally {
    child.kill('SIGTERM');
  }

  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exit(1);
  }
  process.exit(0);
}

await main();
