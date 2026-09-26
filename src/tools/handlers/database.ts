/**
 * The three scratch-database tools: `process_data`, `execute_query`, `clear_table`.
 *
 * They are annotated `readOnlyHint: true` because they touch only the caller's own `:memory:`
 * database and never bank state (A-07); `x-read-only` is `partial` for the two that change it.
 * None of them runs SQL here: the statement is handed to the injected `ScratchDb`, which owns the
 * guard and the out-of-process timeout (ADR-9 as amended). This block never sees SQLite.
 */
import {
  clearedTableText,
  processedTableText,
  rowCapMessage,
  toolError,
  toolText,
} from '../../contracts/index.js';

import { asString, asStringArray } from '../args.js';
import { isOverCap, overCapMessage, toJson } from '../format.js';
import type { ToolCallHandler } from '../types.js';

const processData: ToolCallHandler = async (context, args) => {
  const tableName = asString(args.table_name);
  const cols = asStringArray(args.cols);
  if (cols.length === 0) {
    // Ramp OSS defect #10: an empty `cols` produced a SQL syntax error, not an explanation.
    return toolError(
      'cols was empty: pass the columns you need from the "Available columns are:" list of the load_* result',
    );
  }
  const processed = await context.scratch.process({ table_name: tableName, cols });
  return toolText(processedTableText(processed.table_name), {
    table_name: processed.table_name,
    rows: processed.rows,
    columns_selected: [...processed.columns_selected],
  });
};

const executeQuery: ToolCallHandler = async (context, args) => {
  const tableName = asString(args.table_name);
  const sql = asString(args.query);
  const result = await context.scratch.query({
    table_name: tableName,
    sql,
    max_rows: context.limits.maxQueryRows,
    timeout_ms: context.limits.queryTimeoutMs,
  });

  const body = toJson(result.rows);
  // Hosted Ramp's wording, appended rather than substituted: the model gets the first 100 rows
  // *and* is told the result was trimmed, which is what `test/fixtures/events.jsonl` records
  // (`sql.query {capped: true}` next to a successful `tool.call.completed`).
  const text = result.capped ? `${body}\n${rowCapMessage(context.limits.maxQueryRows)}` : body;
  if (isOverCap(text, context.limits.contentCharCap)) {
    return toolError(overCapMessage(text.length, context.limits.contentCharCap));
  }
  return toolText(text, {
    table_name: tableName,
    rows_returned: result.rows_returned,
    columns: [...result.columns],
    capped: result.capped,
    duration_ms: result.duration_ms,
  });
};

const clearTable: ToolCallHandler = async (context, args) => {
  const tableName = asString(args.table_name);
  await context.scratch.clear(tableName);
  return toolText(clearedTableText(tableName), { table_name: tableName });
};

export const DATABASE_HANDLERS: Record<string, ToolCallHandler> = {
  process_data: processData,
  execute_query: executeQuery,
  clear_table: clearTable,
};
