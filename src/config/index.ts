/**
 * Typed environment parsing for Glass Bank (block: app).
 *
 * Every knob listed in docs/DEPLOYMENT.md section 3 is parsed here exactly once, with the
 * documented default, and validated with zod. `loadConfig` throws a single readable
 * `ConfigError` listing every missing or malformed variable rather than failing on the first one.
 *
 * See also: .env.example (same list, same defaults), CLAUDE.md invariant 14 ("all caps are env knobs").
 */
import { z } from 'zod';

export type { AppConfig } from './types.js';
export { ConfigError } from './errors.js';

import type { AppConfig } from './types.js';
import { ConfigError } from './errors.js';

/** Raw environment shape: everything arrives as a string or is absent. */
type RawEnv = Record<string, string | undefined>;

const DEV_SIGNING_KEY = 'dev-only-insecure-signing-key-change-me-32+';

/**
 * The `.env.example` admin token. Observer mode reads every login on the server, so this is
 * treated exactly like the signing key: long enough to be a real secret, and refused outright in
 * production so a copied `.env.example` fails closed instead of opening observer mode.
 */
const DEV_ADMIN_TOKEN = 'dev-only-insecure-admin-token-change-me-32+';

/** An integer variable with a documented default. Non-integer input fails validation. */
function intVar(defaultValue: number, min: number, max: number) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
  }, z.number().int().min(min).max(max));
}

/** A boolean variable spelled `true`/`false` (also accepts 1/0, yes/no). */
function boolVar(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim().toLowerCase();
    if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes') return true;
    if (trimmed === 'false' || trimmed === '0' || trimmed === 'no') return false;
    return trimmed;
  }, z.boolean());
}

/** A string variable with a documented default; an empty value falls back to the default. */
function strVar(defaultValue: string) {
  return z.preprocess((value) => {
    if (value === undefined) return defaultValue;
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? defaultValue : trimmed;
  }, z.string().min(1));
}

/** An optional string variable: absent or empty becomes `undefined`. */
function optionalStrVar() {
  return z.preprocess((value) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }, z.string().min(1).optional());
}

/**
 * A ';'-separated list. The separator is ';' and not ',' because `gcloud run deploy
 * --set-env-vars` splits on commas (docs/DEPLOYMENT.md section 1.2).
 */
function listVar(defaultValue: string) {
  return z.preprocess(
    (value) => {
      const source = typeof value === 'string' && value.trim() !== '' ? value : defaultValue;
      if (typeof source !== 'string') return source;
      return source
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
    },
    z.array(z.string().min(1)),
  );
}

/** An absolute http(s) URL, without a trailing slash. */
function urlVar(defaultValue: string) {
  return z.preprocess(
    (value) => {
      const source = typeof value === 'string' && value.trim() !== '' ? value.trim() : defaultValue;
      return typeof source === 'string' ? source.replace(/\/+$/, '') : source;
    },
    z.string().refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'must be an absolute http(s) URL'),
  );
}

