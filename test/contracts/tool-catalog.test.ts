/**
 * The catalog-level test of docs/TOOL_CATALOG.md section 1, applied to all 17 entries:
 * a name of 64 characters or fewer, a title, exactly one hint, `openWorldHint: false`, a
 * description, `rationale` required in the published schema and optional in the lenient one,
 * a description on every parameter and a per-tool redaction deny-list.
 */
import { describe, expect, it } from 'vitest';

import type { JsonSchemaNode, ToolCatalogEntry } from '../../src/contracts/index.js';
import {
  AMOUNT_DESCRIPTION,
  CREATE_TRANSFER,
  CatalogToolDescriptorSchema,
  CatalogToolSchema,
  LOAD_STATEMENT_LINES,
  LOCK_OR_UNLOCK_CARD,
  PUBLIC_LANE_NOTICE,
  PUBLIC_TOOL_CATALOG,
  PUBLIC_TOOL_NAMES,
  RATIONALE_DESCRIPTION,
  RATIONALE_MAX_LENGTH,
  SCOPES,
  SCOPE_TO_TOOLS,
  TOOL_CATALOG,
  TOOL_NAMES,
  getPublicTool,
  getTool,
  isRationaleMissing,
  isRationaleTruncated,
  isToolName,
  publishedToolDescriptor,
} from '../../src/contracts/index.js';

/** Walks a JSON Schema node and yields every named property, including inside `oneOf`. */
function namedProperties(node: JsonSchemaNode, path = ''): [string, JsonSchemaNode][] {
  const found: [string, JsonSchemaNode][] = [];
  for (const [name, property] of Object.entries(node.properties ?? {})) {
    const full = path === '' ? name : `${path}.${name}`;
    found.push([full, property]);
    found.push(...namedProperties(property, full));
  }
  for (const [index, branch] of (node.oneOf ?? []).entries()) {
    found.push(
      ...namedProperties(branch, path === '' ? `oneOf[${index}]` : `${path}.oneOf[${index}]`),
    );
  }
  return found;
}

