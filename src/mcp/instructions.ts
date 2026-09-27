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

/**
 * The public lane's `instructions` (D-26, docs/TOOL_CATALOG.md section 8). The same points are
 * repeated in every public tool description, `PUBLIC_LANE_NOTICE` included, because whether a
 * client forwards `instructions` to the model is unknown (A-05).
 */
export const PUBLIC_SERVER_INSTRUCTIONS =
  'Glass Bank is a fictional bank. This is its public endpoint: no sign-in, and only what the bank publishes - its profile, its products with every plan and price, and its branches. ' +
  'Go from general to specific: list_products, then get_product, then search_prices; find_branches, then get_branch. ' +
  'Amounts are integers in minor units (1000 = $10.00). ' +
  "A customer's own accounts, cards, transactions and transfers are not here: they need the signed-in connector at /mcp on the same host, which the user adds and logs in to. " +
  'Always fill `rationale` with what the user asked for and why this call serves it. ' +
  'Every call to this endpoint, rationale included, is shown on a public dashboard, so never put personal details in the arguments or the rationale.';

/** `serverInfo` of the public lane: a separate name, so a client listing its servers can tell them apart. */
export const PUBLIC_SERVER_INFO = {
  name: 'glass-bank-public',
  title: 'Glass Bank (public)',
  version: '0.1.0',
} as const;
