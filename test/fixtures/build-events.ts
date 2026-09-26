/**
 * Builds `test/fixtures/events.jsonl`: the 200-event session described in
 * docs/XRAY_EVENT_MODEL.md section 8.
 *
 * It is a generator rather than a hand-typed file so that ids stay monotonic, `seq` stays
 * correct per `xs`, and every line is validated against `src/contracts/events.ts` before it is
 * written. Regenerate with:
 *
 *     npx tsx test/fixtures/build-events.ts
 *
 * The committed JSONL is the artefact; `test/contracts/events-fixture.test.ts` validates it
 * independently of this script, so a change here that breaks the contract fails the suite.
 *
 * Truthful to contracts v0.5 (task T7b): the catalog rows come from the producer (`catalogRowsOf`),
 * every `/mcp` `http.request` carries the JSON-RPC id `src/mcp/index.ts` would record, and every
 * `tool.call.completed` is summarised by `summariseResult` from the full text the real handler
 * returns, so `content_chars` and `text_preview` agree with each other and with the code.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  CatalogTool,
  ToolAvailability,
  ToolLimits,
  ToolResult,
  XrayCorrelation,
  XrayEvent,
  XrayEventDataInput,
  XrayEventType,
} from '../../src/contracts/index.js';
import {
  DEFAULT_FEATURE_FLAGS,
  RESULT_PREVIEW_BYTES,
  ScratchDbError,
  TOOL_CATALOG,
  TOOL_LIMIT_DEFAULTS,
  TOO_MANY_TABLES_MESSAGE,
  XrayEventSchema,
  catalogAvailability,
  clearedTableText,
  formatScopeString,
  isListed,
  loadResultText,
  pairingUrl,
  processedTableText,
  rowCapMessage,
  toolError,
  toolText,
} from '../../src/contracts/index.js';
import {
  RESULT_PREVIEW_TRUNCATION_SUFFIX,
  catalogRowsOf,
  summariseResult,
} from '../../src/mcp/xray.js';
import { FAKE_READ_ONLY_SCOPES, FAKE_READ_WRITE_SCOPES } from '../../src/testing/fakes.js';
import { describeScratchError } from '../../src/tools/errors.js';
import { formatMoney, toJson } from '../../src/tools/format.js';

// ---------------------------------------------------------------------------
// The cast of one recorded session
// ---------------------------------------------------------------------------

const BOOT_ONE = 'boot_9f2a1c40';
const BOOT_TWO = 'boot_4e7b2811';
const LOGIN = 'lgn_5d2c7a';
const GRANT = 'grt_8a1e33';
const PERSONA = 'per_a1b2';
const PERSONA_NAME = 'Ava Bennett';
const XS_ONE = 'xs_3f1c9a';
const XS_TWO = 'xs_7b4d10';
const CLIENT = { name: 'Anthropic', version: '1.0.0', title: null } as const;
const PROTOCOL = '2025-11-25';
const CLIENT_ID_HASH = 'cli_5f3a9c21';
const BASE_URL = 'https://mcp-bank-520283334162.us-central1.run.app';
const RESOURCE_METADATA = `${BASE_URL}/.well-known/oauth-protected-resource/mcp`;
const AUDIENCE = `${BASE_URL}/mcp`;
/**
 * Still a stand-in: the real `catalogContentHash` is 16 hex characters without a prefix, and
 * `public/__tests__/store.test.mjs` pins this value (docs/contracts/CHANGES.md v0.5).
 */
const CATALOG_HASH = 'sha256:1c9f4b6d2ae08357';
const PAIRING_CODE = 'BANK-7Q2F-K3MZ-8A';
const PAIRING_CODE_HASH = 'sha256:5b3d9ac1';
const PAIRING_EXPIRES_AT = '2026-09-09T14:12:00.000Z';
const IP_PREFIX = '160.79.104.0/24';
const VERSION = '0.1.0';

const CHALLENGE_SCOPES = FAKE_READ_ONLY_SCOPES.join(' ');

/** The knobs the handlers read, at their defaults (docs/DEPLOYMENT.md section 3). */
const LIMITS: ToolLimits = {
  ...TOOL_LIMIT_DEFAULTS,
  contentCharCap: 150_000,
  budgetMs: 300_000,
};

/**
 * The rows `tools/list` records for a grant, built by the producer itself (`catalogRowsOf` in
 * src/mcp/xray.ts): the real `inputSchemaHash` digest and the descriptor the client received, so
 * this fixture cannot drift from the wire (contracts v0.5, ADR-8, ADR-13).
 */
function catalogRowsFor(scopes: readonly string[]): CatalogTool[] {
  return catalogRowsOf(
    TOOL_CATALOG.filter((entry) => isListed(entry, { scopes }, DEFAULT_FEATURE_FLAGS)),
  );
}

const READ_ONLY_AVAILABILITY: ToolAvailability[] = catalogAvailability(
  TOOL_CATALOG,
  { scopes: FAKE_READ_ONLY_SCOPES },
  DEFAULT_FEATURE_FLAGS,
);

const READ_WRITE_AVAILABILITY: ToolAvailability[] = catalogAvailability(
  TOOL_CATALOG,
  { scopes: FAKE_READ_WRITE_SCOPES },
  DEFAULT_FEATURE_FLAGS,
);

const LISTED_COUNT = READ_ONLY_AVAILABILITY.filter((row) => row.listed).length;

// ---------------------------------------------------------------------------
// The data the scratch tables hold (all of it fake)
// ---------------------------------------------------------------------------

const TRANSACTIONS_TABLE = 'load_transactions_9a41c7e2';
const ACCOUNTS_TABLE = 'load_accounts_2b77f014';
const PAYEES_TABLE = 'load_payees_c40b81d9';
const CARDS_TABLE = 'load_cards_51e8a3b6';

const TRANSACTION_COLUMNS = [
  'id',
  'account_id',
  'card_id',
  'date',
  'merchant_name',
  'category_id',
  'amount_cents',
  'currency',
  'status',
  'description',
] as const;
const ACCOUNT_COLUMNS = [
  'id',
  'name',
  'account_type',
  'balance_cents',
  'available_balance_cents',
  'account_number_last4',
  'status',
] as const;
const PAYEE_COLUMNS = [
  'id',
  'name',
  'bank_name',
  'account_number_masked',
  'rail',
  'is_active',
  'created_at',
] as const;
const CARD_COLUMNS = [
  'id',
  'account_id',
  'cardholder_name',
  'brand',
  'last4',
  'status',
  'spending_limit_cents',
  'expires_on',
] as const;

/** Request 7: posted August spending per category, `ORDER BY total_cents ASC`. */
const CATEGORY_TOTALS = [
  ['18', -284_100, 23],
  ['17', -196_450, 31],
  ['19', -142_380, 27],
  ['11', -128_400, 3],
  ['6', -96_200, 2],
  ['4', -84_900, 1],
  ['13', -61_275, 9],
  ['15', -48_830, 6],
  ['24', -35_640, 8],
  ['8', -27_415, 11],
  ['21', -22_000, 2],
  ['14', -18_999, 1],
  ['16', -6_420, 4],
  ['23', -2_500, 5],
].map(([category, total, purchases]) => ({
  category_id: category,
  total_cents: total,
  purchases,
}));

const MERCHANTS = [
  'Harbor Point Grocery',
  'Crestline Fuel Stop',
  'Maple Street Pharmacy',
  'Blue Heron Harbor Bistro',
  'Summit Outdoor Supply',
  'Riverside Hardware Co',
  'Northgate Electronics',
  'Lakeshore Veterinary Clinic',
  'Copperleaf Home Goods',
  'Juniper Lane Bakery',
  'Westbrook Auto Service',
  'Silver Pine Lodge',
  'Oakridge Family Dental',
  'Parkview Cinema Center',
  'Granite Peak Airlines',
  'Cedar Hollow Books',
] as const;

/**
 * The 184 August rows that requests 5, 7 and 9 see, as cents spent, largest first. The 133 posted
 * rows split each category total of request 7 over its purchase count (a descending ramp, so every
 * sum holds to the cent); the other 51 are declined or pending. Only the amounts are modelled.
 */
