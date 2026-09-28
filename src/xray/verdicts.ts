/**
 * Ranking Web Bot Auth verdicts (block: xray, v0.10, D-29).
 *
 * A session sends many requests; the dashboard shows the strongest verdict any of them earned, so
 * one verified request names the provider for the whole session while an unsigned one never erases
 * a verdict a signature earned. Its own module so the read model and the overview share it without
 * importing each other.
 */

/** Lower is stronger evidence. The same order `auth` ranks verdicts in (`verdictRank`). */
const VERDICT_RANK: Record<string, number> = {
  verified: 0,
  invalid_signature: 1,
  unknown_key: 2,
  replayed: 3,
  expired: 4,
  not_yet_valid: 5,
  directory_unreachable: 6,
  unsupported: 7,
  malformed: 8,
  not_checked: 9,
  unsigned: 10,
};

/** The stronger of two verdicts; `unsigned` never replaces a verdict a signature earned. */
export function strongerVerdict(current: string | null, next: string | null): string | null {
  if (next === null || next === 'unsigned') return current;
  if (current === null) return next;
  return (VERDICT_RANK[next] ?? 99) < (VERDICT_RANK[current] ?? 99) ? next : current;
}
