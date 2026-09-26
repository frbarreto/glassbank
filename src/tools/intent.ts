/**
 * The intent classifier (`intent.inferred`).
 *
 * The server never sees the conversation. What it does see is the tool sequence and the
 * model-authored `rationale`, and from those two it can *guess* what the user is doing. This is a
 * guess, and the contract makes that impossible to hide: `IntentInferredData.model_authored` is
 * the literal `false` and `source` is the literal `classifier`, so the dashboard always labels it
 * as ours, never as fact and never as something the model said (docs/XRAY_EVENT_MODEL.md
 * section 7, panel 6).
 *
 * Deterministic on purpose: same tool sequence plus same rationale, same label and same
 * confidence, so the tests can pin both.
 */
import type { IntentWorkflow } from '../contracts/index.js';

import { BoundedMap } from './bounded.js';

/** The five real workflows; `unknown` is what we answer when nothing scores. */
const WORKFLOWS = [
  'spend_analysis',
  'card_control',
  'payment',
  'balance_check',
  'exploration',
] as const;

type ScoredWorkflow = (typeof WORKFLOWS)[number];

/** What each tool suggests, and how strongly. The ETL tools are weak evidence on purpose: they
 * serve whichever load came before them. */
const TOOL_WEIGHTS: Readonly<Record<string, readonly [ScoredWorkflow, number]>> = {
  load_transactions: ['spend_analysis', 1],
  load_statement_lines: ['spend_analysis', 1],
  load_bills: ['spend_analysis', 1],
  process_data: ['spend_analysis', 0.5],
  execute_query: ['spend_analysis', 0.5],
  clear_table: ['spend_analysis', 0.5],
  load_cards: ['card_control', 1],
  lock_or_unlock_card: ['card_control', 2],
  create_transfer: ['payment', 2],
  load_payees: ['payment', 1],
  load_transfers: ['payment', 1],
  load_accounts: ['balance_check', 1],
  get_bank_categories: ['exploration', 0.25],
  get_currencies: ['exploration', 0.25],
  get_current_user: ['exploration', 0.5],
  get_tool_availability: ['exploration', 0.5],
  xray_get_session_link: ['exploration', 1],
};

/** Stems, not whole words: "aggregating" must match `aggregat` and "categories" `categor`. */
const RATIONALE_PATTERNS: Readonly<Record<ScoredWorkflow, RegExp>> = {
  spend_analysis:
    /\b(spend|spent|spending|purchase|transaction|merchant|categor|breakdown|analy|aggregat|total|report|statement|bill|invoice|overdue|owed|budget)/i,
  card_control: /\b(card|lock|unlock|freeze|frozen|block|stolen|fraud|reactivat)/i,
  payment: /\b(transfer|send|sent|pay|payee|beneficiar|wire|ach|remit|move money)/i,
  balance_check: /\b(balance|available|funds|how much|left in|savings|checking)/i,
  exploration:
    /\b(who am i|which tool|what tool|available tool|behind the scenes|watch|x-ray|xray|dashboard|connected|capabilit|explor|permission|scope)/i,
};

/** A matched rationale family is worth more than a single tool: it is the model's own words. */
const RATIONALE_WEIGHT = 1.5;
/** The tool being called now counts double: it is the freshest evidence. */
const CURRENT_TOOL_MULTIPLIER = 2;

/** Tools that close a workflow, so the classifier reports the settled label after them. */
const CLOSING_TOOLS = new Set(['clear_table', 'lock_or_unlock_card', 'create_transfer']);

export interface IntentInference {
  readonly workflow: IntentWorkflow;
  readonly confidence: number;
  readonly tools: readonly string[];
}

/** Pure scoring: exported so a test can pin a label without driving a whole session. */
export function classifyIntent(input: {
  readonly tool: string;
  readonly rationale: string | null;
  readonly history: readonly string[];
}): IntentInference {
  const scores = new Map<ScoredWorkflow, number>(WORKFLOWS.map((workflow) => [workflow, 0]));
  const add = (workflow: ScoredWorkflow, amount: number): void => {
    scores.set(workflow, (scores.get(workflow) ?? 0) + amount);
  };

  for (const tool of input.history) {
    const weight = TOOL_WEIGHTS[tool];
    if (weight === undefined) continue;
    add(weight[0], weight[1]);
  }
  const current = TOOL_WEIGHTS[input.tool];
  if (current !== undefined) add(current[0], current[1] * (CURRENT_TOOL_MULTIPLIER - 1));

  if (input.rationale !== null) {
    for (const workflow of WORKFLOWS) {
      if (RATIONALE_PATTERNS[workflow].test(input.rationale)) add(workflow, RATIONALE_WEIGHT);
    }
  }

  const ranked = [...scores.entries()].sort((left, right) => {
    if (right[1] !== left[1]) return right[1] - left[1];
    // Ties break on the fixed workflow order, so the label is a function of the input alone.
    return WORKFLOWS.indexOf(left[0]) - WORKFLOWS.indexOf(right[0]);
  });
  const top = ranked[0];
  const second = ranked[1];
  const tools = [...input.history];

  if (top === undefined || top[1] <= 0) {
    return { workflow: 'unknown', confidence: 0.2, tools };
  }
  const margin = (top[1] - (second?.[1] ?? 0)) / top[1];
  const confidence = Math.round(Math.min(0.95, Math.max(0.4, 0.4 + 0.45 * margin)) * 100) / 100;
  return { workflow: top[0], confidence, tools };
}

interface SessionState {
  history: string[];
  lastWorkflow: IntentWorkflow | null;
  lastTools: string;
}

export interface IntentClassifier {
  /**
   * Records one completed call and answers with the inference to emit, or `null` when nothing
   * changed enough to be worth an event. Emitting on every call would drown the intent panel;
   * emitting only on a label change would never show the settled confidence of a finished
   * workflow, so both trigger: a new label, or a tool that closes a workflow.
   */
  observe(sessionKey: string, tool: string, rationale: string | null): IntentInference | null;
  size(): number;
  reset(): void;
}

export function createIntentClassifier(options: {
  readonly maxSessions: number;
  readonly historyLength: number;
}): IntentClassifier {
  const sessions = new BoundedMap<SessionState>(Math.max(1, options.maxSessions));

  return {
    observe(sessionKey, tool, rationale) {
      const state = sessions.get(sessionKey) ?? { history: [], lastWorkflow: null, lastTools: '' };
      const inference = classifyIntent({ tool, rationale, history: [...state.history, tool] });
      state.history = [...state.history, tool].slice(-Math.max(1, options.historyLength));
      sessions.set(sessionKey, state);

      const toolsKey = inference.tools.join(',');
      const labelChanged = inference.workflow !== state.lastWorkflow;
      const closing = CLOSING_TOOLS.has(tool);
      if (!labelChanged && !closing) return null;
      if (!labelChanged && toolsKey === state.lastTools) return null;

      state.lastWorkflow = inference.workflow;
      state.lastTools = toolsKey;
      return inference;
    },
    size() {
      return sessions.size;
    },
    reset() {
      sessions.clear();
    },
  };
}