const AUGUST_SPEND_CENTS = [
  ...CATEGORY_TOTALS.flatMap(({ total_cents, purchases }) => {
    const spent = -Number(total_cents);
    const count = Number(purchases);
    const weights = (count * (count + 1)) / 2;
    const split = Array.from({ length: count }, (_, rank) =>
      Math.floor((spent * (count - rank)) / weights),
    );
    const remainder = spent - split.reduce((sum, cents) => sum + cents, 0);
    return split.map((cents, rank) => (rank === 0 ? cents + remainder : cents));
  }),
  ...Array.from({ length: 51 }, (_, index) => 900 + index * 433),
].sort((left, right) => right - left);
if (AUGUST_SPEND_CENTS.length !== 184 || AUGUST_SPEND_CENTS[99] === AUGUST_SPEND_CENTS[100]) {
  throw new Error('the August table must hold 184 rows with no tie at the 100-row cap');
}

/**
 * Request 9: the first 100 of those 184 rows, `ORDER BY "amount_cents" ASC`. The only result in the
 * recording over the 2,048-character preview: 8,417 characters with the row-cap sentence.
 */
const LARGEST_PURCHASES = AUGUST_SPEND_CENTS.slice(0, LIMITS.maxQueryRows).map((spent, index) => ({
  date: `2026-08-${String(1 + ((index * 7) % 31)).padStart(2, '0')}`,
  merchant_name: MERCHANTS[(index * 5) % MERCHANTS.length],
  amount_cents: -spent,
}));

/** Request 23: the saved payees, `ORDER BY "name" ASC`. */
const PAYEES = [
  ['Alder Property Management', 'First Meridian Bank', 'ach'],
  ['Bayside Water District', 'Coastal Federal Credit Union', 'ach'],
  ['Brightline Internet', 'Summit National Bank', 'ach'],
  ['Cascade Auto Finance', 'First Meridian Bank', 'ach'],
  ['Crestwood Utilities', 'Harborview Savings', 'ach'],
  ['Evergreen Pediatrics', 'Summit National Bank', 'ach'],
  ['Greenfield Tuition Office', 'Keystone Trust', 'wire'],
  ['Hillcrest HOA', 'Coastal Federal Credit Union', 'ach'],
  ['Ironwood Insurance Group', 'Keystone Trust', 'ach'],
  ['Lumen Mobile', 'Summit National Bank', 'ach'],
  ['Northstar Childcare', 'Harborview Savings', 'ach'],
  ['Pinecrest Landscaping', 'First Meridian Bank', 'ach'],
  ['Riverbend Storage', 'Coastal Federal Credit Union', 'ach'],
  ['Sofia Ramirez', 'Harborview Savings', 'ach'],
  ['Westlake Veterinary', 'Keystone Trust', 'ach'],
  ['Zenith Tax Advisors', 'Summit National Bank', 'wire'],
].map(([name, bankName, rail]) => ({ name, bank_name: bankName, rail }));

/** Request 5 of the second session: the lock of 8842 did not survive the restart (A-15). */
const CARDS = [
  { last4: '8842', status: 'active', spending_limit_cents: 250_000 },
  { last4: '3051', status: 'active', spending_limit_cents: 500_000 },
  { last4: '7726', status: 'active', spending_limit_cents: 150_000 },
  { last4: '2209', status: 'active', spending_limit_cents: 100_000 },
  { last4: '6634', status: 'active', spending_limit_cents: 300_000 },
  { last4: '1190', status: 'fraud_locked', spending_limit_cents: 200_000 },
];

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

const events: XrayEvent[] = [];
const seqByXs = new Map<string, number>();
let nextId = 1;
let clock = Date.parse('2026-09-08T14:00:00.000Z');

/** No session, no grant: `server.*` and the pre-auth HTTP leg. */
const ROOT: XrayCorrelation = {
  xs: null,
  login_id: null,
  grant_id: null,
  persona_id: null,
  request_id: null,
  era: null,
  client: null,
  protocol_version: null,
  trace_id: null,
};

/** Current correlation; individual events override what they need. */
let current: XrayCorrelation = {
  xs: null,
  login_id: null,
  grant_id: null,
  persona_id: null,
  request_id: null,
  era: null,
  client: null,
  protocol_version: null,
  trace_id: null,
};

function advance(milliseconds: number): void {
  clock += milliseconds;
}

function emit<T extends XrayEventType>(
  type: T,
  data: XrayEventDataInput<T>,
  overrides: XrayCorrelation = {},
  gapMs = 400,
): XrayEvent {
  advance(gapMs);
  const correlation = { ...current, ...overrides };
  const xs = correlation.xs ?? null;
  let seq: number | null = null;
  if (xs) {
    seq = (seqByXs.get(xs) ?? 0) + 1;
    seqByXs.set(xs, seq);
  }
  const event = XrayEventSchema.parse({
    id: nextId,
    ts: new Date(clock).toISOString(),
    v: 1,
    type,
    seq,
    ...correlation,
    xs,
    data,
  });
  nextId += 1;
  events.push(event);
  return event;
}

interface HttpExtras {
  readonly duration_ms?: number;
  readonly has_authorization?: boolean;
  readonly sse?: boolean;
  readonly rate_limited?: boolean;
  readonly content_type?: string | null;
  readonly user_agent?: string | null;
  /**
   * The first JSON-RPC id of the body, which `src/mcp/index.ts` records on every `/mcp` request
   * whatever the status (401, 403 and 429 included). Required on `/mcp`, `null` for a notification;
   * every other path has no JSON-RPC body.
   */
  readonly requestId?: string | null;
}

function http(
  method: string,
  path: string,
  status: number,
  extras: HttpExtras = {},
  gapMs = 6_000,
): XrayEvent {
  if (path === '/mcp' && extras.requestId === undefined) {
    throw new Error(`POST /mcp ${status} must name the JSON-RPC id it carried (null for a notification)`);
  }
  if (path !== '/mcp' && extras.requestId !== undefined) {
    throw new Error(`${method} ${path} has no JSON-RPC body, so it carries no request_id`);
  }
  return emit(
    'http.request',
    {
      method,
      path,
      status,
      duration_ms: extras.duration_ms ?? 12,
      user_agent: extras.user_agent ?? 'Claude-User/1.0 (+https://claude.ai)',
      remote_ip_prefix: IP_PREFIX,
      anthropic_egress: true,
      origin: null,
      origin_decision: 'absent',
      mcp_protocol_version_header: path === '/mcp' ? PROTOCOL : null,
      mcp_session_id: null,
      has_authorization: extras.has_authorization ?? false,
      content_type: extras.content_type ?? 'application/json',
      sse: extras.sse ?? false,
      rate_limited: extras.rate_limited ?? false,
    },
    { request_id: extras.requestId ?? null },
    gapMs,
  );
}

/** One authenticated `POST /mcp` carrying JSON-RPC id `requestId` (`null`: a notification). */
function mcp(
  status: number,
  requestId: string | null,
  extras: Omit<HttpExtras, 'requestId' | 'has_authorization'> = {},
  gapMs = 6_000,
): XrayEvent {
  return http('POST', '/mcp', status, { ...extras, has_authorization: true, requestId }, gapMs);
}

interface CallStart {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly rationale: string | null;
  readonly scopes: readonly string[];
  readonly requestId: string;
}

function callStarted(input: CallStart): XrayEvent {
  return emit(
    'tool.call.started',
    {
      tool: input.tool,
      arguments: input.args,
      redacted_fields: [],
      rationale: input.rationale,
      rationale_present: input.rationale !== null,
      rationale_truncated: false,
      meta: null,
      required_scopes: [...input.scopes],
      budget_ms: 300_000,
    },
    { request_id: input.requestId },
  );
}

/**
 * The completion exactly as `src/mcp/transport.ts` records it: `summariseResult` counts every
 * character and cuts the preview at `RESULT_PREVIEW_BYTES` with the marker, and an error carries its
 * own preview as the message. The scenes build results without `structuredContent`, which the real
 * handlers attach, so `structured_content` stays null (docs/blocks/contracts.md, Known gaps).
 */
