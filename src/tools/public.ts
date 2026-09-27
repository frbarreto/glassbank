/**
 * The six public tools (contracts v0.7, D-26): the handlers and their registry.
 *
 * They read `PublicBankInfo` and nothing else - no persona, no scratch table, no pairing - so an
 * anonymous visitor of `/public/mcp` can browse the whole catalog. Every answer is compact JSON
 * plus `next`: the call that goes one level deeper, and, where the question turns personal, the
 * signed-in connector at `<base>/mcp`. That pointer is the whole hand-off from the public lane to
 * the private one; the server never challenges an anonymous caller (docs/TOOL_CATALOG.md section 8).
 *
 * The per-call sequence is the registry's (`registry.ts`) minus scopes, flags and the intent
 * classifier, whose workflows describe a customer's own data: `intent.declared` or
 * `intent.missing` first, then the lenient schema, then the handler; a throw becomes a tool error.
 */
import {
  OAUTH_ROUTES,
  PUBLIC_LOGIN_ID,
  PUBLIC_MCP_PATH,
  PUBLIC_TOOL_CATALOG,
  XRAY_ROUTES,
  getPublicTool,
  toolError,
  toolText,
  type BranchService,
  type PriceKind,
  type ProductFamily,
  type PublicToolContext,
  type PublicToolName,
  type PublicToolRegistry,
  type ToolCatalogSnapshot,
  type ToolResult,
  type XrayCorrelation,
} from '../contracts/index.js';

import { snapshotFor } from './availability.js';
import { formatMoney, toJson } from './format.js';
import { emitIntent, readRationale, stripRationale } from './rationale.js';
import { validationMessage } from './registry.js';

