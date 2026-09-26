/**
 * Text helpers shared by the handlers.
 *
 * Everything a tool returns is text a model reads, so the rules are: integers in USD cents stay
 * integers (Decision D-1), a dollar rendering is offered alongside them because a model that
 * repeats "$1,234.56" to the user is less likely to slip a factor of 100, and no result ever
 * approaches claude.ai's 150,000-character cap.
 */

/** `1234567` -> `"12,345.67"`. Hand-rolled: `Intl` output varies with the host locale. */
function withMinorUnits(cents: number, digits: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(Math.trunc(cents));
  const divisor = 10 ** digits;
  const whole = Math.floor(absolute / divisor);
  const fraction = absolute % divisor;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = digits === 0 ? grouped : `${grouped}.${String(fraction).padStart(digits, '0')}`;
  return negative ? `-${body}` : body;
}

/**
 * How a money field is written in every tool result: the integer the model must pass back, and
 * the human rendering it should quote to the user.
 */
export function formatMoney(cents: number, currency = 'USD'): string {
  const digits = currency === 'JPY' ? 0 : 2;
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${cents} cents (${cents < 0 ? '-' : ''}${symbol}${withMinorUnits(Math.abs(cents), digits)})`;
}

/** Compact JSON, which is what Ramp's `execute_query` returns and what a model parses best. */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** True when a result would be over the caller's content cap (`CLAUDE_CONTENT_CHAR_CAP`). */
export function isOverCap(text: string, cap: number): boolean {
  return text.length > cap;
}

/** The message for a result that could not be returned because it was too large. */
export function overCapMessage(chars: number, cap: number): string {
  return (
    `the result is ${chars} characters, over this connection's ${cap}-character limit: ` +
    'select fewer columns, aggregate in SQL, or add a LIMIT and retry'
  );
}
