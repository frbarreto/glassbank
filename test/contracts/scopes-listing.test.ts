/**
 * The listing rule of ADR-13 and the availability vocabulary of docs/TOOL_CATALOG.md section 4.
 *
 * The three cases the ticket calls out are a read-only grant, a read-write grant and a tool
 * disabled by a feature flag; the rest cover the reason vocabulary and the step-up challenge.
 */
import { describe, expect, it } from 'vitest';

import type { ToolAvailability } from '../../src/contracts/index.js';
import {
  CREATE_TRANSFER,
  DEFAULT_CHALLENGE_SCOPES,
  DEFAULT_CHALLENGE_SCOPE_STRING,
  DEFAULT_FEATURE_FLAGS,
  LOAD_BILLS,
  LOAD_STATEMENT_LINES,
  LOCK_OR_UNLOCK_CARD,
  READ_SCOPES,
  SCOPES,
  TOOL_CATALOG,
  WRITE_SCOPES,
  authLevelForScopes,
  buildScopeToTools,
  canonicalCatalogSnapshot,
  catalogAvailability,
  isAvailable,
  isListed,
  isWriteScope,
  listedToolNames,
  missingScopesFor,
  normaliseFeatureFlags,
  parseScopeString,
  stepUpScopes,
  supportedScopes,
  toolAvailability,
} from '../../src/contracts/index.js';

const READ_ONLY = { scopes: [...READ_SCOPES] };
const READ_WRITE = { scopes: [...SCOPES] };
const BOTH_FLAGS = [...DEFAULT_FEATURE_FLAGS];

function rowFor(table: readonly ToolAvailability[], tool: string): ToolAvailability {
  const row = table.find((candidate) => candidate.tool === tool);
  if (!row) throw new Error(`no availability row for ${tool}`);
  return row;
}

describe('scopes (docs/TOOL_CATALOG.md section 2)', () => {
  it('has the ten scopes of v1', () => {
    expect(SCOPES).toHaveLength(10);
    expect(READ_SCOPES).toHaveLength(8);
    expect(WRITE_SCOPES).toEqual(['cards:write', 'transfers:write']);
    expect(SCOPES.every((scope) => scope === 'profile' || /^[a-z]+:(read|write)$/.test(scope)));
  });

  it('advertises the read-only default in the 401 challenge', () => {
    expect(DEFAULT_CHALLENGE_SCOPE_STRING).toBe(
      'profile accounts:read transactions:read cards:read transfers:read bills:read payees:read xray:read',
    );
    expect(DEFAULT_CHALLENGE_SCOPES.some(isWriteScope)).toBe(false);
  });

  it('derives auth_level from the granted write scopes', () => {
    expect(authLevelForScopes(READ_ONLY.scopes)).toBe('read_only');
    expect(authLevelForScopes(READ_WRITE.scopes)).toBe('read_write');
    expect(authLevelForScopes(['profile', 'cards:write'])).toBe('read_write');
  });

  it('parses and filters an OAuth scope string', () => {
    expect(parseScopeString('profile  cards:read nonsense')).toEqual(['profile', 'cards:read']);
    expect(parseScopeString(null)).toEqual([]);
  });

  it('advertises write scopes only when the writes flag is on', () => {
    expect(supportedScopes(BOTH_FLAGS)).toEqual([...SCOPES]);
    expect(supportedScopes([])).toEqual([...READ_SCOPES]);
  });

  it('keeps only known feature flags', () => {
    expect(normaliseFeatureFlags(['writes', 'nope'])).toEqual(['writes']);
  });
});

