/**
 * The pure row transforms of Ramp's `memory_db.py` (block: etl).
 *
 * Ported from `ramp_mcp/memory_db.py` (`_process_data`, `_infer_column_types`) and
 * `ramp_mcp/utils.py` (`get_nested_keys`), MIT (c) 2025 Ramp Business Corporation - see
 * THIRD_PARTY_NOTICES.md. Two of Ramp's defects are fixed here (docs/RAMP_REFERENCE.md
 * section 2.1):
 *
 *   - defect 5: columns come from the union of keys across **all** rows, not from `data[0]`,
 *     so a field that only appears on later rows is still visible to the model;
 *   - defect 11: nothing here constructs a date, so no host timezone can shift an instant.
 *     Values are copied through verbatim and dates stay the UTC strings bank-core produced.
 *
 * No I/O, no SQLite, no contracts import at runtime: this module is loaded by both the parent
 * process and the out-of-process SQL runner (ADR-9), and the runner must stay cheap to start.
 */

/** What SQLite is given for one cell. `better-sqlite3` binds exactly these. */
export type SqliteValue = string | number | null;

/** The three column types Ramp infers. SQLite affinity, not a constraint. */
export type SqliteColumnType = 'INTEGER' | 'REAL' | 'TEXT';

/** Ramp joins nested keys with a double underscore; deeper than this is JSON text. */
export const NESTED_KEY_SEPARATOR = '__';

/** Depth cap so a self-referencing object cannot spin the flattener forever. */
const MAX_FLATTEN_DEPTH = 12;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON text for a list or a too-deep object; a cycle becomes a marker instead of throwing. */
function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

/**
 * Ramp's `get_nested_keys`: `{a: {b: 1}}` becomes `{a__b: 1}`, lists become JSON text, and
 * everything else is copied through. An empty nested object contributes no column, exactly as
 * the Python original does.
 */
export function flattenRow(
  row: Record<string, unknown>,
  prefix = '',
  depth = 0,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const name = prefix === '' ? key : `${prefix}${NESTED_KEY_SEPARATOR}${key}`;
    if (isPlainObject(value) && depth < MAX_FLATTEN_DEPTH) {
      Object.assign(flat, flattenRow(value, name, depth + 1));
    } else if (isPlainObject(value)) {
      flat[name] = jsonText(value);
    } else if (Array.isArray(value)) {
      // "To keep things simple, we set missing keys as NULL and cast lists to text."
      flat[name] = jsonText(value);
    } else {
      flat[name] = value;
    }
  }
  return flat;
}

/** Flattens a whole payload once, so callers never flatten the same row twice. */
export function flattenRows(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => flattenRow(row));
}

/**
 * The union of flattened keys across **every** row, in first-seen order (Ramp OSS defect 5).
 * Ramp read `data[0]` only, so any field absent from the first row was invisible to the model.
 */
export function advertisedColumns(flatRows: readonly Record<string, unknown>[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of flatRows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return columns;
}

/** TEXT beats REAL beats INTEGER, so a mixed column keeps every value losslessly. */
const TYPE_RANK: Record<SqliteColumnType, number> = { INTEGER: 0, REAL: 1, TEXT: 2 };

/** What an explicit `null` contributes: nothing but the fact that the column was seen. */
const NULL_OBSERVATION = 'NULL' as const;

function typeOfValue(value: unknown): SqliteColumnType | typeof NULL_OBSERVATION {
  if (value === null) return NULL_OBSERVATION; // See `inferColumnTypes`.
  if (typeof value === 'string') return 'TEXT';
  if (typeof value === 'boolean') return 'INTEGER'; // SQLite stores booleans as 0/1.
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'INTEGER' : 'REAL';
  }
  if (typeof value === 'bigint') return 'INTEGER';
  return 'TEXT'; // lists and anything else are JSON text.
}

/**
 * Ramp's `_infer_column_types`: INTEGER by default, TEXT for a string, REAL for a float, TEXT for
 * a list, and TEXT for a column that is nothing but `None`.
 *
 * Two deliberate deviations, both forced by the union-of-keys fix (Ramp only ever looked at
 * `data[0]`, so it never had to answer either question):
 *
 *   - a key that is **missing** from a row contributes nothing to the inference (its cell is
 *     stored NULL). Treating "absent" as TEXT would turn every sparse numeric column into text
 *     and break `ORDER BY` and `sum()` on exactly the columns the union-of-keys fix exposes.
 *   - an **explicit `null`** likewise contributes no type, only the fact that the column exists.
 *     Ramp's "TEXT for str/None" made a single `None` outrank every number in the column, and the
 *     contract has genuinely nullable numeric columns (`credit_limit_cents` is `number | null`,
 *     src/contracts/bank.ts): three of Ava Stone's four seeded accounts carry `null` there, so the
 *     old rule stored the one real limit under TEXT affinity as the string "1000000.0" and
 *     answered `WHERE credit_limit_cents > 500000` with no rows. A column that saw no non-null
 *     value at all still resolves to TEXT, which is Ramp's answer for an all-`None` column.
 */
export function inferColumnTypes(
  flatRows: readonly Record<string, unknown>[],
  cols: readonly string[],
): Record<string, SqliteColumnType> {
  const types: Record<string, SqliteColumnType> = {};
  /** Columns for which a non-null value was observed; the rest fall back to TEXT. */
  const observed = new Set<string>();
  for (const col of cols) types[col] = 'INTEGER';
  for (const row of flatRows) {
    for (const col of cols) {
      if (!Object.hasOwn(row, col)) continue;
      const candidate = typeOfValue(row[col]);
      if (candidate === NULL_OBSERVATION) continue;
      observed.add(col);
      const current = types[col] ?? 'INTEGER';
      if (TYPE_RANK[candidate] > TYPE_RANK[current]) types[col] = candidate;
    }
  }
  for (const col of cols) {
    if (!observed.has(col)) types[col] = 'TEXT';
  }
  return types;
}

/** Binds one flattened cell. Missing keys become NULL, which is Ramp's documented behaviour. */
export function toSqliteValue(value: unknown): SqliteValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return jsonText(value);
}
