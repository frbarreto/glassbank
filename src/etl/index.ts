/**
 * The `etl` block factory (docs/blocks/etl.md).
 *
 * `createEtl(deps)` builds the scratch-database manager: Ramp's `memory_db.py` protocol
 * (`store_data` -> `process_data` -> `execute_query` -> `clear_table`) with the guardrails Ramp's
 * open-source server lacks. `src/app.ts` creates one instance and injects
 * `etl.forGrant(grant_id)` into each request's `ToolContext.scratch`.
 *
 * The public interface of this block is exactly what this file exports.
 */
export { createEtl, ETL_LIMIT_DEFAULTS, type Etl, type EtlDeps, type EtlLimits } from './scratch-db.js';

export {
  advertisedColumns,
  flattenRow,
  flattenRows,
  inferColumnTypes,
  toSqliteValue,
  NESTED_KEY_SEPARATOR,
  type SqliteColumnType,
  type SqliteValue,
} from './rows.js';

export {
  isValidTableName,
  maskLiterals,
  quoteIdentifier,
  scanStatement,
  tokenize,
  MAX_SQL_LENGTH,
  SQL_DENYLIST_TOKENS,
  SQL_WRITE_TOKENS,
  TABLE_NAME_PATTERN,
  type SqlScanReason,
  type SqlScanVerdict,
} from './sql-text.js';