describe('the tool catalog (docs/TOOL_CATALOG.md)', () => {
  it('has exactly the 17 tools of v1, with unique names in a deterministic order', () => {
    expect(TOOL_CATALOG).toHaveLength(17);
    expect(new Set(TOOL_NAMES).size).toBe(17);
    expect(TOOL_NAMES).toEqual([
      'process_data',
      'execute_query',
      'clear_table',
      'get_bank_categories',
      'get_currencies',
      'get_current_user',
      'get_tool_availability',
      'load_accounts',
      'load_transactions',
      'load_cards',
      'load_transfers',
      'load_bills',
      'load_payees',
      'load_statement_lines',
      'lock_or_unlock_card',
      'create_transfer',
      'xray_get_session_link',
    ]);
  });

  it('resolves tools by name', () => {
    expect(getTool('execute_query')?.title).toBeTruthy();
    expect(getTool('nope')).toBeUndefined();
    expect(isToolName('create_transfer')).toBe(true);
    expect(isToolName('create_transfers')).toBe(false);
  });

  // v0.7: the six public tools (D-26) obey the same catalog rules as the seventeen.
  describe.each([...TOOL_CATALOG, ...PUBLIC_TOOL_CATALOG].map((entry) => [entry.name, entry] as const))(
    '%s',
    (name, entry: ToolCatalogEntry) => {
      it('has a snake_case name of 64 characters or fewer (Decision D-12)', () => {
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      });

      it('has a title, and the annotations repeat it', () => {
        expect(entry.title.length).toBeGreaterThan(0);
        expect(entry.annotations.title).toBe(entry.title);
      });

      it('sets exactly one of readOnlyHint and destructiveHint, and openWorldHint false', () => {
        const readOnly = entry.annotations.readOnlyHint === true;
        const destructive = entry.annotations.destructiveHint === true;
        expect(readOnly !== destructive).toBe(true);
        expect(entry.annotations.openWorldHint).toBe(false);
        expect(typeof entry.annotations.idempotentHint).toBe('boolean');
      });

      it('describes when to use it and when not to (Ramp convention)', () => {
        expect(entry.description.length).toBeGreaterThan(200);
        expect(entry.description).toMatch(/\buse (it|this)\b/i);
        expect(entry.description).toMatch(/\b(do not use|never |only when|instead)\b/i);
        expect(entry.description).not.toMatch(/\{[a-z_]+\}/i);
      });

      it('requires rationale in the published schema, verbatim from Ramp (ADR-8)', () => {
        const schema = entry.publishedInputSchema;
        expect(schema.type).toBe('object');
        expect(schema.required).toContain('rationale');
        const rationale = schema.properties.rationale;
        expect(rationale).toBeDefined();
        expect(rationale?.type).toBe('string');
        expect(rationale?.description).toBe(RATIONALE_DESCRIPTION);
        expect(rationale?.minLength).toBe(1);
        expect(rationale?.maxLength).toBe(RATIONALE_MAX_LENGTH);
      });

      it('accepts a call with no rationale in the lenient schema (A-06)', () => {
        const minimal = minimalArguments(entry);
        const parsed = entry.lenientInputSchema.safeParse(minimal);
        expect(parsed.success).toBe(true);
        expect((parsed.data as { rationale?: string }).rationale).toBeUndefined();
        expect(isRationaleMissing(undefined)).toBe(true);
      });

      it('truncates an over-long rationale instead of failing (A-06)', () => {
        const long = 'x'.repeat(2000);
        const parsed = entry.lenientInputSchema.safeParse({
          ...minimalArguments(entry),
          rationale: long,
        });
        expect(parsed.success).toBe(true);
        expect((parsed.data as { rationale?: string }).rationale).toHaveLength(
          RATIONALE_MAX_LENGTH,
        );
        expect(isRationaleTruncated(long)).toBe(true);
      });

      it('never fails validation on a rationale of the wrong type (A-06)', () => {
        const parsed = entry.lenientInputSchema.safeParse({
          ...minimalArguments(entry),
          rationale: 42,
        });
        expect(parsed.success).toBe(true);
        expect((parsed.data as { rationale?: string }).rationale).toBeUndefined();
      });

      it('describes every published parameter', () => {
        for (const [path, property] of namedProperties(entry.publishedInputSchema)) {
          expect(property.description, `${name}.${path} has no description`).toBeTruthy();
          expect((property.description ?? '').length).toBeGreaterThan(10);
        }
      });

      it('spells out the ""-means-null rule on every optional enum', () => {
        for (const [path, property] of namedProperties(entry.publishedInputSchema)) {
          if (!property.enum?.includes('')) continue;
          expect(property.default, `${name}.${path} enum has no default`).toBe('');
          expect(property.description).toMatch(/empty string/i);
        }
      });

      it('spells out the date format and the inclusive end rule on every date parameter', () => {
        for (const [path, property] of namedProperties(entry.publishedInputSchema)) {
          if (!/(^|\.)(from_date|to_date)$/.test(path)) continue;
          expect(property.description).toContain('YYYY-MM-DD');
          expect(property.description).toMatch(/UTC/);
          if (path.endsWith('to_date')) {
            expect(property.description).toMatch(/adds one day/i);
            expect(property.description).toMatch(/inclusive/i);
          }
        }
      });

      it('carries the Ramp x-* metadata consistently with the annotations', () => {
        expect(entry.metadata['x-destructive']).toBe(entry.annotations.destructiveHint === true);
        expect(entry.metadata['x-gated-by']).toEqual(entry.featureFlags);
        if (entry.annotations.destructiveHint === true) {
          expect(entry.metadata['x-read-only']).toBe(false);
        } else {
          expect(['partial', true]).toContain(entry.metadata['x-read-only']);
        }
      });

      it('declares a redaction deny-list (possibly empty) of lowercase leaf keys', () => {
        expect(Array.isArray(entry.redactionDenyList)).toBe(true);
        for (const field of entry.redactionDenyList) {
          expect(field).toBe(field.toLowerCase());
          expect(field).not.toContain(' ');
        }
      });

      it('requires only known scopes and known feature flags', () => {
        for (const scope of entry.requiredScopes) {
          expect(SCOPES).toContain(scope);
        }
        for (const flag of entry.featureFlags) {
          expect(['writes', 'transfers']).toContain(flag);
        }
      });
    },
  );

  it('states the USD-cents rule on every amount parameter (Decision D-1)', () => {
    const amountProperties = [...TOOL_CATALOG, ...PUBLIC_TOOL_CATALOG].flatMap((entry) =>
      namedProperties(entry.publishedInputSchema).filter(([path]) =>
        /amount$/.test(path.replace(/^oneOf\[\d+]\./, '')),
      ),
    );
    expect(amountProperties.length).toBeGreaterThan(0);
    for (const [path, property] of amountProperties) {
      expect(property.type, path).toBe('integer');
      expect(property.description, path).toContain(AMOUNT_DESCRIPTION);
    }
    expect(AMOUNT_DESCRIPTION).toContain('1000 refers to 1000 cents or $10.00');
  });

  it('gates load_statement_lines on all three read scopes (docs/TOOL_CATALOG.md section 3)', () => {
    expect([...LOAD_STATEMENT_LINES.requiredScopes].sort()).toEqual([
      'bills:read',
      'transactions:read',
      'transfers:read',
    ]);
    expect(LOAD_STATEMENT_LINES.description).toContain(
      'Always use this over load_transactions, load_transfers, load_bills when possible',
    );
  });

  it('gates the two write tools behind their feature flags (ADR-12)', () => {
    expect(LOCK_OR_UNLOCK_CARD.featureFlags).toEqual(['writes']);
    expect(CREATE_TRANSFER.featureFlags).toEqual(['writes', 'transfers']);
    expect(LOCK_OR_UNLOCK_CARD.annotations.destructiveHint).toBe(true);
    expect(LOCK_OR_UNLOCK_CARD.annotations.idempotentHint).toBe(true);
    expect(CREATE_TRANSFER.annotations.destructiveHint).toBe(true);
    expect(CREATE_TRANSFER.annotations.idempotentHint).toBe(false);
  });

  it('advertises the two-step transfer choreography in the description', () => {
    expect(CREATE_TRANSFER.description).toMatch(/WITHOUT confirm/);
    expect(CREATE_TRANSFER.description).toMatch(/explicit approval/);
    expect(CREATE_TRANSFER.publishedInputSchema.properties.confirm?.default).toBe(false);
    expect(CREATE_TRANSFER.publishedInputSchema.required).not.toContain('confirm');
    expect(CREATE_TRANSFER.publishedInputSchema.properties.to?.oneOf).toHaveLength(2);
  });

  it('maps every scope to the tools it unlocks (Ramp scope_to_tools_mapping)', () => {
    expect(SCOPE_TO_TOOLS['accounts:read']).toEqual(['load_accounts']);
    expect(SCOPE_TO_TOOLS['cards:write']).toEqual(['lock_or_unlock_card']);
    expect(SCOPE_TO_TOOLS['transfers:write']).toEqual(['create_transfer']);
    expect(SCOPE_TO_TOOLS['transactions:read']).toEqual([
      'load_transactions',
      'load_statement_lines',
    ]);
    expect(SCOPE_TO_TOOLS.profile).toEqual(['get_current_user', 'get_tool_availability']);
  });
});

