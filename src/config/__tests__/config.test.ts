import { describe, expect, it } from 'vitest';

import { ConfigError, ENV_VARIABLE_NAMES, hasFeatureFlag, loadConfig } from '../index.js';

/** A minimal environment: everything else must come from the documented defaults. */
const EMPTY: Record<string, string | undefined> = {};

describe('loadConfig defaults (docs/DEPLOYMENT.md section 3)', () => {
  it('applies every documented default', () => {
    const config = loadConfig(EMPTY);

    expect(config.nodeEnv).toBe('development');
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('info');

    expect(config.publicBaseUrl).toBe('http://localhost:8080');
    expect(config.originPolicy).toBe('log-only');
    // Decision D-3: write tools are on by default.
    expect(config.featureFlags).toEqual(['writes', 'transfers']);

    expect(config.xrayDbPath).toBe('/tmp/xray.sqlite');
    expect(config.xrayRetentionHours).toBe(72);
    expect(config.xsIdleGapMinutes).toBe(15);

    expect(config.authDbPath).toBe('/tmp/auth.sqlite');
    expect(config.maxDcrClients).toBe(1000);
    expect(config.cimdEnabled).toBe(false);

    expect(config.maxTablesPerGrant).toBe(10);
    expect(config.maxScratchDbs).toBe(200);
    expect(config.maxQueryRows).toBe(100);
    expect(config.tableTtlMinutes).toBe(30);
    expect(config.queryTimeoutMs).toBe(2000);
    expect(config.maxConcurrentEtlOps).toBe(2);
    expect(config.etlWorkerPoolSize).toBe(4);

    expect(config.maxMaterialisedPersonas).toBe(200);
    expect(config.maxPersonaOverlays).toBe(1000);
    expect(config.personaOverlayTtlHours).toBe(24);

    expect(config.rateLimits).toEqual({
      ipRegisterPerHour: 60,
      ipAuthorizePer15Min: 300,
      ipTokenPer15Min: 300,
      ipConsentPer15Min: 60,
      ipPairFailuresPerMin: 5,
      clientTokenPer15Min: 120,
      grantToolCallsPerMin: 120,
      loginGrantsPerDay: 20,
    });

    expect(config.snapshotBucket).toBeUndefined();
    expect(config.xrayAdminToken).toBeUndefined();
  });

  it('always accepts the host of PUBLIC_BASE_URL and splits PUBLIC_HOSTS on ";"', () => {
    const config = loadConfig({
      PUBLIC_BASE_URL: 'https://mcp-bank-520283334162.us-central1.run.app',
      PUBLIC_HOSTS: 'mcp-bank-abcdef-uc.a.run.app; example.trycloudflare.com ',
    });
    expect(config.publicHosts).toEqual([
      'mcp-bank-520283334162.us-central1.run.app',
      'mcp-bank-abcdef-uc.a.run.app',
      'example.trycloudflare.com',
    ]);
  });

  it('strips a trailing slash from PUBLIC_BASE_URL', () => {
    expect(loadConfig({ PUBLIC_BASE_URL: 'https://example.com/' }).publicBaseUrl).toBe(
      'https://example.com',
    );
  });

  it('splits FEATURE_FLAGS on ";" because gcloud --set-env-vars splits on commas', () => {
    const config = loadConfig({ FEATURE_FLAGS: 'writes;transfers;experiment' });
    expect(hasFeatureFlag(config, 'transfers')).toBe(true);
    expect(hasFeatureFlag(config, 'nope')).toBe(false);
  });

  it('parses booleans and integers from strings', () => {
    const config = loadConfig({ CIMD_ENABLED: 'true', QUERY_TIMEOUT_MS: '500' });
    expect(config.cimdEnabled).toBe(true);
    expect(config.queryTimeoutMs).toBe(500);
  });
});

describe('loadConfig validation', () => {
  it('lists every problem in one readable error', () => {
    let error: unknown;
    try {
      loadConfig({
        PORT: 'eight thousand',
        ORIGIN_POLICY: 'wide-open',
        MAX_QUERY_ROWS: '-3',
        PUBLIC_BASE_URL: 'not a url',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    const configError = error as ConfigError;
    expect(configError.problems).toHaveLength(4);
    const names = configError.problems.map((problem) => problem.split(':')[0]).sort();
    expect(names).toEqual(['MAX_QUERY_ROWS', 'ORIGIN_POLICY', 'PORT', 'PUBLIC_BASE_URL']);
    expect(configError.message).toContain('Invalid environment configuration (4 problems)');
    expect(configError.message).toContain('.env.example');
  });

  it('refuses the development signing key in production (CLAUDE.md invariant 7)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/OAUTH_SIGNING_KEY/);
    const config = loadConfig({
      NODE_ENV: 'production',
      OAUTH_SIGNING_KEY: 'a'.repeat(48),
    });
    expect(config.usingDevelopmentSigningKey).toBe(false);
  });

  it('rejects a signing key shorter than 32 characters', () => {
    expect(() => loadConfig({ OAUTH_SIGNING_KEY: 'short' })).toThrow(ConfigError);
  });

  it('flags the development signing key outside production', () => {
    expect(loadConfig(EMPTY).usingDevelopmentSigningKey).toBe(true);
  });

  it('holds XRAY_ADMIN_TOKEN to the same bar as the signing key', () => {
    // Observer mode reads every login on the server, so a one-character or leftover development
    // admin token must not boot: it is a secret exactly like OAUTH_SIGNING_KEY (invariant 11).
    expect(() => loadConfig({ XRAY_ADMIN_TOKEN: 'x' })).toThrow(/XRAY_ADMIN_TOKEN/);
    expect(() => loadConfig({ XRAY_ADMIN_TOKEN: 'a'.repeat(31) })).toThrow(ConfigError);
    expect(loadConfig({ XRAY_ADMIN_TOKEN: 'a'.repeat(32) }).xrayAdminToken).toBe('a'.repeat(32));
    // Absent stays absent: observer mode is simply off.
    expect(loadConfig(EMPTY).xrayAdminToken).toBeUndefined();
  });

  it('refuses the .env.example admin token in production', () => {
    const production = {
      NODE_ENV: 'production',
      OAUTH_SIGNING_KEY: 'a'.repeat(48),
    };
    expect(() =>
      loadConfig({ ...production, XRAY_ADMIN_TOKEN: 'dev-only-insecure-admin-token-change-me-32+' }),
    ).toThrow(/XRAY_ADMIN_TOKEN/);
    // A real secret is accepted, and so is no admin token at all.
    expect(
      loadConfig({ ...production, XRAY_ADMIN_TOKEN: 'c'.repeat(40) }).xrayAdminToken,
    ).toBe('c'.repeat(40));
    expect(loadConfig(production).xrayAdminToken).toBeUndefined();
  });
});

describe('.env.example parity', () => {
  it('lists exactly the variables loadConfig understands', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = fileURLToPath(new URL('../../../.env.example', import.meta.url));
    const documented = [...readFileSync(path, 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(
      (match) => match[1],
    );

    // NODE_ENV and LOG_LEVEL are set by infra/deploy.sh rather than listed in the knob table.
    expect([...documented].sort()).toEqual([...ENV_VARIABLE_NAMES].sort());
  });
});
