/**
 * The knobs `src/bank-core` reads, and their defaults (block: bank-core).
 *
 * The block never reads `process.env`: `src/config` parses the environment and `src/app.ts`
 * injects the values (docs/REPO_LAYOUT.md section 3, CLAUDE.md "no global mutable state outside
 * the composition root"). The names mirror the env knobs of `docs/DEPLOYMENT.md` section 3, and
 * the defaults are the same numbers, so a test that injects nothing behaves like production.
 *
 * Every cap here exists for invariant 14 / ADR-16: the server accepts passwordless logins from
 * anyone on a 1 GiB singleton, so datasets, overlays, audit trails and open transfer previews are
 * all bounded and evicted, never unbounded maps.
 */

export interface BankCoreConfig {
  /** `MAX_MATERIALISED_PERSONAS` (200): datasets held in memory before LRU eviction (ADR-15). */
  readonly maxMaterialisedPersonas: number;
  /** `MAX_PERSONA_OVERLAYS` (1000): live `persona x login` overlays before LRU eviction. */
  readonly maxPersonaOverlays: number;
  /** `PERSONA_OVERLAY_TTL_HOURS` (24): idle time after which a *shared* persona's overlay resets. */
  readonly personaOverlayTtlHours: number;
  /** Generated `per_<seed>` personas remembered by the directory before LRU eviction. */
  readonly maxGeneratedPersonas: number;
  /** Un-confirmed transfer previews held across all logins. */
  readonly maxOpenPreviews: number;
  /** How long a `create_transfer` preview stays confirmable. */
  readonly previewTtlMinutes: number;
  /** Audit entries kept per overlay; the oldest are dropped first. */
  readonly maxAuditEntriesPerOverlay: number;
  /** Transfers a single login may add to one overlay. */
  readonly maxOverlayTransfers: number;
  /** Page size when a list query does not ask for one (`DEFAULT_PAGE_SIZE`). */
  readonly defaultPageSize: number;
  /** Hard ceiling on a caller-supplied `limit`. */
  readonly maxPageSize: number;
}

export const DEFAULT_BANK_CORE_CONFIG: BankCoreConfig = {
  maxMaterialisedPersonas: 200,
  maxPersonaOverlays: 1000,
  personaOverlayTtlHours: 24,
  maxGeneratedPersonas: 200,
  maxOpenPreviews: 200,
  previewTtlMinutes: 15,
  maxAuditEntriesPerOverlay: 200,
  maxOverlayTransfers: 200,
  defaultPageSize: 500,
  maxPageSize: 1000,
};

/** Fills the gaps in a partial configuration and clamps every cap to at least 1. */
export function resolveBankCoreConfig(overrides: Partial<BankCoreConfig> = {}): BankCoreConfig {
  const merged = { ...DEFAULT_BANK_CORE_CONFIG, ...overrides };
  return {
    maxMaterialisedPersonas: atLeastOne(merged.maxMaterialisedPersonas),
    maxPersonaOverlays: atLeastOne(merged.maxPersonaOverlays),
    personaOverlayTtlHours: atLeastOne(merged.personaOverlayTtlHours),
    maxGeneratedPersonas: atLeastOne(merged.maxGeneratedPersonas),
    maxOpenPreviews: atLeastOne(merged.maxOpenPreviews),
    previewTtlMinutes: atLeastOne(merged.previewTtlMinutes),
    maxAuditEntriesPerOverlay: atLeastOne(merged.maxAuditEntriesPerOverlay),
    maxOverlayTransfers: atLeastOne(merged.maxOverlayTransfers),
    defaultPageSize: atLeastOne(merged.defaultPageSize),
    maxPageSize: atLeastOne(merged.maxPageSize),
  };
}

function atLeastOne(value: number): number {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/** The wire fee `previewTransfer` quotes, in USD cents. ACH and internal transfers are free. */
export const WIRE_FEE_CENTS = 2_500;
