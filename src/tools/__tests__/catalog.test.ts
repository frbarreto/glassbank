/**
 * The catalog-level test of docs/TOOL_CATALOG.md section 1, run over all seventeen entries.
 *
 * The catalog itself is frozen in `src/contracts`, so most of this is a guard against a future
 * append that forgets a rule - and against this block growing a handler the catalog does not
 * know about, or losing one it does.
 */
import { describe, expect, it } from 'vitest';

import {
  PUBLISHED_RATIONALE_PROPERTY,
  RATIONALE_DESCRIPTION,
  RATIONALE_MAX_LENGTH,
  SCOPE_TO_TOOLS,
  TOOL_CATALOG,
  TOOL_NAMES,
  WRITE_TOOL_NAMES,
  isWriteScope,
  type JsonSchemaNode,
  type ToolCatalogEntry,
} from '../../contracts/index.js';
import { createTools } from '../index.js';

const registry = createTools();

/** Every property node of a published schema, at any depth, with the path that reached it. */
function propertyNodes(
  node: JsonSchemaNode,
  path: string[] = [],
): { path: string; node: JsonSchemaNode }[] {
  const found: { path: string; node: JsonSchemaNode }[] = [];
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const childPath = [...path, name];
    found.push({ path: childPath.join('.'), node: child });
    found.push(...propertyNodes(child, childPath));
    if (child.items !== undefined) found.push(...propertyNodes(child.items, [...childPath, '[]']));
    for (const [index, branch] of (child.oneOf ?? []).entries()) {
      found.push(...propertyNodes(branch, [...childPath, `oneOf${index}`]));
    }
  }
  return found;
}

describe('the 17-tool catalog', () => {
  it('has exactly seventeen tools in a deterministic order', () => {
    expect(TOOL_CATALOG).toHaveLength(17);
    expect(TOOL_NAMES).toEqual(TOOL_CATALOG.map((entry) => entry.name));
    expect(new Set(TOOL_NAMES).size).toBe(17);
  });

  it('has a handler for every tool and no handler for anything else', () => {
    expect(Object.keys(registry.handlers).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it.each(TOOL_CATALOG.map((entry) => [entry.name, entry] as const))(
    '%s follows every catalog convention',
    (_name: string, entry: ToolCatalogEntry) => {
      expect(entry.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(entry.name.length).toBeLessThanOrEqual(64);
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.annotations.title).toBe(entry.title);
      expect(entry.description.length).toBeGreaterThan(80);

      // Exactly one of the two hints, never both and never neither (A-07).
      const readOnly = entry.annotations.readOnlyHint === true;
      const destructive = entry.annotations.destructiveHint === true;
      expect(readOnly !== destructive).toBe(true);
      expect(entry.annotations.openWorldHint).toBe(false);
      expect(typeof entry.annotations.idempotentHint).toBe('boolean');
      expect(entry.metadata['x-destructive']).toBe(destructive);

      // The published half of ADR-8.
      expect(entry.publishedInputSchema.type).toBe('object');
      expect(entry.publishedInputSchema.required).toContain('rationale');
      expect(entry.publishedInputSchema.properties.rationale).toEqual(PUBLISHED_RATIONALE_PROPERTY);
      expect(entry.publishedInputSchema.properties.rationale?.description).toBe(
        RATIONALE_DESCRIPTION,
      );

      // Fix for Ramp OSS defect #2: a description on every parameter, at every depth.
      for (const { path, node } of propertyNodes(entry.publishedInputSchema)) {
        expect(node.description, `${entry.name}.${path} has no description`).toBeTruthy();
      }

      // The lenient half of ADR-8: valid arguments minus `rationale` still parse.
      expect(Array.isArray(entry.redactionDenyList)).toBe(true);
      expect(entry.featureFlags).toEqual(entry.metadata['x-gated-by']);
    },
  );

  it('lists every tool whose arguments are all optional, and parses each with no arguments', () => {
    const noArgumentTools = TOOL_CATALOG.filter(
      (entry) => entry.publishedInputSchema.required.length === 1,
    );
    expect(noArgumentTools.map((entry) => entry.name)).toEqual([
      'get_bank_categories',
      'get_currencies',
      'get_current_user',
      'get_tool_availability',
      'load_accounts',
      'load_cards',
      'load_payees',
      'xray_get_session_link',
    ]);
    for (const entry of noArgumentTools) {
      expect(entry.lenientInputSchema.safeParse({}).success).toBe(true);
    }
  });

  it('accepts a missing rationale and truncates an over-long one (ADR-8, A-06)', () => {
    for (const entry of TOOL_CATALOG) {
      const withoutRationale = entry.lenientInputSchema.safeParse(minimalArgumentsFor(entry));
      expect(withoutRationale.success, `${entry.name} rejected a missing rationale`).toBe(true);

      const long = 'x'.repeat(RATIONALE_MAX_LENGTH + 976);
      const parsed = entry.lenientInputSchema.safeParse({
        ...minimalArgumentsFor(entry),
        rationale: long,
      });
      expect(parsed.success).toBe(true);
      const data = parsed.data as { rationale?: string };
      expect(data.rationale).toHaveLength(RATIONALE_MAX_LENGTH);

      // A rationale of the wrong type is dropped, never a validation error.
      const wrongType = entry.lenientInputSchema.safeParse({
        ...minimalArgumentsFor(entry),
        rationale: 42,
      });
      expect(wrongType.success).toBe(true);
    }
  });

  it('keeps write tools on write scopes and read tools on read scopes', () => {
    expect(WRITE_TOOL_NAMES).toEqual(['lock_or_unlock_card', 'create_transfer']);
    for (const name of WRITE_TOOL_NAMES) {
      const entry = TOOL_CATALOG.find((candidate) => candidate.name === name);
      expect(entry?.requiredScopes.some(isWriteScope)).toBe(true);
      expect(entry?.featureFlags.length).toBeGreaterThan(0);
    }
    expect(SCOPE_TO_TOOLS['cards:write']).toEqual(['lock_or_unlock_card']);
    expect(SCOPE_TO_TOOLS['transfers:write']).toEqual(['create_transfer']);
    expect(SCOPE_TO_TOOLS['transactions:read']).toEqual([
      'load_transactions',
      'load_statement_lines',
    ]);
  });
});

/** The smallest argument object each tool's lenient schema accepts, without a rationale. */
export function minimalArgumentsFor(entry: ToolCatalogEntry): Record<string, unknown> {
  switch (entry.name) {
    case 'process_data':
      return { table_name: 't', cols: ['a'] };
    case 'execute_query':
      return { table_name: 't', query: 'SELECT 1' };
    case 'clear_table':
      return { table_name: 't' };
    case 'load_transactions':
    case 'load_transfers':
    case 'load_bills':
    case 'load_statement_lines':
      return { from_date: '2026-01-01', to_date: '2026-01-31' };
    case 'lock_or_unlock_card':
      return { card_id: 'card_1', action: 'lock' };
    case 'create_transfer':
      return {
        from_account_id: 'acc_1',
        to: { payee_id: 'pay_1' },
        amount: 1000,
        currency: 'USD',
      };
    default:
      return {};
  }
}
