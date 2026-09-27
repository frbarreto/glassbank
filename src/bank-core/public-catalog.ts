/**
 * The published half of the bank (block: bank-core, contracts v0.7, D-26).
 *
 * What Glass Bank would print on its public website: the profile, six products in three families
 * with every plan and every price, and eight locations in four cities. Hand-written, fictional
 * (street names included), immutable and shared by every caller; nothing here depends on a
 * persona, a login or the clock.
 * `index.ts` wraps the pure lookups below into `PublicBankInfo` and emits one `bank.op` per call.
 *
 * Amounts are USD cents (D-1); rates are basis points, so 310 is 3.10%.
 */
import type {
  BankProfile,
  BranchDetail,
  BranchHours,
  BranchKind,
  BranchQuery,
  BranchSearchResult,
  BranchService,
  BranchSummary,
  PriceKind,
  PriceLine,
  PriceQuery,
  ProductDetail,
  ProductFamily,
  ProductFamilySummary,
  ProductPlan,
  ProductSummary,
} from '../contracts/index.js';

export const BANK_PROFILE: BankProfile = {
  name: 'Glass Bank',
  tagline: 'The bank you can see through.',
  purpose:
    'Glass Bank exists to show, in the open, how an AI agent works with a bank: every product, price and location is published here without sign-in, and every call an agent makes is visible on the X-ray dashboard. It is a fictional bank; its products, prices and branches are made up for the demo.',
  differentiators: [
    {
      title: 'Prices on the glass',
      detail:
        'Every fee and rate of every plan is public and searchable, including the ones most banks bury: wires, overdrafts, foreign transactions and paper statements.',
    },
    {
      title: 'No surprise fees',
      detail:
        'Every monthly fee has a published way to be waived, and overdraft coverage is off until the customer turns it on.',
    },
    {
      title: 'Agent-ready',
      detail:
        "Agents browse the catalog without an account; a customer's own data opens only through their sign-in, one scope per kind of data, with a separate consent before any money moves.",
    },
    {
      title: 'Observable by design',
      detail:
        'Every call, with the reason the agent gave for it, is shown live on the X-ray dashboard, including the calls to this public endpoint.',
    },
  ],
  headquarters: 'Austin, Texas',
  fictional: true,
  public_information: [
    'what the bank is and how it differs',
    'products and their plans',
    'every fee and interest rate',
    'branches, ATMs and opening hours',
  ],
  needs_sign_in: [
    'accounts and balances',
    'transactions and statements',
    'cards, and locking or unlocking them',
    'payees, bills and transfers',
    'whether a customer qualifies for a plan, and which plan they are on',
  ],
};

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** `[kind, name, amount_cents, rate_bps, applies, waiver]`: one line of a plan's price list. */
type PriceRow = readonly [PriceKind, string, number | null, number | null, string, string | null];

interface PlanSeed extends ProductPlan {
  readonly prices: readonly PriceRow[];
}

interface ProductSeed {
  readonly product_id: string;
  readonly family: ProductFamily;
  readonly name: string;
  readonly summary: string;
  readonly description: string;
  readonly who_it_is_for: string;
  readonly why_different: string;
  readonly eligibility: readonly string[];
  readonly needs_sign_in: readonly string[];
  readonly plans: readonly PlanSeed[];
}

const FAMILY_NAMES: Readonly<Record<ProductFamily, { name: string; summary: string }>> = {
  accounts: { name: 'Everyday accounts', summary: 'Checking and savings for individuals.' },
  cards: { name: 'Cards', summary: 'A debit card for every checking account and two credit cards.' },
  business: { name: 'Business', summary: 'Checking and a team card for small companies.' },
};

