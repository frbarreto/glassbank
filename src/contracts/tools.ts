/**
 * The tool catalog (block: contracts).
 *
 * The single source of truth for the 17 tools of v1 (docs/TOOL_CATALOG.md section 3), the
 * conventions of section 1 and the ETL protocol strings of section 6. Frozen at the T0.5 gate
 * and append-only afterwards.
 *
 * ADR-8 is why every entry carries **two** schemas:
 *   - `publishedInputSchema` is the raw JSON Schema advertised in `tools/list`. `rationale` is
 *     in its `required` list, with Ramp's exact description, `minLength` 1 and `maxLength` 1024.
 *     `src/mcp` registers tools from this object, bypassing the SDK's automatic zod validation
 *     (which would answer `-32602` before any handler ran).
 *   - `lenientInputSchema` is what `src/tools` actually validates with. `rationale` is optional
 *     there and over-long values are truncated to 1024 characters; a missing rationale never
 *     fails a call, it emits `intent.missing` (A-06).
 *
 * Pure data and pure functions. No I/O.
 */
import { z } from 'zod';

import type { AuthContext, Pairing } from './auth.js';
import type { BankCore, ScratchDb } from './bank.js';
import type { XrayEmitter } from './events.js';
import type { ToolAvailability } from './events.js';
import type { FeatureFlag, GrantView, Scope, ScopedTool } from './scopes.js';
import { buildScopeToTools } from './scopes.js';

// ---------------------------------------------------------------------------
// Shared description fragments (docs/TOOL_CATALOG.md section 1)
// ---------------------------------------------------------------------------

/** Ramp's exact wording for the intent argument; reproduced verbatim (ADR-8, A-38). */
export const RATIONALE_DESCRIPTION =
  'Briefly explain why you are calling this tool: what goal or workflow it serves and what you intend to do with the result';

export const RATIONALE_MIN_LENGTH = 1;
export const RATIONALE_MAX_LENGTH = 1024;

/** Ramp's `AMOUNT_DESCRIPTION`, with the USD example of Decision D-1. */
export const AMOUNT_DESCRIPTION =
  'The amount is an integer in smallest denomination to avoid precision loss. So 1000 refers to 1000 cents or $10.00';

/** Every date parameter says this. Dates are constructed in UTC (CLAUDE.md "Do"). */
export const DATE_FORMAT_DESCRIPTION = 'Format YYYY-MM-DD, interpreted in UTC.';

export const FROM_DATE_DESCRIPTION =
  `First day of the period, inclusive. ${DATE_FORMAT_DESCRIPTION}` as const;

/** Ramp's +1-day rule, spelled out so the model does not shift the window itself. */
export const TO_DATE_DESCRIPTION =
  `Last day of the period, inclusive: the server adds one day in UTC internally, so an item dated on this day is included. ${DATE_FORMAT_DESCRIPTION}` as const;

/** Ramp's `""`-means-null convention, repeated on every optional enum. */
export const EMPTY_ENUM_DESCRIPTION =
  'Pass an empty string "" to apply no filter on this field.' as const;

/** Every load tool ends its description with this, so the model expects a table, not rows. */
export const LOAD_TOOL_SUFFIX =
  'Returns the scratch table name and the columns available on it, never the rows themselves: call process_data and then execute_query to read the data.' as const;

// ---------------------------------------------------------------------------
// The ETL protocol strings (docs/TOOL_CATALOG.md section 6, copied from Ramp)
// ---------------------------------------------------------------------------

/** What a `load_*` tool returns on success. Columns are the union of keys across all rows. */
export function loadResultText(input: {
  readonly table_name: string;
  readonly columns: readonly string[];
}): string {
  return (
    `Stored data in memory database with table name: ${input.table_name}.\n` +
    ' Call `process_data` tool with table name and desired columns to setup a SQL table.\n' +
    ' Call `execute_query` tool with query to get results as a JSON.\n' +
    ` Available columns are: ${input.columns.join(', ')}\n` +
    ' Call `clear_table` tool with table name to delete the table from the memory database.'
  );
}

export const NO_DATA_FOUND = 'No data found';

export function processedTableText(tableName: string): string {
  return `Table ${tableName} created`;
}

export function clearedTableText(tableName: string): string {
  return `Table ${tableName} cleared`;
}

/** The 100-row cap message (hosted Ramp wording). */
export function rowCapMessage(cap: number): string {
  return `Query returned more than ${cap} rows: add filters and retry`;
}

export const TOO_MANY_TABLES_MESSAGE =
  'too many tables loaded: ask the agent to drop unused tables';
export const ETL_OPERATION_LIMIT_MESSAGE = 'ETL operation limit reached';

/**
 * Ramp's tool-error wording. Returned as `isError: true` content, never as a JSON-RPC error
 * (A-08); protocol codes stay reserved for malformed JSON-RPC.
 */
export function toolErrorText(message: string): string {
  return `Ran into an error: ${message}. Communicate this to the user and consider retrying if the error seems transient.`;
}

/** The knob defaults of docs/DEPLOYMENT.md section 3 that tool handlers care about. */
export const TOOL_LIMIT_DEFAULTS = {
  maxTablesPerGrant: 10,
  maxScratchDbs: 200,
  maxQueryRows: 100,
  tableTtlMinutes: 30,
  queryTimeoutMs: 2000,
  maxConcurrentEtlOps: 2,
  etlWorkerPoolSize: 4,
} as const;

