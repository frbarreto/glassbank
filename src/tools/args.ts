/**
 * Narrow readers for validated arguments.
 *
 * By the time a handler runs, the lenient zod schema has already accepted the arguments and
 * applied the catalog's defaults, so these readers never reject anything - they only give
 * TypeScript the type the schema already guaranteed, and they keep Ramp's `""`-means-null
 * convention in exactly one place.
 */

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** An optional filter: absent, or an empty string, means "no filter". */
export function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** Ramp's `""`-means-null enums: an unknown value is treated as no filter, never as an error. */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | '' {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : '';
}