function callCompleted(
  tool: string,
  requestId: string,
  durationMs: number,
  result: ToolResult,
): XrayEvent {
  const summary = summariseResult(result);
  const isError = result.isError === true;
  return emit(
    'tool.call.completed',
    {
      tool,
      duration_ms: durationMs,
      budget_ms: 300_000,
      is_error: isError,
      error: isError
        ? {
            code: null,
            message: summary.textPreview ?? 'the tool reported an error',
            class: 'tool',
          }
        : null,
      content_types: summary.contentTypes,
      content_chars: summary.contentChars,
      content_cap: 150_000,
      structured_content: summary.structuredContent,
      text_preview: summary.textPreview,
    },
    { request_id: requestId },
  );
}

function declared(tool: string, text: string, requestId: string): XrayEvent {
  return emit(
    'intent.declared',
    { text, source: 'rationale', model_authored: true, tool, truncated: false },
    { request_id: requestId },
  );
}

/** What a `load_*` tool answers (`loadResultText`, src/tools/handlers/load.ts). */
function loaded(table: string, columns: readonly string[]): ToolResult {
  return toolText(loadResultText({ table_name: table, columns }));
}

/** A scratch-database failure as `describeScratchError` words it for the model. */
function scratchFailure(error: ScratchDbError): ToolResult {
  return toolError(describeScratchError(error, LIMITS));
}

// ---------------------------------------------------------------------------
// A. The server boots
// ---------------------------------------------------------------------------

const bootOne = emit('server.started', {
  boot_id: BOOT_ONE,
  version: VERSION,
  git_sha: '4c1f9ab',
  sdk: '@modelcontextprotocol/sdk 1.30.0',
  restored_max_id: null,
  node_version: 'v22.23.2',
});
const bootOneAt = Date.parse(bootOne.ts);

// ---------------------------------------------------------------------------
// B. The 401 challenge, discovery, DCR, login, consent and the first token
// ---------------------------------------------------------------------------

// The scene does not show this body. The client retries the same message once it holds a token,
// and the first request that then reaches the session is `initialize`, so this carries its id.
http('POST', '/mcp', 401, { duration_ms: 4, requestId: '0' });
emit('auth.challenge', {
  status: 401,
  error: null,
  scope: CHALLENGE_SCOPES,
  resource_metadata: RESOURCE_METADATA,
  reason: 'no_access_token',
});
http('GET', '/.well-known/oauth-protected-resource/mcp', 200, { duration_ms: 3 });
http('GET', '/.well-known/oauth-authorization-server', 200, { duration_ms: 3 });
http('POST', '/register', 201, { duration_ms: 9 });
emit('auth.client.registered', {
  client_id: CLIENT_ID_HASH,
  client_name: 'Claude',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  token_endpoint_auth_method: 'none',
  application_type: 'web',
});
http('GET', '/authorize', 200, { duration_ms: 18, content_type: 'text/html; charset=utf-8' });
http('POST', '/login', 302, { duration_ms: 11, content_type: 'application/x-www-form-urlencoded' });
emit('auth.login.created', {
  login_id: LOGIN,
  persona_id: PERSONA,
  expires_at: '2026-10-08T14:00:11.000Z',
  persona_source: 'seeded',
  shared_persona: true,
});
http('POST', '/consent', 302, {
  duration_ms: 14,
  content_type: 'application/x-www-form-urlencoded',
});
emit('auth.grant.created', {
  grant_id: GRANT,
  parent_grant_id: null,
  login_id: LOGIN,
  persona_id: PERSONA,
  scopes: [...FAKE_READ_ONLY_SCOPES],
  auth_level: 'read_only',
  client_id: CLIENT_ID_HASH,
  client_name: 'Claude',
  expires_at: '2026-09-15T14:00:14.000Z',
  shared_persona: true,
});
http('POST', '/token', 200, {
  duration_ms: 8,
  content_type: 'application/x-www-form-urlencoded',
});
emit('auth.token.issued', {
  grant_id: GRANT,
  login_id: LOGIN,
  persona_id: PERSONA,
  scopes: [...FAKE_READ_ONLY_SCOPES],
  auth_level: 'read_only',
  client_id: CLIENT_ID_HASH,
  aud: AUDIENCE,
  expires_at: '2026-09-08T15:00:15.000Z',
  refresh_expires_at: '2026-09-15T14:00:15.000Z',
});

// ---------------------------------------------------------------------------
// C. The first authenticated request opens the X-ray session
// ---------------------------------------------------------------------------

current = {
  xs: XS_ONE,
  login_id: LOGIN,
  grant_id: GRANT,
  persona_id: PERSONA,
  request_id: null,
  era: 'legacy',
  client: CLIENT,
  protocol_version: PROTOCOL,
  trace_id: null,
};

mcp(200, '0', { duration_ms: 21 });
emit('auth.verified', {
  grant_id: GRANT,
  login_id: LOGIN,
  persona_id: PERSONA,
  scopes: [...FAKE_READ_ONLY_SCOPES],
  auth_level: 'read_only',
  client_id: CLIENT_ID_HASH,
  client_name: 'Claude',
  aud: AUDIENCE,
  expires_at: '2026-09-08T15:00:15.000Z',
});
const sessionOneStart = emit('session.started', { reason: 'first_request', idle_ms: null });
const sessionOneStartedAt = Date.parse(sessionOneStart.ts);
emit(
  'session.initialized',
  {
    protocol_version_requested: PROTOCOL,
    protocol_version_negotiated: PROTOCOL,
    client: CLIENT,
    client_capabilities: {},
    server_capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions_sent: true,
    initialize_count: 1,
  },
  { request_id: '0' },
);
// `notifications/initialized` has no id: the 202 is the one `/mcp` row that stays null.
mcp(202, null, { duration_ms: 3 }, 900);
mcp(200, '1', { duration_ms: 9 });
const firstListing = emit(
  'catalog.tools_listed',
  {
    count: LISTED_COUNT,
    content_hash: CATALOG_HASH,
    snapshot_ref: null,
    tools: catalogRowsFor(FAKE_READ_ONLY_SCOPES),
    availability: READ_ONLY_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
  },
  { request_id: '1' },
);
emit(
  'catalog.availability',
  {
    content_hash: CATALOG_HASH,
    availability: READ_ONLY_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
    source: 'tools_list',
  },
  { request_id: '1' },
);
mcp(200, '2', { duration_ms: 4 });
emit('catalog.resources_listed', { count: 0 }, { request_id: '2' });
mcp(200, '3', { duration_ms: 4 });
emit('catalog.prompts_listed', { count: 0 }, { request_id: '3' });

// ---------------------------------------------------------------------------
// D. get_current_user
// ---------------------------------------------------------------------------

mcp(200, '4', { duration_ms: 16 });
callStarted({
  tool: 'get_current_user',
  args: { rationale: 'Confirm which demo customer this connection belongs to before answering.' },
  rationale: 'Confirm which demo customer this connection belongs to before answering.',
  scopes: ['profile'],
  requestId: '4',
});
declared(
  'get_current_user',
  'Confirm which demo customer this connection belongs to before answering.',
  '4',
);
emit(
  'bank.op',
  {
    operation: 'persona.get',
    account_id: null,
    card_id: null,
    pages: null,
    rows: 1,
    latency_ms: 1,
    ok: true,
    audit_id: null,
    preview_id: null,
    error: null,
  },
  { request_id: '4' },
);
// The sentences of `getCurrentUser` (src/tools/handlers/meta.ts).
callCompleted(
  'get_current_user',
  '4',
  6,
  toolText(
    [
      `You are connected to Glass Bank as ${PERSONA_NAME} (${PERSONA}), a retail customer.`,
      'This is one of the shared demo customers: its data is the same for everyone, and any change you make is visible only to this connection.',
      `Authorization level: read_only. Scopes: ${formatScopeString(FAKE_READ_ONLY_SCOPES)}.`,
      'The access token expires at 2026-09-08T15:00:15.000Z.',
      `X-ray session: ${XS_ONE}. Server boot id: ${BOOT_ONE} (a different boot id means the server restarted and in-memory changes were lost).`,
    ].join('\n'),
  ),
);

// ---------------------------------------------------------------------------
// E. load_transactions
// ---------------------------------------------------------------------------