// ---------------------------------------------------------------------------
// JSON Schema (the published half of ADR-8)
// ---------------------------------------------------------------------------

export type JsonSchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';

/** The subset of JSON Schema this catalog uses. Hand-written: the published shape is the contract. */
export interface JsonSchemaNode {
  readonly type?: JsonSchemaType;
  readonly description?: string;
  readonly enum?: readonly (string | number | boolean)[];
  readonly items?: JsonSchemaNode;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly default?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
}

/** An `inputSchema` as published in `tools/list`. */
export interface PublishedInputSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, JsonSchemaNode>>;
  /** Always contains `rationale` (ADR-8). */
  readonly required: readonly string[];
}

/** The published `rationale` property: required, 1..1024, Ramp's description verbatim. */
export const PUBLISHED_RATIONALE_PROPERTY: JsonSchemaNode = {
  type: 'string',
  description: RATIONALE_DESCRIPTION,
  minLength: RATIONALE_MIN_LENGTH,
  maxLength: RATIONALE_MAX_LENGTH,
};

function published(
  properties: Readonly<Record<string, JsonSchemaNode>> = {},
  required: readonly string[] = [],
): PublishedInputSchema {
  return {
    type: 'object',
    properties: { ...properties, rationale: PUBLISHED_RATIONALE_PROPERTY },
    required: [...required, 'rationale'],
  };
}

// ---------------------------------------------------------------------------
// The lenient server-side schema (the other half of ADR-8)
// ---------------------------------------------------------------------------

/**
 * `rationale` as the server validates it: optional, truncated to 1024 characters, and never a
 * validation error - a value of the wrong type becomes `undefined` and the call still runs,
 * which is what makes `intent.missing` possible instead of Ramp's HTTP 422.
 */
export const LENIENT_RATIONALE = z.preprocess(
  (value) => (typeof value === 'string' ? value.slice(0, RATIONALE_MAX_LENGTH) : undefined),
  z.string().optional(),
);

function lenient<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...shape, rationale: LENIENT_RATIONALE });
}

/** True when the incoming value would be shortened by the lenient schema. */
export function isRationaleTruncated(value: unknown): boolean {
  return typeof value === 'string' && value.length > RATIONALE_MAX_LENGTH;
}

/** True when the call carried no usable rationale, so `intent.missing` must be emitted. */
export function isRationaleMissing(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

/** Why a rationale was missing, for `intent.missing.data.reason`. */
export function rationaleMissingReason(value: unknown): 'absent' | 'empty' | 'wrong_type' {
  if (value === undefined || value === null) return 'absent';
  if (typeof value !== 'string') return 'wrong_type';
  return 'empty';
}

// ---------------------------------------------------------------------------
// The catalog entry
// ---------------------------------------------------------------------------

/** Which group a tool belongs to, for the dashboard's possibility-space panel. */
export type ToolKind = 'database' | 'fetch' | 'meta' | 'load' | 'write' | 'xray';

/**
 * MCP annotations. Exactly one of `readOnlyHint` and `destructiveHint` is `true`, never both and
 * never neither; `idempotentHint` and `openWorldHint` are set explicitly on every tool.
 */
export interface ToolAnnotations {
  readonly title: string;
  readonly readOnlyHint?: true;
  readonly destructiveHint?: true;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
}

/** Ramp's `agent-tool.json` extension fields, carried through so the dashboard can show them. */
export interface RampToolMetadata {
  /** Tri-state: `true` touches nothing mutable, `partial` mutates only the caller's scratch
   * database, `false` mutates bank state (A-07). */
  readonly 'x-read-only': true | false | 'partial';
  readonly 'x-destructive': boolean;
  /** Feature flags that gate the tool; empty when it is always on. */
  readonly 'x-gated-by': readonly FeatureFlag[];
}

/** One tool, completely. `ScopedTool` is the slice the listing rule of ADR-13 works on. */
export interface ToolCatalogEntry extends ScopedTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly annotations: ToolAnnotations;
  /** Every scope a successful call needs. Read scopes hide the tool, write scopes do not. */
  readonly requiredScopes: readonly Scope[];
  readonly featureFlags: readonly FeatureFlag[];
  readonly metadata: RampToolMetadata;
  /**
   * Argument leaf keys that the X-ray emitter replaces with `[redacted]` at any depth, matched
   * case-insensitively. Never an allow-list: everything else is stored verbatim, because all the
   * data is fake and the brief asks for "with which arguments"
   * (docs/XRAY_EVENT_MODEL.md section 3). May be empty.
   */
  readonly redactionDenyList: readonly string[];
  /** Advertised in `tools/list`; `rationale` is in `required` (ADR-8). */
  readonly publishedInputSchema: PublishedInputSchema;
  /** Used by `src/tools` to validate; `rationale` is optional and truncated (ADR-8). */
  readonly lenientInputSchema: z.ZodType;
}

/**
 * The `tools/list` entry for one catalog entry: the published schema verbatim and Ramp's metadata
 * under `_meta`. Shared by `src/mcp/transport.ts` (the response) and `catalogRowsOf` in
 * `src/mcp/xray.ts` (the `catalog.tools_listed` record), so the record can never drift from the wire.
 */
