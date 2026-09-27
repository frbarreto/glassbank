/**
 * The public lane (contracts v0.7, D-26).
 *
 * A second MCP endpoint, `PUBLIC_MCP_PATH`, that answers without OAuth. It serves only what the
 * bank would print on its public website - the profile, the product catalog with every price, and
 * the branch directory - through six read-only tools. Nothing here reads a persona, a scratch
 * database or an overlay, and nothing here writes.
 *
 * An anonymous caller has no grant and no login, but every X-ray event is keyed on them
 * (invariant 6). So the lane mints a pseudo grant per visitor (`PUBLIC_GRANT_PREFIX` plus a hash of
 * the caller's IP prefix and User-Agent, used for grouping only, never for gating) and files every
 * visitor under the one pseudo login `PUBLIC_LOGIN_ID`. The dashboard's public viewer sees exactly
 * that login (invariant 11), and the tools say so to the agent (`PUBLIC_LANE_NOTICE`).
 */
import { z } from 'zod';

import {
  AMOUNT_DESCRIPTION,
  EMPTY_ENUM_DESCRIPTION,
  buildLenientInputSchema,
  buildPublishedInputSchema,
  type ToolCatalogEntry,
  type ToolCatalogSnapshot,
  type ToolResult,
} from './tools.js';
import type { XrayEmitter } from './events.js';

// ---------------------------------------------------------------------------
// Identity and routes
// ---------------------------------------------------------------------------

/** Where the sign-in-free MCP endpoint is mounted, next to `/mcp` on the same origin (invariant 4). */
export const PUBLIC_MCP_PATH = '/public/mcp';

/** The pseudo login every anonymous visitor of the public lane belongs to. */
export const PUBLIC_LOGIN_ID = 'lgn_public';

/** Pseudo grants of the public lane: this prefix plus 12 hex characters of the visitor hash. */
export const PUBLIC_GRANT_PREFIX = 'grt_pub_';

/** True for a grant id minted by the public lane. */
export function isPublicGrantId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PUBLIC_GRANT_PREFIX);
}

/**
 * Said to the agent in the server instructions and at the end of every public tool description:
 * the public lane is shown on a dashboard anyone can open (D-26).
 */
export const PUBLIC_LANE_NOTICE =
  'This is the public endpoint, which needs no sign-in: every call to it, rationale included, is shown on a public dashboard, so never put personal details in the arguments or the rationale.' as const;

// ---------------------------------------------------------------------------
// The published data (produced by bank-core, all of it fictional)
// ---------------------------------------------------------------------------

export const PRODUCT_FAMILIES = ['accounts', 'cards', 'business'] as const;
export type ProductFamily = (typeof PRODUCT_FAMILIES)[number];

export const PRICE_KINDS = [
  'monthly_fee',
  'annual_fee',
  'transaction_fee',
  'service_fee',
  'rate',
  'penalty',
] as const;
export type PriceKind = (typeof PRICE_KINDS)[number];

export const BRANCH_KINDS = ['branch', 'studio', 'atm_lobby'] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

export const BRANCH_SERVICES = [
  'tellers',
  'atm_24h',
  'advice',
  'business_desk',
  'safe_deposit',
  'notary',
  'coin_counter',
] as const;
export type BranchService = (typeof BRANCH_SERVICES)[number];

export interface BankProfile {
  readonly name: string;
  readonly tagline: string;
  readonly purpose: string;
  readonly differentiators: readonly { readonly title: string; readonly detail: string }[];
  readonly headquarters: string;
  readonly fictional: true;
  /** What an agent can learn on the public lane, and what needs the customer's sign-in. */
  readonly public_information: readonly string[];
  readonly needs_sign_in: readonly string[];
}

/** One product as the first level of the catalog shows it. */
export interface ProductSummary {
  readonly product_id: string;
  readonly family: ProductFamily;
  readonly name: string;
  readonly summary: string;
  /** The lowest monthly fee among the product's plans, in USD cents (D-1). */
  readonly lowest_monthly_fee_cents: number;
  readonly plan_count: number;
}

export interface ProductFamilySummary {
  readonly family: ProductFamily;
  readonly name: string;
  readonly summary: string;
  readonly products: readonly ProductSummary[];
}

export interface ProductPlan {
  readonly plan_id: string;
  readonly name: string;
  readonly monthly_fee_cents: number;
  readonly headline: string;
  readonly highlights: readonly string[];
  readonly best_for: string;
}

