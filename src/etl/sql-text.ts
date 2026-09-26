/**
 * Identifier quoting and the statement token scan (block: etl, CLAUDE.md invariant 8).
 *
 * Pure text handling with no contracts import at runtime, so the out-of-process SQL runner can
 * load it without pulling zod in. `scratch-db.ts` turns the verdicts below into `ScratchDbError`s.
 *
 * The token deny-list is the **primary** ATTACH guard: `Statement.readonly` is `true` for both
 * `ATTACH` and `DETACH` (they change the connection, not file content), so the readonly check
 * alone leaves Ramp's verified `ATTACH DATABASE ... ; CREATE TABLE ... AS SELECT` file-write
 * escape open (docs/RAMP_REFERENCE.md section 2.1, defect 7).
 */

/** Why the scanner refused a statement. A subset of `ScratchDbFailureReason`. */
export type SqlScanReason = 'denylist' | 'multi_statement' | 'not_readonly';

export type SqlScanVerdict =
  | { readonly ok: true; readonly normalised: string }
  | { readonly ok: false; readonly reason: SqlScanReason; readonly message: string };

/** Keywords that never reach SQLite, whatever `Statement.readonly` says about them. */
export const SQL_DENYLIST_TOKENS: readonly string[] = ['attach', 'detach', 'pragma', 'vacuum'];

/**
 * Deny-list keywords that are also refused as a token PREFIX (`attach_anything`), because SQLite
 * exposes eponymous table-valued functions whose names are the keyword plus an underscore and a
 * whole-token match walks straight around them. No column any `load_*` tool produces starts with
 * one of these, so honest SQL is unaffected.
 *
 * `pragma` is deliberately NOT in this list. Its eponymous functions (`pragma_table_list`,
 * `pragma_function_list`, `pragma_query_only`, ...) are read-only virtual tables over the
 * caller's OWN `:memory:` scratch database - measured: `pragma_database_list` reports `main` with
 * an empty file, `sqlite_dbpage` is not compiled into this better-sqlite3 build, and none of them
 * can set a pragma, so `query_only = 1` cannot be flipped through them. Against that nil exposure,
 * `SELECT * FROM pragma_query_only` is the only probe the tests have for the resting pragma state
 * of a live runner (`scratch-db.test.ts`, `runner-guard.test.ts`), which is worth keeping.
 */
export const SQL_DENYLIST_PREFIX_TOKENS: readonly string[] = ['attach', 'detach', 'vacuum'];

/**
 * Statement keywords that write. They are caught here as well as by `Statement.readonly` in the
 * runner, so a write is refused before a child process is even asked to prepare it.
 * `replace` and `analyze` are deliberately absent: `replace(x, y, z)` is a SQLite *function* and
 * banning the token would reject honest queries. Both are still refused by `Statement.readonly`.
 */
export const SQL_WRITE_TOKENS: readonly string[] = [
  'insert',
  'update',
  'delete',
  'drop',
  'create',
  'alter',
  'reindex',
];

/** Statements that may start a read-only query. */
const READ_ONLY_LEADERS = new Set(['select', 'with', 'values']);

/** A model cannot need more than this; anything longer is an attack on the scanner itself. */
export const MAX_SQL_LENGTH = 100_000;

/** SQLite identifier quoting: `"` doubled, exactly like `sqlite3_mprintf("%w")`. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** `{tool}_{uuid4hex}` and anything else we are willing to create a table for. */
export const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function isValidTableName(name: string): boolean {
  return TABLE_NAME_PATTERN.test(name);
}

/**
 * Replaces the contents of string literals, quoted identifiers and comments with spaces, keeping
 * the delimiters and the overall length. Masking is what stops `SELECT 'a;b' AS x` from looking
 * like two statements and `SELECT merchant FROM t WHERE merchant = 'Attach Co'` from looking like
 * an ATTACH; an unterminated literal is refused outright rather than masked to the end of the
 * string, because that is the one way masking could hide a real keyword.
 */
