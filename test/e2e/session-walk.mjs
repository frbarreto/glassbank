/**
 * The scripted end-to-end **session** walk (Phase 2 seams I1, I2 and the local half of I3).
 *
 * `oauth-walk.mjs` proves the handshake. This one proves the thing the whole project exists for:
 * a connected client asks the bank a question, and a paired viewer watches the answer being
 * produced on the X-ray dashboard API.
 *
 *   1. boot the real `src/server.ts`, register a client, and complete the browser leg
 *      programmatically for a **read-only** grant
 *   2. the read flow: load_transactions -> process_data -> execute_query (real rows out of the
 *      seeded bank) -> clear_table
 *   3. reference and meta tools: get_bank_categories, get_tool_availability
 *   4. the 403 `insufficient_scope` step-up on a write tool under the read-only grant
 *   5. `xray_get_session_link` -> a pairing code
 *   6. the step-up itself: the same browser approves the write scopes, the grant is extended
 *      (same `grant_id`, ADR-14) and new tokens are issued
 *   7. the write flow: lock_or_unlock_card, then create_transfer preview -> confirm
 *   8. the headline: exchange the pairing code at `/xray/s/<code>`, then read
 *      `GET /xray/api/sessions`, `GET /xray/api/sessions/:xs/events` and the SSE stream, and
 *      assert that the tool calls above are all there
 *   9. the dashboard itself is served at `/xray/`, live and in `?fixture=1` mode
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
const PORT = Number(process.env.E2E_PORT ?? 8897);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://127.0.0.1:60124/callback';

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

/** Prints a tool result the way a reader wants to see it: the model's text, indented. */
function show(label, text) {
  console.log(`\n  ${label} ->`);
  for (const line of String(text).split('\n')) console.log(`    ${line}`);
  console.log('');
}

/** One cookie jar for the browser leg; a second one for the dashboard viewer. */
function cookieJar() {
  const jar = new Map();
  return {
    jar,
    async http(path, init = {}) {
      const headers = new Headers(init.headers ?? {});
      if (jar.size > 0) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
      const response = await fetch(new URL(path, BASE_URL), { ...init, headers, redirect: 'manual' });
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
      return response;
    },
  };
}

const browser = cookieJar();
const viewer = cookieJar();
const http = browser.http;

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
  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE_URL,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      AUTH_DB_PATH: join(tmpdir(), `glass-bank-session-auth-${process.pid}.sqlite`),
      XRAY_DB_PATH: join(tmpdir(), `glass-bank-session-xray-${process.pid}.sqlite`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const serverLog = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => serverLog.push(chunk));

  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('the server did not start in 30 s')), 30_000);
    child.stdout.on('data', (chunk) => {
      serverLog.push(chunk);
      if (chunk.includes('"event":"server.started"')) {
        clearTimeout(timer);
        resolveReady();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`the server exited with code ${code}:\n${serverLog.join('')}`));
    });
  });

  return { child, serverLog };
}

/** One full browser leg: /authorize -> /login -> /consent -> /token. Returns the token set. */
async function authorize({ clientId, scopes, persona, label }) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
  const state = randomBytes(16).toString('base64url');

  const authorizeUrl =
    `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=${state}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&scope=${encodeURIComponent(scopes.join(' '))}` +
    `&resource=${encodeURIComponent(`${BASE_URL}/mcp`)}`;

  const first = await http(authorizeUrl);
  const firstHtml = await first.text();

  // A browser that already holds the `login_id` cookie skips the persona picker and is taken
  // straight to consent (ADR-14). The rendered form tells us which page we are on.
  let consentHtml = firstHtml;
  if (firstHtml.includes('name="choice"')) {
    const consentPage = await http('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ txn: hidden(firstHtml, 'txn'), csrf: hidden(firstHtml, 'csrf'), choice: persona }),
    });
    check(`${label}: POST /login renders the consent page`, consentPage.status === 200, `status ${consentPage.status}`);
    consentHtml = await consentPage.text();
  }

  const callback = await http('/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      txn: hidden(consentHtml, 'txn'),
      csrf: hidden(consentHtml, 'csrf'),
      scope: scopes,
      decision: 'approve',
    }),
  });
  check(`${label}: POST /consent redirects to the callback`, callback.status === 302, `status ${callback.status}`);
  const location = new URL(callback.headers.get('location'));
  const code = location.searchParams.get('code');

  const tokenResponse = await http('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      resource: `${BASE_URL}/mcp`,
    }),
  });
  check(`${label}: POST /token answers 200`, tokenResponse.status === 200, `status ${tokenResponse.status}`);
  const tokens = await tokenResponse.json();
  return { tokens, consentHtml };
}