const schema = z.object({
  // Runtime
  NODE_ENV: z.preprocess(
    (v) => (v === undefined || v === '' ? 'development' : v),
    z.enum(['development', 'test', 'production']),
  ),
  PORT: intVar(8080, 1, 65535),
  LOG_LEVEL: z.preprocess(
    (v) => (v === undefined || v === '' ? 'info' : v),
    z.enum(['debug', 'info', 'warn', 'error']),
  ),

  // Public identity (CLAUDE.md invariant 4)
  PUBLIC_BASE_URL: urlVar('http://localhost:8080'),
  PUBLIC_HOSTS: listVar(''),
  ORIGIN_POLICY: z.preprocess(
    (v) => (v === undefined || v === '' ? 'log-only' : v),
    z.enum(['log-only', 'allowlist']),
  ),
  FEATURE_FLAGS: listVar('writes;transfers'),
  PUBLIC_MCP: boolVar(true),

  // Secrets
  OAUTH_SIGNING_KEY: strVar(DEV_SIGNING_KEY).pipe(z.string().min(32)),
  XRAY_ADMIN_TOKEN: optionalStrVar().pipe(z.string().min(32).optional()),

  // X-ray event log
  XRAY_DB_PATH: strVar('/tmp/xray.sqlite'),
  XRAY_RETENTION_HOURS: intVar(72, 1, 24 * 365),
  XRAY_MAX_LOG_ROWS: intVar(200_000, 100, 100_000_000),
  XS_IDLE_GAP_MINUTES: intVar(15, 1, 1440),
  XRAY_MAX_STREAMS_PER_LOGIN: intVar(4, 1, 10_000),
  XRAY_MAX_STREAMS: intVar(64, 1, 100_000),
  XRAY_MAX_PUBLIC_STREAMS: intVar(16, 1, 100_000),

  // Auth storage
  AUTH_DB_PATH: strVar('/tmp/auth.sqlite'),
  MAX_DCR_CLIENTS: intVar(1000, 1, 1_000_000),
  CIMD_ENABLED: boolVar(false),

  // ETL / scratch SQL guard
  MAX_TABLES_PER_GRANT: intVar(10, 1, 1000),
  MAX_SCRATCH_DBS: intVar(200, 1, 100_000),
  MAX_QUERY_ROWS: intVar(100, 1, 10_000),
  TABLE_TTL_MINUTES: intVar(30, 1, 1440),
  QUERY_TIMEOUT_MS: intVar(2000, 50, 300_000),
  MAX_CONCURRENT_ETL_OPS: intVar(2, 1, 64),
  ETL_WORKER_POOL_SIZE: intVar(4, 1, 64),
  MAX_QUERY_TIMEOUTS: intVar(3, 1, 10_000),

  // Bank core caps
  MAX_MATERIALISED_PERSONAS: intVar(200, 1, 100_000),
  MAX_PERSONA_OVERLAYS: intVar(1000, 1, 1_000_000),
  PERSONA_OVERLAY_TTL_HOURS: intVar(24, 1, 24 * 365),

  // Rate limits (counts; the window is part of the variable name)
  RATE_LIMIT_IP_REGISTER: intVar(60, 1, 1_000_000),
  RATE_LIMIT_IP_AUTHORIZE: intVar(300, 1, 1_000_000),
  RATE_LIMIT_IP_TOKEN: intVar(300, 1, 1_000_000),
  RATE_LIMIT_IP_CONSENT: intVar(60, 1, 1_000_000),
  RATE_LIMIT_IP_PAIR_FAILURES: intVar(5, 1, 1_000_000),
  RATE_LIMIT_CLIENT_TOKEN: intVar(120, 1, 1_000_000),
  RATE_LIMIT_GRANT_TOOL_CALLS: intVar(120, 1, 1_000_000),
  RATE_LIMIT_LOGIN_GRANTS: intVar(20, 1, 1_000_000),
  RATE_LIMIT_PUBLIC_IP_TOOL_CALLS: intVar(60, 1, 1_000_000),
  RATE_LIMIT_PUBLIC_TOOL_CALLS: intVar(600, 1, 1_000_000),

  // Optional (Phase 3)
  SNAPSHOT_BUCKET: optionalStrVar(),
});

type ParsedEnv = z.infer<typeof schema>;

/**
 * Every variable `loadConfig` understands, in the order they are declared above.
 * `.env.example` must list exactly these (plus nothing); a test asserts the parity.
 */
export const ENV_VARIABLE_NAMES: readonly string[] = Object.keys(schema.shape);

/** Hostname (with port when non-default) of an absolute URL, used to seed PUBLIC_HOSTS. */
function hostOf(url: string): string {
  return new URL(url).host;
}

/**
 * Read, default, validate and shape the environment.
 *
 * @throws ConfigError listing every problem, one variable per line.
 */
