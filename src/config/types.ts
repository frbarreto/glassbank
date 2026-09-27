/** Shape of the validated configuration produced by `loadConfig` (block: app). */

export type NodeEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** CLAUDE.md invariant 10: log-only until real claude.ai Origin values are recorded, then allowlist. */
export type OriginPolicy = 'log-only' | 'allowlist';

export interface RateLimitConfig {
  /** POST /register attempts per IP per hour. */
  readonly ipRegisterPerHour: number;
  /** GET /authorize requests per IP per 15 minutes. */
  readonly ipAuthorizePer15Min: number;
  /** `RATE_LIMIT_IP_TOKEN`, per IP per 15 minutes: the un-forgeable half of the /token limit. */
  readonly ipTokenPer15Min: number;
  /** POST /consent submissions per IP per 15 minutes. */
  readonly ipConsentPer15Min: number;
  /** Failed pairing-code exchanges per IP per minute. */
  readonly ipPairFailuresPerMin: number;
  /** POST /token requests per client_id or grant_id per 15 minutes. */
  readonly clientTokenPer15Min: number;
  /** tools/call requests per grant per minute. */
  readonly grantToolCallsPerMin: number;
  /** Public lane (D-26): tools/call per IP prefix per minute. */
  readonly publicIpToolCallsPerMin: number;
  /** Public lane (D-26): tools/call per minute across every anonymous visitor. */
  readonly publicToolCallsPerMin: number;
  /** New grants per login_id per day. */
  readonly loginGrantsPerDay: number;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly logLevel: LogLevel;

  /** Fallback canonical base URL when the request Host is not listed in `publicHosts`. */
  readonly publicBaseUrl: string;
  /** Every hostname this service answers on; always contains the host of `publicBaseUrl`. */
  readonly publicHosts: readonly string[];
  readonly originPolicy: OriginPolicy;
  /** Parsed FEATURE_FLAGS; `writes` and `transfers` are on by default (Decision D-3). */
  readonly featureFlags: readonly string[];
  /** `PUBLIC_MCP`: serve the sign-in-free endpoint at `/public/mcp` (D-26); on by default. */
  readonly publicMcp: boolean;

  /** HS256 signing key. Never log this value (CLAUDE.md invariant 7). */
  readonly oauthSigningKey: string;
  readonly xrayAdminToken: string | undefined;
  /** True when the insecure development default is in use; refused when nodeEnv is production. */
  readonly usingDevelopmentSigningKey: boolean;

  readonly xrayDbPath: string;
  readonly xrayRetentionHours: number;
  /** Hard row cap on the X-ray event log, alongside the time-based retention. */
  readonly xrayMaxLogRows: number;
  /**
   * v0.9 (D-28): byte cap on the event log. Events are stored whole, never truncated, so the
   * oldest whole events go first when the log outgrows it.
   */
  readonly xrayMaxLogBytes: number;
  /** v0.9 (D-28): path prefixes the catch-all `http.request` observer leaves out. */
  readonly xrayCaptureSkipPaths: readonly string[];
  readonly xsIdleGapMinutes: number;
  /** Concurrent SSE streams one login may hold open on the dashboard. */
  readonly xrayMaxStreamsPerLogin: number;
  /** Concurrent SSE streams the whole process may hold open. */
  readonly xrayMaxStreams: number;
  /** Concurrent SSE streams of the public lane, every reader together (D-26). */
  readonly xrayMaxPublicStreams: number;

  readonly authDbPath: string;
  readonly maxDcrClients: number;
  readonly cimdEnabled: boolean;

  readonly maxTablesPerGrant: number;
  readonly maxScratchDbs: number;
  readonly maxQueryRows: number;
  readonly tableTtlMinutes: number;
  readonly queryTimeoutMs: number;
  readonly maxConcurrentEtlOps: number;
  readonly etlWorkerPoolSize: number;
  /** Hard query timeouts one grant may cause before its queries are refused up front. */
  readonly maxQueryTimeouts: number;

  readonly maxMaterialisedPersonas: number;
  readonly maxPersonaOverlays: number;
  readonly personaOverlayTtlHours: number;

  readonly rateLimits: RateLimitConfig;

  readonly snapshotBucket: string | undefined;
}
