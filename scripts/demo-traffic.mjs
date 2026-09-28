/**
 * Fills a locally running Glass Bank with the traffic the X-ray is built to show (contracts v0.10).
 *
 * Three callers, so every view has something real in it:
 *
 *   1. a **signed-in agent** (OAuth driven programmatically, persona Ava Stone, read and write
 *      scopes): a spending analysis (load -> process -> query -> clear), a card lock and a
 *      confirmed transfer, each with its rationale, then `xray_get_session_link` - the pairing
 *      link it prints opens the chain and the Account view of that session;
 *   2. an **unsigned public visitor** that calls itself `claude-ai` and sends `User-Agent:
 *      Claude-User`: the name is a claim, and the X-ray says so;
 *   3. a **signed public visitor**: every request carries a Web Bot Auth signature (RFC 9421,
 *      Ed25519) whose key is published by a directory this script serves on loopback, so the
 *      server verifies it and the X-ray names the agent; one tampered request is recorded as
 *      `invalid_signature` and answered all the same (D-29).
 *
 * The server must accept a loopback directory, which only development allows:
 *
 *   BOT_AUTH_ALLOW_LOOPBACK=true BOT_AUTH_CHALLENGE=advertise npm run dev
 *   node scripts/demo-traffic.mjs            # BASE_URL=http://localhost:8080 by default
 *
 * Everything here is fake: the bank, the persona, the agent's key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const REDIRECT_URI = 'http://127.0.0.1:60125/callback';
const SCOPES = [
  'profile',
  'accounts:read',
  'transactions:read',
  'cards:read',
  'transfers:read',
  'bills:read',
  'payees:read',
  'xray:read',
  'cards:write',
  'transfers:write',
];

const log = (line) => console.log(line);
const textOf = (result) => (result.content ?? []).map((item) => item.text).join('\n');
const isoDay = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// 1. The signed-in agent
// ---------------------------------------------------------------------------------------------

const jar = new Map();
async function http(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  if (jar.size > 0)
    headers.set('cookie', [...jar].map(([key, value]) => `${key}=${value}`).join('; '));
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
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function form(fields) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params;
}

async function signIn() {
  const registration = await http('/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Glass Bank demo agent',
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  if (registration.status !== 201) throw new Error(`/register answered ${registration.status}`);
  const { client_id: clientId } = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest().toString('base64url');
  const first = await http(
    `/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=demo` +
      `&code_challenge=${challenge}&code_challenge_method=S256` +
      `&scope=${encodeURIComponent(SCOPES.join(' '))}&resource=${encodeURIComponent(`${BASE_URL}/mcp`)}`,
  );
  let html = await first.text();
  if (html.includes('name="choice"')) {
    const consent = await http('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ txn: hidden(html, 'txn'), csrf: hidden(html, 'csrf'), choice: 'per_ava_stone' }),
    });
    html = await consent.text();
  }
  const callback = await http('/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      txn: hidden(html, 'txn'),
      csrf: hidden(html, 'csrf'),
      scope: SCOPES,
      decision: 'approve',
    }),
  });
  const code = new URL(callback.headers.get('location')).searchParams.get('code');
  const token = await http('/token', {
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
  if (token.status !== 200) throw new Error(`/token answered ${token.status}`);
  return (await token.json()).access_token;
}

async function signedInAgent() {
  log('1. A signed-in agent (Ava Stone): a spending analysis, a card lock, a transfer');
  const accessToken = await signIn();
  const client = new Client({ name: 'demo-agent', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${accessToken}`,
          'user-agent': 'demo-agent/1.0 (glass-bank local demo)',
        },
      },
    }),
  );
  const call = (name, args) => client.callTool({ name, arguments: args });
  const rows = async (table, cols, query, rationale) => {
    await call('process_data', {
      table_name: table,
      cols,
      rationale: `building a table to ${rationale}`,
    });
    return JSON.parse(textOf(await call('execute_query', { table_name: table, query, rationale })));
  };

  await call('get_current_user', {
    rationale: 'The user asked which customer this connection is for.',
  });
  const lines = await call('load_statement_lines', {
    from_date: isoDay(90),
    to_date: isoDay(0),
    rationale: 'The user asked where their money went in the last three months.',
  });
  const linesTable = lines.structuredContent?.table_name;
  const top = await rows(
    linesTable,
    ['date', 'counterparty', 'amount_cents', 'category_id', 'source'],
    `SELECT "counterparty", COUNT(*) AS payments, SUM("amount_cents") AS cents FROM "${linesTable}" WHERE "amount_cents" < 0 GROUP BY "counterparty" ORDER BY cents ASC LIMIT 5`,
    'rank the five payees the user spent the most with',
  );
  log(`   top payee: ${top[0]?.counterparty} (${top[0]?.cents} cents)`);
  await call('clear_table', {
    table_name: linesTable,
    rationale: 'The analysis is done; freeing the table.',
  });

  const cards = await call('load_cards', {
    rationale: 'The user wants to freeze the card they lost.',
  });
  const cardRows = await rows(
    cards.structuredContent?.table_name,
    ['id', 'last4', 'status'],
    `SELECT "id", "last4" FROM "${cards.structuredContent?.table_name}" WHERE "status" = 'active' LIMIT 1`,
    'find an active card to lock',
  );
  if (cardRows[0]) {
    await call('lock_or_unlock_card', {
      card_id: cardRows[0].id,
      action: 'lock',
      rationale: `The user lost the card ending ${cardRows[0].last4} and asked to lock it.`,
    });
  }

  const accounts = await call('load_accounts', {
    rationale: 'Choosing the accounts for the transfer the user asked for.',
  });
  const accountRows = await rows(
    accounts.structuredContent?.table_name,
    ['id', 'name', 'account_type', 'status'],
    `SELECT "id", "account_type" FROM "${accounts.structuredContent?.table_name}" WHERE "status" = 'open' AND "account_type" IN ('checking', 'savings') ORDER BY "account_type"`,
    'pick the checking and the savings account',
  );
  const checking = accountRows.find((row) => row.account_type === 'checking');
  const savings = accountRows.find((row) => row.account_type === 'savings');
  if (checking && savings) {
    const transfer = {
      from_account_id: checking.id,
      to: { account_id: savings.id },
      amount: 30_000,
      currency: 'USD',
      memo: 'Monthly savings',
    };
    const preview = await call('create_transfer', {
      ...transfer,
      rationale: 'The user asked to move $300 to savings; previewing first.',
    });
    const expected =
      preview.structuredContent?.expected_total_amount ??
      preview.structuredContent?.total_amount_cents;
    await call('create_transfer', {
      ...transfer,
      confirm: true,
      expected_total_amount: expected,
      rationale: 'The user approved the $300 preview and asked to send it.',
    });
  }
  const link = textOf(
    await call('xray_get_session_link', {
      rationale: 'The user asked to watch what the connector is doing.',
    }),
  );
  await client.close();
  const pairing = /https?:\/\/\S+\/xray\/s\/[A-Z0-9-]+/.exec(link)?.[0] ?? null;
  log(`   pairing link: ${pairing ?? link}`);
  return pairing;
}

// ---------------------------------------------------------------------------------------------
// 2. The unsigned public visitor
// ---------------------------------------------------------------------------------------------

async function publicVisitor({ name, userAgent, fetchImpl, calls }) {
  const client = new Client({ name, version: name === 'claude-ai' ? '0.1.0' : '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE_URL}/public/mcp`), {
      requestInit: { headers: { 'user-agent': userAgent } },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
  );
  for (const [tool, args] of calls) await client.callTool({ name: tool, arguments: args });
  await client.close();
}

// ---------------------------------------------------------------------------------------------
// 3. The signed public visitor (Web Bot Auth over a loopback directory)
// ---------------------------------------------------------------------------------------------

function thumbprint(x) {
  return createHash('sha256')
    .update(JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x }))
    .digest('base64url');
}

async function startDirectory(x) {
  const server = createServer((request, response) => {
    if (request.url === '/.well-known/http-message-signatures-directory') {
      response.writeHead(200, {
        'content-type': 'application/http-message-signatures-directory+json',
        'cache-control': 'max-age=86400',
      });
      response.end(JSON.stringify({ keys: [{ kty: 'OKP', crv: 'Ed25519', x, use: 'sig' }] }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, agent: `http://127.0.0.1:${server.address().port}` };
}

/** A fetch that signs every request the way the architecture draft describes. */
function signingFetch({ privateKey, keyid, agent, tamper = () => false }) {
  return async (input, init = {}) => {
    const url =
      input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    const created = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(32).toString('base64url');
    const inner = `("@authority" "@method" "@path" "signature-agent");created=${created};expires=${created + 60};keyid="${keyid}";nonce="${nonce}";tag="web-bot-auth"`;
    const authority = tamper(method, String(init.body ?? '')) ? 'somewhere-else.example' : url.host;
    const base = [
      `"@authority": ${authority}`,
      `"@method": ${method}`,
      `"@path": ${url.pathname}`,
      `"signature-agent": "${agent}"`,
      `"@signature-params": ${inner}`,
    ].join('\n');
    const headers = new Headers(init.headers ?? {});
    headers.set('signature-agent', `"${agent}"`);
    headers.set('signature-input', `sig1=${inner}`);
    headers.set(
      'signature',
      `sig1=:${sign(null, Buffer.from(base, 'utf8'), privateKey).toString('base64')}:`,
    );
    return fetch(url, { ...init, headers });
  };
}

