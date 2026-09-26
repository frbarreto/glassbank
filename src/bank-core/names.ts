/**
 * The vocabulary the seed generator draws from (block: bank-core).
 *
 * Every name here is invented, neutral and English (Decision D-1, CLAUDE.md "Language rules"), and
 * every merchant is pinned to one of Ramp's category ids (`categories.ts`) so that a
 * `load_transactions(category_ids=["17"])` filter and a "how much did I spend on groceries"
 * question line up. Weights are relative frequencies, not probabilities: they only have to be
 * sensible next to each other.
 *
 * No real business, bank or person is referenced. Amounts are USD cents everywhere.
 */

/** A merchant a transaction can be posted against. */
export interface MerchantProfile {
  readonly name: string;
  /** A Ramp category id from `BANK_CATEGORIES`. */
  readonly category_id: string;
  /** Relative frequency among everyday purchases. */
  readonly weight: number;
  /** Typical amount range in USD cents. */
  readonly min_cents: number;
  readonly max_cents: number;
  /** `card` postings carry a `card_id`; `transfer` postings are account-to-account debits. */
  readonly channel: 'card' | 'account';
  /** Business personas draw from `business`, retail personas from `retail`; `both` is shared. */
  readonly audience: 'retail' | 'business' | 'both';
}

/** Everyday spending. The long tail is what makes a whole-year query interesting (A-23). */
export const MERCHANTS: readonly MerchantProfile[] = [
  // Groceries and food (17, 19, 20)
  { name: 'Northline Grocers', category_id: '17', weight: 90, min_cents: 1_200, max_cents: 21_000, channel: 'card', audience: 'both' },
  { name: 'Meadowbrook Market', category_id: '17', weight: 55, min_cents: 900, max_cents: 14_500, channel: 'card', audience: 'both' },
  { name: 'Copperleaf Restaurant', category_id: '19', weight: 48, min_cents: 2_400, max_cents: 18_000, channel: 'card', audience: 'both' },
  { name: 'Harbor Coffee House', category_id: '19', weight: 96, min_cents: 380, max_cents: 2_400, channel: 'card', audience: 'both' },
  { name: 'Two Rivers Deli', category_id: '19', weight: 44, min_cents: 850, max_cents: 4_600, channel: 'card', audience: 'both' },
  { name: 'Ninth Street Taproom', category_id: '20', weight: 22, min_cents: 1_600, max_cents: 11_000, channel: 'card', audience: 'retail' },

  // Fuel, transport, travel (18, 8, 28, 29, 4, 5, 6, 7)
  { name: 'Beacon Fuel Stop', category_id: '18', weight: 60, min_cents: 2_800, max_cents: 9_800, channel: 'card', audience: 'both' },
  { name: 'Union Rail Transit', category_id: '8', weight: 52, min_cents: 275, max_cents: 3_200, channel: 'card', audience: 'both' },
  { name: 'Cityline Rideshare', category_id: '8', weight: 46, min_cents: 900, max_cents: 7_500, channel: 'card', audience: 'both' },
  { name: 'Riverside Parking Authority', category_id: '28', weight: 26, min_cents: 400, max_cents: 4_200, channel: 'card', audience: 'both' },
  { name: 'Granite Auto Service', category_id: '29', weight: 9, min_cents: 6_500, max_cents: 88_000, channel: 'card', audience: 'both' },
  { name: 'Meridian Airlines', category_id: '4', weight: 14, min_cents: 18_000, max_cents: 142_000, channel: 'card', audience: 'both' },
  { name: 'Kestrel Car Rental', category_id: '5', weight: 8, min_cents: 9_500, max_cents: 62_000, channel: 'card', audience: 'business' },
  { name: 'Lakeview Inn', category_id: '6', weight: 11, min_cents: 12_000, max_cents: 94_000, channel: 'card', audience: 'both' },
  { name: 'Waypoint Travel Desk', category_id: '7', weight: 6, min_cents: 3_500, max_cents: 41_000, channel: 'card', audience: 'business' },

  // Retail goods (13, 14, 15, 16, 1, 3, 12, 10, 9)
  { name: 'Lakeside Hardware', category_id: '13', weight: 34, min_cents: 1_100, max_cents: 46_000, channel: 'card', audience: 'both' },
  { name: 'Fieldstone General Store', category_id: '13', weight: 30, min_cents: 900, max_cents: 28_000, channel: 'card', audience: 'both' },
  { name: 'Bright Circuit Electronics', category_id: '14', weight: 18, min_cents: 3_900, max_cents: 189_000, channel: 'card', audience: 'both' },
  { name: 'Willow and Thread', category_id: '15', weight: 20, min_cents: 2_500, max_cents: 34_000, channel: 'card', audience: 'retail' },
  { name: 'Quarry Books', category_id: '16', weight: 16, min_cents: 1_100, max_cents: 9_800, channel: 'card', audience: 'both' },
  { name: 'Sparrow Pet Supply', category_id: '1', weight: 15, min_cents: 1_500, max_cents: 17_500, channel: 'card', audience: 'retail' },
  { name: 'Foundry Office Interiors', category_id: '3', weight: 10, min_cents: 8_500, max_cents: 240_000, channel: 'card', audience: 'business' },
  { name: 'Clearwater Office Supply', category_id: '12', weight: 26, min_cents: 1_800, max_cents: 42_000, channel: 'card', audience: 'business' },
  { name: 'Parcelway Shipping', category_id: '10', weight: 22, min_cents: 650, max_cents: 12_500, channel: 'card', audience: 'business' },
  { name: 'Ironwood Freight', category_id: '9', weight: 12, min_cents: 14_000, max_cents: 168_000, channel: 'account', audience: 'business' },

  // Services, health, leisure (25, 32, 21, 24, 42, 31, 33, 26, 27, 30, 34, 38, 37)
  { name: 'Sable Consulting Group', category_id: '25', weight: 12, min_cents: 45_000, max_cents: 420_000, channel: 'account', audience: 'business' },
  { name: 'Harrow and Vale Legal', category_id: '32', weight: 6, min_cents: 60_000, max_cents: 380_000, channel: 'account', audience: 'business' },
  { name: 'Cedar Street Pharmacy', category_id: '21', weight: 30, min_cents: 850, max_cents: 24_000, channel: 'card', audience: 'both' },
  { name: 'Harborview Clinic', category_id: '21', weight: 10, min_cents: 4_500, max_cents: 96_000, channel: 'card', audience: 'retail' },
  { name: 'Palace Row Cinema', category_id: '24', weight: 18, min_cents: 1_400, max_cents: 7_200, channel: 'card', audience: 'retail' },
  { name: 'Summit Fitness Club', category_id: '31', weight: 8, min_cents: 3_900, max_cents: 12_900, channel: 'card', audience: 'retail' },
  { name: 'Riverbend Learning Centre', category_id: '33', weight: 5, min_cents: 9_500, max_cents: 120_000, channel: 'account', audience: 'both' },
  { name: 'Pinehurst Tax Advisors', category_id: '26', weight: 4, min_cents: 25_000, max_cents: 180_000, channel: 'account', audience: 'business' },
  { name: 'Beacon Media Buying', category_id: '27', weight: 9, min_cents: 20_000, max_cents: 350_000, channel: 'account', audience: 'business' },
  { name: 'Open Hand Foundation', category_id: '34', weight: 6, min_cents: 2_500, max_cents: 50_000, channel: 'card', audience: 'both' },
  { name: 'County Clerk Services', category_id: '38', weight: 4, min_cents: 1_500, max_cents: 26_000, channel: 'card', audience: 'both' },
  { name: 'Municipal Parking Fines', category_id: '37', weight: 3, min_cents: 3_500, max_cents: 15_000, channel: 'card', audience: 'both' },

  // Software and connectivity (40, 41, 43, 39, 23)
  { name: 'Latchkey Software', category_id: '40', weight: 14, min_cents: 1_900, max_cents: 68_000, channel: 'card', audience: 'both' },
  { name: 'Stonebridge Cloud', category_id: '41', weight: 10, min_cents: 8_500, max_cents: 320_000, channel: 'card', audience: 'business' },
  { name: 'Northgate Wireless', category_id: '43', weight: 8, min_cents: 3_500, max_cents: 18_000, channel: 'card', audience: 'both' },
  { name: 'Harbor Supply Warehouse', category_id: '39', weight: 5, min_cents: 22_000, max_cents: 260_000, channel: 'account', audience: 'business' },
  { name: 'Glass Bank Service Fees', category_id: '23', weight: 7, min_cents: 300, max_cents: 4_500, channel: 'account', audience: 'both' },
];