export function maskLiterals(
  sql: string,
):
  | { readonly ok: true; readonly masked: string }
  | { readonly ok: false; readonly message: string } {
  const out = [...sql];
  let index = 0;
  const length = sql.length;

  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      const char = out[i];
      out[i] = char === '\n' ? '\n' : ' ';
    }
  };

  while (index < length) {
    const char = sql[index];

    if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? length : end;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (char === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) return { ok: false, message: 'unterminated block comment' };
      blank(index, end + 2);
      index = end + 2;
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      const closer = char;
      let cursor = index + 1;
      for (;;) {
        const next = sql.indexOf(closer, cursor);
        if (next === -1) {
          return {
            ok: false,
            message: `unterminated ${closer === "'" ? 'string literal' : 'quoted identifier'}`,
          };
        }
        if (sql[next + 1] === closer) {
          cursor = next + 2; // doubled delimiter: an escaped quote, keep scanning.
          continue;
        }
        blank(index + 1, next);
        index = next + 1;
        break;
      }
      continue;
    }

    if (char === '[') {
      const end = sql.indexOf(']', index + 1);
      if (end === -1) return { ok: false, message: 'unterminated bracket identifier' };
      blank(index + 1, end);
      index = end + 1;
      continue;
    }

    index += 1;
  }

  return { ok: true, masked: out.join('') };
}

/** Lower-cased word tokens of already-masked SQL. */
export function tokenize(maskedSql: string): string[] {
  return maskedSql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
}

/**
 * The full parent-side scan of one model-authored statement, in the order CLAUDE.md invariant 8
 * lists the guards: single statement, deny-list, read-only shape.
 *
 * Returns the statement with any single trailing semicolon removed, which is what the runner
 * prepares.
 */
export function scanStatement(sql: string): SqlScanVerdict {
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { ok: false, reason: 'not_readonly', message: 'the query is empty' };
  }
  if (sql.length > MAX_SQL_LENGTH) {
    return {
      ok: false,
      reason: 'denylist',
      message: `the query is longer than ${MAX_SQL_LENGTH} characters`,
    };
  }
  if (sql.includes('\u0000')) {
    return { ok: false, reason: 'denylist', message: 'the query contains a NUL character' };
  }

  const masked = maskLiterals(sql);
  if (!masked.ok) {
    return { ok: false, reason: 'denylist', message: masked.message };
  }

  const trimmedMask = masked.masked.trim().replace(/;\s*$/, '');
  if (trimmedMask.includes(';')) {
    return {
      ok: false,
      reason: 'multi_statement',
      message: 'only one statement may be sent at a time; remove the semicolon',
    };
  }
  if (trimmedMask === '') {
    return { ok: false, reason: 'not_readonly', message: 'the query is empty' };
  }

  const tokens = tokenize(trimmedMask);
  for (const token of SQL_DENYLIST_TOKENS) {
    if (tokens.includes(token)) {
      return {
        ok: false,
        reason: 'denylist',
        message: `the statement keyword "${token.toUpperCase()}" is not allowed in a scratch query`,
      };
    }
  }
  for (const keyword of SQL_DENYLIST_PREFIX_TOKENS) {
    const prefix = `${keyword}_`;
    if (tokens.some((token) => token.startsWith(prefix))) {
      return {
        ok: false,
        reason: 'denylist',
        message: `the statement keyword "${keyword.toUpperCase()}" is not allowed in a scratch query`,
      };
    }
  }
  for (const token of SQL_WRITE_TOKENS) {
    if (tokens.includes(token)) {
      return {
        ok: false,
        reason: 'not_readonly',
        message: `only read-only SELECT statements are allowed; "${token.toUpperCase()}" writes`,
      };
    }
  }

  const leader = tokens[0];
  const startsWithParenthesis = trimmedMask.trimStart().startsWith('(');
  if (!startsWithParenthesis && (leader === undefined || !READ_ONLY_LEADERS.has(leader))) {
    return {
      ok: false,
      reason: 'not_readonly',
      message: 'only read-only SELECT statements are allowed; start the query with SELECT or WITH',
    };
  }

  // The statement the runner prepares: the original text minus one trailing semicolon.
  const normalised = sql.trim().replace(/;\s*$/, '');
  return { ok: true, normalised };
}