/** One product in full: the second level of the catalog. */
export interface ProductDetail extends ProductSummary {
  readonly description: string;
  readonly who_it_is_for: string;
  readonly why_different: string;
  readonly eligibility: readonly string[];
  readonly plans: readonly ProductPlan[];
  /** What about this product is private to a customer and needs the signed-in connector. */
  readonly needs_sign_in: readonly string[];
}

/** One line of the price list: the third level of the catalog. */
export interface PriceLine {
  readonly price_id: string;
  readonly product_id: string;
  readonly product_name: string;
  readonly plan_id: string;
  readonly plan_name: string;
  readonly kind: PriceKind;
  readonly name: string;
  /** USD cents (D-1); `null` for a rate. */
  readonly amount_cents: number | null;
  /** Basis points, so 310 is 3.10%; `null` for an amount. */
  readonly rate_bps: number | null;
  /** The price as a person reads it, for example "$25.00 per wire" or "3.10% APY". */
  readonly display: string;
  readonly applies: string;
  readonly waiver: string | null;
}

export interface PriceQuery {
  readonly product_id?: string;
  readonly plan_id?: string;
  readonly kind?: PriceKind;
  /** Case-insensitive words matched against the name, `applies` and `waiver`. */
  readonly text?: string;
  /** USD cents; rates are left out when set. */
  readonly max_amount_cents?: number;
}

export interface BranchSummary {
  readonly branch_id: string;
  readonly name: string;
  readonly city: string;
  readonly state: string;
  readonly kind: BranchKind;
  readonly services: readonly BranchService[];
}

export interface BranchHours {
  readonly day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  /** `HH:MM` local time; both `null` on a closed day. */
  readonly opens: string | null;
  readonly closes: string | null;
}

export interface BranchDetail extends BranchSummary {
  readonly address: string;
  readonly time_zone: string;
  /** `true` for a location that never closes (an ATM lobby); `hours` then lists every day open. */
  readonly open_24_hours: boolean;
  readonly hours: readonly BranchHours[];
  readonly atm_count: number;
  readonly accessibility: string;
  readonly languages: readonly string[];
  readonly notes: string;
}

export interface BranchQuery {
  /** Matched case-insensitively against the city name. */
  readonly city?: string;
  readonly service?: BranchService;
}

export interface BranchSearchResult {
  /** Every city served, so an empty answer still tells the agent where to look. */
  readonly cities: readonly string[];
  readonly branches: readonly BranchSummary[];
}

/**
 * The public half of the bank, implemented by `bank-core` (`BankCoreHandle.publicInfo`). Every
 * method emits one `bank.op` (`public.*`), so the dashboard shows how deep an agent went.
 */
export interface PublicBankInfo {
  profile(): Promise<BankProfile>;
  listProducts(family?: ProductFamily): Promise<readonly ProductFamilySummary[]>;
  getProduct(productId: string): Promise<ProductDetail | null>;
  searchPrices(query: PriceQuery): Promise<readonly PriceLine[]>;
  findBranches(query: BranchQuery): Promise<BranchSearchResult>;
  getBranch(branchId: string): Promise<BranchDetail | null>;
}

// ---------------------------------------------------------------------------
// The six public tools (docs/TOOL_CATALOG.md section 8)
// ---------------------------------------------------------------------------

const PUBLIC_METADATA = { 'x-read-only': true, 'x-destructive': false, 'x-gated-by': [] } as const;