export function publishedToolDescriptor(entry: ToolCatalogEntry): {
  name: string;
  title: string;
  description: string;
  inputSchema: PublishedInputSchema;
  annotations: ToolAnnotations;
  _meta: Record<string, unknown>;
} {
  return {
    name: entry.name,
    title: entry.title,
    description: entry.description,
    inputSchema: entry.publishedInputSchema,
    annotations: entry.annotations,
    _meta: {
      'x-read-only': entry.metadata['x-read-only'],
      'x-destructive': entry.metadata['x-destructive'],
      'x-gated-by': entry.metadata['x-gated-by'],
      'x-required-scopes': entry.requiredScopes,
      'x-kind': entry.kind,
    },
  };
}

/** The value the emitter substitutes for a denied field. */
export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * The global pattern deny-list applied to every argument value, on top of the per-tool list:
 * anything that looks like a bearer token, a JWT or an access token of this server.
 */
export const GLOBAL_REDACTION_PATTERNS: readonly RegExp[] = [
  /mockbank_user_tok_[A-Za-z0-9._-]+/,
  /\beyJ[A-Za-z0-9._-]{20,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i,
];

/** Fields that carry a full account or routing number if a model ever invents them. */
const ACCOUNT_NUMBER_FIELDS = ['account_number', 'routing_number', 'iban', 'swift'] as const;
/** Fields that carry full card data if a model ever invents them. */
const CARD_NUMBER_FIELDS = ['card_number', 'pan', 'cvv', 'cvc', 'pin'] as const;

// ---------------------------------------------------------------------------
// The 17 tools (docs/TOOL_CATALOG.md section 3)
// ---------------------------------------------------------------------------

const TABLE_NAME_DESCRIPTION =
  'Name of the scratch table, exactly as returned by the load_* tool that created it.';

export const PROCESS_DATA: ToolCatalogEntry = {
  name: 'process_data',
  title: 'Build a SQL table from loaded data',
  kind: 'database',
  description:
    'Projects the raw JSON a load_* tool stored onto a real SQL table in your own scratch database: it flattens nested keys with a double underscore, infers INTEGER, REAL or TEXT column types and creates the table. ' +
    'Use it after any load_* tool and before execute_query, selecting only the columns you actually need from the advertised column list. ' +
    'Do not use it to fetch data (that is what the load_* tools do), and do not call it for a table you have not loaded or for a column that was not advertised: both are errors. ' +
    'There is no alternative: data that has not been processed cannot be queried.',
  annotations: {
    title: 'Build a SQL table from loaded data',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: [],
  featureFlags: [],
  metadata: { 'x-read-only': 'partial', 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(
    {
      table_name: { type: 'string', description: TABLE_NAME_DESCRIPTION },
      cols: {
        type: 'array',
        description:
          'The columns to project, taken from the "Available columns are:" list of the load_* result. Nested keys are joined with a double underscore, for example merchant__name. Selecting fewer columns makes the table smaller and the queries faster.',
        items: { type: 'string', description: 'One advertised column name.' },
      },
    },
    ['table_name', 'cols'],
  ),
  lenientInputSchema: lenient({
    table_name: z.string().min(1),
    cols: z.array(z.string().min(1)).min(1),
  }),
};

export const EXECUTE_QUERY: ToolCatalogEntry = {
  name: 'execute_query',
  title: 'Run a read-only SQL query',
  kind: 'database',
  description:
    'Runs one read-only SQLite SELECT statement against your own scratch database and returns the rows as JSON. ' +
    'Use it after process_data to filter, join, aggregate and rank the data you loaded; window functions are supported and encouraged, and every calculation should be done in SQL rather than by hand so the numbers are exact. ' +
    "Do not use it to change data or to reach anything you have not loaded: INSERT, UPDATE, DELETE, DROP, CREATE, ATTACH, DETACH, PRAGMA, VACUUM and multi-statement input are rejected, and the query runs only against this session's own tables. " +
    'At most 100 rows come back; if the result is larger, add filters, aggregate, or use LIMIT and retry.',
  annotations: {
    title: 'Run a read-only SQL query',
    readOnlyHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requiredScopes: [],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(
    {
      table_name: {
        type: 'string',
        description:
          'The scratch table the query reads, exactly as returned by the load_* tool. The table must already have been processed with process_data.',
      },
      query: {
        type: 'string',
        description:
          'One SQLite SELECT statement. Read-only: no INSERT, UPDATE, DELETE, DROP, CREATE, ATTACH, DETACH, PRAGMA or VACUUM, and one statement only. Quote identifiers with double quotes. At most 100 rows are returned.',
      },
    },
    ['table_name', 'query'],
  ),
  lenientInputSchema: lenient({
    table_name: z.string().min(1),
    query: z.string().min(1),
  }),
};

export const CLEAR_TABLE: ToolCatalogEntry = {
  name: 'clear_table',
  title: 'Drop a scratch table',
  kind: 'database',
  description:
    'Drops one table from your scratch database and forgets it. ' +
    'Use it as soon as you have finished with a table, so the per-session table budget stays free for the next load. ' +
    'Do not use it to undo a bank operation: it removes analysis data only and never changes an account, a card or a transfer. ' +
    'Calling it for a table that does not exist is an error, so clear a table once.',
  annotations: {
    title: 'Drop a scratch table',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: [],
  featureFlags: [],
  metadata: { 'x-read-only': 'partial', 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(
    { table_name: { type: 'string', description: TABLE_NAME_DESCRIPTION } },
    ['table_name'],
  ),
  lenientInputSchema: lenient({ table_name: z.string().min(1) }),
};

export const GET_BANK_CATEGORIES: ToolCatalogEntry = {
  name: 'get_bank_categories',
  title: 'List merchant categories',
  kind: 'fetch',
  description:
    "Returns the bank's merchant categories: the id and the name of every category used to classify card transactions. " +
    'Use it to turn the category_id column of a transaction into a readable name, or to build the category_ids filter of load_transactions. ' +
    'Do not use it to get spending per category: load the transactions and aggregate them with execute_query. ' +
    'This is reference data, so no bank record is read and no scope is needed.',
  annotations: {
    title: 'List merchant categories',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: [],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(),
  lenientInputSchema: lenient({}),
};

export const GET_CURRENCIES: ToolCatalogEntry = {
  name: 'get_currencies',
  title: 'List supported currencies',
  kind: 'fetch',
  description:
    'Returns the currencies this bank supports, each with its ISO 4217 code, name, symbol and number of minor-unit digits. USD comes first and is the currency of every demo account. ' +
    'Use it to check that a currency is supported before calling create_transfer, or to format an amount correctly for the user. ' +
    'Do not use it for exchange rates: this bank does not quote them, and it does not convert between currencies.',
  annotations: {
    title: 'List supported currencies',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: [],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(),
  lenientInputSchema: lenient({}),
};

export const GET_CURRENT_USER: ToolCatalogEntry = {
  name: 'get_current_user',
  title: 'Show the connected demo customer',
  kind: 'fetch',
  description:
    'Returns who this connection belongs to: the persona id, name and kind, whether that persona is a shared demo identity, the scopes and authorization level of the current grant, when the access token expires, the current X-ray session id and the server boot id. ' +
    'Use it at the start of a conversation to tell the user which demo customer they are connected as, and whenever a write seems to have been undone - a different boot id means the server restarted and in-memory bank changes were lost. ' +
    'Do not use it as a permission check before another call: call the tool you need and handle its error, or call get_tool_availability for the full picture. ' +
    'The per_ id it returns is what the login page accepts to recover a generated persona later.',
  annotations: {
    title: 'Show the connected demo customer',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['profile'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(),
  lenientInputSchema: lenient({}),
};

export const GET_TOOL_AVAILABILITY: ToolCatalogEntry = {
  name: 'get_tool_availability',
  title: 'Explain which tools are usable',
  kind: 'meta',
  description:
    'Returns the availability table for every tool of this server: whether the tool was listed, whether a call would succeed, and, when it would not, the reason (a missing scope, a read-only grant, or a feature disabled for this deployment) together with the exact scopes still needed. ' +
    'Use it after an authorization error, or before proposing a write to the user, so you can explain precisely what this connection is allowed to do and what re-authorizing would add. ' +
    'Do not use it to discover tool names or parameters: the tools/list result already carries those, and a tool can be listed and still unavailable.',
  annotations: {
    title: 'Explain which tools are usable',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['profile'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(),
  lenientInputSchema: lenient({}),
};

export const LOAD_ACCOUNTS: ToolCatalogEntry = {
  name: 'load_accounts',
  title: 'Load bank accounts',
  kind: 'load',
  description:
    "Loads the customer's bank accounts - checking, savings and credit card - with their balances into a scratch table. " +
    'Use it for any question about balances, account types, credit limits or the last four digits of an account number, then call process_data and execute_query to answer it. ' +
    'Do not use it for individual purchases or payments: those are load_transactions, and money the customer sent is load_transfers. ' +
    `Balances are integers in USD cents (${AMOUNT_DESCRIPTION.toLowerCase()}). ${LOAD_TOOL_SUFFIX}`,
  annotations: {
    title: 'Load bank accounts',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['accounts:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [...ACCOUNT_NUMBER_FIELDS],
  publishedInputSchema: published({
    account_id: {
      type: 'string',
      description:
        'Load one account only, by its acc_ id. Omit it to load every account of the customer.',
    },
    account_type: {
      type: 'string',
      description: `Only accounts of this type. ${EMPTY_ENUM_DESCRIPTION}`,
      enum: ['checking', 'savings', 'credit_card', ''],
      default: '',
    },
  }),
  lenientInputSchema: lenient({
    account_id: z.string().min(1).optional(),
    account_type: z.enum(['checking', 'savings', 'credit_card', '']).default(''),
  }),
};

export const LOAD_TRANSACTIONS: ToolCatalogEntry = {
  name: 'load_transactions',
  title: 'Load card and account transactions',
  kind: 'load',
  description:
    "Loads the customer's card purchases and account postings for a date range into a scratch table, sorted by amount descending. " +
    'Use it for spending questions - how much was spent, what was bought at a merchant, which purchases were the largest, what was declined - optionally narrowed to one account, one card, a set of categories or a status. ' +
    'Do not use it for money the customer sent or received as a transfer (load_transfers) or for invoices that are due (load_bills); when a question mixes purchases, transfers and bills, prefer load_statement_lines, which returns all three in one table. ' +
    `Amounts are integers in USD cents and negative for money leaving the account (${AMOUNT_DESCRIPTION.toLowerCase()}). ${LOAD_TOOL_SUFFIX}`,
  annotations: {
    title: 'Load card and account transactions',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['transactions:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [...CARD_NUMBER_FIELDS],
  publishedInputSchema: published(
    {
      from_date: { type: 'string', description: FROM_DATE_DESCRIPTION },
      to_date: { type: 'string', description: TO_DATE_DESCRIPTION },
      account_id: {
        type: 'string',
        description: 'Only transactions on this acc_ account. Omit it to include every account.',
      },
      card_id: {
        type: 'string',
        description:
          'Only transactions made with this card_ card. Omit it to include card and non-card postings alike.',
      },
      category_ids: {
        type: 'array',
        description:
          'Only transactions in these merchant categories, by category id from get_bank_categories. Pass an empty array to apply no category filter.',
        items: { type: 'string', description: 'A merchant category id.' },
        default: [],
      },
      status: {
        type: 'string',
        description: `Only transactions in this state. ${EMPTY_ENUM_DESCRIPTION}`,
        enum: ['pending', 'posted', 'declined', ''],
        default: '',
      },
    },
    ['from_date', 'to_date'],
  ),
  lenientInputSchema: lenient({
    from_date: z.string().min(1),
    to_date: z.string().min(1),
    account_id: z.string().min(1).optional(),
    card_id: z.string().min(1).optional(),
    category_ids: z.array(z.string()).default([]),
    status: z.enum(['pending', 'posted', 'declined', '']).default(''),
  }),
};

export const LOAD_CARDS: ToolCatalogEntry = {
  name: 'load_cards',
  title: 'Load payment cards',
  kind: 'load',
  description:
    "Loads the customer's payment cards into a scratch table: the cardholder name, the last four digits, the status (active, locked or fraud_locked), the spending limit and the account each card belongs to. " +
    'Use it before answering any question about cards, and always before calling lock_or_unlock_card, so you can name the card by its last four digits and check whether it is already locked. ' +
    'Do not use it to see what was bought on a card: that is load_transactions filtered by card_id. ' +
    `Limits are integers in USD cents. ${LOAD_TOOL_SUFFIX}`,
  annotations: {
    title: 'Load payment cards',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['cards:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [...CARD_NUMBER_FIELDS],
  publishedInputSchema: published({
    account_id: {
      type: 'string',
      description: 'Only cards issued on this acc_ account. Omit it to load every card.',
    },
    status: {
      type: 'string',
      description: `Only cards in this state. A fraud_locked card was locked by the bank and cannot be unlocked with lock_or_unlock_card. ${EMPTY_ENUM_DESCRIPTION}`,
      enum: ['active', 'locked', 'fraud_locked', ''],
      default: '',
    },
  }),
  lenientInputSchema: lenient({
    account_id: z.string().min(1).optional(),
    status: z.enum(['active', 'locked', 'fraud_locked', '']).default(''),
  }),
};

export const LOAD_TRANSFERS: ToolCatalogEntry = {
  name: 'load_transfers',
  title: 'Load transfers',
  kind: 'load',
  description:
    'Loads money the customer sent or received for a date range into a scratch table: the amount, the fee, the rail (ACH, wire or an internal move between their own accounts), the counterparty and the status. ' +
    'Use it for questions such as whether a transfer went through, what was sent last month, or which transfers failed. ' +
    'Do not use it for card purchases (load_transactions) or for invoices that have not been paid yet (load_bills); when a question mixes them, prefer load_statement_lines. ' +
    `Amounts are integers in USD cents. ${LOAD_TOOL_SUFFIX}`,
  annotations: {
    title: 'Load transfers',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['transfers:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [...ACCOUNT_NUMBER_FIELDS],
  publishedInputSchema: published(
    {
      from_date: { type: 'string', description: FROM_DATE_DESCRIPTION },
      to_date: { type: 'string', description: TO_DATE_DESCRIPTION },
      direction: {
        type: 'string',
        description: `Only transfers in this direction: outgoing is money leaving the customer's accounts, incoming is money arriving. ${EMPTY_ENUM_DESCRIPTION}`,
        enum: ['outgoing', 'incoming', ''],
        default: '',
      },
      status: {
        type: 'string',
        description: `Only transfers in this state. ${EMPTY_ENUM_DESCRIPTION}`,
        enum: ['scheduled', 'completed', 'failed', ''],
        default: '',
      },
    },
    ['from_date', 'to_date'],
  ),
  lenientInputSchema: lenient({
    from_date: z.string().min(1),
    to_date: z.string().min(1),
    direction: z.enum(['outgoing', 'incoming', '']).default(''),
    status: z.enum(['scheduled', 'completed', 'failed', '']).default(''),
  }),
};

export const LOAD_BILLS: ToolCatalogEntry = {
  name: 'load_bills',
  title: 'Load bills',
  kind: 'load',
  description:
    "Loads the customer's bills by due date into a scratch table: the payee, the amount, the due date, the account the bill is paid from and whether it is open, paid or overdue. " +
    'Use it for questions about what is owed, what is overdue, and what falls due in a period. ' +
    'Do not use it to pay a bill: this version of the bank has no bill-payment tool, so say so instead of attempting a transfer. Do not use it for purchases (load_transactions) or for completed transfers (load_transfers); prefer load_statement_lines when a question mixes them. ' +
    `Amounts are integers in USD cents. ${LOAD_TOOL_SUFFIX}`,
  annotations: {
    title: 'Load bills',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['bills:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(
    {
      from_date: {
        type: 'string',
        description: `First due date to include, inclusive. ${DATE_FORMAT_DESCRIPTION}`,
      },
      to_date: {
        type: 'string',
        description: `Last due date to include, inclusive: the server adds one day in UTC internally, so a bill due on this day is included. ${DATE_FORMAT_DESCRIPTION}`,
      },
      payment_status: {
        type: 'string',
        description: `Only bills in this state. Overdue means open and past the due date. ${EMPTY_ENUM_DESCRIPTION}`,
        enum: ['open', 'paid', 'overdue', ''],
        default: '',
      },
    },
    ['from_date', 'to_date'],
  ),
  lenientInputSchema: lenient({
    from_date: z.string().min(1),
    to_date: z.string().min(1),
    payment_status: z.enum(['open', 'paid', 'overdue', '']).default(''),
  }),
};

export const LOAD_PAYEES: ToolCatalogEntry = {
  name: 'load_payees',
  title: 'Load saved payees',
  kind: 'load',
  description:
    "Loads the customer's saved beneficiaries into a scratch table: the payee name, the bank, the rail and a masked account number. Full account details never leave the bank. " +
    'Use it before create_transfer to find the payee_id the user means, and to confirm the payee back to them by name and masked number. ' +
    'Do not use it to look up a merchant a card was used at: merchants come from load_transactions. ' +
    `By default only active payees are loaded. ${LOAD_TOOL_SUFFIX}`,
  annotations: {
    title: 'Load saved payees',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['payees:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [...ACCOUNT_NUMBER_FIELDS],
  publishedInputSchema: published({
    name: {
      type: 'string',
      description:
        'Only payees whose name contains this text, matched case-insensitively. Omit it to load every payee.',
    },
    is_active: {
      type: 'boolean',
      description:
        'Load active payees (true, the default) or archived ones (false). Archived payees cannot receive a transfer.',
      default: true,
    },
  }),
  lenientInputSchema: lenient({
    name: z.string().min(1).optional(),
    is_active: z.boolean().default(true),
  }),
};

export const LOAD_STATEMENT_LINES: ToolCatalogEntry = {
  name: 'load_statement_lines',
  title: 'Load a combined statement',
  kind: 'load',
  description:
    'Loads the flat union of transactions, transfers and bills for a date range into one scratch table, with a source column saying which of the three each row came from. ' +
    'Always use this over load_transactions, load_transfers, load_bills when possible: one table answers any question that mixes purchases, transfers and bills, and it costs one load instead of three. ' +
    'Use the individual load tools only when you need a filter this one does not have: a merchant category, a specific card, a transfer direction or a payment status. ' +
    `This tool needs the transactions, transfers and bills read scopes together; if any of them is missing it is not listed. Amounts are integers in USD cents and negative for money out. ${LOAD_TOOL_SUFFIX}`,
  annotations: {
    title: 'Load a combined statement',
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['transactions:read', 'transfers:read', 'bills:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [...ACCOUNT_NUMBER_FIELDS, ...CARD_NUMBER_FIELDS],
  publishedInputSchema: published(
    {
      from_date: { type: 'string', description: FROM_DATE_DESCRIPTION },
      to_date: { type: 'string', description: TO_DATE_DESCRIPTION },
    },
    ['from_date', 'to_date'],
  ),
  lenientInputSchema: lenient({
    from_date: z.string().min(1),
    to_date: z.string().min(1),
  }),
};

export const LOCK_OR_UNLOCK_CARD: ToolCatalogEntry = {
  name: 'lock_or_unlock_card',
  title: 'Lock or unlock a card',
  kind: 'write',
  description:
    "Locks or unlocks one of the customer's payment cards and appends an entry to the bank audit log. This changes the customer's account. " +
    "Use it when the user explicitly asks to freeze, block, lock, unlock or reactivate a card; load_cards first, quote the card by its last four digits, and get the user's explicit approval before calling. " +
    'Do not use it to cancel or replace a card, to dispute a transaction or to change a spending limit: none of those exist in this version. A card whose status is fraud_locked was locked by the bank and cannot be unlocked here; say that the fraud team has to release it. ' +
    'Locking a card that is already locked is harmless and changes nothing.',
  annotations: {
    title: 'Lock or unlock a card',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  requiredScopes: ['cards:write'],
  featureFlags: ['writes'],
  metadata: { 'x-read-only': false, 'x-destructive': true, 'x-gated-by': ['writes'] },
  redactionDenyList: [...CARD_NUMBER_FIELDS],
  publishedInputSchema: published(
    {
      card_id: {
        type: 'string',
        description: 'The card_ id of the card to change, from load_cards.',
      },
      action: {
        type: 'string',
        description:
          'What to do: "lock" freezes the card so new purchases are declined, "unlock" makes it usable again.',
        enum: ['lock', 'unlock'],
      },
    },
    ['card_id', 'action'],
  ),
  lenientInputSchema: lenient({
    card_id: z.string().min(1),
    action: z.enum(['lock', 'unlock']),
  }),
};

export const CREATE_TRANSFER: ToolCatalogEntry = {
  name: 'create_transfer',
  title: 'Preview and send a transfer',
  kind: 'write',
  description:
    "Moves money from one of the customer's accounts to a saved payee or to another of their own accounts. This changes the customer's account and happens in two steps. " +
    'Use it when the user asks to send money, pay a saved payee, move funds between their own accounts, or transfer a specific amount; do not use it to pay a bill from load_bills, because this version has no bill-payment tool. ' +
    "First call it WITHOUT confirm: nothing moves and you get a preview with the amount, the fee, the total, the resulting balance, how the transfer sits against the customer's limits, and an expected_total_amount. Show that preview to the user and ask for explicit approval. " +
    'Then call it again with confirm set to true and the expected_total_amount copied from the preview; the transfer executes and an audit entry is appended. It is rejected if the total changed since the preview, if the funds are insufficient, or if the amount is over the per-transfer limit. ' +
    "Never set confirm to true on the first call, and never confirm without the user's explicit approval in this conversation. " +
    `Use load_accounts to choose the source account and load_payees to choose the destination. ${AMOUNT_DESCRIPTION}.`,
  annotations: {
    title: 'Preview and send a transfer',
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requiredScopes: ['transfers:write'],
  featureFlags: ['writes', 'transfers'],
  metadata: { 'x-read-only': false, 'x-destructive': true, 'x-gated-by': ['writes', 'transfers'] },
  redactionDenyList: [...ACCOUNT_NUMBER_FIELDS, ...CARD_NUMBER_FIELDS],
  publishedInputSchema: published(
    {
      from_account_id: {
        type: 'string',
        description: 'The acc_ id of the account the money leaves, from load_accounts.',
      },
      to: {
        type: 'object',
        description:
          'Where the money goes. Exactly one of payee_id (a saved beneficiary from load_payees) or account_id (another account of the same customer from load_accounts).',
        oneOf: [
          {
            type: 'object',
            properties: {
              payee_id: {
                type: 'string',
                description: 'The pay_ id of a saved, active payee.',
              },
            },
            required: ['payee_id'],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              account_id: {
                type: 'string',
                description: 'The acc_ id of another account belonging to the same customer.',
              },
            },
            required: ['account_id'],
            additionalProperties: false,
          },
        ],
      },
      amount: {
        type: 'integer',
        description: `How much to move, before any fee. ${AMOUNT_DESCRIPTION}`,
        minimum: 1,
      },
      currency: {
        type: 'string',
        description:
          'ISO 4217 currency code of the transfer, for example "USD". Call get_currencies for the supported list; the demo accounts are funded in USD.',
        pattern: '^[A-Z]{3}$',
      },
      memo: {
        type: 'string',
        description:
          'A short note stored with the transfer and shown on the statement. Optional; keep it under 140 characters.',
        maxLength: 140,
      },
      confirm: {
        type: 'boolean',
        description:
          'Leave false (the default) to get a preview and move no money. Set it to true only on a second call, after the user has explicitly approved the preview.',
        default: false,
      },
      expected_total_amount: {
        type: 'integer',
        description: `The total (amount plus fee) copied verbatim from the preview you showed the user. Required when confirm is true; the transfer is rejected if the real total no longer matches, so the user never approves one number and pays another. ${AMOUNT_DESCRIPTION}`,
        minimum: 1,
      },
    },
    ['from_account_id', 'to', 'amount', 'currency'],
  ),
  lenientInputSchema: lenient({
    from_account_id: z.string().min(1),
    to: z.union([
      z.object({ payee_id: z.string().min(1) }),
      z.object({ account_id: z.string().min(1) }),
    ]),
    amount: z.int().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    memo: z.string().max(140).optional(),
    confirm: z.boolean().default(false),
    expected_total_amount: z.int().positive().optional(),
  }),
};

export const XRAY_GET_SESSION_LINK: ToolCatalogEntry = {
  name: 'xray_get_session_link',
  title: 'Get the X-ray dashboard link',
  kind: 'xray',
  description:
    "Returns a pairing code and a link to this server's live X-ray dashboard, where the user can watch every HTTP request, tool call, argument, rationale, SQL statement and bank operation of their own session as it happens. " +
    'Use it whenever the user asks what is happening behind the scenes, how this connector works, what the server can see, or wants to watch the session; then show them the link with a short sentence such as "open this to watch what happens behind the scenes". ' +
    'Do not use it to read bank data, and do not paraphrase or shorten the code: the link only works verbatim. ' +
    'The link covers every session of this login, stays valid for 24 hours and can be opened more than once, so a step-up or a reconnect does not need a new link.',
  annotations: {
    title: 'Get the X-ray dashboard link',
    readOnlyHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  requiredScopes: ['xray:read'],
  featureFlags: [],
  metadata: { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] },
  redactionDenyList: [],
  publishedInputSchema: published(),
  lenientInputSchema: lenient({}),
};

/**
 * The catalog in `tools/list` order. Deterministic on purpose: the order feeds `content_hash`
 * and the clients' prompt cache (docs/TOOL_CATALOG.md section 1).
 */
export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  PROCESS_DATA,
  EXECUTE_QUERY,
  CLEAR_TABLE,
  GET_BANK_CATEGORIES,
  GET_CURRENCIES,
  GET_CURRENT_USER,
  GET_TOOL_AVAILABILITY,
  LOAD_ACCOUNTS,
  LOAD_TRANSACTIONS,
  LOAD_CARDS,
  LOAD_TRANSFERS,
  LOAD_BILLS,
  LOAD_PAYEES,
  LOAD_STATEMENT_LINES,
  LOCK_OR_UNLOCK_CARD,
  CREATE_TRANSFER,
  XRAY_GET_SESSION_LINK,
];

/** Every tool name, in catalogue order. */
export const TOOL_NAMES = TOOL_CATALOG.map((entry) => entry.name);

/** The union of the 17 names, so a handler map can be exhaustive. */
export type ToolName =
  | 'process_data'
  | 'execute_query'
  | 'clear_table'
  | 'get_bank_categories'
  | 'get_currencies'
  | 'get_current_user'
  | 'get_tool_availability'
  | 'load_accounts'
  | 'load_transactions'
  | 'load_cards'
  | 'load_transfers'
  | 'load_bills'
  | 'load_payees'
  | 'load_statement_lines'
  | 'lock_or_unlock_card'
  | 'create_transfer'
  | 'xray_get_session_link';

const CATALOG_BY_NAME = new Map(TOOL_CATALOG.map((entry) => [entry.name, entry]));

export function getTool(name: string): ToolCatalogEntry | undefined {
  return CATALOG_BY_NAME.get(name);
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && CATALOG_BY_NAME.has(value);
}

/** Ramp's `scope_to_tools_mapping`, materialised for the 17-tool catalog. */
export const SCOPE_TO_TOOLS: Readonly<Record<Scope, readonly string[]>> =
  buildScopeToTools(TOOL_CATALOG);

/** The write tools, as the dashboard and the step-up challenge need them. */
export const WRITE_TOOL_NAMES: readonly string[] = TOOL_CATALOG.filter(
  (entry) => entry.metadata['x-destructive'],
).map((entry) => entry.name);

// ---------------------------------------------------------------------------
// ToolContext: what a handler is given
// ---------------------------------------------------------------------------

/** The caps a handler must respect, from docs/DEPLOYMENT.md section 3. */
export interface ToolLimits {
  readonly maxTablesPerGrant: number;
  readonly maxQueryRows: number;
  readonly tableTtlMinutes: number;
  readonly queryTimeoutMs: number;
  readonly maxConcurrentEtlOps: number;
  /** claude.ai's per-call limits, echoed onto the X-ray events. */
  readonly contentCharCap: number;
  readonly budgetMs: number;
}

/**
 * Everything a tool handler may touch. `src/app.ts` builds it per request and injects it; a
 * handler has no other way to reach the outside world, which is what makes the whole `tools`
 * block testable against `src/testing/fakes.ts` alone.
 */
export interface ToolContext {
  readonly auth: AuthContext;
  readonly bank: BankCore;
  readonly scratch: ScratchDb;
  readonly xray: XrayEmitter;
  readonly pairing: Pairing;
  readonly featureFlags: readonly FeatureFlag[];
  readonly limits: ToolLimits;
  /** Injected clock; handlers never call `Date.now()` directly, so tests stay deterministic. */
  readonly now: () => Date;
  /** JSON-RPC request id as a string, for correlation. */
  readonly requestId: string | null;
  /** The base URL pairing links are built from (`PUBLIC_BASE_URL`, A-36). */
  readonly publicBaseUrl: string;
}

/** MCP tool result content, as `src/tools` returns it and `src/mcp` forwards it. */
export interface ToolTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolResult {
  readonly content: readonly ToolTextContent[];
  /** True for a tool error; protocol codes stay reserved for malformed JSON-RPC (A-08). */
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

/** Builds the standard tool error result (Ramp's wording plus `isError`). */
export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: toolErrorText(message) }], isError: true };
}

/** Builds a plain text success result. */
export function toolText(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return structuredContent === undefined
    ? { content: [{ type: 'text', text }] }
    : { content: [{ type: 'text', text }], structuredContent };
}

/** A handler is a pure function of its context and validated arguments. */
export type ToolHandler = (
  context: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/** The catalog snapshot a client received, with the hash `catalog.tools_listed` reports. */
export interface ToolCatalogSnapshot {
  readonly content_hash: string;
  readonly listed: readonly ToolCatalogEntry[];
  readonly availability: readonly ToolAvailability[];
  readonly feature_flags: readonly FeatureFlag[];
}

/**
 * What `src/mcp` gets from `src/tools`. The registry owns the listing rule, the availability
 * table and dispatch; the transport owns nothing but the protocol (docs/blocks/mcp.md).
 */
export interface ToolRegistry {
  /** The full catalog, listed or not, in `tools/list` order. */
  readonly catalog: readonly ToolCatalogEntry[];
  /** The entries this grant should see, per ADR-13. */
  listFor(grant: GrantView, flags: readonly FeatureFlag[]): ToolCatalogSnapshot;
  /** Dispatches a call; a missing tool is the caller's `-32601`, everything else is a result. */
  call(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