const spendRationale =
  'The user asked where their money went last month, so load the postings for August 2026 before aggregating.';
mcp(200, '5', { duration_ms: 148 });
callStarted({
  tool: 'load_transactions',
  args: {
    from_date: '2026-08-01',
    to_date: '2026-08-31',
    category_ids: [],
    status: '',
    rationale: spendRationale,
  },
  rationale: spendRationale,
  scopes: ['transactions:read'],
  requestId: '5',
});
declared('load_transactions', spendRationale, '5');
emit(
  'bank.op',
  {
    operation: 'transactions.list',
    account_id: null,
    card_id: null,
    pages: 1,
    rows: 184,
    latency_ms: 31,
    ok: true,
    audit_id: null,
    preview_id: null,
    error: null,
  },
  { request_id: '5' },
);
emit(
  'etl.load',
  {
    table: TRANSACTIONS_TABLE,
    rows: 184,
    columns_advertised: [...TRANSACTION_COLUMNS],
    source_tool: 'load_transactions',
    duration_ms: 22,
  },
  { request_id: '5' },
);
callCompleted('load_transactions', '5', 137, loaded(TRANSACTIONS_TABLE, TRANSACTION_COLUMNS));

// ---------------------------------------------------------------------------
// F. process_data
// ---------------------------------------------------------------------------

const processRationale =
  'Build a SQL table with the columns needed to total spending by merchant category.';
mcp(200, '6', { duration_ms: 41 });
callStarted({
  tool: 'process_data',
  args: {
    table_name: TRANSACTIONS_TABLE,
    cols: ['date', 'merchant_name', 'category_id', 'amount_cents', 'status'],
    rationale: processRationale,
  },
  rationale: processRationale,
  scopes: [],
  requestId: '6',
});
declared('process_data', processRationale, '6');
emit(
  'etl.processed',
  {
    table: TRANSACTIONS_TABLE,
    rows: 184,
    columns_advertised: [...TRANSACTION_COLUMNS],
    columns_selected: ['date', 'merchant_name', 'category_id', 'amount_cents', 'status'],
    duration_ms: 18,
  },
  { request_id: '6' },
);
callCompleted('process_data', '6', 24, toolText(processedTableText(TRANSACTIONS_TABLE)));

// ---------------------------------------------------------------------------
// G. execute_query
// ---------------------------------------------------------------------------

const querySql =
  'SELECT "category_id", SUM("amount_cents") AS total_cents, COUNT(*) AS purchases FROM "load_transactions_9a41c7e2" WHERE "status" = \'posted\' GROUP BY "category_id" ORDER BY total_cents ASC';
const queryRationale = 'Total the posted spending per category to answer the monthly breakdown.';
mcp(200, '7', { duration_ms: 34 });
callStarted({
  tool: 'execute_query',
  args: { table_name: TRANSACTIONS_TABLE, query: querySql, rationale: queryRationale },
  rationale: queryRationale,
  scopes: [],
  requestId: '7',
});
declared('execute_query', queryRationale, '7');
emit(
  'sql.query',
  {
    table: TRANSACTIONS_TABLE,
    sql: querySql,
    rows_returned: CATEGORY_TOTALS.length,
    capped: false,
    duration_ms: 6,
  },
  { request_id: '7' },
);
callCompleted('execute_query', '7', 11, toolText(toJson(CATEGORY_TOTALS)));

// ---------------------------------------------------------------------------
// H. A rejected SQL statement (the ATTACH escape of ADR-9)
// ---------------------------------------------------------------------------

const attackSql = "ATTACH DATABASE '/tmp/exfiltrated.sqlite' AS leak";
const attackRationale = 'Try to persist the aggregated result for later reuse.';
// The guard's own words (`checkScratchSql`, src/etl/sql-text.ts), passed through to the model.
const attackMessage = 'the statement keyword "ATTACH" is not allowed in a scratch query';
mcp(200, '8', { duration_ms: 9 });
callStarted({
  tool: 'execute_query',
  args: { table_name: TRANSACTIONS_TABLE, query: attackSql, rationale: attackRationale },
  rationale: attackRationale,
  scopes: [],
  requestId: '8',
});
declared('execute_query', attackRationale, '8');
emit(
  'sql.rejected',
  {
    table: TRANSACTIONS_TABLE,
    sql: attackSql,
    rejected_reason: 'denylist',
    error: attackMessage,
    duration_ms: 1,
  },
  { request_id: '8' },
);
callCompleted(
  'execute_query',
  '8',
  3,
  scratchFailure(new ScratchDbError('denylist', attackMessage, { sql: attackSql, duration_ms: 1 })),
);

// ---------------------------------------------------------------------------
// I. A query that hits the 100-row cap
// ---------------------------------------------------------------------------

const cappedSql =
  'SELECT "date", "merchant_name", "amount_cents" FROM "load_transactions_9a41c7e2" ORDER BY "amount_cents" ASC';
const cappedRationale = 'List every purchase so the user can scan the largest ones.';
mcp(200, '9', { duration_ms: 28 });
callStarted({
  tool: 'execute_query',
  args: { table_name: TRANSACTIONS_TABLE, query: cappedSql, rationale: cappedRationale },
  rationale: cappedRationale,
  scopes: [],
  requestId: '9',
});
declared('execute_query', cappedRationale, '9');
emit(
  'sql.query',
  {
    table: TRANSACTIONS_TABLE,
    sql: cappedSql,
    rows_returned: LARGEST_PURCHASES.length,
    capped: true,
    duration_ms: 8,
  },
  { request_id: '9' },
);
// `executeQuery` (src/tools/handlers/database.ts) appends the row-cap sentence to the first 100 rows
// and still succeeds, so this is a successful result of 8,417 characters and the one preview in the
// recording that was cut at 2,048 characters plus the marker.
callCompleted(
  'execute_query',
  '9',
  14,
  toolText(`${toJson(LARGEST_PURCHASES)}\n${rowCapMessage(LIMITS.maxQueryRows)}`),
);

// ---------------------------------------------------------------------------
// J. clear_table
// ---------------------------------------------------------------------------

const clearRationale = 'The category breakdown is answered, so free the table budget.';
mcp(200, '10', { duration_ms: 7 });
callStarted({
  tool: 'clear_table',
  args: { table_name: TRANSACTIONS_TABLE, rationale: clearRationale },
  rationale: clearRationale,
  scopes: [],
  requestId: '10',
});
declared('clear_table', clearRationale, '10');
emit('sql.table_cleared', { table: TRANSACTIONS_TABLE, duration_ms: 2 }, { request_id: '10' });
callCompleted('clear_table', '10', 4, toolText(clearedTableText(TRANSACTIONS_TABLE)));

// ---------------------------------------------------------------------------
// K. The classifier labels the sequence
// ---------------------------------------------------------------------------

emit(
  'intent.inferred',
  {
    workflow: 'spend_analysis',
    // 0.85 is the classifier's ceiling: `confidence` is `0.4 + 0.45 x margin` clamped, so the only
    // values it can produce are 0.2 for `unknown` and 0.40 to 0.85 for the rest (src/tools/intent.ts).
    // The sample is what a first-time visitor sees; it must not show a number the server cannot emit.
    confidence: 0.85,
    source: 'classifier',
    model_authored: false,
    tools: ['load_transactions', 'process_data', 'execute_query', 'clear_table'],
  },
  // `src/tools/registry.ts` emits it with the correlation of the call that closed the sequence.
  { request_id: '10' },
);

// ---------------------------------------------------------------------------
// L. A call that arrives without a rationale (ADR-8, A-06)
// ---------------------------------------------------------------------------

mcp(200, '11', { duration_ms: 62 });
callStarted({
  tool: 'load_accounts',
  args: { account_type: '' },
  rationale: null,
  scopes: ['accounts:read'],
  requestId: '11',
});
emit('intent.missing', { tool: 'load_accounts', reason: 'absent' }, { request_id: '11' });
emit(
  'bank.op',
  {
    operation: 'accounts.list',
    account_id: null,
    card_id: null,
    pages: 1,
    rows: 4,
    latency_ms: 3,
    ok: true,
    audit_id: null,
    preview_id: null,
    error: null,
  },
  { request_id: '11' },
);
emit(
  'etl.load',
  {
    table: ACCOUNTS_TABLE,
    rows: 4,
    columns_advertised: [...ACCOUNT_COLUMNS],
    source_tool: 'load_accounts',
    duration_ms: 5,
  },
  { request_id: '11' },
);
callCompleted('load_accounts', '11', 51, loaded(ACCOUNTS_TABLE, ACCOUNT_COLUMNS));

