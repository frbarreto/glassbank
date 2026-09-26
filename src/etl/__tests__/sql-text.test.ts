/**
 * The statement scan of CLAUDE.md invariant 8: every denylisted statement, every write and every
 * multi-statement input is refused before a SQL runner is even asked to prepare it.
 *
 * One test here opens `better-sqlite3` directly - `src/etl/__tests__` is allowed to, and it is
 * the only way to show *why* the deny-list, not `Statement.readonly`, is the primary ATTACH
 * guard (docs/RAMP_REFERENCE.md section 2.1, defect 7).
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { maskLiterals, quoteIdentifier, scanStatement, tokenize } from '../sql-text.js';

const temporaryDirectories: string[] = [];
afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function reject(sql: string): { reason: string; message: string } {
  const verdict = scanStatement(sql);
  if (verdict.ok) throw new Error(`expected ${sql} to be rejected`);
  return { reason: verdict.reason, message: verdict.message };
}

describe('scanStatement deny-list (the primary ATTACH guard)', () => {
  it.each([
    ["ATTACH DATABASE '/tmp/escape.db' AS escape", 'ATTACH'],
    ['attach database "x" as y', 'ATTACH'],
    ['DETACH DATABASE esc', 'DETACH'],
    ['PRAGMA table_info(load_transactions_1)', 'PRAGMA'],
    ['VACUUM', 'VACUUM'],
  ])('rejects %s', (sql, keyword) => {
    const rejected = reject(sql);
    expect(rejected.reason).toBe('denylist');
    expect(rejected.message).toContain(keyword);
  });

  it('rejects an ATTACH hidden behind a leading SELECT and a semicolon', () => {
    expect(reject("SELECT 1; ATTACH DATABASE '/tmp/escape.db' AS e").reason).toBe(
      'multi_statement',
    );
  });

  it('rejects PRAGMA anywhere in the statement, not only at the start', () => {
    expect(reject('SELECT 1 FROM t WHERE x = (PRAGMA page_size)').reason).toBe('denylist');
  });

  it('rejects a token that merely STARTS with a dangerous keyword and an underscore', () => {
    // SQLite exposes eponymous table-valued functions named `<keyword>_<something>`; a whole-token
    // deny-list walks straight around them. No column any `load_*` tool produces looks like this.
    expect(reject('SELECT * FROM attach_anything').reason).toBe('denylist');
    expect(reject('SELECT * FROM detach_anything').reason).toBe('denylist');
    expect(reject('SELECT * FROM vacuum_anything').reason).toBe('denylist');
  });

  it('still allows pragma_* table-valued functions, deliberately', () => {
    // Measured: these are read-only virtual tables over the caller's OWN `:memory:` scratch
    // database, they cannot set a pragma (so `query_only = 1` survives), `pragma_database_list`
    // reports `main` with an empty file, and `sqlite_dbpage` is not compiled into this build.
    // `SELECT * FROM pragma_query_only` is the only external probe the runner tests have for the
    // resting pragma state, so `pragma` stays an exact-token match. See SQL_DENYLIST_PREFIX_TOKENS.
    expect(scanStatement('SELECT * FROM pragma_query_only').ok).toBe(true);
    expect(scanStatement('SELECT * FROM pragma_table_list').ok).toBe(true);
  });
});

describe('scanStatement write refusal', () => {
  it.each([
    ['UPDATE load_transactions_1 SET amount_cents = 0', 'UPDATE'],
    ["INSERT INTO load_transactions_1 (id) VALUES ('x')", 'INSERT'],
    ['DROP TABLE load_transactions_1', 'DROP'],
    ['DELETE FROM load_transactions_1', 'DELETE'],
    ['CREATE TABLE evil AS SELECT 1', 'CREATE'],
    ['ALTER TABLE load_transactions_1 RENAME TO evil', 'ALTER'],
  ])('rejects %s', (sql, keyword) => {
    const rejected = reject(sql);
    expect(rejected.reason).toBe('not_readonly');
    expect(rejected.message).toContain(keyword);
  });

  it('rejects a write smuggled behind a CTE', () => {
    expect(
      reject('WITH x AS (SELECT 1 AS n) INSERT INTO load_transactions_1 SELECT n FROM x').reason,
    ).toBe('not_readonly');
  });

  it('rejects anything that is not a SELECT, WITH or VALUES statement', () => {
    expect(reject('EXPLAIN SELECT 1').reason).toBe('not_readonly');
    expect(reject('BEGIN').reason).toBe('not_readonly');
    expect(reject('   ').reason).toBe('not_readonly');
  });
});

describe('scanStatement multi-statement refusal', () => {
  it('rejects two statements', () => {
    expect(reject('SELECT 1; SELECT 2').reason).toBe('multi_statement');
  });

  it('accepts a single trailing semicolon and strips it', () => {
    const verdict = scanStatement('SELECT 1;  ');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.normalised).toBe('SELECT 1');
  });

  it('does not mistake a semicolon inside a string literal for a second statement', () => {
    const verdict = scanStatement("SELECT 'a;b' AS memo");
    expect(verdict.ok).toBe(true);
  });
});

describe('scanStatement false positives', () => {
  it('allows a merchant name that contains a denylisted word', () => {
    expect(scanStatement("SELECT * FROM t WHERE merchant_name = 'Attach Supply Co'").ok).toBe(true);
  });

  it('allows the replace() function, which is why "replace" is not a write token', () => {
    expect(scanStatement("SELECT replace(memo, 'a', 'b') FROM t").ok).toBe(true);
  });

  it('allows a column whose name merely starts with a keyword', () => {
    expect(scanStatement('SELECT update_date, insert_id FROM t').ok).toBe(true);
  });

  it('allows window functions, which the server instructions encourage', () => {
    expect(
      scanStatement(
        'WITH ranked AS (SELECT merchant_name, sum(amount_cents) AS total, ' +
          'rank() OVER (ORDER BY sum(amount_cents)) AS r FROM t GROUP BY 1) SELECT * FROM ranked',
      ).ok,
    ).toBe(true);
  });
});

describe('maskLiterals', () => {
  it('blanks string literals, quoted identifiers, brackets and comments', () => {
    const masked = maskLiterals("SELECT \"a b\" /* attach */ FROM t -- attach\nWHERE x = 'attach'");
    expect(masked.ok).toBe(true);
    if (masked.ok) expect(tokenize(masked.masked)).not.toContain('attach');
  });

  it('handles a doubled quote inside a literal', () => {
    const masked = maskLiterals("SELECT 'it''s fine' AS memo");
    expect(masked.ok).toBe(true);
    if (masked.ok) expect(masked.masked).toContain('AS memo');
  });

  it('refuses an unterminated literal instead of masking to the end of the input', () => {
    expect(maskLiterals("SELECT 'a ATTACH").ok).toBe(false);
    expect(reject("SELECT 'a ATTACH").reason).toBe('denylist');
    expect(reject('SELECT /* a').reason).toBe('denylist');
  });

  it('keeps the input length so offsets stay meaningful', () => {
    const sql = "SELECT 'abc' FROM t";
    const masked = maskLiterals(sql);
    expect(masked.ok).toBe(true);
    if (masked.ok) expect(masked.masked).toHaveLength(sql.length);
  });
});

