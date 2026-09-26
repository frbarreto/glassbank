/**
 * The persona directory (block: bank-core): who a dataset belongs to.
 *
 * Three named, shared demo identities plus `per_<seed>` personas minted on demand (A-14). The
 * three ids, seeds, names, emails, creation dates and per-transfer limits are **the same values
 * `src/auth/personas.ts` already serves**, because `src/app.ts` swaps the spike directory for this
 * one and a user who logged in as `per_ava_stone` yesterday must find the same customer today.
 * `nameForSeed` reproduces the spike's algorithm for the same reason.
 *
 * A generated persona is fully described by its id: after a restart, pasting `per_<seed>` into the
 * login page rebuilds the same customer, so nothing needs to be persisted (A-15). That is also why
 * `created_at` for a generated persona is a constant rather than `now()`: `dataset()` embeds the
 * persona, and a regenerated dataset has to be byte-identical to the one that was evicted.
 *
 * Names are neutral English and every amount is USD cents (Decision D-1).
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  ID_PREFIXES,
  isId,
  type Persona,
  type PersonaDirectory,
  type PersonaKind,
} from '../contracts/index.js';

import { BoundedLru } from './lru.js';

/** The three shared demo identities the login page offers. Their datasets are shared; writes are not. */
export const SHARED_PERSONAS: readonly Persona[] = [
  {
    id: 'per_ava_stone',
    name: 'Ava Stone',
    kind: 'retail',
    shared: true,
    seed: 'ava-stone',
    email: 'ava.stone@example.com',
    created_at: '2026-01-05T00:00:00.000Z',
    transfer_limit_cents: 250_000,
  },
  {
    id: 'per_noah_reid',
    name: 'Noah Reid',
    kind: 'retail',
    shared: true,
    seed: 'noah-reid',
    email: 'noah.reid@example.com',
    created_at: '2026-01-05T00:00:00.000Z',
    transfer_limit_cents: 150_000,
  },
  {
    id: 'per_harbor_supply',
    name: 'Harbor Supply Co.',
    kind: 'business',
    shared: true,
    seed: 'harbor-supply',
    email: 'accounts@harborsupply.example.com',
    created_at: '2026-01-05T00:00:00.000Z',
    transfer_limit_cents: 1_000_000,
  },
];

/** Every generated persona claims this creation date, so its dataset is stable across restarts. */
export const GENERATED_PERSONA_CREATED_AT = '2026-01-05T00:00:00.000Z';

/** The per-transfer ceiling a generated demo customer gets; matches `src/auth/personas.ts`. */
export const GENERATED_PERSONA_TRANSFER_LIMIT_CENTS = 200_000;

/** Seeds longer than this are truncated so every derived id stays inside `idPattern` (64 chars). */
export const MAX_SEED_LENGTH = 32;

const FIRST_NAMES = ['Iris', 'Miles', 'Rowan', 'Lena', 'Otto', 'Nadia', 'Felix', 'Wren'] as const;
const LAST_NAMES = [
  'Barlow',
  'Kerr',
  'Mendes',
  'Vance',
  'Okafor',
  'Lindqvist',
  'Ruiz',
  'Hale',
] as const;

/**
 * A stable, human-readable demo name derived from the seed. Byte-for-byte the algorithm of
 * `src/auth/personas.ts` (SHA-256 of the seed, first two bytes indexing two eight-name lists), so
 * the spike directory and this one never disagree about what `per_<seed>` is called.
 */
export function nameForSeed(seed: string): string {
  const digest = createHash('sha256').update(seed).digest();
  const first = FIRST_NAMES[(digest[0] ?? 0) % FIRST_NAMES.length] as string;
  const last = LAST_NAMES[(digest[1] ?? 0) % LAST_NAMES.length] as string;
  return `${first} ${last}`;
}

/** Keeps only the characters an id may carry, so `per_${seed}` always matches `idPattern`. */
export function sanitiseSeed(seed: string): string {
  const cleaned = seed.replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_SEED_LENGTH);
  const trimmed = cleaned.replace(/^[^A-Za-z0-9]+/, '');
  return trimmed;
}

/** The persona a seed describes. Pure: the same seed always yields the same record. */
export function personaForSeed(
  seed: string,
  overrides: { readonly name?: string; readonly kind?: PersonaKind } = {},
): Persona {
  return {
    id: `${ID_PREFIXES.persona}${seed}`,
    name: overrides.name ?? nameForSeed(seed),
    kind: overrides.kind ?? 'retail',
    shared: false,
    seed,
    email: `${seed}@demo.example.com`,
    created_at: GENERATED_PERSONA_CREATED_AT,
    transfer_limit_cents: GENERATED_PERSONA_TRANSFER_LIMIT_CENTS,
  };
}

export interface PersonaDirectoryOptions {
  /** Replaces the three shared personas; used by tests that want a smaller world. */
  readonly personas?: readonly Persona[];
  /** Bound on remembered generated personas (invariant 14). */
  readonly maxGenerated?: number;
  /** Injected so a test can mint a predictable `per_` id. */
  readonly randomSeed?: () => string;
}

/** What the directory exposes on top of the contract, for the factory and for tests. */
export interface BankPersonaDirectory extends PersonaDirectory {
  /** The shared personas synchronously, in a stable order. */
  readonly shared: readonly Persona[];
  /** How many generated personas are currently remembered. */
  generatedCount(): number;
}

export function createPersonaDirectory(
  options: PersonaDirectoryOptions = {},
): BankPersonaDirectory {
  const seeded = options.personas ?? SHARED_PERSONAS;
  const seededById = new Map(seeded.map((persona) => [persona.id, persona]));
  const generated = new BoundedLru<string, Persona>({
    maxEntries: options.maxGenerated ?? 200,
  });
  const randomSeed = options.randomSeed ?? (() => randomBytes(8).toString('hex'));

  function remember(persona: Persona): Persona {
    generated.set(persona.id, persona);
    return persona;
  }

  return {
    shared: seeded.filter((persona) => persona.shared),

    generatedCount() {
      return generated.size;
    },

    async list() {
      return seeded.filter((persona) => persona.shared);
    },

    async get(personaId: string) {
      const known = seededById.get(personaId);
      if (known) return known;
      const remembered = generated.get(personaId);
      if (remembered) return remembered;
      // A generated persona is recoverable from its id alone (A-15): the login page's "paste an
      // existing per_ id" field depends on this, and so does an evicted dataset coming back.
      if (!isId(personaId, 'persona')) return null;
      const seed = sanitiseSeed(personaId.slice(ID_PREFIXES.persona.length));
      if (seed.length < 4) return null;
      return remember(personaForSeed(seed));
    },

    async createDemoPersona(input = {}) {
      const requested = input.seed === undefined ? randomSeed() : input.seed;
      const seed = sanitiseSeed(requested);
      if (seed.length < 4) {
        throw new Error(
          'a demo persona seed needs at least four url-safe characters after sanitising',
        );
      }
      const existingShared = seededById.get(`${ID_PREFIXES.persona}${seed}`);
      if (existingShared) return existingShared;
      const overrides: { name?: string; kind?: PersonaKind } = {};
      if (input.name !== undefined) overrides.name = input.name;
      if (input.kind !== undefined) overrides.kind = input.kind;
      return remember(personaForSeed(seed, overrides));
    },
  };
}