// ---------------------------------------------------------------------------
// M. A claude.ai reconnect loop: initialize again inside the same xs (A-27)
// ---------------------------------------------------------------------------

mcp(200, '0', { duration_ms: 18 });
emit(
  'session.initialized',
  {
    protocol_version_requested: PROTOCOL,
    protocol_version_negotiated: PROTOCOL,
    client: CLIENT,
    client_capabilities: {},
    server_capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions_sent: true,
    initialize_count: 2,
  },
  { request_id: '0' },
);
mcp(200, '12', { duration_ms: 6 });
emit(
  'catalog.tools_listed',
  {
    count: LISTED_COUNT,
    content_hash: CATALOG_HASH,
    snapshot_ref: firstListing.id,
    tools: null,
    availability: READ_ONLY_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
  },
  { request_id: '12' },
);

// ---------------------------------------------------------------------------
// N. A protocol error
// ---------------------------------------------------------------------------

mcp(200, '13', { duration_ms: 3 });
emit(
  'protocol.error',
  { 'mcp.method.name': 'resources/templates/list', code: -32601, message: 'Method not found' },
  { request_id: '13' },
);

// ---------------------------------------------------------------------------
// O. The 403 step-up: a listed write tool under a read-only grant (ADR-13)
// ---------------------------------------------------------------------------

mcp(403, '14', { duration_ms: 5 });
emit(
  'tool.call.denied',
  {
    tool: 'create_transfer',
    denied_reason: 'insufficient_scope',
    required_scopes: ['transfers:write'],
    missing_scopes: ['cards:write', 'transfers:write'],
    status: 403,
  },
  { request_id: '14' },
);
emit(
  'auth.stepup.requested',
  {
    status: 403,
    error: 'insufficient_scope',
    grant_id: GRANT,
    login_id: LOGIN,
    persona_id: PERSONA,
    tool: 'create_transfer',
    scope: 'cards:write transfers:write',
    missing_scopes: ['cards:write', 'transfers:write'],
    resource_metadata: RESOURCE_METADATA,
  },
  { request_id: '14' },
);

// ---------------------------------------------------------------------------
// P. Re-consent in the same browser extends the SAME grant (ADR-14)
// ---------------------------------------------------------------------------

const browser: XrayCorrelation = {
  xs: null,
  login_id: LOGIN,
  grant_id: GRANT,
  persona_id: PERSONA,
  request_id: null,
  era: null,
  client: null,
  protocol_version: null,
  trace_id: null,
};
const mcpSession = current;
current = browser;

http(
  'GET',
  '/authorize',
  200,
  { duration_ms: 15, content_type: 'text/html; charset=utf-8' },
  20_000,
);
http('POST', '/login', 302, { duration_ms: 9, content_type: 'application/x-www-form-urlencoded' });
http('POST', '/consent', 302, {
  duration_ms: 12,
  content_type: 'application/x-www-form-urlencoded',
});
emit('auth.grant.updated', {
  grant_id: GRANT,
  login_id: LOGIN,
  persona_id: PERSONA,
  scopes: [...FAKE_READ_WRITE_SCOPES],
  added_scopes: ['cards:write', 'transfers:write'],
  auth_level: 'read_write',
  client_id: CLIENT_ID_HASH,
  reason: 'step_up',
});
http('POST', '/token', 200, { duration_ms: 7, content_type: 'application/x-www-form-urlencoded' });
emit('auth.token.issued', {
  grant_id: GRANT,
  login_id: LOGIN,
  persona_id: PERSONA,
  scopes: [...FAKE_READ_WRITE_SCOPES],
  auth_level: 'read_write',
  client_id: CLIENT_ID_HASH,
  aud: AUDIENCE,
  expires_at: '2026-09-08T16:05:00.000Z',
  refresh_expires_at: '2026-09-09T15:05:00.000Z',
});

current = mcpSession;

// ---------------------------------------------------------------------------
// Q. Back on /mcp with the widened grant
// ---------------------------------------------------------------------------

mcp(200, '0', { duration_ms: 17 });
emit(
  'session.initialized',
  {
    protocol_version_requested: PROTOCOL,
    protocol_version_negotiated: PROTOCOL,
    client: CLIENT,
    client_capabilities: {},
    server_capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions_sent: true,
    initialize_count: 3,
  },
  { request_id: '0' },
);
mcp(200, '15', { duration_ms: 6 });
emit(
  'catalog.tools_listed',
  {
    count: LISTED_COUNT,
    content_hash: CATALOG_HASH,
    snapshot_ref: firstListing.id,
    tools: null,
    availability: READ_WRITE_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
  },
  { request_id: '15' },
);
emit(
  'catalog.availability',
  {
    content_hash: CATALOG_HASH,
    availability: READ_WRITE_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
    source: 'tools_list',
  },
  { request_id: '15' },
);

// ---------------------------------------------------------------------------
// R. create_transfer, step one: the preview
// ---------------------------------------------------------------------------

const FROM_ACCOUNT = 'acc_a1b2_01';
const PAYEE = 'pay_a1b2_03';
const TRANSFER_AMOUNT = 128_400;
const RESULTING_BALANCE = 1_042_300;
/** The persona's per-transfer limit; the daily allowance is three of them (src/bank-core/transfers.ts). */
const TRANSFER_LIMIT = 500_000;
const DAILY_ALLOWANCE = TRANSFER_LIMIT * 3;
const DAILY_REMAINING = DAILY_ALLOWANCE - TRANSFER_AMOUNT;

const previewRationale =
  'The user asked to pay the Crestwood Utilities bill; preview the transfer so they can approve the exact total.';
mcp(200, '16', { duration_ms: 44 });
callStarted({
  tool: 'create_transfer',
  args: {
    from_account_id: FROM_ACCOUNT,
    to: { payee_id: PAYEE },
    amount: TRANSFER_AMOUNT,
    currency: 'USD',
    memo: 'September utilities',
    confirm: false,
    rationale: previewRationale,
  },
  rationale: previewRationale,
  scopes: ['transfers:write'],
  requestId: '16',
});
declared('create_transfer', previewRationale, '16');
const previewOp = emit(
  'bank.op',
  {
    operation: 'transfer.preview',
    account_id: '****4417',
    card_id: null,
    pages: null,
    rows: 1,
    latency_ms: 4,
    ok: true,
    audit_id: null,
    preview_id: 'prv_7c31',
    error: null,
  },
  { request_id: '16' },
);
// `previewLines` and the two closing sentences of `createTransferHandler`
// (src/tools/handlers/writes.ts); the preview lives 15 minutes (`previewTtlMinutes`).
const previewExpiresAt = new Date(Date.parse(previewOp.ts) + 15 * 60_000).toISOString();
callCompleted(
  'create_transfer',
  '16',
  21,
  toolText(
    [
      'Preview only: no money has moved and nothing is scheduled yet.',
      `From ${FROM_ACCOUNT} to payee ${PAYEE} over the ach rail.`,
      `Amount: ${formatMoney(TRANSFER_AMOUNT, 'USD')}`,
      `Fee: ${formatMoney(0, 'USD')}`,
      `Total: ${formatMoney(TRANSFER_AMOUNT, 'USD')}`,
      `Resulting balance on ${FROM_ACCOUNT}: ${formatMoney(RESULTING_BALANCE, 'USD')}`,
      `Limits: ok - within the ${TRANSFER_LIMIT} cent per-transfer limit; ${DAILY_REMAINING} cents of today's ${DAILY_ALLOWANCE} cent allowance remain after this transfer (per-transfer limit ${TRANSFER_LIMIT} cents, ${DAILY_REMAINING} cents left today).`,
      `Show this to the user and ask for explicit approval. To send it, call create_transfer again with the same arguments plus confirm set to true and expected_total_amount set to ${TRANSFER_AMOUNT}.`,
      `The preview expires at ${previewExpiresAt}.`,
    ].join('\n'),
  ),
);

