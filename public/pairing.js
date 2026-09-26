/**
 * Pairing-code handling (block: dashboard).
 *
 * The shape is copied from `src/contracts/auth.ts` rather than imported: the dashboard talks HTTP
 * only and imports nothing from `src/` (docs/REPO_LAYOUT.md section 3). Ten characters from a
 * 32-character alphabet without `0`, `O`, `1` or `I`, grouped `BANK-XXXX-XXXX-XX` - 50 bits
 * (ADR-10, A-24). If the contract ever changes these, `public/__tests__/contract-copy.test.mjs`
 * fails, because it re-reads the pattern out of the contract file.
 *
 * Pure functions. No DOM, no network.
 */

/** `PAIRING_CODE_ALPHABET` in `src/contracts/auth.ts`. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** `PAIRING_CODE_PATTERN` in `src/contracts/auth.ts`. */
export const PAIRING_CODE_PATTERN = /^BANK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/;
export const PAIRING_CODE_LENGTH = 10;

/** True for a well-formed `BANK-XXXX-XXXX-XX`. */
export function isPairingCode(value) {
  return typeof value === 'string' && PAIRING_CODE_PATTERN.test(value);
}

/** Groups ten alphabet characters as `BANK-XXXX-XXXX-XX`. */
export function formatPairingCode(characters) {
  if (characters.length !== PAIRING_CODE_LENGTH) {
    throw new Error(`a pairing code needs exactly ${PAIRING_CODE_LENGTH} characters`);
  }
  return `BANK-${characters.slice(0, 4)}-${characters.slice(4, 8)}-${characters.slice(8, 10)}`;
}

/**
 * What the input box does on every keystroke: upper-cases, drops the `BANK` prefix, the dashes and
 * every character outside the alphabet, then regroups. A partial code stays partial so the caret
 * can keep moving; `isPairingCode` decides when it is submittable.
 */
export function normalisePairingInput(raw) {
  const cleaned = String(raw ?? '')
    .toUpperCase()
    // Only a literal `BANK` followed by a separator is the prefix; `BANK` as the first four
    // characters of a body group is left alone.
    .replace(/^\s*BANK[-\s]+/, '')
    .replace(/[^A-Z2-9]/g, '')
    .split('')
    .filter((character) => PAIRING_CODE_ALPHABET.includes(character))
    .slice(0, PAIRING_CODE_LENGTH)
    .join('');
  if (cleaned.length === 0) return '';
  const groups = [cleaned.slice(0, 4), cleaned.slice(4, 8), cleaned.slice(8, 10)].filter(Boolean);
  return `BANK-${groups.join('-')}`;
}

/** Reads a code out of `/xray/s/BANK-...` so a pasted link works as well as a pasted code. */
export function codeFromUrl(value) {
  const match = String(value ?? '').match(/BANK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}/);
  return match ? match[0] : null;
}

/** English for each `PairingRejectionReason` of the contract. */
export const PAIRING_ERRORS = {
  unknown_code: 'That code is not one this server issued. Check it against the message in chat.',
  expired: 'That code has expired. Ask for a new link with the xray_get_session_link tool.',
  rate_limited: 'Too many attempts from this address. Wait a minute and try again.',
  malformed: 'That is not a valid code. It looks like BANK-XXXX-XXXX-XX.',
};

export function pairingErrorText(reason, fallback) {
  return PAIRING_ERRORS[reason] ?? fallback ?? 'The code could not be exchanged.';
}