describe('the public catalog (contracts v0.7, D-26)', () => {
  it('has the six public tools in level order, none of them named like a private tool', () => {
    expect(PUBLIC_TOOL_NAMES).toEqual([
      'get_bank_profile',
      'list_products',
      'get_product',
      'search_prices',
      'find_branches',
      'get_branch',
    ]);
    for (const name of PUBLIC_TOOL_NAMES) {
      expect(TOOL_NAMES).not.toContain(name);
      expect(getPublicTool(name)?.name).toBe(name);
      expect(getTool(name)).toBeUndefined();
    }
    expect(getPublicTool('load_accounts')).toBeUndefined();
  });

  it.each(PUBLIC_TOOL_CATALOG.map((entry) => [entry.name, entry] as const))(
    '%s is read-only, needs no scope or flag, and tells the agent the lane is public',
    (_name, entry: ToolCatalogEntry) => {
      expect(entry.annotations.readOnlyHint).toBe(true);
      expect(entry.metadata['x-read-only']).toBe(true);
      expect(entry.requiredScopes).toEqual([]);
      expect(entry.featureFlags).toEqual([]);
      expect(entry.description.endsWith(PUBLIC_LANE_NOTICE)).toBe(true);
    },
  );

  it('produces descriptors CatalogToolDescriptorSchema accepts', () => {
    for (const entry of PUBLIC_TOOL_CATALOG) {
      expect(CatalogToolDescriptorSchema.safeParse(publishedToolDescriptor(entry)).success).toBe(true);
    }
  });
});