// ---------------------------------------------------------------------------
// S. create_transfer, step two: the confirmation
// ---------------------------------------------------------------------------

const confirmRationale =
  'The user approved the preview of 128400 cents, so confirm the transfer with the expected total.';
mcp(200, '17', { duration_ms: 39 });
callStarted({
  tool: 'create_transfer',
  args: {
    from_account_id: FROM_ACCOUNT,
    to: { payee_id: PAYEE },
    amount: TRANSFER_AMOUNT,
    currency: 'USD',
    memo: 'September utilities',
    confirm: true,
    expected_total_amount: TRANSFER_AMOUNT,
    rationale: confirmRationale,
  },
  rationale: confirmRationale,
  scopes: ['transfers:write'],
  requestId: '17',
});
declared('create_transfer', confirmRationale, '17');
emit(
  'bank.op',
  {
    operation: 'transfer.confirm',
    account_id: '****4417',
    card_id: null,
    pages: null,
    rows: 1,
    latency_ms: 6,
    ok: true,
    audit_id: 'aud_0001',
    preview_id: 'prv_7c31',
    error: null,
  },
  { request_id: '17' },
);
callCompleted(
  'create_transfer',
  '17',
  25,
  toolText(
    [
      'Transfer tr_0002 is completed.',
      `Sent ${formatMoney(TRANSFER_AMOUNT, 'USD')} from ${FROM_ACCOUNT} to payee ${PAYEE} over the ach rail.`,
      `Fee: ${formatMoney(0, 'USD')}. Total taken from the account: ${formatMoney(TRANSFER_AMOUNT, 'USD')}.`,
      'An audit entry was appended (aud_0001).',
    ].join('\n'),
  ),
);

// ---------------------------------------------------------------------------
// T. lock_or_unlock_card
// ---------------------------------------------------------------------------

const lockRationale = 'The user lost the card ending 8842 and asked to freeze it immediately.';
mcp(200, '18', { duration_ms: 26 });
callStarted({
  tool: 'lock_or_unlock_card',
  args: { card_id: 'card_a1b2_02', action: 'lock', rationale: lockRationale },
  rationale: lockRationale,
  scopes: ['cards:write'],
  requestId: '18',
});
declared('lock_or_unlock_card', lockRationale, '18');
emit(
  'bank.op',
  {
    operation: 'card.lock',
    account_id: '****4417',
    card_id: '****8842',
    pages: null,
    rows: 1,
    latency_ms: 2,
    ok: true,
    audit_id: 'aud_0002',
    preview_id: null,
    error: null,
  },
  { request_id: '18' },
);
callCompleted(
  'lock_or_unlock_card',
  '18',
  9,
  toolText(
    'Card ending 8842 (card_a1b2_02) is now locked. An audit entry was appended (aud_0002).',
  ),
);

// ---------------------------------------------------------------------------
// U. A write that the bank refuses: a fraud-locked card
// ---------------------------------------------------------------------------

const unlockRationale = 'The user asked to reactivate the card ending 1190.';
mcp(200, '19', { duration_ms: 18 });
callStarted({
  tool: 'lock_or_unlock_card',
  args: { card_id: 'card_a1b2_20', action: 'unlock', rationale: unlockRationale },
  rationale: unlockRationale,
  scopes: ['cards:write'],
  requestId: '19',
});
declared('lock_or_unlock_card', unlockRationale, '19');
emit(
  'bank.op',
  {
    operation: 'card.unlock',
    account_id: '****9903',
    card_id: '****1190',
    pages: null,
    rows: 0,
    latency_ms: 2,
    ok: false,
    audit_id: null,
    preview_id: null,
    error: 'fraud_locked',
  },
  { request_id: '19' },
);
// `lockOrUnlockCard` wraps bank-core's refusal (src/bank-core/index.ts) in its own sentence.
callCompleted(
  'lock_or_unlock_card',
  '19',
  7,
  toolError(
    'the card could not be unlocked (fraud_locked): card ending 1190 was locked by the bank for suspected fraud and cannot be unlocked with this tool; the customer has to call the fraud line',
  ),
);

// ---------------------------------------------------------------------------
// V. xray_get_session_link
// ---------------------------------------------------------------------------

const xrayRationale = 'The user asked what the server can see, so give them the dashboard link.';
mcp(200, '20', { duration_ms: 12 });
callStarted({
  tool: 'xray_get_session_link',
  args: { rationale: xrayRationale },
  rationale: xrayRationale,
  scopes: ['xray:read'],
  requestId: '20',
});
declared('xray_get_session_link', xrayRationale, '20');
emit(
  'xray.pairing.created',
  { code: PAIRING_CODE_HASH, login_id: LOGIN, expires_at: PAIRING_EXPIRES_AT },
  { request_id: '20' },
);
// `getSessionLink` (src/tools/handlers/xray.ts). The emitter hashes the code on the pairing event
// only; the tool result is previewed as the model received it.
callCompleted(
  'xray_get_session_link',
  '20',
  5,
  toolText(
    [
      `Open this to watch what happens behind the scenes: ${pairingUrl(BASE_URL, PAIRING_CODE)}`,
      `Pairing code: ${PAIRING_CODE} (type it at ${BASE_URL}/xray if the link is not clickable).`,
      `The link covers every session of this login, works more than once and expires at ${PAIRING_EXPIRES_AT}.`,
      'Show the link to the user exactly as it is written: it only works verbatim.',
    ].join('\n'),
  ),
);

// ---------------------------------------------------------------------------
// W. The viewer opens the dashboard (one mistyped code first)
// ---------------------------------------------------------------------------

current = browser;
http('GET', '/xray/s/BANK-7Q2F-K3MZ-88', 404, { duration_ms: 3 });
emit('xray.pairing.rejected', { code: 'sha256:9d10ff2c', reason: 'unknown_code' });
http('GET', `/xray/s/${PAIRING_CODE}`, 302, { duration_ms: 6 });
http('GET', '/xray/api/me', 200, { duration_ms: 2 });
http('GET', '/xray/api/stream', 200, { duration_ms: 1, sse: true });
const viewerConnected = emit('xray.viewer.connected', {
  viewer_kind: 'pairing',
  login_id: LOGIN,
  filter: 'login',
  last_event_id: null,
  replayed: 200,
});
const viewerConnectedAt = Date.parse(viewerConnected.ts);
current = mcpSession;

// ---------------------------------------------------------------------------
// X. A second ETL cycle on payees
// ---------------------------------------------------------------------------

const payeeRationale =
  'List the saved payees so the user can pick the right one for the next bill.';
mcp(200, '21', { duration_ms: 58 });
callStarted({
  tool: 'load_payees',
  args: { is_active: true, rationale: payeeRationale },
  rationale: payeeRationale,
  scopes: ['payees:read'],
  requestId: '21',
});
declared('load_payees', payeeRationale, '21');
emit(
  'bank.op',
  {
    operation: 'payees.list',
    account_id: null,
    card_id: null,
    pages: 1,
    rows: PAYEES.length,
    latency_ms: 4,
    ok: true,
    audit_id: null,
    preview_id: null,
    error: null,
  },
  { request_id: '21' },
);
emit(
  'etl.load',
  {
    table: PAYEES_TABLE,
    rows: PAYEES.length,
    columns_advertised: [...PAYEE_COLUMNS],
    source_tool: 'load_payees',
    duration_ms: 6,
  },
  { request_id: '21' },
);
callCompleted('load_payees', '21', 44, loaded(PAYEES_TABLE, PAYEE_COLUMNS));

const payeeProcessRationale = 'Project the payee columns needed to show a short picking list.';
mcp(200, '22', { duration_ms: 22 });
callStarted({
  tool: 'process_data',
  args: {
    table_name: PAYEES_TABLE,
    cols: ['id', 'name', 'bank_name', 'rail'],
    rationale: payeeProcessRationale,
  },
  rationale: payeeProcessRationale,
  scopes: [],
  requestId: '22',
});
declared('process_data', payeeProcessRationale, '22');
emit(
  'etl.processed',
  {
    table: PAYEES_TABLE,
    rows: PAYEES.length,
    columns_advertised: [...PAYEE_COLUMNS],
    columns_selected: ['id', 'name', 'bank_name', 'rail'],
    duration_ms: 7,
  },
  { request_id: '22' },
);
callCompleted('process_data', '22', 12, toolText(processedTableText(PAYEES_TABLE)));