function publicAnnotations(title: string) {
  return { title, readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;
}

export const GET_BANK_PROFILE: ToolCatalogEntry = {
  name: 'get_bank_profile',
  title: 'Show what Glass Bank is',
  kind: 'fetch',
  description:
    "Returns Glass Bank's public profile: its purpose, what makes it different from other banks, where it is based, and what an agent can learn here without signing in versus what needs the customer's own sign-in. " +
    'Use it first, to orient yourself or to answer "what is this bank and why would I pick it". ' +
    'Do not use it for prices or locations: list_products, search_prices and find_branches answer those. ' +
    PUBLIC_LANE_NOTICE,
  annotations: publicAnnotations('Show what Glass Bank is'),
  requiredScopes: [],
  featureFlags: [],
  metadata: PUBLIC_METADATA,
  redactionDenyList: [],
  publishedInputSchema: buildPublishedInputSchema(),
  lenientInputSchema: buildLenientInputSchema({}),
};

export const LIST_PRODUCTS: ToolCatalogEntry = {
  name: 'list_products',
  title: "List the bank's products",
  kind: 'fetch',
  description:
    'Lists every product Glass Bank sells, grouped by family (everyday accounts, cards, business), each with its product_id, a one-line summary, the lowest monthly fee among its plans in USD cents and how many plans it has. ' +
    'This is the first level of the product catalog: use it to see what exists, then call get_product with a product_id for its plans, and search_prices for every fee and rate. ' +
    'Do not use it to find out which products a customer holds: that is private and needs the signed-in connector. ' +
    PUBLIC_LANE_NOTICE,
  annotations: publicAnnotations("List the bank's products"),
  requiredScopes: [],
  featureFlags: [],
  metadata: PUBLIC_METADATA,
  redactionDenyList: [],
  publishedInputSchema: buildPublishedInputSchema({
    family: {
      type: 'string',
      description: `Only this product family: accounts (checking and savings), cards (debit and credit) or business. ${EMPTY_ENUM_DESCRIPTION}`,
      enum: [...PRODUCT_FAMILIES, ''],
      default: '',
    },
  }),
  lenientInputSchema: buildLenientInputSchema({
    family: z.enum([...PRODUCT_FAMILIES, '']).default(''),
  }),
};

export const GET_PRODUCT: ToolCatalogEntry = {
  name: 'get_product',
  title: 'Show one product and its plans',
  kind: 'fetch',
  description:
    'Returns one product in full: what it is, who it is for, why it differs from the usual bank offer, who is eligible, and each of its plans with its plan_id, monthly fee in USD cents and highlights. ' +
    'This is the second level of the product catalog: use it after list_products when the user wants to understand or compare the plans of one product, then call search_prices with the product_id, and optionally a plan_id, for the complete fee and rate schedule. ' +
    'Do not use it to check whether a particular customer qualifies or which plan they are on: that needs the signed-in connector. ' +
    PUBLIC_LANE_NOTICE,
  annotations: publicAnnotations('Show one product and its plans'),
  requiredScopes: [],
  featureFlags: [],
  metadata: PUBLIC_METADATA,
  redactionDenyList: [],
  publishedInputSchema: buildPublishedInputSchema(
    {
      product_id: {
        type: 'string',
        description: 'The product_id exactly as list_products returned it, for example clear_checking.',
      },
    },
    ['product_id'],
  ),
  lenientInputSchema: buildLenientInputSchema({ product_id: z.string().min(1) }),
};

export const SEARCH_PRICES: ToolCatalogEntry = {
  name: 'search_prices',
  title: 'Search fees and rates',
  kind: 'fetch',
  description:
    'Searches the published price list: every monthly and annual fee, per-transaction fee, service fee, interest rate and penalty of every plan, each with its amount in USD cents or its rate, a readable form, when it applies and how to have it waived. ' +
    'This is the third and deepest level of the product catalog: use it to answer "how much does this cost", to compare one fee across plans, or to find every price under a budget. ' +
    'Narrow it with a product_id from list_products, a plan_id from get_product, a kind, words to look for or a maximum amount; with no filter it returns the whole list. ' +
    'Do not use it for the fees a customer was actually charged: those are transactions and need the signed-in connector. ' +
    PUBLIC_LANE_NOTICE,
  annotations: publicAnnotations('Search fees and rates'),
  requiredScopes: [],
  featureFlags: [],
  metadata: PUBLIC_METADATA,
  redactionDenyList: [],
  publishedInputSchema: buildPublishedInputSchema({
    product_id: {
      type: 'string',
      description: 'Only prices of this product, by product_id from list_products. Omit it to search every product.',
    },
    plan_id: {
      type: 'string',
      description: 'Only prices of this plan, by plan_id from get_product, for example clear_checking_plus. Omit it to search every plan.',
    },
    kind: {
      type: 'string',
      description: `Only prices of this kind: a monthly, annual, per-transaction or service fee, an interest rate, or a penalty. ${EMPTY_ENUM_DESCRIPTION}`,
      enum: [...PRICE_KINDS, ''],
      default: '',
    },
    query: {
      type: 'string',
      description: 'Words to look for in the name, the condition and the waiver of a price, for example wire, overdraft or abroad; case-insensitive. Omit it for no text filter.',
    },
    max_amount: {
      type: 'integer',
      description: `Only prices of at most this amount; rates, which have no amount, are left out when it is set. ${AMOUNT_DESCRIPTION}`,
      minimum: 0,
    },
  }),
  lenientInputSchema: buildLenientInputSchema({
    product_id: z.string().optional(),
    plan_id: z.string().optional(),
    kind: z.enum([...PRICE_KINDS, '']).default(''),
    query: z.string().max(200).optional(),
    max_amount: z.int().nonnegative().optional(),
  }),
};

export const FIND_BRANCHES: ToolCatalogEntry = {
  name: 'find_branches',
  title: 'Find branches and ATMs',
  kind: 'fetch',
  description:
    "Finds Glass Bank's locations in a city, optionally only those offering one service, each with its branch_id, its kind (a full branch, an advice studio without cash, or an ATM lobby) and its services; the answer also lists every city served. " +
    'This is the first level of the location directory: use it to answer "where can I go", then call get_branch with a branch_id for the address, the opening hours and the ATMs. ' +
    "Do not use it for a customer's own branch or banker: that is private and needs the signed-in connector. " +
    PUBLIC_LANE_NOTICE,
  annotations: publicAnnotations('Find branches and ATMs'),
  requiredScopes: [],
  featureFlags: [],
  metadata: PUBLIC_METADATA,
  redactionDenyList: [],
  publishedInputSchema: buildPublishedInputSchema({
    city: {
      type: 'string',
      description: 'A city name, for example Austin or Chicago, matched case-insensitively. Omit it to list every city.',
    },
    service: {
      type: 'string',
      description: `Only locations offering this service. ${EMPTY_ENUM_DESCRIPTION}`,
      enum: [...BRANCH_SERVICES, ''],
      default: '',
    },
  }),
  lenientInputSchema: buildLenientInputSchema({
    city: z.string().max(100).optional(),
    service: z.enum([...BRANCH_SERVICES, '']).default(''),
  }),
};

export const GET_BRANCH: ToolCatalogEntry = {
  name: 'get_branch',
  title: 'Show one branch',
  kind: 'fetch',
  description:
    'Returns one location in full: street address, time zone, opening hours for every day of the week, services, the number of ATMs, accessibility and the languages spoken. ' +
    'This is the second level of the location directory: use it after find_branches when the user wants to visit. ' +
    "Do not use it to book an appointment: this endpoint takes none, and a signed-in customer's banker is private. " +
    PUBLIC_LANE_NOTICE,
  annotations: publicAnnotations('Show one branch'),
  requiredScopes: [],
  featureFlags: [],
  metadata: PUBLIC_METADATA,
  redactionDenyList: [],
  publishedInputSchema: buildPublishedInputSchema(
    {
      branch_id: {
        type: 'string',
        description: 'The branch_id exactly as find_branches returned it, for example aus_south_congress.',
      },
    },
    ['branch_id'],
  ),
  lenientInputSchema: buildLenientInputSchema({ branch_id: z.string().min(1) }),
};

/** The public catalog in `tools/list` order: the profile, the product levels, the location levels. */
export const PUBLIC_TOOL_CATALOG: readonly ToolCatalogEntry[] = [
  GET_BANK_PROFILE,
  LIST_PRODUCTS,
  GET_PRODUCT,
  SEARCH_PRICES,
  FIND_BRANCHES,
  GET_BRANCH,
];

export type PublicToolName =
  | 'get_bank_profile'
  | 'list_products'
  | 'get_product'
  | 'search_prices'
  | 'find_branches'
  | 'get_branch';

export const PUBLIC_TOOL_NAMES = PUBLIC_TOOL_CATALOG.map((entry) => entry.name);

const PUBLIC_CATALOG_BY_NAME = new Map(PUBLIC_TOOL_CATALOG.map((entry) => [entry.name, entry]));

export function getPublicTool(name: string): ToolCatalogEntry | undefined {
  return PUBLIC_CATALOG_BY_NAME.get(name);
}

// ---------------------------------------------------------------------------
// What a public handler is given, and what `mcp` gets from `tools`
// ---------------------------------------------------------------------------

/** Everything a public tool handler may touch: no persona, no scratch database, no pairing. */
export interface PublicToolContext {
  readonly info: PublicBankInfo;
  /** Already correlated to the visitor's pseudo grant, `PUBLIC_LOGIN_ID` and the request. */
  readonly xray: XrayEmitter;
  readonly now: () => Date;
  /** JSON-RPC request id as a string (invariant 6). */
  readonly requestId: string | null;
  /** The base URL of this request, so a result can point at `<base>/mcp` for the signed-in data. */
  readonly publicBaseUrl: string;
  readonly grantId: string;
  readonly xs: string | null;
}

/** The public counterpart of `ToolRegistry`: one listing for everybody, no scopes, no flags. */
export interface PublicToolRegistry {
  readonly catalog: readonly ToolCatalogEntry[];
  list(): ToolCatalogSnapshot;
  call(name: string, args: Record<string, unknown>, context: PublicToolContext): Promise<ToolResult>;
}