describe('publishedToolDescriptor (contracts v0.5)', () => {
  it('keeps rationale required in the published schema of all 17 entries (ADR-8)', () => {
    const descriptors = TOOL_CATALOG.map((entry) => publishedToolDescriptor(entry));
    expect(descriptors).toHaveLength(17);
    for (const descriptor of descriptors) {
      expect(descriptor.inputSchema.type, descriptor.name).toBe('object');
      expect(descriptor.inputSchema.required, descriptor.name).toContain('rationale');
      expect(descriptor.inputSchema.properties.rationale?.description, descriptor.name).toBe(
        RATIONALE_DESCRIPTION,
      );
    }
  });

  it('repeats the catalog entry: the same six keys, the annotations and the x-* metadata', () => {
    for (const entry of TOOL_CATALOG) {
      const descriptor = publishedToolDescriptor(entry);
      expect(Object.keys(descriptor), entry.name).toEqual([
        'name',
        'title',
        'description',
        'inputSchema',
        'annotations',
        '_meta',
      ]);
      expect(descriptor.name).toBe(entry.name);
      expect(descriptor.title).toBe(entry.title);
      expect(descriptor.description).toBe(entry.description);
      expect(descriptor.inputSchema).toBe(entry.publishedInputSchema);
      expect(descriptor.annotations).toBe(entry.annotations);
      expect(descriptor._meta, entry.name).toEqual({
        'x-read-only': entry.metadata['x-read-only'],
        'x-destructive': entry.metadata['x-destructive'],
        'x-gated-by': entry.metadata['x-gated-by'],
        // ADR-13: a write tool is listed without its write scope, so what the client sees for it
        // is part of the record.
        'x-required-scopes': entry.requiredScopes,
        'x-kind': entry.kind,
      });
    }
  });

  it('produces a descriptor CatalogToolDescriptorSchema accepts, minus name and title', () => {
    for (const entry of TOOL_CATALOG) {
      const parsed = CatalogToolDescriptorSchema.safeParse(publishedToolDescriptor(entry));
      expect(parsed.success, entry.name).toBe(true);
      expect(Object.keys(parsed.data ?? {}).sort(), entry.name).toEqual([
        '_meta',
        'annotations',
        'description',
        'inputSchema',
      ]);
    }
  });

  it('parses a catalog row with and without a descriptor (the pre-v0.5 shape)', () => {
    const entry = TOOL_CATALOG[0] as ToolCatalogEntry;
    const row = {
      name: entry.name,
      title: entry.title,
      read_only: entry.metadata['x-read-only'] === true,
      destructive: entry.metadata['x-destructive'],
      idempotent: entry.annotations.idempotentHint,
      scopes: [...entry.requiredScopes],
      input_schema_hash: '0123456789abcdef',
    };
    const old = CatalogToolSchema.safeParse(row);
    expect(old.success).toBe(true);
    expect(old.data?.descriptor).toBeUndefined();

    const current = CatalogToolSchema.safeParse({
      ...row,
      descriptor: publishedToolDescriptor(entry),
    });
    expect(current.success).toBe(true);
    expect(current.data?.descriptor?.description).toBe(entry.description);
  });
});

/** The smallest argument object that satisfies a tool's required parameters. */
function minimalArguments(entry: ToolCatalogEntry): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const key of entry.publishedInputSchema.required) {
    if (key === 'rationale') continue;
    const property = entry.publishedInputSchema.properties[key];
    args[key] = sampleFor(property);
  }
  return args;
}

function sampleFor(property: JsonSchemaNode | undefined): unknown {
  if (!property) return 'x';
  if (property.oneOf && property.oneOf.length > 0) {
    const branch = property.oneOf[0] as JsonSchemaNode;
    const sample: Record<string, unknown> = {};
    for (const key of branch.required ?? []) {
      sample[key] = sampleFor(branch.properties?.[key]);
    }
    return sample;
  }
  switch (property.type) {
    case 'array':
      return ['x'];
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'object':
      return {};
    default:
      return property.enum && property.enum.length > 0 ? property.enum[0] : 'USD';
  }
}
