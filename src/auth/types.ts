/**
 * Local shapes for the `auth` block (block: auth).
 *
 * `src/auth` may import `src/contracts` and itself only (docs/REPO_LAYOUT.md section 3), so it
 * cannot reference `AppConfig` from `src/config`. Everything the block needs from the
 * environment is re-declared here as a narrow structural type and injected by `src/app.ts`.
 */
import type {
  FeatureFlag,
  Pairing,
  Persona,
  PersonaDirectory,
  PublicHostConfig,
  XrayEmitter,
} from '../contracts/index.js';

/** The knobs of docs/DEPLOYMENT.md section 3 that this block reads. */
export interface AuthRateLimitConfig {
  /** `RATE_LIMIT_IP_REGISTER`, per IP per hour. */
  readonly ipRegisterPerHour: number;
  /** `RATE_LIMIT_IP_AUTHORIZE`, per IP per 15 minutes. */
  readonly ipAuthorizePer15Min: number;
  /** `RATE_LIMIT_IP_TOKEN`, per IP per 15 minutes, charged on /token and /revoke. */
  readonly ipTokenPer15Min: number;
  /** `RATE_LIMIT_IP_CONSENT`, per IP per 15 minutes. */
  readonly ipConsentPer15Min: number;
  /** `RATE_LIMIT_CLIENT_TOKEN`, per `client_id` (falling back to IP) per 15 minutes. */
  readonly clientTokenPer15Min: number;
  /** `RATE_LIMIT_LOGIN_GRANTS`, new grants per `login_id` per day (invariant 14). */
  readonly loginGrantsPerDay: number;
}

/** Exactly the configuration `createAuth` needs. A subset of `AppConfig`, by structural typing. */
export interface AuthConfig extends PublicHostConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  /** HS256 key. Never logged, never echoed (CLAUDE.md invariant 7). */
  readonly oauthSigningKey: string;
  readonly featureFlags: readonly string[];
  /** `MAX_DCR_CLIENTS`; the registration store is a bounded LRU (ADR-16). */
  readonly maxDcrClients: number;
  /**
   * `AUTH_DB_PATH`: the SQLite file the DCR client table lives in (A-12). Same durability as the
   * event log - it survives a restart locally and on a VM, not a Cloud Run instance replacement.
   * `:memory:` keeps the table in the process, which is what the tests use.
   */
  readonly authDbPath: string;
  /** `CIMD_ENABLED`; never advertised until it is implemented (A-37). */
  readonly cimdEnabled: boolean;
  readonly rateLimits: AuthRateLimitConfig;
}

/**
 * One structured line on stdout. The X-ray emitter replaced it as the block's observability
 * surface (L5); it stays as an optional debugging seam and as the default when no emitter is
 * injected, so a half-wired tree is not silent.
 */
export interface SpikeLogRecord {
  readonly event: string;
  readonly [key: string]: unknown;
}

export type SpikeLogger = (record: SpikeLogRecord) => void;

/** Everything `createAuth` is given. Only `config` is required. */
export interface AuthDeps {
  readonly config: AuthConfig;
  /**
   * Seeded personas and demo-persona minting. Injected from `bank-core` by `src/app.ts`;
   * the spike ships `createSpikePersonaDirectory()` so T0.3 runs before L1 exists.
   */
  readonly personas?: PersonaDirectory;
  /** Injected clock, so tests are deterministic. */
  readonly now?: () => Date;
  /**
   * The X-ray emitter (CLAUDE.md invariant 13). Every `auth.*` event this block decides goes
   * through it, contract-validated. Omitted, the block emits nothing and keeps logging to stdout.
   */
  readonly emitter?: XrayEmitter;
  /**
   * The dashboard pairing service (ADR-10), injected from `src/xray`. Used by the consent success
   * page to show a live X-ray link before the first tool call. Omitted, the page shows the
   * persona id and points at `xray_get_session_link` instead.
   */
  readonly pairing?: Pairing;
  /**
   * How long the consent success page stays on screen before it redirects itself to the client
   * callback. `0` turns the page off entirely and restores the bare 302 - the kill switch if a
   * real client ever turns out not to tolerate the interstitial.
   */
  readonly consentSuccessRedirectMs?: number;
  /**
   * Structured stdout logging. Defaults to `console.log` when no `emitter` is injected and to a
   * no-op when one is, so the two never double up.
   */
  readonly log?: SpikeLogger;
  /** Overrides the random id source in tests. */
  readonly randomId?: (bytes: number) => string;
}

/** A grant as the AS remembers it (ADR-14: grants are grouped by `login_id`). */
export interface GrantRecord {
  readonly grant_id: string;
  readonly login_id: string;
  readonly persona_id: string;
  readonly client_id: string;
  readonly scopes: readonly string[];
  readonly auth_level: 'read_only' | 'read_write';
  readonly parent_grant_id: string | null;
  readonly created_at: string;
  updated_at: string;
}

/** What the enabled feature flags are, narrowed to the contract's union. */
export type EnabledFlags = readonly FeatureFlag[];

export type { Persona };