export function loadConfig(env: RawEnv = process.env): AppConfig {
  const result = schema.safeParse(env);
  const problems: string[] = [];

  if (!result.success) {
    for (const issue of result.error.issues) {
      const name = issue.path.length > 0 ? String(issue.path[0]) : '(root)';
      problems.push(`${name}: ${issue.message}`);
    }
    throw new ConfigError(problems);
  }

  const parsed: ParsedEnv = result.data;

  // Production refuses to boot on the development signing key (CLAUDE.md invariant 7).
  if (parsed.NODE_ENV === 'production' && parsed.OAUTH_SIGNING_KEY === DEV_SIGNING_KEY) {
    problems.push(
      'OAUTH_SIGNING_KEY: must be set from Secret Manager when NODE_ENV=production (the development default is refused)',
    );
  }
  // Observer mode over every login on the server gets the same treatment (CLAUDE.md invariant 11).
  if (parsed.NODE_ENV === 'production' && parsed.XRAY_ADMIN_TOKEN === DEV_ADMIN_TOKEN) {
    problems.push(
      'XRAY_ADMIN_TOKEN: must be set from Secret Manager when NODE_ENV=production (the development default is refused)',
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);

  // The canonical base URL's own host is always accepted, so PUBLIC_HOSTS may be left empty locally.
  const hosts = [...new Set([hostOf(parsed.PUBLIC_BASE_URL), ...parsed.PUBLIC_HOSTS])];

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,

    publicBaseUrl: parsed.PUBLIC_BASE_URL,
    publicHosts: hosts,
    originPolicy: parsed.ORIGIN_POLICY,
    featureFlags: parsed.FEATURE_FLAGS,
    publicMcp: parsed.PUBLIC_MCP,

    oauthSigningKey: parsed.OAUTH_SIGNING_KEY,
    xrayAdminToken: parsed.XRAY_ADMIN_TOKEN,
    usingDevelopmentSigningKey: parsed.OAUTH_SIGNING_KEY === DEV_SIGNING_KEY,

    xrayDbPath: parsed.XRAY_DB_PATH,
    xrayRetentionHours: parsed.XRAY_RETENTION_HOURS,
    xrayMaxLogRows: parsed.XRAY_MAX_LOG_ROWS,
    xsIdleGapMinutes: parsed.XS_IDLE_GAP_MINUTES,
    xrayMaxStreamsPerLogin: parsed.XRAY_MAX_STREAMS_PER_LOGIN,
    xrayMaxStreams: parsed.XRAY_MAX_STREAMS,
    xrayMaxPublicStreams: parsed.XRAY_MAX_PUBLIC_STREAMS,

    authDbPath: parsed.AUTH_DB_PATH,
    maxDcrClients: parsed.MAX_DCR_CLIENTS,
    cimdEnabled: parsed.CIMD_ENABLED,

    maxTablesPerGrant: parsed.MAX_TABLES_PER_GRANT,
    maxScratchDbs: parsed.MAX_SCRATCH_DBS,
    maxQueryRows: parsed.MAX_QUERY_ROWS,
    tableTtlMinutes: parsed.TABLE_TTL_MINUTES,
    queryTimeoutMs: parsed.QUERY_TIMEOUT_MS,
    maxConcurrentEtlOps: parsed.MAX_CONCURRENT_ETL_OPS,
    etlWorkerPoolSize: parsed.ETL_WORKER_POOL_SIZE,
    maxQueryTimeouts: parsed.MAX_QUERY_TIMEOUTS,

    maxMaterialisedPersonas: parsed.MAX_MATERIALISED_PERSONAS,
    maxPersonaOverlays: parsed.MAX_PERSONA_OVERLAYS,
    personaOverlayTtlHours: parsed.PERSONA_OVERLAY_TTL_HOURS,

    rateLimits: {
      ipRegisterPerHour: parsed.RATE_LIMIT_IP_REGISTER,
      ipAuthorizePer15Min: parsed.RATE_LIMIT_IP_AUTHORIZE,
      ipTokenPer15Min: parsed.RATE_LIMIT_IP_TOKEN,
      ipConsentPer15Min: parsed.RATE_LIMIT_IP_CONSENT,
      ipPairFailuresPerMin: parsed.RATE_LIMIT_IP_PAIR_FAILURES,
      clientTokenPer15Min: parsed.RATE_LIMIT_CLIENT_TOKEN,
      grantToolCallsPerMin: parsed.RATE_LIMIT_GRANT_TOOL_CALLS,
      loginGrantsPerDay: parsed.RATE_LIMIT_LOGIN_GRANTS,
      publicIpToolCallsPerMin: parsed.RATE_LIMIT_PUBLIC_IP_TOOL_CALLS,
      publicToolCallsPerMin: parsed.RATE_LIMIT_PUBLIC_TOOL_CALLS,
    },

    snapshotBucket: parsed.SNAPSHOT_BUCKET,
  };
}

/** True when the named flag is present in FEATURE_FLAGS (Decision D-3 turns writes on by default). */
export function hasFeatureFlag(config: AppConfig, flag: string): boolean {
  return config.featureFlags.includes(flag);
}