const PRODUCTS: readonly ProductSeed[] = [
  {
    product_id: 'clear_checking',
    family: 'accounts',
    name: 'Clear Checking',
    summary: 'Everyday checking with overdraft off by default and every fee shown before it happens.',
    description:
      'A checking account with a debit card, direct deposit up to two days early, and a fee preview on every payment that could cost money.',
    who_it_is_for: 'Anyone who wants an everyday account without surprises.',
    why_different:
      'Most banks turn overdraft coverage on and charge for it; Clear Checking declines the payment instead unless the customer opts in, and the opt-in is free.',
    eligibility: ['18 or older', 'A US address', 'No opening deposit required'],
    needs_sign_in: ['your balance and transactions', 'which plan you are on', 'whether you meet a waiver this month'],
    plans: [
      {
        plan_id: 'clear_checking_basic',
        name: 'Basic',
        monthly_fee_cents: 0,
        headline: 'No monthly fee',
        highlights: ['Free debit card', 'Free incoming wires', '2 free out-of-network ATM withdrawals a month'],
        best_for: 'Anyone who wants a free account',
        prices: [
          ['monthly_fee', 'Monthly maintenance', 0, null, 'every month', null],
          ['transaction_fee', 'Out-of-network ATM withdrawal', 250, null, 'after the 2 free each month', 'Use a Glass Bank ATM'],
          ['transaction_fee', 'Outgoing domestic wire', 2500, null, 'per wire', null],
          ['transaction_fee', 'Incoming wire', 0, null, 'per wire', null],
          ['penalty', 'Overdraft', 0, null, 'only with overdraft coverage turned on; otherwise the payment is declined', null],
          ['service_fee', 'Paper statement', 200, null, 'per month, when chosen', 'Choose e-statements'],
        ],
      },
      {
        plan_id: 'clear_checking_plus',
        name: 'Plus',
        monthly_fee_cents: 1200,
        headline: '$12 a month, waived with a $1,500 daily balance',
        highlights: ['ATM owner fees refunded in the US', '2 free outgoing domestic wires a month', 'Free paper checks'],
        best_for: 'Customers who use other ATMs or send wires often',
        prices: [
          ['monthly_fee', 'Monthly maintenance', 1200, null, 'every month', 'Keep a daily balance of $1,500 or more'],
          ['transaction_fee', 'Out-of-network ATM withdrawal', 0, null, 'any US ATM; the owner fee is refunded', null],
          ['transaction_fee', 'Outgoing domestic wire', 0, null, 'the first 2 each month', null],
          ['transaction_fee', 'Outgoing domestic wire after the free ones', 1500, null, 'per wire', null],
          ['service_fee', 'Paper checks', 0, null, 'per book', null],
        ],
      },
    ],
  },
  {
    product_id: 'glass_savings',
    family: 'accounts',
    name: 'Glass Savings',
    summary: 'Savings that pays the same rate on every dollar, with the rate history published.',
    description:
      'A savings account linked to checking, with no minimum balance, no withdrawal limit and a rate that applies from the first dollar.',
    who_it_is_for: 'Savers who want a simple rate they can check.',
    why_different: 'No teaser rate and no balance tiers: the published rate is the rate every customer gets.',
    eligibility: ['A Glass Bank checking account', 'No minimum balance'],
    needs_sign_in: ['your balance and interest earned', 'your deposit history'],
    plans: [
      {
        plan_id: 'glass_savings_standard',
        name: 'Standard',
        monthly_fee_cents: 0,
        headline: '3.10% APY on every balance',
        highlights: ['No minimum balance', 'Unlimited transfers to checking'],
        best_for: 'A place to keep an emergency fund',
        prices: [
          ['rate', 'Annual percentage yield', null, 310, 'on the whole balance, variable', null],
          ['monthly_fee', 'Monthly maintenance', 0, null, 'every month', null],
          ['transaction_fee', 'Transfer to or from checking', 0, null, 'per transfer', null],
        ],
      },
      {
        plan_id: 'glass_savings_goal',
        name: 'Goal',
        monthly_fee_cents: 0,
        headline: '3.60% APY in any month with a $100 deposit',
        highlights: ['Named savings goals', 'Round-ups from debit purchases'],
        best_for: 'Saving steadily towards a target',
        prices: [
          ['rate', 'Annual percentage yield with a qualifying deposit', null, 360, 'in a month with $100 or more deposited', null],
          ['rate', 'Annual percentage yield without the deposit', null, 310, 'in a month with less than $100 deposited', null],
          ['monthly_fee', 'Monthly maintenance', 0, null, 'every month', null],
        ],
      },
    ],
  },
  {
    product_id: 'prism_debit',
    family: 'cards',
    name: 'Prism Debit Card',
    summary: 'The debit card of every checking account, with an optional metal upgrade.',
    description:
      'A debit card drawn on Clear Checking that the customer, or their agent with the right consent, can lock and unlock instantly.',
    who_it_is_for: 'Every checking customer.',
    why_different: 'Instant lock and unlock from an agent, with the reason for each change kept in the audit trail.',
    eligibility: ['A Clear Checking account'],
    needs_sign_in: ['your cards and their status', 'locking or unlocking a card'],
    plans: [
      {
        plan_id: 'prism_debit_standard',
        name: 'Standard',
        monthly_fee_cents: 0,
        headline: 'Included with every checking account',
        highlights: ['Instant lock and unlock', 'Contactless'],
        best_for: 'Everyday spending at home',
        prices: [
          ['annual_fee', 'Annual fee', 0, null, 'every year', null],
          ['rate', 'Foreign transaction fee', null, 300, 'of each purchase made in another currency', null],
          ['service_fee', 'Replacement card', 0, null, 'the first each year', null],
          ['service_fee', 'Expedited delivery', 2500, null, 'per card', null],
        ],
      },
      {
        plan_id: 'prism_debit_metal',
        name: 'Metal',
        monthly_fee_cents: 500,
        headline: '$5 a month for a metal card with 1% back',
        highlights: ['1% back on debit purchases', 'No foreign transaction fee', 'Free expedited delivery'],
        best_for: 'Travellers who pay by debit',
        prices: [
          ['monthly_fee', 'Metal card', 500, null, 'every month', null],
          ['rate', 'Foreign transaction fee', null, 0, 'of each purchase made in another currency', null],
          ['service_fee', 'Replacement card', 0, null, 'any number', null],
          ['service_fee', 'Expedited delivery', 0, null, 'per card', null],
        ],
      },
    ],
  },
  {
    product_id: 'lens_credit',
    family: 'cards',
    name: 'Lens Credit Card',
    summary: 'A credit card with the APR and every penalty on the first page.',
    description:
      'A credit card with cash back or travel points, a variable purchase APR and a published list of every penalty.',
    who_it_is_for: 'Customers who pay their balance and want the rewards.',
    why_different: 'The first late payment each year is forgiven, and the APR is shown next to the price on every statement.',
    eligibility: ['18 or older', 'A US address', 'Subject to a credit check'],
    needs_sign_in: ['your credit limit and balance', 'your statements', 'whether you are approved'],
    plans: [
      {
        plan_id: 'lens_credit_everyday',
        name: 'Everyday',
        monthly_fee_cents: 0,
        headline: 'No annual fee, 1.5% cash back',
        highlights: ['1.5% cash back on every purchase', 'First late payment each year forgiven'],
        best_for: 'Everyday spending paid in full',
        prices: [
          ['annual_fee', 'Annual fee', 0, null, 'every year', null],
          ['rate', 'Purchase APR, variable', null, 2199, 'on balances not paid in full', null],
          ['rate', 'Foreign transaction fee', null, 300, 'of each purchase made in another currency', null],
          ['penalty', 'Late payment', 2900, null, 'per late payment', 'The first late payment each year is forgiven'],
        ],
      },
      {
        plan_id: 'lens_credit_travel',
        name: 'Travel',
        monthly_fee_cents: 0,
        headline: '$95 a year, 3x points on travel, no foreign transaction fee',
        highlights: ['3 points per dollar on travel', 'No foreign transaction fee', 'Annual fee waived the first year'],
        best_for: 'Frequent travellers',
        prices: [
          ['annual_fee', 'Annual fee', 9500, null, 'every year', 'Waived the first year'],
          ['rate', 'Purchase APR, variable', null, 2299, 'on balances not paid in full', null],
          ['rate', 'Foreign transaction fee', null, 0, 'of each purchase made in another currency', null],
          ['penalty', 'Late payment', 2900, null, 'per late payment', 'The first late payment each year is forgiven'],
        ],
      },
    ],
  },
  {
    product_id: 'pane_business_checking',
    family: 'business',
    name: 'Pane Business Checking',
    summary: 'Business checking priced by transaction volume, with wires included on Growth.',
    description:
      'A business checking account with ACH, wires, payroll payments and a bookkeeping export, run by the owner or their agent.',
    who_it_is_for: 'Small companies and freelancers.',
    why_different: 'Agents can prepare payments, but every transfer still needs a human approval before money moves.',
    eligibility: ['A US-registered business', 'An owner with a Glass Bank sign-in'],
    needs_sign_in: ['your business balances', 'payments and payroll', 'approving a transfer'],
    plans: [
      {
        plan_id: 'pane_business_starter',
        name: 'Starter',
        monthly_fee_cents: 0,
        headline: 'No monthly fee up to 100 transactions',
        highlights: ['100 transactions a month included', 'Free ACH payments'],
        best_for: 'A new or small business',
        prices: [
          ['monthly_fee', 'Monthly maintenance', 0, null, 'every month', null],
          ['transaction_fee', 'Transaction above the included 100', 50, null, 'per transaction', 'Move to Growth'],
          ['transaction_fee', 'ACH payment', 0, null, 'per payment', null],
          ['transaction_fee', 'Outgoing domestic wire', 2500, null, 'per wire', null],
        ],
      },
      {
        plan_id: 'pane_business_growth',
        name: 'Growth',
        monthly_fee_cents: 3000,
        headline: '$30 a month, unlimited transactions, free domestic wires',
        highlights: ['Unlimited transactions', 'Free domestic wires', 'Two user seats with their own approvals'],
        best_for: 'A business sending wires every week',
        prices: [
          ['monthly_fee', 'Monthly maintenance', 3000, null, 'every month', 'Keep $25,000 across business accounts'],
          ['transaction_fee', 'Outgoing domestic wire', 0, null, 'per wire', null],
          ['transaction_fee', 'Outgoing international wire', 3500, null, 'per wire', null],
          ['transaction_fee', 'ACH payment', 0, null, 'per payment', null],
        ],
      },
    ],
  },
  {
    product_id: 'frame_business_card',
    family: 'business',
    name: 'Frame Business Card',
    summary: 'A team card with a limit per employee and receipts matched automatically.',
    description:
      'A corporate card with employee cards, per-card limits, merchant category controls and receipt matching.',
    who_it_is_for: 'Businesses that give cards to employees.',
    why_different: 'Limits and category controls per employee card, changeable by the owner or their agent with the right consent.',
    eligibility: ['A Pane Business Checking account', 'Subject to a credit check'],
    needs_sign_in: ['your cards and limits', 'employee spending', 'locking an employee card'],
    plans: [
      {
        plan_id: 'frame_business_team',
        name: 'Team',
        monthly_fee_cents: 0,
        headline: 'Free for up to 10 employee cards, 1% cash back',
        highlights: ['Up to 10 employee cards', '1% cash back', 'Per-card limits'],
        best_for: 'A small team',
        prices: [
          ['annual_fee', 'Annual fee', 0, null, 'every year', null],
          ['service_fee', 'Employee card', 0, null, 'up to 10 cards', null],
          ['rate', 'Foreign transaction fee', null, 300, 'of each purchase made in another currency', null],
          ['penalty', 'Late payment', 3900, null, 'per late payment', null],
        ],
      },
      {
        plan_id: 'frame_business_scale',
        name: 'Scale',
        monthly_fee_cents: 2000,
        headline: '$20 a month for unlimited cards, 1.5% cash back and approval rules',
        highlights: ['Unlimited employee cards', '1.5% cash back', 'Custom approval rules'],
        best_for: 'A growing company',
        prices: [
          ['monthly_fee', 'Platform fee', 2000, null, 'every month', null],
          ['service_fee', 'Employee card', 0, null, 'any number', null],
          ['rate', 'Foreign transaction fee', null, 0, 'of each purchase made in another currency', null],
          ['penalty', 'Late payment', 3900, null, 'per late payment', null],
        ],
      },
    ],
  },
];