/** A charge that repeats every month, which is what makes a 12-month query worth asking. */
export interface RecurringProfile {
  readonly name: string;
  readonly category_id: string;
  readonly description: string;
  readonly min_cents: number;
  readonly max_cents: number;
  /** Day of the month, clamped to the length of the month. */
  readonly day_of_month: number;
  readonly channel: 'card' | 'account';
  readonly audience: 'retail' | 'business' | 'both';
}

/** Monthly outgoings. `2` ("Other") carries rent and lease, which Ramp's table has no id for. */
export const RECURRING_CHARGES: readonly RecurringProfile[] = [
  { name: 'Alder Property Management', category_id: '2', description: 'Monthly rent', min_cents: 145_000, max_cents: 265_000, day_of_month: 1, channel: 'account', audience: 'retail' },
  { name: 'Alder Property Management', category_id: '3', description: 'Warehouse lease', min_cents: 480_000, max_cents: 920_000, day_of_month: 1, channel: 'account', audience: 'business' },
  { name: 'Crestwood Utilities', category_id: '11', description: 'Electricity and water', min_cents: 6_500, max_cents: 28_000, day_of_month: 8, channel: 'account', audience: 'both' },
  { name: 'Delta Point Telecom', category_id: '43', description: 'Internet and phone plan', min_cents: 5_500, max_cents: 14_500, day_of_month: 12, channel: 'account', audience: 'both' },
  { name: 'Bell Ridge Insurance', category_id: '44', description: 'Insurance premium', min_cents: 8_900, max_cents: 46_000, day_of_month: 15, channel: 'account', audience: 'both' },
  { name: 'Latchkey Software', category_id: '40', description: 'Software subscription', min_cents: 1_900, max_cents: 9_900, day_of_month: 18, channel: 'card', audience: 'both' },
  { name: 'Stonebridge Cloud', category_id: '41', description: 'Cloud hosting', min_cents: 24_000, max_cents: 185_000, day_of_month: 20, channel: 'card', audience: 'business' },
  { name: 'Riverlight Streaming', category_id: '42', description: 'Streaming subscription', min_cents: 899, max_cents: 2_199, day_of_month: 22, channel: 'card', audience: 'retail' },
  { name: 'Summit Fitness Club', category_id: '31', description: 'Club membership', min_cents: 3_900, max_cents: 8_900, day_of_month: 25, channel: 'card', audience: 'retail' },
];

