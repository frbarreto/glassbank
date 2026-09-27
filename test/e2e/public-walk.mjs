/**
 * The public lane end to end (D-26): an MCP client with no OAuth at all, against the real server.
 *
 *   1. `/public/mcp` initializes with no bearer and no challenge; `/mcp` still answers 401
 *   2. `tools/list` is the six public tools
 *   3. the product catalog three levels deep: list_products -> get_product -> search_prices
 *   4. the location directory two levels deep: find_branches -> get_branch
 *   5. a signed-in tool name is an unknown tool here, never a 401
 *   6. the X-ray shows the visitor's session on `?lane=public` with no cookie, every call nested
 *      with its `bank.op`, and refuses an erase
 *   7. the export (D-27): the public lane as JSONL with no credential, the whole log with the admin
 *      token as a bearer, a wrong token refused
 *
 * Exit code 0 means every step passed.
 */

import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const PORT = Number(process.env.E2E_PORT ?? 8896);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = 'e2e-only-admin-token-at-least-32-characters';

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

async function startServer() {
  const child = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE_URL,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      XRAY_ADMIN_TOKEN: ADMIN_TOKEN,
      AUTH_DB_PATH: join(tmpdir(), `glass-bank-e2e-public-auth-${process.pid}.sqlite`),
      XRAY_DB_PATH: join(tmpdir(), `glass-bank-e2e-public-xray-${process.pid}.sqlite`),
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

/** The parsed lines of a JSONL body. */
function jsonLines(text) {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** The JSON a public tool answered, or `null` when it was not a JSON text result. */
function jsonOf(result) {
  try {
    return JSON.parse(result.content?.[0]?.text ?? '');
  } catch {
    return null;
  }
}

async function main() {
  const { child, serverLog } = await startServer();
  const client = new Client({ name: 'glass-bank-public-walk', version: '0.1.0' });

  try {
    section('1. No sign-in on the public lane, the gate unchanged on /mcp');
    const signedIn = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
    });
    check('/mcp still answers 401 without a bearer (invariant 5)', signedIn.status === 401, `status ${signedIn.status}`);

    // No `authProvider`: this client cannot do OAuth, so any 401 would fail the connect.
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE_URL}/public/mcp`)));
    const info = client.getServerVersion();
    check('initialize succeeds with no OAuth', info?.name === 'glass-bank-public', JSON.stringify(info));
    check(
      'the instructions say the lane is public',
      (client.getInstructions() ?? '').includes('public dashboard'),
    );

    section('2. The public catalog');
    const listing = await client.listTools();
    const names = listing.tools.map((tool) => tool.name);
    check(
      'tools/list is the six public tools',
      JSON.stringify(names) ===
        JSON.stringify(['get_bank_profile', 'list_products', 'get_product', 'search_prices', 'find_branches', 'get_branch']),
      names.join(','),
    );
    check(
      'every public tool requires rationale in its schema (ADR-8)',
      listing.tools.every((tool) => tool.inputSchema.required?.includes('rationale')),
    );

    section('3. Products, three levels deep');
    const profile = jsonOf(await client.callTool({ name: 'get_bank_profile', arguments: { rationale: 'what is this bank' } }));
    check('the profile points at the signed-in connector', profile?.endpoints?.signed_in_mcp === `${BASE_URL}/mcp`);
    const level1 = jsonOf(await client.callTool({ name: 'list_products', arguments: { family: '', rationale: 'what does it sell' } }));
    const products = (level1?.families ?? []).flatMap((family) => family.products);
    check('list_products returns six products in three families', level1?.families?.length === 3 && products.length === 6);
    const level2 = jsonOf(
      await client.callTool({ name: 'get_product', arguments: { product_id: 'clear_checking', rationale: 'compare plans' } }),
    );
    check('get_product returns the plans of one product', level2?.plans?.length === 2, JSON.stringify(level2?.plans?.map((plan) => plan.plan_id)));
    const level3 = jsonOf(
      await client.callTool({
        name: 'search_prices',
        arguments: { product_id: 'clear_checking', plan_id: 'clear_checking_plus', query: 'wire', rationale: 'wire fees' },
      }),
    );
    check('search_prices finds the wire prices of one plan', level3?.count === 2, JSON.stringify(level3?.prices?.map((price) => price.name)));

    section('4. Locations, two levels deep');
    const branches = jsonOf(await client.callTool({ name: 'find_branches', arguments: { city: 'Chicago', rationale: 'where to go' } }));
    check('find_branches lists the Chicago locations', branches?.count === 2, JSON.stringify(branches?.branches?.map((b) => b.branch_id)));
    const branch = jsonOf(await client.callTool({ name: 'get_branch', arguments: { branch_id: 'chi_the_loop', rationale: 'opening hours' } }));
    check('get_branch returns seven days of hours', branch?.hours?.length === 7);

    section('5. The signed-in catalog is not reachable here');
    let unknownError = null;
    try {
      await client.callTool({ name: 'load_accounts', arguments: { rationale: 'try' } });
    } catch (error) {
      unknownError = error;
    }
    check('load_accounts is an unknown tool, not a challenge', String(unknownError?.message ?? '').includes('Unknown tool'), String(unknownError));

    section('6. The X-ray public lane, with no cookie');
    const me = await (await fetch(`${BASE_URL}/xray/api/me?lane=public`)).json();
    check('/xray/api/me?lane=public describes the public reader', me.viewer_kind === 'public' && me.login_id === 'lgn_public');
    const sessions = await (await fetch(`${BASE_URL}/xray/api/sessions?lane=public`)).json();
    const xs = sessions.data?.[0]?.xs;
    check('the visitor session is listed on the public lane', typeof xs === 'string' && sessions.data.length === 1, JSON.stringify(sessions.data));
    const events = await (await fetch(`${BASE_URL}/xray/api/sessions/${xs}/events?lane=public&limit=500`)).json();
    const types = (events.data ?? []).map((event) => event.type);
    const started = (events.data ?? []).filter((event) => event.type === 'tool.call.started');
    const ops = (events.data ?? []).filter((event) => event.type === 'bank.op');
    check('every public call is recorded with its rationale (the unknown tool never starts)', started.length === 6 && started.every((event) => event.data.rationale_present));
    check(
      'every successful read has a bank.op nested under its call',
      ops.length >= 6 && ops.every((op) => started.some((call) => call.request_id === op.request_id)),
      `${ops.length} bank.op`,
    );
    check('the catalog listing was recorded', types.includes('catalog.tools_listed'));
    const erase = await fetch(`${BASE_URL}/xray/api/events?lane=public`, { method: 'DELETE' });
    check('the public lane cannot erase', erase.status === 403, `status ${erase.status}`);
    const signedInSessions = await fetch(`${BASE_URL}/xray/api/sessions`);
    check('without the lane and without a cookie the X-ray still answers 401', signedInSessions.status === 401);

    section('7. The export as JSONL (D-27)');
    const laneExport = await fetch(`${BASE_URL}/xray/api/export?lane=public`);
    const laneLines = jsonLines(await laneExport.text());
    const exportedIds = new Set(laneLines.map((event) => event.id));
    check(
      'the public lane exports as application/x-ndjson with no credential',
      laneExport.status === 200 && (laneExport.headers.get('content-type') ?? '').startsWith('application/x-ndjson'),
      `status ${laneExport.status}`,
    );
    check(
      'the export holds every event the session history showed, and only the public login',
      (events.data ?? []).every((event) => exportedIds.has(event.id)) &&
        laneLines.every((event) => event.login_id === 'lgn_public'),
      `${laneLines.length} lines`,
    );
    const fullExport = await fetch(`${BASE_URL}/xray/api/export`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    const fullLines = jsonLines(await fullExport.text());
    const exportedCall = fullLines.find((event) => event.type === 'tool.call.started' && event.data.tool === 'search_prices');
    check(
      'the admin bearer exports the whole log, server events included, arguments verbatim',
      fullExport.status === 200 &&
        fullLines.some((event) => event.type === 'server.started') &&
        exportedCall?.data.arguments?.query === 'wire' &&
        exportedCall?.data.rationale === 'wire fees',
      `status ${fullExport.status}, ${fullLines.length} lines`,
    );
    const wrongToken = await fetch(`${BASE_URL}/xray/api/export`, { headers: { authorization: 'Bearer not-the-token' } });
    check('a wrong admin token is refused with 403', wrongToken.status === 403, `status ${wrongToken.status}`);
  } catch (error) {
    failures.push(`walk threw: ${error instanceof Error ? error.stack : String(error)}`);
    console.error(error);
    console.error(serverLog.join(''));
  } finally {
    await client.close().catch(() => undefined);
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