/** `1500` -> `"$15.00"`, `250000` -> `"$2,500.00"`. */
function dollars(cents: number): string {
  const whole = Math.floor(cents / 100);
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${grouped}.${String(cents % 100).padStart(2, '0')}`;
}

/** `310` -> `"3.10%"`. */
function percent(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, '0')}%`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function summaryOf(product: ProductSeed): ProductSummary {
  return {
    product_id: product.product_id,
    family: product.family,
    name: product.name,
    summary: product.summary,
    lowest_monthly_fee_cents: Math.min(...product.plans.map((plan) => plan.monthly_fee_cents)),
    plan_count: product.plans.length,
  };
}

function planOf(plan: PlanSeed): ProductPlan {
  return {
    plan_id: plan.plan_id,
    name: plan.name,
    monthly_fee_cents: plan.monthly_fee_cents,
    headline: plan.headline,
    highlights: plan.highlights,
    best_for: plan.best_for,
  };
}

/** Every price line, built once; `price_id` is the plan id plus the slug of the price name. */
const PRICE_LINES: readonly PriceLine[] = PRODUCTS.flatMap((product) =>
  product.plans.flatMap((plan) =>
    plan.prices.map(([kind, name, amount, rate, applies, waiver]): PriceLine => ({
      price_id: `${plan.plan_id}_${slug(name)}`,
      product_id: product.product_id,
      product_name: product.name,
      plan_id: plan.plan_id,
      plan_name: plan.name,
      kind,
      name,
      amount_cents: amount,
      rate_bps: rate,
      display: amount !== null ? `${dollars(amount)} ${applies}` : `${percent(rate ?? 0)} ${applies}`,
      applies,
      waiver,
    })),
  ),
);

export function productFamilies(family?: ProductFamily): ProductFamilySummary[] {
  const families = family === undefined ? (Object.keys(FAMILY_NAMES) as ProductFamily[]) : [family];
  return families.map((name) => ({
    family: name,
    name: FAMILY_NAMES[name].name,
    summary: FAMILY_NAMES[name].summary,
    products: PRODUCTS.filter((product) => product.family === name).map(summaryOf),
  }));
}

export function productDetail(productId: string): ProductDetail | null {
  const product = PRODUCTS.find((candidate) => candidate.product_id === productId);
  if (product === undefined) return null;
  return {
    ...summaryOf(product),
    description: product.description,
    who_it_is_for: product.who_it_is_for,
    why_different: product.why_different,
    eligibility: product.eligibility,
    plans: product.plans.map(planOf),
    needs_sign_in: product.needs_sign_in,
  };
}

/** Every filter narrows; the words of `text` must all appear in the name, `applies` or `waiver`. */
export function searchPriceLines(query: PriceQuery): PriceLine[] {
  const words = (query.text ?? '').toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  return PRICE_LINES.filter((line) => {
    if (query.product_id !== undefined && line.product_id !== query.product_id) return false;
    if (query.plan_id !== undefined && line.plan_id !== query.plan_id) return false;
    if (query.kind !== undefined && line.kind !== query.kind) return false;
    if (query.max_amount_cents !== undefined) {
      if (line.amount_cents === null || line.amount_cents > query.max_amount_cents) return false;
    }
    const haystack = `${line.name} ${line.applies} ${line.waiver ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

const DAYS: readonly BranchHours['day'][] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/** Opening hours from one weekday range, one Saturday range and Sunday closed or open. */
function week(weekday: [string, string], saturday: [string, string] | null, sunday: [string, string] | null): BranchHours[] {
  return DAYS.map((day) => {
    const range = day === 'saturday' ? saturday : day === 'sunday' ? sunday : weekday;
    return { day, opens: range?.[0] ?? null, closes: range?.[1] ?? null };
  });
}

const BRANCH_HOURS = week(['09:00', '17:00'], ['09:00', '13:00'], null);
const STUDIO_HOURS = week(['10:00', '19:00'], ['10:00', '16:00'], null);
const ALWAYS_OPEN = week(['00:00', '24:00'], ['00:00', '24:00'], ['00:00', '24:00']);

interface BranchSeed {
  readonly branch_id: string;
  readonly name: string;
  readonly city: string;
  readonly state: string;
  readonly kind: BranchKind;
  readonly services: readonly BranchService[];
  readonly address: string;
  readonly time_zone: string;
  readonly atm_count: number;
  readonly languages: readonly string[];
  readonly notes: string;
}

const BRANCHES: readonly BranchSeed[] = [
  {
    branch_id: 'aus_south_congress',
    name: 'South Congress',
    city: 'Austin',
    state: 'TX',
    kind: 'branch',
    services: ['tellers', 'atm_24h', 'advice', 'business_desk', 'safe_deposit', 'notary'],
    address: '1400 Glasswork Lane, Austin, TX 78704',
    time_zone: 'America/Chicago',
    atm_count: 3,
    languages: ['English', 'Spanish'],
    notes: 'The headquarters branch; the business desk takes walk-ins on weekday mornings.',
  },
  {
    branch_id: 'aus_north',
    name: 'North Austin',
    city: 'Austin',
    state: 'TX',
    kind: 'studio',
    services: ['advice', 'atm_24h'],
    address: '88 Clearview Drive, Austin, TX 78758',
    time_zone: 'America/Chicago',
    atm_count: 1,
    languages: ['English', 'Spanish'],
    notes: 'An advice studio: account opening and planning, no cash counter.',
  },
  {
    branch_id: 'chi_the_loop',
    name: 'The Loop',
    city: 'Chicago',
    state: 'IL',
    kind: 'branch',
    services: ['tellers', 'atm_24h', 'business_desk', 'notary', 'coin_counter'],
    address: '120 Pane Street, Chicago, IL 60603',
    time_zone: 'America/Chicago',
    atm_count: 4,
    languages: ['English', 'Spanish', 'Polish'],
    notes: 'The coin counter is free for customers and $5 per bag for everyone else.',
  },
  {
    branch_id: 'chi_wicker_park',
    name: 'Wicker Park',
    city: 'Chicago',
    state: 'IL',
    kind: 'studio',
    services: ['advice'],
    address: '15 Lens Court, Chicago, IL 60622',
    time_zone: 'America/Chicago',
    atm_count: 0,
    languages: ['English'],
    notes: 'An advice studio without ATMs; the nearest ATM is at The Loop.',
  },
  {
    branch_id: 'nyc_flatiron',
    name: 'Flatiron',
    city: 'New York',
    state: 'NY',
    kind: 'branch',
    services: ['tellers', 'atm_24h', 'advice', 'business_desk', 'safe_deposit', 'notary'],
    address: '200 Prism Avenue, New York, NY 10010',
    time_zone: 'America/New_York',
    atm_count: 4,
    languages: ['English', 'Spanish', 'Mandarin'],
    notes: 'Safe deposit boxes are waitlisted; ask at the front desk.',
  },
  {
    branch_id: 'nyc_brooklyn_heights',
    name: 'Brooklyn Heights',
    city: 'New York',
    state: 'NY',
    kind: 'branch',
    services: ['tellers', 'atm_24h', 'coin_counter'],
    address: '75 Window Street, Brooklyn, NY 11201',
    time_zone: 'America/New_York',
    atm_count: 2,
    languages: ['English', 'Russian'],
    notes: 'Tellers only; for advice book the Flatiron branch.',
  },
  {
    branch_id: 'sf_mission',
    name: 'Mission',
    city: 'San Francisco',
    state: 'CA',
    kind: 'branch',
    services: ['tellers', 'atm_24h', 'advice', 'notary'],
    address: '2300 Crystal Street, San Francisco, CA 94110',
    time_zone: 'America/Los_Angeles',
    atm_count: 2,
    languages: ['English', 'Spanish', 'Cantonese'],
    notes: 'Notary by appointment only.',
  },
  {
    branch_id: 'sf_embarcadero',
    name: 'Embarcadero',
    city: 'San Francisco',
    state: 'CA',
    kind: 'atm_lobby',
    services: ['atm_24h'],
    address: '4 Harbor Glass Plaza, San Francisco, CA 94111',
    time_zone: 'America/Los_Angeles',
    atm_count: 6,
    languages: [],
    notes: 'An ATM lobby open around the clock; the ATMs take cash and check deposits.',
  },
];

const ACCESSIBILITY =
  'Step-free entrance, accessible ATMs with audio guidance, and staff trained to assist.';

function branchSummaryOf(branch: BranchSeed): BranchSummary {
  return {
    branch_id: branch.branch_id,
    name: branch.name,
    city: branch.city,
    state: branch.state,
    kind: branch.kind,
    services: branch.services,
  };
}

export const BRANCH_CITIES: readonly string[] = [...new Set(BRANCHES.map((branch) => branch.city))];

export function findBranchSummaries(query: BranchQuery): BranchSearchResult {
  const city = (query.city ?? '').trim().toLowerCase();
  const branches = BRANCHES.filter(
    (branch) =>
      (city === '' || branch.city.toLowerCase() === city) &&
      (query.service === undefined || branch.services.includes(query.service)),
  ).map(branchSummaryOf);
  return { cities: BRANCH_CITIES, branches };
}

export function branchDetail(branchId: string): BranchDetail | null {
  const branch = BRANCHES.find((candidate) => candidate.branch_id === branchId);
  if (branch === undefined) return null;
  const alwaysOpen = branch.kind === 'atm_lobby';
  return {
    ...branchSummaryOf(branch),
    address: branch.address,
    time_zone: branch.time_zone,
    open_24_hours: alwaysOpen,
    hours: alwaysOpen ? ALWAYS_OPEN : branch.kind === 'studio' ? STUDIO_HOURS : BRANCH_HOURS,
    atm_count: branch.atm_count,
    accessibility: ACCESSIBILITY,
    languages: branch.languages,
    notes: branch.notes,
  };
}
