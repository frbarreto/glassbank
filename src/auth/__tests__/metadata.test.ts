/**
 * Discovery documents (docs/ARCHITECTURE.md section 5, CLAUDE.md invariant 4, A-36).
 *
 * The assertions mirror `infra/smoke.sh` check 4 line for line, so a green suite here predicts a
 * green smoke run against a deployed service.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OAUTH_ROUTES } from '../../contracts/index.js';

import { SECOND_PUBLIC_HOST, startAuthHarness, type Harness } from './harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startAuthHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('RFC 9728 protected-resource metadata', () => {
  it('is served at both /.well-known/oauth-protected-resource and .../mcp', async () => {
    for (const path of [
      OAUTH_ROUTES.protectedResourceMetadata,
      OAUTH_ROUTES.protectedResourceMetadataForMcp,
    ]) {
      const response = await harness.fetch(path);
      expect(response.status, path).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.resource).toBe(`${harness.baseUrl}/mcp`);
      expect(body.authorization_servers).toEqual([harness.baseUrl]);
      expect(body.scopes_supported).toContain('accounts:read');
      expect(body.bearer_methods_supported).toEqual(['header']);
    }
  });

  it('derives resource and issuer from the request Host for every PUBLIC_HOSTS entry (A-36)', async () => {
    // The second listed host is not the one PUBLIC_BASE_URL names, so it must come back https.
    const response = await harness.rawGet(OAUTH_ROUTES.protectedResourceMetadataForMcp, {
      host: SECOND_PUBLIC_HOST,
    });
    const body = response.json() as Record<string, unknown>;
    expect(body.resource).toBe(`https://${SECOND_PUBLIC_HOST}/mcp`);
    expect(body.authorization_servers).toEqual([`https://${SECOND_PUBLIC_HOST}`]);
  });

  it('falls back to PUBLIC_BASE_URL for a Host that is not listed', async () => {
    const response = await harness.rawGet(OAUTH_ROUTES.protectedResourceMetadataForMcp, {
      host: 'attacker.example.com',
    });
    const body = response.json() as Record<string, unknown>;
    expect(body.resource).toBe(`${harness.baseUrl}/mcp`);
  });
});

describe('RFC 8414 authorization-server metadata', () => {
  it('advertises exactly what infra/smoke.sh asserts', async () => {
    const response = await harness.fetch(OAUTH_ROUTES.authorizationServerMetadata);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.issuer).toBe(harness.baseUrl);
    expect(body.authorization_endpoint).toBe(`${harness.baseUrl}/authorize`);
    expect(body.token_endpoint).toBe(`${harness.baseUrl}/token`);
    expect(body.registration_endpoint).toBe(`${harness.baseUrl}/register`);
    expect(body.revocation_endpoint).toBe(`${harness.baseUrl}/revoke`);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(body.token_endpoint_auth_methods_supported).toContain('none');
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
  });

  it('never advertises CIMD while CIMD_ENABLED is unimplemented (A-37)', async () => {
    const response = await harness.fetch(OAUTH_ROUTES.authorizationServerMetadata);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('client_id_metadata_document_supported');
  });

  it('hides write scopes when the writes flag is off (ADR-12)', async () => {
    const readOnly = await startAuthHarness({ featureFlags: [] });
    try {
      const response = await readOnly.fetch(OAUTH_ROUTES.authorizationServerMetadata);
      const body = (await response.json()) as { scopes_supported: string[] };
      expect(body.scopes_supported).toContain('cards:read');
      expect(body.scopes_supported).not.toContain('cards:write');
      expect(body.scopes_supported).not.toContain('transfers:write');
    } finally {
      await readOnly.close();
    }
  });

  it('answers a CORS preflight so browser-based clients can discover it', async () => {
    const response = await harness.fetch(OAUTH_ROUTES.authorizationServerMetadata, {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
  });
});