export type PublicToolHandler = (
  context: PublicToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

/** `""` and whitespace mean "no filter", as on every optional enum (Ramp convention). */
function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** The three addresses an agent may hand the user: this lane, the signed-in one, the dashboard. */
function endpointsFor(base: string) {
  return {
    public_mcp: `${base}${PUBLIC_MCP_PATH}`,
    signed_in_mcp: `${base}${OAUTH_ROUTES.mcp}`,
    public_dashboard: `${base}${XRAY_ROUTES.spa}?lane=public`,
  };
}

function signInPointer(base: string, what: string): string {
  return `${what} needs the customer's sign-in: the user adds the connector ${base}${OAUTH_ROUTES.mcp} and logs in there.`;
}

async function knownProductIds(context: PublicToolContext): Promise<string[]> {
  const families = await context.info.listProducts();
  return families.flatMap((family) => family.products.map((product) => product.product_id));
}

export const PUBLIC_HANDLERS: Readonly<Record<PublicToolName, PublicToolHandler>> = {
  async get_bank_profile(context) {
    const profile = await context.info.profile();
    return toolText(
      toJson({
        ...profile,
        endpoints: endpointsFor(context.publicBaseUrl),
        next: [
          'Call list_products for the product catalog, or find_branches for locations.',
          signInPointer(context.publicBaseUrl, 'Anything about a customer'),
        ],
      }),
    );
  },

  async list_products(context, args) {
    const family = optional(args.family) as ProductFamily | undefined;
    const families = await context.info.listProducts(family);
    return toolText(
      toJson({
        families: families.map((entry) => ({
          ...entry,
          products: entry.products.map((product) => ({
            ...product,
            lowest_monthly_fee: formatMoney(product.lowest_monthly_fee_cents),
          })),
        })),
        next: ['Call get_product with a product_id for its plans and who it is for.'],
      }),
    );
  },

  async get_product(context, args) {
    const productId = String(args.product_id);
    const product = await context.info.getProduct(productId);
    if (product === null) {
      const known = await knownProductIds(context);
      return toolError(
        `there is no product "${productId}". Known product_ids: ${known.join(', ')}. Call list_products to see them.`,
      );
    }
    const firstPlan = product.plans[0]?.plan_id ?? '';
    return toolText(
      toJson({
        ...product,
        lowest_monthly_fee: formatMoney(product.lowest_monthly_fee_cents),
        plans: product.plans.map((plan) => ({
          ...plan,
          monthly_fee: formatMoney(plan.monthly_fee_cents),
        })),
        next: [
          `Call search_prices with product_id "${product.product_id}" for every fee and rate, or add a plan_id such as "${firstPlan}" for one plan.`,
          signInPointer(context.publicBaseUrl, `Whether the user qualifies, and which plan they are on,`),
        ],
      }),
    );
  },

  async search_prices(context, args) {
    const productId = optional(args.product_id);
    if (productId !== undefined && (await context.info.getProduct(productId)) === null) {
      const known = await knownProductIds(context);
      return toolError(
        `there is no product "${productId}". Known product_ids: ${known.join(', ')}.`,
      );
    }
    const planId = optional(args.plan_id);
    const kind = optional(args.kind) as PriceKind | undefined;
    const text = optional(args.query);
    const maxAmount = typeof args.max_amount === 'number' ? args.max_amount : undefined;
    const lines = await context.info.searchPrices({
      ...(productId === undefined ? {} : { product_id: productId }),
      ...(planId === undefined ? {} : { plan_id: planId }),
      ...(kind === undefined ? {} : { kind }),
      ...(text === undefined ? {} : { text }),
      ...(maxAmount === undefined ? {} : { max_amount_cents: maxAmount }),
    });
    return toolText(
      toJson({
        count: lines.length,
        prices: lines.map((line) => ({
          ...line,
          amount: line.amount_cents === null ? null : formatMoney(line.amount_cents),
        })),
        next:
          lines.length === 0
            ? [
                'No price matched every filter. Drop a filter, or call get_product for the plan_ids of a product.',
              ]
            : [signInPointer(context.publicBaseUrl, 'The fees a customer was actually charged')],
      }),
    );
  },

  async find_branches(context, args) {
    const city = optional(args.city);
    const service = optional(args.service) as BranchService | undefined;
    const result = await context.info.findBranches({
      ...(city === undefined ? {} : { city }),
      ...(service === undefined ? {} : { service }),
    });
    return toolText(
      toJson({
        cities: result.cities,
        count: result.branches.length,
        branches: result.branches,
        next:
          result.branches.length === 0
            ? [`No location matched. Cities served: ${result.cities.join(', ')}.`]
            : ['Call get_branch with a branch_id for the address, opening hours and ATMs.'],
      }),
    );
  },

  async get_branch(context, args) {
    const branchId = String(args.branch_id);
    const branch = await context.info.getBranch(branchId);
    if (branch === null) {
      return toolError(
        `there is no location "${branchId}". Call find_branches for the branch_ids of a city.`,
      );
    }
    return toolText(
      toJson({
        ...branch,
        next: [signInPointer(context.publicBaseUrl, "A customer's own banker or appointment")],
      }),
    );
  },
};

export interface PublicToolsStats {
  readonly calls: number;
  readonly errors: number;
}

export interface PublicToolsHandle extends PublicToolRegistry {
  readonly handlers: Readonly<Record<PublicToolName, PublicToolHandler>>;
  stats(): PublicToolsStats;
}

/** The correlation of a public call: the visitor's pseudo grant under `PUBLIC_LOGIN_ID`. */
function publicCorrelation(context: PublicToolContext): XrayCorrelation {
  return {
    xs: context.xs,
    login_id: PUBLIC_LOGIN_ID,
    grant_id: context.grantId,
    request_id: context.requestId,
  };
}

/** The public lane's registry: one listing for everybody, no scopes, no flags (D-26). */
export function createPublicTools(): PublicToolsHandle {
  // No grant and no flag changes it, so the snapshot and its hash are computed once.
  const snapshot: ToolCatalogSnapshot = snapshotFor({ scopes: [] }, [], PUBLIC_TOOL_CATALOG);
  let calls = 0;
  let errors = 0;

  return {
    catalog: PUBLIC_TOOL_CATALOG,
    handlers: PUBLIC_HANDLERS,
    list: () => snapshot,

    async call(name, args, context): Promise<ToolResult> {
      const entry = getPublicTool(name);
      if (entry === undefined) throw new Error(`Unknown tool: ${name}`);
      calls += 1;

      emitIntent(context.xray, name, readRationale(args.rationale), publicCorrelation(context));

      const parsed = entry.lenientInputSchema.safeParse(args);
      if (!parsed.success) {
        errors += 1;
        return toolError(validationMessage(entry.name, parsed.error.issues));
      }

      let result: ToolResult;
      try {
        const handler = PUBLIC_HANDLERS[name as PublicToolName];
        result = await handler(context, stripRationale(parsed.data as Record<string, unknown>));
      } catch (error) {
        result = toolError(error instanceof Error ? error.message : String(error));
      }
      if (result.isError === true) errors += 1;
      return result;
    },

    stats: () => ({ calls, errors }),
  };
}
