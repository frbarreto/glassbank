/**
 * The two reference tools: `get_bank_categories` and `get_currencies`.
 *
 * Both answer from `BankCore`'s static tables (Ramp's 43-entry `SK_CATEGORIES`, copied verbatim,
 * and the supported currency list with USD first per Decision D-1). They read no customer record,
 * so they need no scope; the result is small enough to return directly instead of going through
 * the load -> process -> query protocol.
 */
import { toolText } from '../../contracts/index.js';

import { toJson } from '../format.js';
import type { ToolCallHandler } from '../types.js';

const getBankCategories: ToolCallHandler = async (context) => {
  const categories = await context.bank.listCategories();
  return toolText(toJson(categories), { categories: [...categories], count: categories.length });
};

const getCurrencies: ToolCallHandler = async (context) => {
  const currencies = await context.bank.listCurrencies();
  return toolText(toJson(currencies), { currencies: [...currencies], count: currencies.length });
};

export const REFERENCE_HANDLERS: Record<string, ToolCallHandler> = {
  get_bank_categories: getBankCategories,
  get_currencies: getCurrencies,
};
