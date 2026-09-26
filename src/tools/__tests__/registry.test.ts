/**
 * The registry: the listing rule of ADR-13, the availability table of docs/TOOL_CATALOG.md
 * section 4, the `rationale` rule of ADR-8 and the defence-in-depth scope re-check.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FEATURE_FLAGS,
  RATIONALE_MAX_LENGTH,
  TOOL_NAMES,
  getTool,
  type FeatureFlag,
  type GrantView,
  type Scope,
} from '../../contracts/index.js';
import { catalogContentHash, createTools, describeToolCall } from '../index.js';

import { FAKE_READ_ONLY_SCOPES, FAKE_READ_WRITE_SCOPES, createFakeToolContext } from './fakes.js';

const registry = createTools();
const READ_ONLY: GrantView = { scopes: FAKE_READ_ONLY_SCOPES, auth_level: 'read_only' };
const READ_WRITE: GrantView = { scopes: FAKE_READ_WRITE_SCOPES, auth_level: 'read_write' };

function listedNames(grant: GrantView, flags: readonly FeatureFlag[] = DEFAULT_FEATURE_FLAGS) {
  return registry.listFor(grant, flags).listed.map((entry) => entry.name);
}

function availabilityOf(
  tool: string,
  grant: GrantView,
  flags: readonly FeatureFlag[] = DEFAULT_FEATURE_FLAGS,
) {
  const row = registry.availabilityFor(grant, flags).tools.find((entry) => entry.tool === tool);
  if (row === undefined) throw new Error(`no availability row for ${tool}`);
  return row;
}

describe('the listing rule (ADR-13)', () => {
  it('lists the write tools under a read-only grant, so the 403 step-up can fire', () => {
    expect(listedNames(READ_ONLY)).toEqual([...TOOL_NAMES]);
    expect(availabilityOf('create_transfer', READ_ONLY)).toEqual({
      tool: 'create_transfer',
      listed: true,
      available: false,
      unavailable_reasons: ['missing_scopes'],
      missing_scopes: ['transfers:write'],
    });
  });

  it('hides a tool whose read scope is missing, and the combined loader with it', () => {
    const withoutBills: GrantView = {
      scopes: FAKE_READ_ONLY_SCOPES.filter((scope) => scope !== 'bills:read'),
      auth_level: 'read_only',
    };
    const listed = listedNames(withoutBills);
    expect(listed).not.toContain('load_bills');
    expect(listed).not.toContain('load_statement_lines');
    expect(listed).toContain('load_transactions');
    expect(availabilityOf('load_bills', withoutBills)).toEqual({
      tool: 'load_bills',
      listed: false,
      available: false,
      unavailable_reasons: ['missing_scopes'],
      missing_scopes: ['bills:read'],
    });
    expect(availabilityOf('load_statement_lines', withoutBills).missing_scopes).toEqual([
      'bills:read',
    ]);
  });

  it('hides a tool whose feature flag is off, and says so without naming a scope', () => {
    const listed = listedNames(READ_WRITE, []);
    expect(listed).not.toContain('create_transfer');
    expect(listed).not.toContain('lock_or_unlock_card');
    expect(availabilityOf('lock_or_unlock_card', READ_WRITE, [])).toEqual({
      tool: 'lock_or_unlock_card',
      listed: false,
      available: false,
      unavailable_reasons: ['disabled_for_deployment'],
      missing_scopes: [],
    });
  });

  it('respects a partially enabled flag set (create_transfer needs writes and transfers)', () => {
    const listed = listedNames(READ_WRITE, ['writes']);
    expect(listed).toContain('lock_or_unlock_card');
    expect(listed).not.toContain('create_transfer');
  });

  it('never hides a tool that needs only the implicit profile scope', () => {
    const bare: GrantView = { scopes: [], auth_level: 'read_only' };
    expect(listedNames(bare)).toContain('get_current_user');
    expect(availabilityOf('get_current_user', bare).available).toBe(true);
    expect(listedNames(bare)).not.toContain('load_accounts');
  });

  it('has a row for every catalog entry, listed or not, and never uses the reserved reason', () => {
    const table = registry.availabilityFor(READ_ONLY, []);
    expect(table.tools.map((row) => row.tool)).toEqual([...TOOL_NAMES]);
    // `authorization_level_not_allowed` is reserved for the Phase 3 role scoping of A-33 and is
    // never produced in v1; the vocabulary carries it, the code does not use it.
    for (const row of table.tools) {
      expect(row.unavailable_reasons).not.toContain('authorization_level_not_allowed');
    }
  });

  it('marks everything available under a read-write grant with both flags on', () => {
    const table = registry.availabilityFor(READ_WRITE, DEFAULT_FEATURE_FLAGS);
    expect(table.tools).toHaveLength(17);
    expect(table.tools.every((row) => row.available && row.listed)).toBe(true);
  });
});

describe('content_hash', () => {
  it('is stable for the same snapshot and changes when the listed set changes', () => {
    const readOnly = registry.listFor(READ_ONLY, DEFAULT_FEATURE_FLAGS);
    const again = registry.listFor(READ_ONLY, DEFAULT_FEATURE_FLAGS);
    expect(readOnly.content_hash).toBe(again.content_hash);
    expect(readOnly.content_hash).toMatch(/^[0-9a-f]{16}$/);

    const withoutFlags = registry.listFor(READ_ONLY, []);
    expect(withoutFlags.content_hash).not.toBe(readOnly.content_hash);
    expect(withoutFlags.content_hash).toBe(catalogContentHash(withoutFlags.listed, []));
  });

  it('is the same for a read-only and a read-write grant, because the listing is the same', () => {
    // ADR-13's consequence: a step-up must not invalidate a cached `tools/list`.
    expect(registry.listFor(READ_ONLY, DEFAULT_FEATURE_FLAGS).content_hash).toBe(
      registry.listFor(READ_WRITE, DEFAULT_FEATURE_FLAGS).content_hash,
    );
  });
});

describe('the rationale rule (ADR-8 / A-06)', () => {
  it('runs the tool and emits intent.missing when the rationale is absent', async () => {
    const context = createFakeToolContext();
    const result = await registry.call('get_current_user', {}, context);
    expect(result.isError).toBeUndefined();
    expect(context.xray.lastOfType('intent.missing')?.data).toEqual({
      tool: 'get_current_user',
      reason: 'absent',
    });
  });

  it.each([
    ['   ', 'empty'],
    [42, 'wrong_type'],
    [null, 'absent'],
  ])('reports %j as %s', async (rationale, reason) => {
    const context = createFakeToolContext();
    const result = await registry.call('get_current_user', { rationale }, context);
    expect(result.isError).toBeUndefined();
    expect(context.xray.lastOfType('intent.missing')?.data.reason).toBe(reason);
  });

  it('emits intent.declared with the rationale verbatim and model_authored true', async () => {
    const context = createFakeToolContext();
    await registry.call(
      'get_current_user',
      { rationale: 'Tell the user which demo customer this is.' },
      context,
    );
    expect(context.xray.lastOfType('intent.declared')?.data).toEqual({
      text: 'Tell the user which demo customer this is.',
      source: 'rationale',
      model_authored: true,
      tool: 'get_current_user',
      truncated: false,
    });
    expect(context.xray.ofType('intent.missing')).toHaveLength(0);
  });

  it('truncates an over-long rationale and flags it', async () => {
    const context = createFakeToolContext();
    await registry.call(
      'get_current_user',
      { rationale: 'y'.repeat(RATIONALE_MAX_LENGTH + 500) },
      context,
    );
    const declared = context.xray.lastOfType('intent.declared');
    expect(declared?.data.truncated).toBe(true);
    expect(declared?.data.text).toHaveLength(RATIONALE_MAX_LENGTH);
  });

  it('strips the rationale before the handler sees the arguments', async () => {
    const context = createFakeToolContext();
    await registry.call('load_cards', { rationale: 'check the cards', status: 'locked' }, context);
    const table = (await context.scratch.listTables())[0];
    expect(table?.columns_advertised).not.toContain('rationale');
  });

  it('describeToolCall gives src/mcp the tool.call.started payload fields', () => {
    const entry = getTool('load_transactions');
    expect(entry).toBeDefined();
    const description = describeToolCall(
      entry!,
      { from_date: '2026-08-01', to_date: '2026-08-31', rationale: 'why' },
      { grantedScopes: [] },
    );
    expect(description).toMatchObject({
      tool: 'load_transactions',
      rationale: 'why',
      rationale_present: true,
      rationale_truncated: false,
      required_scopes: ['transactions:read'],
      missing_scopes: ['transactions:read'],
      budget_ms: 300_000,
    });
    // The event keeps `arguments` verbatim; redaction is the emitter's job, not ours.
    expect(description.arguments.rationale).toBe('why');
  });
});

describe('dispatch and the defence-in-depth scope check', () => {
  it('throws on an unknown tool so the transport can answer -32601', async () => {
    const context = createFakeToolContext();
    await expect(registry.call('no_such_tool', {}, context)).rejects.toThrow(/unknown tool/);
  });

  it('refuses a call whose scope the grant lacks and emits tool.call.denied', async () => {
    const context = createFakeToolContext({
      auth: { scopes: FAKE_READ_ONLY_SCOPES.filter((scope) => scope !== 'accounts:read') },
    });
    const result = await registry.call('load_accounts', { rationale: 'balances' }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('accounts:read');
    expect(context.xray.lastOfType('tool.call.denied')?.data).toEqual({
      tool: 'load_accounts',
      denied_reason: 'insufficient_scope',
      required_scopes: ['accounts:read'],
      missing_scopes: ['accounts:read'],
      status: 403,
    });
    // The handler never ran, so nothing was loaded.
    expect(context.scratch.tableNames()).toEqual([]);
  });

  it('refuses a write tool whose feature flag is off', async () => {
    const context = createFakeToolContext({
      auth: { scopes: FAKE_READ_WRITE_SCOPES },
      featureFlags: [],
    });
    const result = await registry.call(
      'lock_or_unlock_card',
      { card_id: 'card_ava01_01', action: 'lock', rationale: 'freeze it' },
      context,
    );
    expect(result.isError).toBe(true);
    expect(context.xray.lastOfType('tool.call.denied')?.data.denied_reason).toBe('feature_flag');
  });

  it('still records the declared intent of a call it then refuses', async () => {
    const context = createFakeToolContext({ auth: { scopes: ['profile' as Scope] } });
    await registry.call('load_bills', { from_date: 'x', to_date: 'y', rationale: 'why' }, context);
    expect(context.xray.lastOfType('intent.declared')?.data.tool).toBe('load_bills');
    expect(context.xray.lastOfType('tool.call.denied')).toBeDefined();
  });

  it('returns a tool error, not a protocol error, for arguments that do not match the schema', async () => {
    const context = createFakeToolContext();
    const result = await registry.call('process_data', { table_name: 't' }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('did not match its schema');
    expect(result.content[0]?.text).toMatch(/^Ran into an error: /);
    expect(context.xray.ofType('tool.call.denied')).toHaveLength(0);
  });

  it('turns an unexpected failure inside a handler into a tool error, not a rejection', async () => {
    // The fake bank throws for a persona it has never seen, which is as close as a fake gets to
    // an unexpected internal failure.
    const context = createFakeToolContext({
      auth: {
        persona: {
          id: 'per_ghost',
          name: 'Ghost Customer',
          kind: 'retail',
          shared: false,
          seed: 'ghost',
          email: 'ghost@example.com',
          created_at: '2026-01-05T09:00:00.000Z',
          transfer_limit_cents: 100_000,
        },
      },
    });
    const result = await registry.call('load_accounts', { rationale: 'balances' }, context);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('unknown persona: per_ghost');
    expect(result.content[0]?.text).toMatch(/^Ran into an error: /);
  });

  it('counts what it did', async () => {
    const isolated = createTools();
    const context = createFakeToolContext();
    await isolated.call('get_current_user', { rationale: 'who' }, context);
    await isolated.call('process_data', { table_name: 't' }, context);
    expect(isolated.stats()).toMatchObject({ calls: 2, denied: 0, errors: 1 });
    isolated.reset();
    expect(isolated.stats()).toMatchObject({ calls: 0, errors: 0 });
  });
});
