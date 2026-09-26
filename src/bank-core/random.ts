/**
 * The deterministic pseudo-random source behind the seed generator (block: bank-core).
 *
 * Everything the bank shows a user is a pure function of a persona seed (A-15, ADR-15): the
 * dataset is thrown away under memory pressure and regenerated on demand, so "same seed, same
 * dataset" is a correctness property, not a nicety. `Math.random` is therefore never used here.
 *
 * mulberry32 over an FNV-1a hash of the seed string: 32 bits of state, no dependencies, and the
 * same sequence on every platform and every Node version.
 */

/** FNV-1a (32-bit), so a string seed becomes a number. */
export function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A stream of numbers in `[0, 1)`. Same seed, same stream, every run. */
export type Random = () => number;

/** mulberry32. */
export function makeRandom(seed: string): Random {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inclusive on both ends. */
export function integerBetween(random: Random, min: number, max: number): number {
  if (max <= min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

/** One element of a non-empty array. */
export function pick<T>(random: Random, values: readonly T[]): T {
  if (values.length === 0) throw new Error('pick() needs a non-empty array');
  const index = Math.min(values.length - 1, Math.floor(random() * values.length));
  return values[index] as T;
}

/** One element of a non-empty array of `{weight}` items, proportional to the weights. */
export function weightedPick<T extends { readonly weight: number }>(
  random: Random,
  values: readonly T[],
): T {
  if (values.length === 0) throw new Error('weightedPick() needs a non-empty array');
  let total = 0;
  for (const value of values) total += Math.max(0, value.weight);
  if (total <= 0) return values[0] as T;
  let ticket = random() * total;
  for (const value of values) {
    ticket -= Math.max(0, value.weight);
    if (ticket <= 0) return value;
  }
  return values[values.length - 1] as T;
}

/** True with probability `probability` (0..1). */
export function chance(random: Random, probability: number): boolean {
  return random() < probability;
}

/**
 * A money amount in USD cents, rounded to a plausible shape: prices cluster on whole dollars and
 * on `.99`, not on uniformly random cents (Decision D-1: integer cents, never floats).
 */
export function moneyCents(random: Random, minCents: number, maxCents: number): number {
  const raw = integerBetween(random, minCents, maxCents);
  const dollars = Math.max(1, Math.round(raw / 100));
  const roll = random();
  if (roll < 0.35) return dollars * 100 - 1; // $x.99
  if (roll < 0.55) return dollars * 100 - 5; // $x.95
  if (roll < 0.7) return dollars * 100 + integerBetween(random, 1, 98);
  return dollars * 100;
}