describe('the listing rule (ADR-13)', () => {
  it('lists every tool for a read-only grant, write tools included', () => {
    const listed = listedToolNames(TOOL_CATALOG, READ_ONLY, BOTH_FLAGS);
    expect(listed).toHaveLength(17);
    expect(listed).toContain('create_transfer');
    expect(listed).toContain('lock_or_unlock_card');
  });

  it('marks the write tools listed but unavailable, with the scopes still needed', () => {
    const table = catalogAvailability(TOOL_CATALOG, READ_ONLY, BOTH_FLAGS);
    expect(rowFor(table, 'create_transfer')).toEqual({
      tool: 'create_transfer',
      listed: true,
      available: false,
      unavailable_reasons: ['missing_scopes'],
      missing_scopes: ['transfers:write'],
    });
    expect(rowFor(table, 'lock_or_unlock_card')).toEqual({
      tool: 'lock_or_unlock_card',
      listed: true,
      available: false,
      unavailable_reasons: ['missing_scopes'],
      missing_scopes: ['cards:write'],
    });
    expect(rowFor(table, 'load_transactions')).toEqual({
      tool: 'load_transactions',
      listed: true,
      available: true,
      unavailable_reasons: [],
      missing_scopes: [],
    });
  });

  it('makes everything available for a read-write grant', () => {
    const table = catalogAvailability(TOOL_CATALOG, READ_WRITE, BOTH_FLAGS);
    expect(table.every((row) => row.listed && row.available)).toBe(true);
    expect(table.every((row) => row.unavailable_reasons.length === 0)).toBe(true);
    expect(isAvailable(CREATE_TRANSFER, READ_WRITE, BOTH_FLAGS)).toBe(true);
  });

  it('hides a tool whose feature flag is off, reporting disabled_for_deployment', () => {
    const table = catalogAvailability(TOOL_CATALOG, READ_ONLY, []);
    expect(rowFor(table, 'lock_or_unlock_card')).toEqual({
      tool: 'lock_or_unlock_card',
      listed: false,
      available: false,
      unavailable_reasons: ['disabled_for_deployment'],
      missing_scopes: [],
    });
    expect(rowFor(table, 'create_transfer').unavailable_reasons).toEqual([
      'disabled_for_deployment',
    ]);
    // The flag decision comes first: the scope question is not reported (section 4 example).
    expect(rowFor(table, 'create_transfer').missing_scopes).toEqual([]);
    expect(listedToolNames(TOOL_CATALOG, READ_ONLY, [])).toHaveLength(15);
  });

  it('honours each flag independently', () => {
    const onlyWrites = catalogAvailability(TOOL_CATALOG, READ_WRITE, ['writes']);
    expect(rowFor(onlyWrites, 'lock_or_unlock_card').listed).toBe(true);
    expect(rowFor(onlyWrites, 'create_transfer').listed).toBe(false);
    expect(rowFor(onlyWrites, 'create_transfer').unavailable_reasons).toEqual([
      'disabled_for_deployment',
    ]);
  });

  it('hides a tool whose READ scope is missing, and says which scope', () => {
    const grant = { scopes: READ_SCOPES.filter((scope) => scope !== 'bills:read') };
    const table = catalogAvailability(TOOL_CATALOG, grant, BOTH_FLAGS);
    expect(rowFor(table, 'load_bills')).toEqual({
      tool: 'load_bills',
      listed: false,
      available: false,
      unavailable_reasons: ['missing_scopes'],
      missing_scopes: ['bills:read'],
    });
    // The union tool needs all three read scopes, so it disappears too.
    expect(rowFor(table, 'load_statement_lines').listed).toBe(false);
    expect(rowFor(table, 'load_statement_lines').missing_scopes).toEqual(['bills:read']);
    expect(isListed(LOAD_BILLS, grant, BOTH_FLAGS)).toBe(false);
    expect(isListed(LOAD_STATEMENT_LINES, grant, BOTH_FLAGS)).toBe(false);
  });

  it('treats profile as implicit in every grant', () => {
    const table = catalogAvailability(TOOL_CATALOG, { scopes: [] }, BOTH_FLAGS);
    expect(rowFor(table, 'get_current_user').available).toBe(true);
    expect(rowFor(table, 'get_tool_availability').available).toBe(true);
    expect(missingScopesFor(LOAD_BILLS, [])).toEqual(['bills:read']);
  });

  it('leaves the database tools available to any grant', () => {
    const table = catalogAvailability(TOOL_CATALOG, { scopes: [] }, BOTH_FLAGS);
    for (const tool of ['process_data', 'execute_query', 'clear_table', 'get_currencies']) {
      expect(rowFor(table, tool).available, tool).toBe(true);
    }
  });

  it('challenges with every still-needed write scope, not only the one tool needs', () => {
    expect(stepUpScopes(TOOL_CATALOG, READ_ONLY)).toEqual(['cards:write', 'transfers:write']);
    expect(stepUpScopes(TOOL_CATALOG, { scopes: [...READ_SCOPES, 'cards:write'] })).toEqual([
      'transfers:write',
    ]);
    expect(stepUpScopes(TOOL_CATALOG, READ_WRITE)).toEqual([]);
  });

  it('computes one availability row per catalog entry, listed or not', () => {
    expect(catalogAvailability(TOOL_CATALOG, READ_ONLY, [])).toHaveLength(17);
    expect(toolAvailability(LOCK_OR_UNLOCK_CARD, READ_ONLY, []).tool).toBe('lock_or_unlock_card');
  });

  it('produces a stable catalog snapshot for content_hash', () => {
    const first = canonicalCatalogSnapshot(TOOL_CATALOG, BOTH_FLAGS);
    const second = canonicalCatalogSnapshot(TOOL_CATALOG, [...BOTH_FLAGS].reverse());
    expect(first).toBe(second);
    expect(canonicalCatalogSnapshot(TOOL_CATALOG, [])).not.toBe(first);
  });

  it('builds the scope to tools map from any catalog', () => {
    const map = buildScopeToTools(TOOL_CATALOG);
    expect(map['xray:read']).toEqual(['xray_get_session_link']);
    expect(map['bills:read']).toEqual(['load_bills', 'load_statement_lines']);
  });
});
