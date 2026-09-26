/**
 * The spike persona directory (block: auth).
 *
 * `src/bank-core` owns the real one (three seeded personas with full datasets, ADR-15). It does
 * not exist yet, so T0.3 ships this stand-in behind the same `PersonaDirectory` contract:
 * `src/app.ts` injects `bankCore.personas` instead once L1 lands and nothing else changes.
 *
 * Names are neutral English and money is USD cents (Decision D-1).
 */
import { createHash, randomBytes } from 'node:crypto';

import { ID_PREFIXES, isId, type Persona, type PersonaDirectory, type PersonaKind } from '../contracts/index.js';

/** The three shared demo identities the login page offers (A-14: shared, never mutated in place). */
export const SEEDED_PERSONAS: readonly Persona[] = [
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

export interface SpikePersonaDirectoryOptions {
  readonly now?: () => Date;
  readonly randomSeed?: () => string;
  /** Bound on generated personas, so an anonymous flood cannot exhaust memory (ADR-16). */
  readonly maxGenerated?: number;
}

/** A stable, human-readable demo name derived from the seed, so a recovered `per_` id looks sane. */
function nameForSeed(seed: string): string {
  const first = ['Iris', 'Miles', 'Rowan', 'Lena', 'Otto', 'Nadia', 'Felix', 'Wren'];
  const last = ['Barlow', 'Kerr', 'Mendes', 'Vance', 'Okafor', 'Lindqvist', 'Ruiz', 'Hale'];
  const digest = createHash('sha256').update(seed).digest();
  const firstName = first[digest[0]! % first.length]!;
  const lastName = last[digest[1]! % last.length]!;
  return `${firstName} ${lastName}`;
}

/**
 * The seeded personas plus demo personas minted on demand. A generated persona regenerates its
 * dataset from `seed` after any restart (A-15), so recovering the `per_` id recovers the customer.
 */
export function createSpikePersonaDirectory(
  options: SpikePersonaDirectoryOptions = {},
): PersonaDirectory {
  const now = options.now ?? (() => new Date());
  const randomSeed = options.randomSeed ?? (() => randomBytes(8).toString('hex'));
  const maxGenerated = options.maxGenerated ?? 200;
  const generated = new Map<string, Persona>();

  const seededById = new Map(SEEDED_PERSONAS.map((persona) => [persona.id, persona]));

  function remember(persona: Persona): Persona {
    generated.set(persona.id, persona);
    while (generated.size > maxGenerated) {
      const oldest = generated.keys().next();
      if (oldest.done === true) break;
      generated.delete(oldest.value);
    }
    return persona;
  }

  function personaForSeed(seed: string, name?: string, kind?: PersonaKind): Persona {
    const id = `${ID_PREFIXES.persona}${seed}`;
    return {
      id,
      name: name ?? nameForSeed(seed),
      kind: kind ?? 'retail',
      shared: false,
      seed,
      email: `${seed}@demo.example.com`,
      created_at: now().toISOString(),
      transfer_limit_cents: 200_000,
    };
  }

  return {
    async list() {
      return SEEDED_PERSONAS;
    },

    async get(personaId: string) {
      const seeded = seededById.get(personaId);
      if (seeded) return seeded;
      const known = generated.get(personaId);
      if (known) return known;
      // A generated persona is fully described by its id: after a restart the same `per_<seed>`
      // rebuilds the same customer, which is exactly what the login page's "paste an existing
      // per_ id" field is for (docs/ARCHITECTURE.md section 5, login continuity).
      if (!isId(personaId, 'persona')) return null;
      const seed = personaId.slice(ID_PREFIXES.persona.length);
      if (seed.length < 4) return null;
      return remember(personaForSeed(seed));
    },

    async createDemoPersona(input = {}) {
      const seed = input.seed ?? randomSeed();
      return remember(personaForSeed(seed, input.name, input.kind));
    },
  };
}
