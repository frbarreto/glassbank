/**
 * The server `instructions` carried by `InitializeResult` (block: mcp).
 *
 * Verbatim from docs/TOOL_CATALOG.md section 5. Whether claude.ai forwards `instructions` to the
 * model is unknown (A-05), which is why every point here is repeated in the tool descriptions.
 * The `mcp` block owns the wording; the test asserts each point is present so an edit that drops
 * one is caught.
 */
export const SERVER_INSTRUCTIONS =
  'Glass Bank is a fictional bank; every account, card, transaction and person is fake demo data. ' +
  'Amounts are integers in minor units (1000 = $10.00). ' +
  'For performance, always load all the data you need first with the `load_*` tools, then call `process_data` to build tables, ' +
  'then run SQL with `execute_query`; prefer window functions and make sure calculations are accurate. ' +
  'Prefer `load_statement_lines` over separate loads when possible. Clear tables you no longer need. ' +
  'Always fill `rationale` with what the user asked for and why this call serves it. ' +
  "Write tools change the customer's accounts: preview `create_transfer` first and confirm only with the user's explicit approval. " +
  'If the user wants to see what is happening behind the scenes, call `xray_get_session_link` and show them the link.';

/** Reported in `InitializeResult.serverInfo`. */
export const SERVER_INFO = {
  name: 'glass-bank',
  title: 'Glass Bank',
  version: '0.1.0',
} as const;
