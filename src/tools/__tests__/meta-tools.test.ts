/**
 * The reference, meta and X-ray tools: `get_bank_categories`, `get_currencies`,
 * `get_current_user`, `get_tool_availability` and `xray_get_session_link`.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FEATURE_FLAGS, type ToolResult } from '../../contracts/index.js';
import { createTools } from '../index.js';

import { FAKE_READ_ONLY_SCOPES, createFakeToolContext } from './fakes.js';

const registry = createTools();

function text(result: ToolResult): string {
  return result.content.map((part) => part.text).join('');
}

describe('reference tools', () => {
  it('get_bank_categories returns the category table as JSON, with no bank record read', async () => {
    const context = createFakeToolContext();
    const result = await registry.call(
      'get_bank_categories',
      { rationale: 'map category ids to names' },
      context,
    );
    const parsed = JSON.parse(text(result)) as { id: string; name: string }[];
    expect(parsed.length).toBeGreaterThan(10);
    expect(parsed[0]).toEqual({ id: '1', name: 'Advertising' });
    expect(result.structuredContent).toMatchObject({ count: parsed.length });
  });

  it('get_currencies lists USD first (Decision D-1)', async () => {
    const context = createFakeToolContext();
    const result = await registry.call('get_currencies', { rationale: 'check USD' }, context);
    const parsed = JSON.parse(text(result)) as { code: string; minor_unit_digits: number }[];
    expect(parsed[0]?.code).toBe('USD');
    expect(parsed[0]?.minor_unit_digits).toBe(2);
  });

  it('needs no scope at all', async () => {
    const context = createFakeToolContext({ auth: { scopes: [] } });
    expect(
      (await registry.call('get_bank_categories', { rationale: 'reference' }, context)).isError,
    ).toBeUndefined();
    expect(
      (await registry.call('get_currencies', { rationale: 'reference' }, context)).isError,
    ).toBeUndefined();
  });
});

describe('get_current_user', () => {
  it('names the persona, the grant and the boot id (A-15)', async () => {
    const context = createFakeToolContext();
    const result = await registry.call('get_current_user', { rationale: 'who am I' }, context);
    expect(result.structuredContent).toEqual({
      persona_id: 'per_ava01',
      persona_name: 'Ava Bennett',
      persona_kind: 'retail',
      shared_persona: true,
      login_id: 'lgn_demo01',
      grant_id: 'grt_demo01',
      scopes: [...FAKE_READ_ONLY_SCOPES],
      auth_level: 'read_only',
      token_expires_at: context.auth.token_expires_at,
      xray_session_id: 'xs_demo01',
      boot_id: 'boot_fake01',
    });
    expect(text(result)).toContain('Ava Bennett');
    expect(text(result)).toContain('boot_fake01');
    expect(text(result)).toContain('the server restarted');
    expect(text(result)).toContain('shared demo customers');
  });

  it('tells a generated persona apart from a shared one', async () => {
    const context = createFakeToolContext({
      auth: {
        persona: {
          id: 'per_demo9',
          name: 'Demo Customer 9',
          kind: 'business',
          shared: false,
          seed: 'demo9',
          email: 'demo9@example.com',
          created_at: '2026-01-05T09:00:00.000Z',
          transfer_limit_cents: 500_000,
        },
      },
    });
    const result = await registry.call('get_current_user', { rationale: 'who am I' }, context);
    expect(text(result)).toContain('generated demo customer');
    expect(result.structuredContent).toMatchObject({ shared_persona: false });
  });

  it('is available with nothing but the implicit profile scope', async () => {
    const context = createFakeToolContext({ auth: { scopes: [] } });
    const result = await registry.call('get_current_user', { rationale: 'who am I' }, context);
    expect(result.isError).toBeUndefined();
  });
});

describe('get_tool_availability', () => {
  it('returns the whole table with its content hash and emits catalog.availability', async () => {
    const context = createFakeToolContext();
    const result = await registry.call(
      'get_tool_availability',
      { rationale: 'explain what I can do' },
      context,
    );
    const expected = registry.availabilityFor(
      { scopes: context.auth.scopes, auth_level: context.auth.auth_level },
      DEFAULT_FEATURE_FLAGS,
    );
    expect(result.structuredContent).toEqual({
      content_hash: expected.content_hash,
      tools: expected.tools,
      feature_flags: [...DEFAULT_FEATURE_FLAGS],
    });
    expect(text(result)).toContain('create_transfer: listed but unavailable');
    expect(text(result)).toContain('still needs transfers:write');
    expect(text(result)).toContain('load_accounts: available');

    const emitted = context.xray.lastOfType('catalog.availability');
    expect(emitted?.data.source).toBe('get_tool_availability');
    expect(emitted?.data.content_hash).toBe(expected.content_hash);
    expect(emitted?.data.availability).toHaveLength(17);
    expect(emitted?.xs).toBe('xs_demo01');
    expect(emitted?.grant_id).toBe('grt_demo01');
  });

  it('explains a hidden tool differently from a listed-but-unavailable one', async () => {
    const context = createFakeToolContext({
      auth: { scopes: FAKE_READ_ONLY_SCOPES.filter((scope) => scope !== 'cards:read') },
      featureFlags: ['writes'],
    });
    const result = await registry.call('get_tool_availability', { rationale: 'why' }, context);
    expect(text(result)).toContain('load_cards: hidden - missing_scopes (still needs cards:read)');
    expect(text(result)).toContain('create_transfer: hidden - disabled_for_deployment');
    expect(text(result)).toContain('lock_or_unlock_card: listed but unavailable');
  });
});

describe('xray_get_session_link', () => {
  it('mints a login-bound pairing code and tells the model to show it verbatim', async () => {
    const context = createFakeToolContext();
    const result = await registry.call(
      'xray_get_session_link',
      { rationale: 'the user wants to watch' },
      context,
    );
    const minted = context.pairing.issued[0];
    expect(minted).toBeDefined();
    expect(result.structuredContent).toEqual({
      code: minted!.code,
      url: minted!.url,
      expires_at: minted!.expires_at,
    });
    expect(minted!.code).toMatch(/^BANK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/);
    expect(text(result)).toContain('Open this to watch what happens behind the scenes');
    expect(text(result)).toContain(minted!.url);
    expect(text(result)).toContain('verbatim');
    expect(text(result)).toContain('every session of this login');
  });

  it('refuses when the grant has no login to bind the dashboard to', async () => {
    const context = createFakeToolContext({ auth: { login_id: null } });
    const result = await registry.call('xray_get_session_link', { rationale: 'watch' }, context);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('no login');
    expect(context.pairing.issued).toHaveLength(0);
  });

  it('is hidden and refused without the xray:read scope', async () => {
    const context = createFakeToolContext({
      auth: { scopes: FAKE_READ_ONLY_SCOPES.filter((scope) => scope !== 'xray:read') },
    });
    expect(
      registry
        .listFor(
          { scopes: context.auth.scopes, auth_level: context.auth.auth_level },
          DEFAULT_FEATURE_FLAGS,
        )
        .listed.map((entry) => entry.name),
    ).not.toContain('xray_get_session_link');
    const result = await registry.call('xray_get_session_link', { rationale: 'watch' }, context);
    expect(result.isError).toBe(true);
    expect(text(result)).toContain('xray:read');
  });
});