/** Connects an MCP client with one access token. */
async function connect(accessToken, name) {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name, version: '0.1.0' });
  await client.connect(transport);
  return client;
}

const textOf = (result) => (result.content ?? []).map((item) => item.text).join('\n');

/** The UTC day, `days` days ago, as YYYY-MM-DD. */
function isoDay(days) {
  const date = new Date(Date.now() - days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const { child, serverLog } = await startServer();
  let mcpRead;
  let mcpWrite;

  try {
    section('1. A read-only grant, the whole browser leg driven programmatically');
    const registration = await http('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Glass Bank session walk',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
      }),
    });
    check('POST /register answers 201', registration.status === 201, `status ${registration.status}`);
    const client = await registration.json();

    const readLeg = await authorize({
      clientId: client.client_id,
      scopes: READ_SCOPES,
      persona: 'per_ava_stone',
      label: 'read-only',
    });
    const readToken = readLeg.tokens.access_token;
    check('the read-only grant is read_only', readLeg.tokens.scope.split(' ').every((s) => !s.endsWith(':write')), readLeg.tokens.scope);

    mcpRead = await connect(readToken, 'glass-bank-session-walk');
    const toolList = await mcpRead.listTools();
    check('tools/list returns all 17 tools', toolList.tools.length === 17, `got ${toolList.tools.length}`);
    check(
      'the write tools are listed even without the write scopes (ADR-13)',
      ['lock_or_unlock_card', 'create_transfer'].every((name) =>
        toolList.tools.some((tool) => tool.name === name),
      ),
    );

    section('2. The read flow: load -> process -> query -> clear');
    const load = await mcpRead.callTool({
      name: 'load_transactions',
      arguments: {
        from_date: isoDay(90),
        to_date: isoDay(0),
        rationale: 'the user asked what they spent the most on in the last three months',
      },
    });
    const loadText = textOf(load);
    check('load_transactions succeeded', !load.isError, loadText);
    const tableName = load.structuredContent?.table_name;
    check('load_transactions returned a scratch table name', typeof tableName === 'string' && tableName.startsWith('load_transactions_'), String(tableName));
    check('load_transactions loaded rows from the seeded bank', (load.structuredContent?.rows ?? 0) > 0, JSON.stringify(load.structuredContent));
    check('load_transactions returned no rows to the model (Ramp convention)', !loadText.includes('"amount_cents"'), loadText.slice(0, 120));
    check('the result advertises the columns', loadText.includes('Available columns are:'), loadText.slice(0, 200));
    show('load_transactions', loadText);

    const columns = load.structuredContent?.columns ?? [];
    const wanted = ['id', 'merchant_name', 'amount_cents', 'status', 'date'].filter((name) =>
      columns.includes(name),
    );
    check('the advertised columns include the ones the query needs', wanted.length === 5, columns.join(', '));

    const processed = await mcpRead.callTool({
      name: 'process_data',
      arguments: {
        table_name: tableName,
        cols: wanted,
        rationale: 'building a SQL table so the spending can be aggregated exactly',
      },
    });
    check('process_data succeeded', !processed.isError, textOf(processed));
    show('process_data', textOf(processed));

    const queried = await mcpRead.callTool({
      name: 'execute_query',
      arguments: {
        table_name: tableName,
        query: `SELECT "merchant_name", COUNT(*) AS purchases, SUM("amount_cents") AS cents FROM "${tableName}" WHERE "amount_cents" < 0 GROUP BY "merchant_name" ORDER BY cents ASC LIMIT 5`,
        rationale: 'ranking the five merchants the customer spent the most at',
      },
    });
    const queryText = textOf(queried);
    check('execute_query succeeded', !queried.isError, queryText);
    let rows = [];
    try {
      rows = JSON.parse(queryText);
    } catch {
      rows = [];
    }
    check('execute_query returned real rows out of the seeded bank', Array.isArray(rows) && rows.length > 0, queryText.slice(0, 200));
    check('the rows carry a merchant and a signed cent total', rows.length > 0 && typeof rows[0].merchant_name === 'string' && typeof rows[0].cents === 'number', JSON.stringify(rows[0] ?? null));
    show('execute_query', queryText);

    const writeAttempt = await mcpRead.callTool({
      name: 'execute_query',
      arguments: {
        table_name: tableName,
        query: `UPDATE "${tableName}" SET "amount_cents" = 0`,
        rationale: 'this must be refused: the scratch database is read-only',
      },
    });
    check('a write statement is refused by the SQL guard (invariant 8)', writeAttempt.isError === true, textOf(writeAttempt));

    const cleared = await mcpRead.callTool({
      name: 'clear_table',
      arguments: { table_name: tableName, rationale: 'the analysis is finished, freeing the table budget' },
    });
    check('clear_table succeeded', !cleared.isError, textOf(cleared));
    show('clear_table', textOf(cleared));

    section('3. Reference and meta tools');
    const categories = await mcpRead.callTool({
      name: 'get_bank_categories',
      arguments: { rationale: 'turning a category id into a readable name' },
    });
    check('get_bank_categories returned the Ramp category table', !categories.isError && textOf(categories).includes('Restaurants'), textOf(categories).slice(0, 120));

    const availability = await mcpRead.callTool({
      name: 'get_tool_availability',
      arguments: { rationale: 'explaining to the user which tools are usable right now' },
    });
    const table = availability.structuredContent ?? {};
    check('get_tool_availability returned the availability table', Array.isArray(table.tools) && table.tools.length === 17, JSON.stringify(table).slice(0, 160));
    check('it carries a catalog content hash', typeof table.content_hash === 'string' && table.content_hash.length === 16, String(table.content_hash));
    const lockRow = (table.tools ?? []).find((row) => row.tool === 'lock_or_unlock_card');
    check('lock_or_unlock_card is listed but not available under a read-only grant (ADR-13)', lockRow?.listed === true && lockRow?.available === false, JSON.stringify(lockRow));

    section('4. The 403 step-up on a write tool under a read-only grant');
    const stepUp = await http('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${readToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: { name: 'lock_or_unlock_card', arguments: { card_id: 'card_x', action: 'lock', rationale: 'the user asked to freeze the card' } },
      }),
    });
    check('a write tool under a read-only grant answers 403', stepUp.status === 403, `status ${stepUp.status}`);
    check(
      'the challenge names every still-needed scope and the resource metadata',
      stepUp.headers.get('www-authenticate') ===
        `Bearer error="insufficient_scope", scope="cards:write transfers:write", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`,
      stepUp.headers.get('www-authenticate') ?? '',
    );

    section('5. xray_get_session_link: the pairing code the user opens');
    const link = await mcpRead.callTool({
      name: 'xray_get_session_link',
      arguments: { rationale: 'the user asked to watch what the connector is doing' },
    });
    const linkText = textOf(link);
    check('xray_get_session_link succeeded', !link.isError, linkText);
    const pairingCode = /BANK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{2}/.exec(linkText)?.[0];
    check('it returned a BANK-XXXX-XXXX-XX pairing code', Boolean(pairingCode), linkText);
    check('it returned a link to this server', linkText.includes(`${BASE_URL}/xray/s/`), linkText);
    show('xray_get_session_link', linkText);

    section('6. The step-up: the same browser approves the write scopes (ADR-14)');
    const beforeUser = await mcpRead.callTool({
      name: 'get_current_user',
      arguments: { rationale: 'noting the session before the step-up' },
    });
    const xsBefore = beforeUser.structuredContent?.xray_session_id;
    check('get_current_user reports the X-ray session', typeof xsBefore === 'string' && xsBefore.startsWith('xs_'), String(xsBefore));

    const writeLeg = await authorize({
      clientId: client.client_id,
      scopes: [...READ_SCOPES, ...WRITE_SCOPES],
      persona: 'per_ava_stone',
      label: 'step-up',
    });
    const writeToken = writeLeg.tokens.access_token;
    check(
      'the step-up grant carries the write scopes',
      WRITE_SCOPES.every((scope) => writeLeg.tokens.scope.split(' ').includes(scope)),
      writeLeg.tokens.scope,
    );
    check(
      'the consent page offered to extend the grant the browser already holds',
      writeLeg.consentHtml.includes('cards:write'),
    );

    mcpWrite = await connect(writeToken, 'glass-bank-session-walk-write');
    const afterUser = await mcpWrite.callTool({
      name: 'get_current_user',
      arguments: { rationale: 'confirming the new authorization level' },
    });
    check('the persona is unchanged across the step-up', afterUser.structuredContent?.persona_id === beforeUser.structuredContent?.persona_id, `${afterUser.structuredContent?.persona_id} vs ${beforeUser.structuredContent?.persona_id}`);
    check('the authorization level is now read_write', textOf(afterUser).includes('read_write'), textOf(afterUser).slice(0, 200));

    section('7. The write flow: lock a card, then preview and confirm a transfer');
    const cards = await mcpWrite.callTool({
      name: 'load_cards',
      arguments: { rationale: 'finding the card the user wants to freeze' },
    });
    check('load_cards succeeded', !cards.isError, textOf(cards));
    const cardsTable = cards.structuredContent?.table_name;
    await mcpWrite.callTool({
      name: 'process_data',
      arguments: { table_name: cardsTable, cols: ['id', 'last4', 'status'], rationale: 'reading the card ids' },
    });
    const cardRows = JSON.parse(
      textOf(
        await mcpWrite.callTool({
          name: 'execute_query',
          arguments: {
            table_name: cardsTable,
            query: `SELECT "id", "last4", "status" FROM "${cardsTable}" WHERE "status" = 'active' LIMIT 3`,
            rationale: 'listing the active cards so the user can pick one',
          },
        }),
      ),
    );
    check('the customer has at least one active card', cardRows.length > 0, JSON.stringify(cardRows));
    const cardId = cardRows[0].id;

    const locked = await mcpWrite.callTool({
      name: 'lock_or_unlock_card',
      arguments: {
        card_id: cardId,
        action: 'lock',
        rationale: `the user asked to freeze the card ending ${cardRows[0].last4} after losing it`,
      },
    });
    check('lock_or_unlock_card succeeded under the stepped-up grant', !locked.isError, textOf(locked));
    check('the lock is reported as a real change', textOf(locked).toLowerCase().includes('locked'), textOf(locked));
    show('lock_or_unlock_card', textOf(locked));

    const accounts = await mcpWrite.callTool({
      name: 'load_accounts',
      arguments: { rationale: 'choosing the account the money leaves' },
    });
    const accountsTable = accounts.structuredContent?.table_name;
    await mcpWrite.callTool({
      name: 'process_data',
      arguments: { table_name: accountsTable, cols: ['id', 'name', 'account_type', 'status'], rationale: 'reading the account ids' },
    });
    const accountRows = JSON.parse(
      textOf(
        await mcpWrite.callTool({
          name: 'execute_query',
          arguments: {
            table_name: accountsTable,
            query: `SELECT "id", "name", "account_type" FROM "${accountsTable}" WHERE "status" = 'open' AND "account_type" = 'checking' LIMIT 1`,
            rationale: 'picking the checking account',
          },
        }),
      ),
    );
    check('the customer has an open checking account', accountRows.length > 0, JSON.stringify(accountRows));

    const payees = await mcpWrite.callTool({
      name: 'load_payees',
      arguments: { rationale: 'choosing the saved payee the user named' },
    });
    const payeesTable = payees.structuredContent?.table_name;
    await mcpWrite.callTool({
      name: 'process_data',
      arguments: { table_name: payeesTable, cols: ['id', 'name', 'rail'], rationale: 'reading the payee ids' },
    });
    const payeeRows = JSON.parse(
      textOf(
        await mcpWrite.callTool({
          name: 'execute_query',
          arguments: {
            table_name: payeesTable,
            query: `SELECT "id", "name", "rail" FROM "${payeesTable}" WHERE "rail" = 'ach' LIMIT 1`,
            rationale: 'picking a payee on the fee-free ACH rail',
          },
        }),
      ),
    );
    check('the customer has a saved payee', payeeRows.length > 0, JSON.stringify(payeeRows));

    const preview = await mcpWrite.callTool({
      name: 'create_transfer',
      arguments: {
        from_account_id: accountRows[0].id,
        to: { payee_id: payeeRows[0].id },
        amount: 2500,
        currency: 'USD',
        memo: 'dinner share',
        rationale: `the user asked to send 25.00 dollars to ${payeeRows[0].name}`,
      },
    });
    const previewText = textOf(preview);
    check('create_transfer without confirm returns a preview', !preview.isError, previewText);
    check('the preview moves no money and states a total', previewText.toLowerCase().includes('total'), previewText.slice(0, 200));
    const expectedTotal = preview.structuredContent?.total_amount_cents ?? preview.structuredContent?.expected_total_amount;
    check('the preview carries an expected total the model must echo back', typeof expectedTotal === 'number', JSON.stringify(preview.structuredContent));
    show('create_transfer (preview)', previewText);

    const confirmed = await mcpWrite.callTool({
      name: 'create_transfer',
      arguments: {
        from_account_id: accountRows[0].id,
        to: { payee_id: payeeRows[0].id },
        amount: 2500,
        currency: 'USD',
        memo: 'dinner share',
        confirm: true,
        expected_total_amount: expectedTotal,
        rationale: 'the user approved the preview and asked to send it',
      },
    });
    const confirmedText = textOf(confirmed);
    check('create_transfer with confirm executed the transfer', !confirmed.isError, confirmedText);
    check('the confirmation carries an audit entry id', typeof confirmed.structuredContent?.audit_id === 'string', JSON.stringify(confirmed.structuredContent).slice(0, 200));
    show('create_transfer (confirm)', confirmedText);

    const stale = await mcpWrite.callTool({
      name: 'create_transfer',
      arguments: {
        from_account_id: accountRows[0].id,
        to: { payee_id: payeeRows[0].id },
        amount: 2500,
        currency: 'USD',
        confirm: true,
        expected_total_amount: expectedTotal,
        rationale: 'a replayed confirmation must not move money twice',
      },
    });
    check('a replayed confirmation is refused (the preview is single-use)', stale.isError === true, textOf(stale).slice(0, 200));

    section('8. THE HEADLINE: the dashboard API shows the session we just drove');
    const landing = await viewer.http(`/xray/s/${pairingCode}`, { redirect: 'manual' });
    check('the pairing link answers with a redirect to the dashboard', landing.status === 302, `status ${landing.status}`);
    check('the pairing link sets the viewer cookie', viewer.jar.size > 0, [...viewer.jar.keys()].join(', '));

    const me = await viewer.http('/xray/api/me');
    check('GET /xray/api/me answers 200 for the paired viewer', me.status === 200, `status ${me.status}`);
    const meBody = await me.json();
    check('the viewer is a pairing viewer bound to one login (ADR-10)', meBody.viewer_kind === 'pairing' && typeof meBody.login_id === 'string', JSON.stringify(meBody).slice(0, 160));
    check('the viewer sees the persona it paired with', meBody.persona?.id === 'per_ava_stone', JSON.stringify(meBody.persona));

    const sessions = await viewer.http('/xray/api/sessions');
    check('GET /xray/api/sessions answers 200', sessions.status === 200, `status ${sessions.status}`);
    const sessionBody = await sessions.json();
    const sessionRows = sessionBody.data ?? [];
    check('the viewer sees the sessions of their own login', sessionRows.length > 0, JSON.stringify(sessionBody).slice(0, 200));
    const totalCalls = sessionRows.reduce((sum, row) => sum + (row.call_count ?? 0), 0);
    check('those sessions count the tool calls we just made', totalCalls >= 15, `counted ${totalCalls}`);
    console.log(
      `\n  sessions ->\n${sessionRows
        .map(
          (row) =>
            `    ${row.xs}  persona=${row.persona?.name ?? '-'}  calls=${row.call_count}  errors=${row.error_count}  client=${row.client?.name ?? '-'}`,
        )
        .join('\n')}\n`,
    );

    const xs = sessionRows[0].xs;
    const events = await viewer.http(`/xray/api/sessions/${xs}/events?limit=500`);
    check('GET /xray/api/sessions/:xs/events answers 200', events.status === 200, `status ${events.status}`);
    const eventBody = await events.json();
    const eventRows = eventBody.data ?? [];
    const types = new Set(eventRows.map((event) => event.type));
    check('the stored events include the tool call lifecycle', types.has('tool.call.started') && types.has('tool.call.completed'), [...types].join(', '));
    check('the stored events include the SQL the model ran', types.has('sql.query'), [...types].join(', '));
    check('the stored events include the ETL load and its columns', types.has('etl.load'), [...types].join(', '));
    check('the stored events include the bank operations', types.has('bank.op'), [...types].join(', '));
    check('the stored events include the declared intent', types.has('intent.declared'), [...types].join(', '));
    check('the stored events include the catalog listing', types.has('catalog.tools_listed'), [...types].join(', '));

    // The persona card (contracts v0.3): the numbers the tools returned, on the login's overlay,
    // and reading them must leave no trace in the session (the dashboard is an observer).
    const bankOpsBefore = eventRows.filter((event) => event.type === 'bank.op').length;
    const bank = await viewer.http(`/xray/api/sessions/${xs}/bank`);
    check('GET /xray/api/sessions/:xs/bank answers 200', bank.status === 200, `status ${bank.status}`);
    const bankBody = await bank.json();
    check('the persona card names the persona', typeof bankBody.persona?.name === 'string' && bankBody.persona.name.length > 0, JSON.stringify(bankBody.persona));
    check('the persona card carries accounts with balances in cents', Array.isArray(bankBody.accounts) && bankBody.accounts.length > 0 && Number.isInteger(bankBody.accounts[0].balance_cents), JSON.stringify(bankBody.accounts?.[0]));
    check('the persona card states a net position', Number.isInteger(bankBody.net_position_cents), String(bankBody.net_position_cents));
    check('the persona card reflects the card locked earlier in this walk (overlay applied, ADR-15)', (bankBody.cards?.locked ?? 0) >= 1, JSON.stringify(bankBody.cards));
    const eventsAfter = await viewer.http(`/xray/api/sessions/${xs}/events?limit=500`);
    const bankOpsAfter = ((await eventsAfter.json()).data ?? []).filter((event) => event.type === 'bank.op').length;
    check('reading the persona card emitted no bank.op into the session', bankOpsAfter === bankOpsBefore, `${bankOpsBefore} before, ${bankOpsAfter} after`);

    // Erasing history (contracts v0.4). Done last, because it destroys what the checks above read.
    const beforeErase = ((await (await viewer.http('/xray/api/sessions')).json()).data ?? []).length;
    check('the viewer can see its sessions before erasing', beforeErase > 0, String(beforeErase));
    const erased = await viewer.http('/xray/api/events', { method: 'DELETE' });
    check('DELETE /xray/api/events answers 200', erased.status === 200, `status ${erased.status}`);
    const erasedBody = await erased.json();
    check('the erase reports how many events and sessions went', erasedBody.deleted > 0 && erasedBody.sessions > 0, JSON.stringify(erasedBody));
    check('the erase names its scope', erasedBody.scope === 'login', String(erasedBody.scope));
    const afterErase = ((await (await viewer.http('/xray/api/sessions')).json()).data ?? []).length;
    check('every session of the login is gone', afterErase === 0, String(afterErase));
    const eraseTrace = await viewer.http(`/xray/api/sessions/${xs}/events?limit=500`);
    check('the erased session no longer resolves', eraseTrace.status === 403, `status ${eraseTrace.status}`);

    const started = eventRows.filter((event) => event.type === 'tool.call.started');
    const calledTools = new Set(started.map((event) => event.data.tool));
    for (const tool of ['load_transactions', 'process_data', 'execute_query', 'clear_table', 'xray_get_session_link']) {
      check(`the dashboard can see the ${tool} call`, calledTools.has(tool), [...calledTools].join(', '));
    }
    const loadEvent = started.find((event) => event.data.tool === 'load_transactions');
    check('the call carries the arguments the model sent', typeof loadEvent?.data.arguments?.from_date === 'string', JSON.stringify(loadEvent?.data.arguments));
    check('the call carries the stated intent verbatim', String(loadEvent?.data.rationale ?? '').includes('spent the most'), String(loadEvent?.data.rationale));

    const sqlEvent = eventRows.find((event) => event.type === 'sql.query');
    check('the SQL event carries the statement and what came back', typeof sqlEvent?.data.sql === 'string' && typeof sqlEvent?.data.rows_returned === 'number', JSON.stringify(sqlEvent?.data).slice(0, 200));
    console.log(`\n  the SQL the dashboard shows ->\n    ${String(sqlEvent?.data.sql).slice(0, 200)}\n    rows_returned=${sqlEvent?.data.rows_returned} duration_ms=${sqlEvent?.data.duration_ms}\n`);

    // The live stream, with one more tool call made while it is open.
    const controller = new AbortController();
    const streamResponse = await fetch(new URL('/xray/api/stream', BASE_URL), {
      headers: { cookie: [...viewer.jar].map(([k, v]) => `${k}=${v}`).join('; '), accept: 'text/event-stream' },
      signal: controller.signal,
    });
    check('GET /xray/api/stream answers 200 with an SSE body', streamResponse.status === 200 && (streamResponse.headers.get('content-type') ?? '').includes('text/event-stream'), `${streamResponse.status} ${streamResponse.headers.get('content-type')}`);

    const liveTypes = new Set();
    let sawRetry = false;
    const reader = streamResponse.body.getReader();
    const decoder = new TextDecoder();
    const readUntil = (async () => {
      let buffer = '';
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split('\n')) {
          if (line.startsWith('retry:')) sawRetry = true;
          if (line.startsWith('data:')) {
            try {
              liveTypes.add(JSON.parse(line.slice(5).trim()).type);
            } catch {
              /* a heartbeat comment, not a frame */
            }
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
        if (liveTypes.has('tool.call.completed')) break;
      }
    })();

    // Give the stream a moment to replay, then make a call it must show us live.
    await new Promise((r) => setTimeout(r, 300));
    await mcpWrite.callTool({
      name: 'get_currencies',
      arguments: { rationale: 'a call made while the dashboard stream is open, so it must appear live' },
    });
    await readUntil;
    controller.abort();

    check('the stream opens with the SSE retry hint', sawRetry, [...liveTypes].join(', '));
    check('the stream carries the tool call made while it was open', liveTypes.has('tool.call.started') && liveTypes.has('tool.call.completed'), [...liveTypes].join(', '));
    console.log(`\n  event types seen on the live stream -> ${[...liveTypes].sort().join(', ')}\n`);

    section('9. The dashboard itself');
    const page = await fetch(new URL('/xray/', BASE_URL));
    const pageHtml = await page.text();
    check('GET /xray/ serves the dashboard page', page.status === 200 && pageHtml.includes('Glass Bank X-ray'), `status ${page.status}`);
    for (const asset of ['app.js', 'app.css', 'panel-timeline.js', 'store.js']) {
      const response = await fetch(new URL(`/xray/${asset}`, BASE_URL));
      check(`GET /xray/${asset} is served`, response.status === 200, `status ${response.status}`);
    }
    const fixture = await fetch(new URL('/xray/fixtures/events.jsonl', BASE_URL));
    check('GET /xray/fixtures/events.jsonl feeds ?fixture=1', fixture.status === 200, `status ${fixture.status}`);
    check('the fixture is the recorded session', (await fixture.text()).includes('"type"'));
    for (const path of ['/xray/_dev/serve.mjs', '/xray/__tests__/store.test.mjs']) {
      const response = await fetch(new URL(path, BASE_URL));
      check(`${path} is not served`, response.status === 404, `status ${response.status}`);
    }

    const unpaired = await fetch(new URL('/xray/api/sessions', BASE_URL));
    check('a viewer with no cookie sees no sessions at all (invariant 11)', unpaired.status === 401, `status ${unpaired.status}`);
  } catch (error) {
    failures.push(`walk threw: ${error instanceof Error ? error.stack : String(error)}`);
    console.error(error);
    console.error(serverLog.join(''));
  } finally {
    try {
      await mcpRead?.close();
    } catch {
      /* the walk is over */
    }
    try {
      await mcpWrite?.close();
    } catch {
      /* the walk is over */
    }
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
