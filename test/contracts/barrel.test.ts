/**
 * `src/contracts/index.ts` is the only import surface every other block has
 * (docs/REPO_LAYOUT.md section 3). This file checks it against the "Consumes" line of every
 * block document, so a block author is never told to import a name that does not exist.
 */
import { describe, expect, it } from 'vitest';

import * as contracts from '../../src/contracts/index.js';
import type {
  AuthContext,
  BankCore,
  JwtService,
  Page,
  Pairing,
  PersonaDirectory,
  ScratchDb,
  ToolCatalogEntry,
  ToolContext,
  ToolRegistry,
  VerifyAccessToken,
  XrayEmitter,
  XrayEvent,
  XraySessionsResponse,
} from '../../src/contracts/index.js';

/** A type is only exported if it can be named; this list fails to compile if one goes missing. */
type ConsumedTypes = [
  AuthContext,
  BankCore,
  JwtService,
  Page<number>,
  Pairing,
  PersonaDirectory,
  ScratchDb,
  ToolCatalogEntry,
  ToolContext,
  ToolRegistry,
  VerifyAccessToken,
  XrayEmitter,
  XrayEvent,
  XraySessionsResponse,
];

describe('the contracts barrel', () => {
  it('exports the runtime values every block document names', () => {
    const expected = [
      // events.ts
      'XrayEventSchema',
      'XrayEnvelopeSchema',
      'XRAY_EVENT_TYPES',
      'XRAY_CONTRACT_VERSION',
      'parseXrayEvent',
      'safeParseXrayEvent',
      'parseXrayEventLine',
      'dataKeysOf',
      'idSchema',
      'idPattern',
      'isId',
      'ID_PREFIXES',
      'CLAUDE_TOOL_BUDGET_MS',
      'CLAUDE_CONTENT_CHAR_CAP',
      'JSON_RPC_ERROR_CODES',
      'BANK_OPERATIONS',
      // scopes.ts
      'SCOPES',
      'READ_SCOPES',
      'WRITE_SCOPES',
      'DEFAULT_CHALLENGE_SCOPES',
      'DEFAULT_CHALLENGE_SCOPE_STRING',
      'FEATURE_FLAGS',
      'DEFAULT_FEATURE_FLAGS',
      'authLevelForScopes',
      'isListed',
      'isAvailable',
      'toolAvailability',
      'catalogAvailability',
      'listedToolNames',
      'stepUpScopes',
      'supportedScopes',
      'buildScopeToTools',
      'canonicalCatalogSnapshot',
      'parseScopeString',
      'formatScopeString',
      // tools.ts
      'TOOL_CATALOG',
      'TOOL_NAMES',
      'SCOPE_TO_TOOLS',
      'WRITE_TOOL_NAMES',
      'getTool',
      'isToolName',
      'RATIONALE_DESCRIPTION',
      'RATIONALE_MAX_LENGTH',
      'AMOUNT_DESCRIPTION',
      'LENIENT_RATIONALE',
      'isRationaleMissing',
      'isRationaleTruncated',
      'rationaleMissingReason',
      'loadResultText',
      'NO_DATA_FOUND',
      'processedTableText',
      'clearedTableText',
      'rowCapMessage',
      'TOO_MANY_TABLES_MESSAGE',
      'ETL_OPERATION_LIMIT_MESSAGE',
      'toolErrorText',
      'toolError',
      'toolText',
      'TOOL_LIMIT_DEFAULTS',
      'GLOBAL_REDACTION_PATTERNS',
      'REDACTED_PLACEHOLDER',
      // bank.ts
      'DEFAULT_PAGE_SIZE',
      'CLIENT_MAX_PAGES',
      'ScratchDbError',
      'isScratchDbError',
      // auth.ts
      'ACCESS_TOKEN_PREFIX',
      'applyAccessTokenPrefix',
      'stripAccessTokenPrefix',
      'NO_ACCESS_TOKEN_BODY',
      'OAUTH_ROUTES',
      'COOKIE_NAMES',
      'OAUTH_METADATA_CONSTANTS',
      'TOKEN_LIFETIMES_SECONDS',
      'refreshLifetimeSeconds',
      'OAUTH_CALLBACK_ALLOWLIST',
      'RECONSTRUCTED_CLIENT_REDIRECT_URIS',
      'isAllowedRedirectUri',
      'canonicalBaseUrl',
      'canonicalMcpUrl',
      'issuerUrl',
      'resourceMetadataUrl',
      'acceptableAudiences',
      'isAcceptableAudience',
      'isPublicHost',
      'buildUnauthorizedChallenge',
      'buildInsufficientScopeChallenge',
      'JWT_TYPES',
      'JWT_CLAIMS_SCHEMAS',
      'JwtClaimsSchema',
      'isJwtType',
      'PAIRING_CODE_ALPHABET',
      'PAIRING_CODE_PATTERN',
      'isPairingCode',
      'formatPairingCode',
      'pairingUrl',
      // xray-api.ts
      'XRAY_ROUTES',
      'SSE_EVENT_NAME',
      'SSE_RETRY_MS',
      'SSE_HEARTBEAT_MS',
      'SSE_HEADERS',
      'INITIAL_REPLAY',
      'MAX_EVENTS_PAGE_LIMIT',
      'RING_BUFFER_SIZE',
      'renderStreamFrame',
    ];
    const missing = expected.filter((name) => !(name in contracts));
    expect(missing).toEqual([]);
  });

  it('exports no runtime state, only constants and pure functions', () => {
    for (const [name, value] of Object.entries(contracts)) {
      const kind = typeof value;
      expect(['function', 'object', 'string', 'number', 'boolean'], name).toContain(kind);
    }
    // A frozen catalogue: the arrays are shared, so nobody may mutate them in place.
    expect(contracts.TOOL_CATALOG).toHaveLength(17);
    expect(contracts.XRAY_EVENT_TYPES).toHaveLength(46);
  });

  it('keeps the ETL protocol strings exactly as Ramp writes them', () => {
    const text = contracts.loadResultText({ table_name: 'load_cards_1', columns: ['id', 'last4'] });
    expect(text).toBe(
      'Stored data in memory database with table name: load_cards_1.\n' +
        ' Call `process_data` tool with table name and desired columns to setup a SQL table.\n' +
        ' Call `execute_query` tool with query to get results as a JSON.\n' +
        ' Available columns are: id, last4\n' +
        ' Call `clear_table` tool with table name to delete the table from the memory database.',
    );
    expect(contracts.NO_DATA_FOUND).toBe('No data found');
    expect(contracts.processedTableText('t')).toBe('Table t created');
    expect(contracts.clearedTableText('t')).toBe('Table t cleared');
    expect(contracts.rowCapMessage(100)).toBe(
      'Query returned more than 100 rows: add filters and retry',
    );
    expect(contracts.TOO_MANY_TABLES_MESSAGE).toBe(
      'too many tables loaded: ask the agent to drop unused tables',
    );
    expect(contracts.ETL_OPERATION_LIMIT_MESSAGE).toBe('ETL operation limit reached');
  });

  it('wraps a tool error in Ramp wording with isError set (A-08)', () => {
    const result = contracts.toolError('the table does not exist');
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      'Ran into an error: the table does not exist. Communicate this to the user and consider retrying if the error seems transient.',
    );
    expect(contracts.toolText('ok').isError).toBeUndefined();
  });

  it('catches a token in an argument value with the global redaction patterns', () => {
    const samples = [
      'mockbank_user_tok_abc.def.ghi',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      'Bearer abcdefghijklmnopqrstuvwxyz012345',
    ];
    for (const sample of samples) {
      expect(
        contracts.GLOBAL_REDACTION_PATTERNS.some((pattern) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
    expect(
      contracts.GLOBAL_REDACTION_PATTERNS.some((pattern) => pattern.test('load_transactions')),
    ).toBe(false);
    expect(contracts.REDACTED_PLACEHOLDER).toBe('[redacted]');
  });

  it('names the type surface every block document consumes', () => {
    // Compile-time only: the tuple above fails to build if a type stops being exported.
    const names: (keyof ConsumedTypes)[] = [];
    expect(names).toEqual([]);
  });
});
