/**
 * Parity with Ramp's `memory_db.py` row transforms, plus the two defects of
 * docs/RAMP_REFERENCE.md section 2.1 that live in this file (5: column discovery from all rows;
 * 11: nothing here constructs a date, so the host timezone cannot shift an instant).
 */
import { describe, expect, it } from 'vitest';

import { advertisedColumns, flattenRow, flattenRows, inferColumnTypes, toSqliteValue } from '../rows.js';

describe('flattenRow (Ramp `get_nested_keys`)', () => {
  it('joins nested keys with a double underscore', () => {
    expect(flattenRow({ merchant: { name: 'Blue Bottle', city: 'Austin' }, amount_cents: -450 })).toEqual({
      merchant__name: 'Blue Bottle',
      merchant__city: 'Austin',
      amount_cents: -450,
    });
  });

  it('flattens more than one level', () => {
    expect(flattenRow({ a: { b: { c: 1 } } })).toEqual({ a__b__c: 1 });
  });

  it('casts lists to JSON text, as the Ramp blog says', () => {
    expect(flattenRow({ category_ids: ['1', '2'] })).toEqual({ category_ids: '["1","2"]' });
  });

  it('keeps null as null rather than dropping the key', () => {
    expect(flattenRow({ decline_reason: null })).toEqual({ decline_reason: null });
  });

  it('contributes no column for an empty nested object', () => {
    expect(flattenRow({ meta: {}, id: 'txn_1' })).toEqual({ id: 'txn_1' });
  });

  it('does not spin on a self-referencing object', () => {
    const cyclic: Record<string, unknown> = { id: 'txn_1' };
    cyclic.self = cyclic;
    const flat = flattenRow(cyclic);
    expect(flat.id).toBe('txn_1');
    expect(Object.keys(flat).length).toBeGreaterThan(1);
  });
});

describe('advertisedColumns (Ramp OSS defect 5)', () => {
  it('takes the union of keys across ALL rows, not just row zero', () => {
    const rows = flattenRows([
      { id: 'txn_1', amount_cents: -450 },
      { id: 'txn_2', amount_cents: -900, decline_reason: 'insufficient_funds' },
      { id: 'txn_3', amount_cents: 120, card: { last4: '4242' } },
    ]);
    expect(advertisedColumns(rows)).toEqual([
      'id',
      'amount_cents',
      'decline_reason',
      'card__last4',
    ]);
  });

  it('keeps first-seen order and never repeats a column', () => {
    const rows = flattenRows([{ b: 1, a: 2 }, { a: 3, b: 4, c: 5 }]);
    expect(advertisedColumns(rows)).toEqual(['b', 'a', 'c']);
  });

  it('returns no columns for no rows', () => {
    expect(advertisedColumns([])).toEqual([]);
  });
});

describe('inferColumnTypes (Ramp `_infer_column_types`)', () => {
  it('defaults to INTEGER, uses REAL for a float and TEXT for a string', () => {
    const rows = flattenRows([{ n: 1, f: 1.5, s: 'x' }]);
    expect(inferColumnTypes(rows, ['n', 'f', 's'])).toEqual({ n: 'INTEGER', f: 'REAL', s: 'TEXT' });
  });

  it('types an all-null column as TEXT, exactly as Ramp does for an all-None column', () => {
    const rows = flattenRows([{ decline_reason: null }, { decline_reason: null }]);
    expect(inferColumnTypes(rows, ['decline_reason'])).toEqual({ decline_reason: 'TEXT' });
  });

  it('never lets an explicit null outrank an observed number (nullable numeric columns)', () => {
    // `credit_limit_cents` is `number | null` in src/contracts/bank.ts and three of Ava Stone's
    // four seeded accounts carry null, so Ramp's "TEXT for str/None" stored the one real limit as
    // the string "1000000.0" and answered `WHERE credit_limit_cents > 500000` with no rows.
    const rows = flattenRows([{ credit_limit_cents: null }, { credit_limit_cents: 1_000_000 }]);
    expect(inferColumnTypes(rows, ['credit_limit_cents'])).toEqual({
      credit_limit_cents: 'INTEGER',
    });
    // Order must not matter, and a float still wins over an integer.
    expect(inferColumnTypes(flattenRows([{ v: 1 }, { v: null }]), ['v'])).toEqual({ v: 'INTEGER' });
    expect(inferColumnTypes(flattenRows([{ v: null }, { v: 2.5 }]), ['v'])).toEqual({ v: 'REAL' });
    // A null next to a string is still TEXT.
    expect(inferColumnTypes(flattenRows([{ v: null }, { v: 'x' }]), ['v'])).toEqual({ v: 'TEXT' });
  });

  it('ignores a MISSING key, so a sparse numeric column stays numeric (union-of-keys deviation)', () => {
    const rows = flattenRows([{ id: 'a', amount_cents: 100 }, { id: 'b' }]);
    expect(inferColumnTypes(rows, ['id', 'amount_cents'])).toEqual({
      id: 'TEXT',
      amount_cents: 'INTEGER',
    });
  });

  it('lets TEXT win over REAL and REAL win over INTEGER in a mixed column', () => {
    expect(inferColumnTypes(flattenRows([{ v: 1 }, { v: 2.5 }]), ['v'])).toEqual({ v: 'REAL' });
    expect(inferColumnTypes(flattenRows([{ v: 2.5 }, { v: 'x' }]), ['v'])).toEqual({ v: 'TEXT' });
    expect(inferColumnTypes(flattenRows([{ v: 'x' }, { v: 1 }]), ['v'])).toEqual({ v: 'TEXT' });
  });

  it('types a list column as TEXT (lists are JSON text)', () => {
    expect(inferColumnTypes(flattenRows([{ tags: ['a'] }]), ['tags'])).toEqual({ tags: 'TEXT' });
  });

  it('types a boolean as INTEGER, which is how SQLite stores it', () => {
    expect(inferColumnTypes(flattenRows([{ active: true }]), ['active'])).toEqual({
      active: 'INTEGER',
    });
  });
});

describe('toSqliteValue', () => {
  it('binds a missing key as NULL (Ramp: "we set missing keys as NULL")', () => {
    expect(toSqliteValue(undefined)).toBeNull();
    expect(toSqliteValue(null)).toBeNull();
  });

  it('binds booleans as 0 and 1 and passes numbers and strings through', () => {
    expect(toSqliteValue(true)).toBe(1);
    expect(toSqliteValue(false)).toBe(0);
    expect(toSqliteValue(-450)).toBe(-450);
    expect(toSqliteValue('2026-09-08')).toBe('2026-09-08');
  });

  it('refuses to bind a non-finite number', () => {
    expect(toSqliteValue(Number.NaN)).toBeNull();
    expect(toSqliteValue(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps a date string exactly as bank-core produced it, in UTC (defect 11)', () => {
    expect(toSqliteValue('2026-01-31T00:00:00.000Z')).toBe('2026-01-31T00:00:00.000Z');
  });
});