describe('quoteIdentifier (Ramp OSS defect 6)', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(quoteIdentifier('load_transactions_1')).toBe('"load_transactions_1"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteIdentifier('t; DROP TABLE x')).toBe('"t; DROP TABLE x"');
  });

  it('is what makes an interpolated identifier inert in SQLite', () => {
    const db = new Database(':memory:');
    const evil = 'x" ; CREATE TABLE pwned (a)--';
    db.exec(`CREATE TABLE ${quoteIdentifier(evil)} (a)`);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(names).toEqual([evil]);
    db.close();
  });
});

describe('why the deny-list is the primary ATTACH guard', () => {
  it('better-sqlite3 reports Statement.readonly === true for ATTACH and DETACH', () => {
    const directory = mkdtempSync(join(tmpdir(), 'glass-bank-etl-'));
    temporaryDirectories.push(directory);
    const escapeFile = join(directory, 'escape.db');
    const db = new Database(':memory:');
    db.pragma('query_only = 1');

    const attach = db.prepare(`ATTACH DATABASE '${escapeFile}' AS esc`);
    expect(attach.readonly).toBe(true);
    const detach = db.prepare('DETACH DATABASE esc');
    expect(detach.readonly).toBe(true);

    // The escape Ramp's OSS server leaves open: `readonly` would have let this run.
    attach.run();
    db.pragma('query_only = 0');
    db.exec('CREATE TABLE esc.stolen AS SELECT 1 AS a');
    detach.run();
    db.close();
    expect(existsSync(escapeFile)).toBe(true);

    // And the scan refuses exactly that statement.
    expect(reject(`ATTACH DATABASE '${escapeFile}' AS esc`).reason).toBe('denylist');
  });
});