async function main() {
  const health = await fetch(`${BASE_URL}/health`).catch(() => null);
  if (!health?.ok)
    throw new Error(`no Glass Bank answers at ${BASE_URL}; start it first (npm run dev)`);

  const pairing = await signedInAgent();

  log('2. An unsigned public visitor that calls itself claude-ai');
  await publicVisitor({
    name: 'claude-ai',
    userAgent: 'Claude-User',
    calls: [
      ['get_bank_profile', { rationale: 'The user asked what Glass Bank is.' }],
      ['list_products', { family: '', rationale: 'The user wants to compare checking accounts.' }],
      [
        'search_prices',
        {
          product_id: 'clear_checking',
          query: 'wire',
          rationale: 'The user asked what an outgoing wire costs.',
        },
      ],
      ['find_branches', { city: 'Chicago', rationale: 'The user wants a branch near the Loop.' }],
      [
        'get_product',
        {
          product_id: 'no_such_product',
          rationale: 'Checking a product the user half-remembered.',
        },
      ],
    ],
  });

  log('3. A signed public visitor (Web Bot Auth, key served on loopback)');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  const { server, agent } = await startDirectory(x);
  try {
    await publicVisitor({
      name: 'signed-demo-agent',
      userAgent: 'SignedDemoAgent/1.0 (+https://example.test/bot)',
      fetchImpl: signingFetch({ privateKey, keyid: thumbprint(x), agent }),
      calls: [
        [
          'list_products',
          { family: 'accounts', rationale: 'The user is looking for a savings account.' },
        ],
        [
          'search_prices',
          {
            product_id: 'clear_checking',
            query: 'overdraft',
            rationale: 'The user asked about overdraft fees.',
          },
        ],
      ],
    });
    // One tool call whose signature covers another host: recorded as invalid, answered all the same.
    await publicVisitor({
      name: 'signed-demo-agent',
      userAgent: 'SignedDemoAgent/1.0 (+https://example.test/bot)',
      fetchImpl: signingFetch({
        privateKey,
        keyid: thumbprint(x),
        agent,
        tamper: (method, body) => method === 'POST' && body.includes('"tools/call"'),
      }),
      calls: [['get_bank_profile', { rationale: 'Checking the bank before recommending it.' }]],
    });
  } finally {
    server.close();
  }

  log('\nOpen:');
  log(`  public overview   ${BASE_URL}/xray/?lane=public`);
  log(`  your session      ${pairing ?? '(no pairing link came back)'}`);
  log(`  sample recording  ${BASE_URL}/xray/?fixture=1`);
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