/** Money coming in. Positive `amount_cents`, no card. */
export interface IncomeProfile {
  readonly name: string;
  readonly description: string;
  readonly min_cents: number;
  readonly max_cents: number;
  readonly days_of_month: readonly number[];
  readonly audience: 'retail' | 'business';
}

export const INCOME_SOURCES: readonly IncomeProfile[] = [
  { name: 'Fairmount Analytics Payroll', description: 'Direct deposit - salary', min_cents: 285_000, max_cents: 372_000, days_of_month: [1, 15], audience: 'retail' },
  { name: 'Bayside Outfitters', description: 'Customer payment received', min_cents: 380_000, max_cents: 1_450_000, days_of_month: [4, 19], audience: 'business' },
  { name: 'Kettle Creek Trading', description: 'Customer payment received', min_cents: 240_000, max_cents: 980_000, days_of_month: [11, 26], audience: 'business' },
];

/** Saved beneficiaries. The rail decides the fee `previewTransfer` quotes. */
export interface PayeeProfile {
  readonly name: string;
  readonly rail: 'ach' | 'wire';
}

export const PAYEE_PROFILES: readonly PayeeProfile[] = [
  // Wire payees sit inside the first eight so a retail persona (eight payees) can still be shown
  // the wire fee, and inside the first fourteen for a business persona.
  { name: 'Alder Property Management', rail: 'ach' },
  { name: 'Bell Ridge Insurance', rail: 'ach' },
  { name: 'Crestwood Utilities', rail: 'ach' },
  { name: 'Ironwood Contractors', rail: 'wire' },
  { name: 'Delta Point Telecom', rail: 'ach' },
  { name: 'Evergreen Landscaping', rail: 'ach' },
  { name: 'Larkspur Design Studio', rail: 'wire' },
  { name: 'Fairmont Dental Group', rail: 'ach' },
  { name: 'Granite Auto Service', rail: 'ach' },
  { name: 'Harborview Clinic', rail: 'ach' },
  { name: 'Juniper Cleaning Services', rail: 'ach' },
  { name: 'Kettle Creek Trading', rail: 'wire' },
  { name: 'Maple Court Accounting', rail: 'ach' },
  { name: 'Pinehurst Tax Advisors', rail: 'wire' },
  { name: 'Northgate Wireless', rail: 'ach' },
  { name: 'Orchard Lane Catering', rail: 'ach' },
];

export const PAYEE_BANK_NAMES: readonly string[] = [
  'First Meridian Bank',
  'Union Harbor Savings',
  'Cedar Trust Bank',
  'Northfield Community Bank',
  'Stonegate Financial',
];

/** Cardholders for a business persona; a retail persona uses the persona's own name. */
export const EMPLOYEE_NAMES: readonly string[] = [
  'Ruth Callahan',
  'Peter Nakamura',
  'Dana Whitfield',
  'Omar Reyes',
  'Grace Lindholm',
  'Victor Amaro',
];

/** Why a seeded transfer failed. Shown to the model verbatim. */
export const TRANSFER_FAILURE_REASONS: readonly string[] = [
  'the receiving bank rejected the account number',
  'the payee closed the destination account',
  'the transfer was recalled by the sender',
];

/** Why a seeded transaction was declined. Shown to the model verbatim. */
export const DECLINE_REASONS: readonly string[] = [
  'insufficient_funds',
  'card_locked',
  'merchant_category_blocked',
  'expired_card',
];

/** Memo lines for seeded transfers. */
export const TRANSFER_MEMOS: readonly string[] = [
  'Invoice settlement',
  'Monthly retainer',
  'Deposit top-up',
  'Contractor payment',
  'Reimbursement',
  'Quarterly service',
];
