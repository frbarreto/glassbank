/**
 * Reference data: the merchant category table and the currency list (block: bank-core).
 *
 * `BANK_CATEGORIES` is Ramp's `SK_CATEGORIES` copied **verbatim** from `src/ramp_mcp/constants.py`
 * of `ramp-public/ramp_mcp` (MIT; the notice and this fragment are listed in
 * `THIRD_PARTY_NOTICES.md`). The ids run 1..44 with 22 missing - 43 entries - and both the ids and
 * the names are reproduced exactly, including "SaaS / Software" and the comma inside
 * "Freight, moving and delivery services". Ramp keys the table by integer; `Category.id` in
 * `src/contracts/bank.ts` is a string, so the integer is rendered as its decimal string and
 * nothing else changes. `get_bank_categories` serves this list without a bank call, exactly as
 * Ramp's `get_ramp_categories` does (docs/RAMP_REFERENCE.md section 6.1).
 *
 * Do not sort, renumber, rename or extend this table: a category id is part of the wire surface
 * that `load_transactions(category_ids=[...])` filters on.
 */
import type { Category, CurrencyInfo } from '../contracts/index.js';

/** Ramp's 43-entry `SK_CATEGORIES`, in Ramp's own order. */
export const BANK_CATEGORIES: readonly Category[] = [
  { id: '1', name: 'Pet' },
  { id: '2', name: 'Other' },
  { id: '3', name: 'Office' },
  { id: '4', name: 'Airlines' },
  { id: '5', name: 'Car rental' },
  { id: '6', name: 'Lodging' },
  { id: '7', name: 'Travel misc' },
  { id: '8', name: 'Taxi and rideshare' },
  { id: '9', name: 'Freight, moving and delivery services' },
  { id: '10', name: 'Shipping' },
  { id: '11', name: 'Utilities' },
  { id: '12', name: 'Office supplies and cleaning' },
  { id: '13', name: 'General merchandise' },
  { id: '14', name: 'Electronics' },
  { id: '15', name: 'Clothing' },
  { id: '16', name: 'Books and newspapers' },
  { id: '17', name: 'Supermarkets and grocery stores' },
  { id: '18', name: 'Fuel and gas' },
  { id: '19', name: 'Restaurants' },
  { id: '20', name: 'Alcohol and bars' },
  { id: '21', name: 'Medical' },
  { id: '23', name: 'Fees and financial institutions' },
  { id: '24', name: 'Entertainment' },
  { id: '25', name: 'Professional services' },
  { id: '26', name: 'Taxes and tax preparation' },
  { id: '27', name: 'Advertising' },
  { id: '28', name: 'Parking' },
  { id: '29', name: 'Car services' },
  { id: '30', name: 'Gambling' },
  { id: '31', name: 'Clubs and memberships' },
  { id: '32', name: 'Legal' },
  { id: '33', name: 'Education' },
  { id: '34', name: 'Charitable donations' },
  { id: '35', name: 'Political organizations' },
  { id: '36', name: 'Religious organizations' },
  { id: '37', name: 'Fines' },
  { id: '38', name: 'Government services' },
  { id: '39', name: 'Intra-company purchases' },
  { id: '40', name: 'SaaS / Software' },
  { id: '41', name: 'Cloud computing' },
  { id: '42', name: 'Streaming services' },
  { id: '43', name: 'Internet and phone' },
  { id: '44', name: 'Insurance' },
];

/** Category id -> name, for the seed generator and for validating a `category_ids` filter. */
export const CATEGORY_NAME_BY_ID: ReadonlyMap<string, string> = new Map(
  BANK_CATEGORIES.map((category) => [category.id, category.name]),
);

/**
 * `get_currencies`, USD first (Decision D-1). The bank only funds accounts in USD; the rest of the
 * list exists so the model can see that a non-USD `create_transfer` is rejected on purpose
 * (`currency_not_supported`) rather than because the code forgot about currencies.
 */
export const BANK_CURRENCIES: readonly CurrencyInfo[] = [
  { code: 'USD', name: 'United States Dollar', symbol: '$', minor_unit_digits: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', minor_unit_digits: 2 },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', minor_unit_digits: 2 },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'CA$', minor_unit_digits: 2 },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', minor_unit_digits: 0 },
];

/** The one currency every account is funded in (Decision D-1). */
export const BASE_CURRENCY = 'USD';