const payeeQuerySql =
  'SELECT "name", "bank_name", "rail" FROM "load_payees_c40b81d9" ORDER BY "name" ASC';
const payeeQueryRationale = 'Show the saved payees alphabetically.';
mcp(200, '23', { duration_ms: 19 });
callStarted({
  tool: 'execute_query',
  args: {
    table_name: PAYEES_TABLE,
    query: payeeQuerySql,
    rationale: payeeQueryRationale,
  },
  rationale: payeeQueryRationale,
  scopes: [],
  requestId: '23',
});
declared('execute_query', payeeQueryRationale, '23');
emit(
  'sql.query',
  {
    table: PAYEES_TABLE,
    sql: payeeQuerySql,
    rows_returned: PAYEES.length,
    capped: false,
    duration_ms: 3,
  },
  { request_id: '23' },
);
callCompleted('execute_query', '23', 8, toolText(toJson(PAYEES)));

// ---------------------------------------------------------------------------
// Y. The per-grant table cap
// ---------------------------------------------------------------------------

const billsRationale = 'Load the open bills so the user can see what is still due this month.';
mcp(200, '24', { duration_ms: 15 });
callStarted({
  tool: 'load_bills',
  args: {
    from_date: '2026-09-01',
    to_date: '2026-09-30',
    payment_status: 'open',
    rationale: billsRationale,
  },
  rationale: billsRationale,
  scopes: ['bills:read'],
  requestId: '24',
});
declared('load_bills', billsRationale, '24');
emit(
  'etl.limit_reached',
  {
    limit: 'tables',
    table: null,
    current: 10,
    max: 10,
    message: TOO_MANY_TABLES_MESSAGE,
  },
  { request_id: '24' },
);
callCompleted(
  'load_bills',
  '24',
  6,
  scratchFailure(new ScratchDbError('grant_cap', TOO_MANY_TABLES_MESSAGE)),
);

// ---------------------------------------------------------------------------
// Z. Two tables cleared to free the budget
// ---------------------------------------------------------------------------

for (const [tableName, requestId] of [
  [PAYEES_TABLE, '25'],
  [ACCOUNTS_TABLE, '26'],
] as const) {
  const rationale = `Drop ${tableName}; the answer it supported is already given.`;
  mcp(200, requestId, { duration_ms: 6 });
  callStarted({
    tool: 'clear_table',
    args: { table_name: tableName, rationale },
    rationale,
    scopes: [],
    requestId,
  });
  declared('clear_table', rationale, requestId);
  emit('sql.table_cleared', { table: tableName, duration_ms: 2 }, { request_id: requestId });
  callCompleted('clear_table', requestId, 4, toolText(clearedTableText(tableName)));
}

// ---------------------------------------------------------------------------
// AA. A recursive-CTE bomb: the ADR-9 timeout path
// ---------------------------------------------------------------------------

const bombSql =
  'WITH RECURSIVE bomb(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM bomb) SELECT count(*) FROM bomb';
const bombRationale = 'Count the rows generated by a recursive series to benchmark the database.';
// What `src/etl/scratch-db.ts` records when the runner is killed on `QUERY_TIMEOUT_MS`.
const bombMessage = `the query was stopped after ${LIMITS.queryTimeoutMs} ms; add filters, aggregate, or use LIMIT and retry`;
mcp(200, '27', { duration_ms: 2140 });
callStarted({
  tool: 'execute_query',
  args: { table_name: TRANSACTIONS_TABLE, query: bombSql, rationale: bombRationale },
  rationale: bombRationale,
  scopes: [],
  requestId: '27',
});
declared('execute_query', bombRationale, '27');
emit(
  'sql.rejected',
  {
    table: TRANSACTIONS_TABLE,
    sql: bombSql,
    rejected_reason: 'timeout',
    error: bombMessage,
    duration_ms: 2004,
  },
  { request_id: '27' },
);
emit(
  'etl.worker_terminated',
  {
    reason: 'timeout',
    duration_ms: 2011,
    table: TRANSACTIONS_TABLE,
    tables_lost: [TRANSACTIONS_TABLE],
  },
  { request_id: '27' },
);
callCompleted(
  'execute_query',
  '27',
  2028,
  scratchFailure(new ScratchDbError('timeout', bombMessage, { sql: bombSql, duration_ms: 2004 })),
);

// ---------------------------------------------------------------------------
// BB. TTL eviction and a rate-limited call
// ---------------------------------------------------------------------------

emit('etl.table_evicted', {
  table: PAYEES_TABLE,
  reason: 'ttl',
  rows: PAYEES.length,
  age_ms: 1_800_000,
});
mcp(429, '28', { duration_ms: 1, rate_limited: true });
emit(
  'tool.call.denied',
  {
    tool: 'execute_query',
    denied_reason: 'rate_limited',
    required_scopes: [],
    missing_scopes: [],
    status: 429,
  },
  { request_id: '28' },
);

// ---------------------------------------------------------------------------
// CC. A refresh, then an expired access token
// ---------------------------------------------------------------------------

current = browser;
http('POST', '/token', 200, { duration_ms: 7, content_type: 'application/x-www-form-urlencoded' });
emit('auth.token.refreshed', {
  grant_id: GRANT,
  login_id: LOGIN,
  persona_id: PERSONA,
  scopes: [...FAKE_READ_WRITE_SCOPES],
  auth_level: 'read_write',
  client_id: CLIENT_ID_HASH,
  expires_at: '2026-09-08T17:10:00.000Z',
  refresh_expires_at: '2026-09-09T16:10:00.000Z',
  rotated_jti: 'rft_3f18aa',
});
current = mcpSession;

// The scene does not show this body. The request this client sends next, and so the one it retried,
// is the `initialize` that opens xs_7b4d10 after the restart, so this carries its id.
mcp(401, '0', { duration_ms: 2 });
emit('auth.rejected', {
  status: 401,
  error: 'invalid_token',
  reason: 'expired',
  client_id: CLIENT_ID_HASH,
});
emit('auth.challenge', {
  status: 401,
  error: 'invalid_token',
  scope: CHALLENGE_SCOPES,
  resource_metadata: RESOURCE_METADATA,
  reason: 'expired',
});

// ---------------------------------------------------------------------------
// DD. The viewer stream overflows and reconnects with Last-Event-ID
// ---------------------------------------------------------------------------

current = browser;
emit('xray.dropped', {
  dropped_count: 37,
  viewer_kind: 'pairing',
  filter: 'login',
  reason: 'backpressure',
});
http('GET', '/xray/api/stream', 200, { duration_ms: 1, sse: true });
emit('xray.viewer.connected', {
  viewer_kind: 'pairing',
  login_id: LOGIN,
  filter: 'login',
  last_event_id: 160,
  replayed: 37,
});
current = mcpSession;

// ---------------------------------------------------------------------------
// EE. Shutdown and the restart marker
// ---------------------------------------------------------------------------

const sessionOneEnd = emit('session.ended', {
  reason: 'server_stopping',
  idle_ms: null,
  duration_ms: clock + 400 - sessionOneStartedAt,
  call_count: 22,
  error_count: 4,
  initialize_count: 3,
});
emit(
  'xray.viewer.disconnected',
  {
    viewer_kind: 'pairing',
    login_id: LOGIN,
    filter: 'login',
    duration_ms: Date.parse(sessionOneEnd.ts) + 400 - viewerConnectedAt,
    reason: 'server_cut',
  },
  browser,
);
emit(
  'server.stopping',
  {
    boot_id: BOOT_ONE,
    version: VERSION,
    reason: 'sigterm',
    uptime_s: Math.round((clock + 400 - bootOneAt) / 1000),
    sessions_ended: 1,
  },
  ROOT,
);
emit(
  'server.started',
  {
    boot_id: BOOT_TWO,
    version: VERSION,
    git_sha: '4c1f9ab',
    sdk: '@modelcontextprotocol/sdk 1.30.0',
    restored_max_id: nextId - 1,
    node_version: 'v22.23.2',
  },
  ROOT,
  9_000,
);

// ---------------------------------------------------------------------------
// FF. A new xs for the same grant after the restart
// ---------------------------------------------------------------------------

current = { ...mcpSession, xs: XS_TWO };

mcp(200, '0', { duration_ms: 24 }, 45_000);
emit('auth.verified', {
  grant_id: GRANT,
  login_id: LOGIN,
  persona_id: PERSONA,
  scopes: [...FAKE_READ_WRITE_SCOPES],
  auth_level: 'read_write',
  client_id: CLIENT_ID_HASH,
  client_name: 'Claude',
  aud: AUDIENCE,
  expires_at: '2026-09-08T17:10:00.000Z',
});
emit('session.started', { reason: 'first_request', idle_ms: null });
emit(
  'session.initialized',
  {
    protocol_version_requested: PROTOCOL,
    protocol_version_negotiated: PROTOCOL,
    client: CLIENT,
    client_capabilities: {},
    server_capabilities: { tools: {}, prompts: {}, resources: {} },
    instructions_sent: true,
    initialize_count: 1,
  },
  { request_id: '0' },
);
mcp(200, '1', { duration_ms: 7 });
// A full array again: catalog memory is in-process, so the restart at `server.started` forgets
// that this grant was already sent the descriptors.
emit(
  'catalog.tools_listed',
  {
    count: LISTED_COUNT,
    content_hash: CATALOG_HASH,
    snapshot_ref: null,
    tools: catalogRowsFor(FAKE_READ_WRITE_SCOPES),
    availability: READ_WRITE_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
  },
  { request_id: '1' },
);
emit(
  'catalog.availability',
  {
    content_hash: CATALOG_HASH,
    availability: READ_WRITE_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
    source: 'tools_list',
  },
  { request_id: '1' },
);

// ---------------------------------------------------------------------------
// GG. get_tool_availability explains what changed
// ---------------------------------------------------------------------------

const availabilityRationale =
  'The card lock looks undone after the restart; check what this connection can still do.';
mcp(200, '2', { duration_ms: 11 });
callStarted({
  tool: 'get_tool_availability',
  args: { rationale: availabilityRationale },
  rationale: availabilityRationale,
  scopes: ['profile'],
  requestId: '2',
});
declared('get_tool_availability', availabilityRationale, '2');
emit(
  'catalog.availability',
  {
    content_hash: CATALOG_HASH,
    availability: READ_WRITE_AVAILABILITY,
    feature_flags: [...DEFAULT_FEATURE_FLAGS],
    source: 'get_tool_availability',
  },
  { request_id: '2' },
);
// The table `getToolAvailability` prints (src/tools/handlers/meta.ts), one line per catalog row.
const availabilityLines = READ_WRITE_AVAILABILITY.map((row) => {
  if (row.available) return `${row.tool}: available`;
  const reasons = row.unavailable_reasons.join(', ');
  const missing =
    row.missing_scopes.length > 0 ? ` (still needs ${row.missing_scopes.join(' ')})` : '';
  return `${row.tool}: ${row.listed ? 'listed but unavailable' : 'hidden'} - ${reasons}${missing}`;
});
callCompleted(
  'get_tool_availability',
  '2',
  4,
  toolText(
    [
      `Tool availability for this connection (read_write, catalog ${CATALOG_HASH}):`,
      ...availabilityLines,
    ].join('\n'),
  ),
);

// ---------------------------------------------------------------------------
// HH. One more load / process / query cycle closes the fixture
// ---------------------------------------------------------------------------

const cardsRationale = 'Reload the cards to show whether the lock survived the restart.';
mcp(200, '3', { duration_ms: 47 });
callStarted({
  tool: 'load_cards',
  args: { status: '', rationale: cardsRationale },
  rationale: cardsRationale,
  scopes: ['cards:read'],
  requestId: '3',
});
declared('load_cards', cardsRationale, '3');
emit(
  'bank.op',
  {
    operation: 'cards.list',
    account_id: null,
    card_id: null,
    pages: 1,
    rows: CARDS.length,
    latency_ms: 3,
    ok: true,
    audit_id: null,
    preview_id: null,
    error: null,
  },
  { request_id: '3' },
);
emit(
  'etl.load',
  {
    table: CARDS_TABLE,
    rows: CARDS.length,
    columns_advertised: [...CARD_COLUMNS],
    source_tool: 'load_cards',
    duration_ms: 5,
  },
  { request_id: '3' },
);
callCompleted('load_cards', '3', 36, loaded(CARDS_TABLE, CARD_COLUMNS));

const cardsProcessRationale = 'Project the card columns needed to compare statuses.';
mcp(200, '4', { duration_ms: 18 });
callStarted({
  tool: 'process_data',
  args: {
    table_name: CARDS_TABLE,
    cols: ['id', 'last4', 'status', 'spending_limit_cents'],
    rationale: cardsProcessRationale,
  },
  rationale: cardsProcessRationale,
  scopes: [],
  requestId: '4',
});
declared('process_data', cardsProcessRationale, '4');
emit(
  'etl.processed',
  {
    table: CARDS_TABLE,
    rows: CARDS.length,
    columns_advertised: [...CARD_COLUMNS],
    columns_selected: ['id', 'last4', 'status', 'spending_limit_cents'],
    duration_ms: 6,
  },
  { request_id: '4' },
);
callCompleted('process_data', '4', 10, toolText(processedTableText(CARDS_TABLE)));

const cardsQuerySql =
  'SELECT "last4", "status", "spending_limit_cents" FROM "load_cards_51e8a3b6" ORDER BY "status" ASC';
const cardsQueryRationale = 'Show every card with its status after the restart.';
mcp(200, '5', { duration_ms: 16 });
callStarted({
  tool: 'execute_query',
  args: {
    table_name: CARDS_TABLE,
    query: cardsQuerySql,
    rationale: cardsQueryRationale,
  },
  rationale: cardsQueryRationale,
  scopes: [],
  requestId: '5',
});
declared('execute_query', cardsQueryRationale, '5');
emit(
  'sql.query',
  {
    table: CARDS_TABLE,
    sql: cardsQuerySql,
    rows_returned: CARDS.length,
    capped: false,
    duration_ms: 2,
  },
  { request_id: '5' },
);
callCompleted('execute_query', '5', 7, toolText(toJson(CARDS)));

// ---------------------------------------------------------------------------
// Check what T7b promises, then write it out
// ---------------------------------------------------------------------------

const cut: number[] = [];
for (const event of events) {
  if (event.type !== 'tool.call.completed' || event.data.text_preview === null) continue;
  const preview = event.data.text_preview ?? '';
  if (preview.endsWith(RESULT_PREVIEW_TRUNCATION_SUFFIX)) {
    cut.push(event.id);
    const chars = event.data.content_chars;
    if (preview.length !== RESULT_PREVIEW_BYTES + RESULT_PREVIEW_TRUNCATION_SUFFIX.length) {
      throw new Error(`event ${event.id}: a cut preview must be ${RESULT_PREVIEW_BYTES} characters plus the marker`);
    }
    if (event.data.is_error || chars < 8_400 || chars > 8_499) {
      throw new Error(`event ${event.id}: the cut result must be a successful 8,4xx-character one, not ${chars}`);
    }
  } else if (preview.length !== event.data.content_chars) {
    throw new Error(`event ${event.id}: a whole preview must be exactly content_chars long`);
  }
}
if (cut.length !== 1) throw new Error(`expected exactly one cut preview, found ${cut.length}`);
if (events.length !== 200) throw new Error(`expected 200 events, built ${events.length}`);

const target = fileURLToPath(new URL('events.jsonl', import.meta.url));
writeFileSync(target, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

const byType = new Map<string, number>();
for (const event of events) byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
console.log(`wrote ${events.length} events to ${target}`);
console.log(`distinct event types: ${byType.size}`);
console.log(
  [...byType.entries()]
    .sort((left, right) => (left[0] < right[0] ? -1 : 1))
    .map(([type, count]) => `  ${type}: ${count}`)
    .join('\n'),
);
