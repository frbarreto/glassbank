/**
 * The intent classifier.
 *
 * Two things are being pinned here. The labels and confidences, because the classifier is
 * deterministic and a change to it should be a decision, not a surprise. And the honesty of the
 * event: `intent.inferred` always says `source: classifier` and `model_authored: false`, so the
 * dashboard can never present our guess as something the model said.
 */
import { describe, expect, it } from 'vitest';

import { classifyIntent, createIntentClassifier, createTools } from '../index.js';

import { createFakeToolContext } from './fakes.js';

describe('classifyIntent', () => {
  it('reads the fixture spend-analysis sequence as spend_analysis', () => {
    const inference = classifyIntent({
      tool: 'clear_table',
      rationale: 'The category breakdown is answered, so free the table budget.',
      history: ['load_transactions', 'process_data', 'execute_query', 'clear_table'],
    });
    expect(inference.workflow).toBe('spend_analysis');
    expect(inference.confidence).toBe(0.85);
    expect(inference.tools).toEqual([
      'load_transactions',
      'process_data',
      'execute_query',
      'clear_table',
    ]);
  });

  it.each([
    ['card_control', 'lock_or_unlock_card', 'The user said the card ending 8842 was stolen.'],
    ['payment', 'create_transfer', 'The user asked to send money to their landscaper.'],
    [
      'balance_check',
      'load_accounts',
      'The user asked how much is left in their checking account.',
    ],
    [
      'exploration',
      'xray_get_session_link',
      'The user wants to watch what happens behind the scenes.',
    ],
  ])('reads %s from the tool and the rationale', (workflow, tool, rationale) => {
    const inference = classifyIntent({ tool, rationale, history: [tool] });
    expect(inference.workflow).toBe(workflow);
    expect(inference.confidence).toBeGreaterThanOrEqual(0.4);
    expect(inference.confidence).toBeLessThanOrEqual(0.95);
  });

  it('answers unknown, with low confidence, when nothing scores', () => {
    const inference = classifyIntent({ tool: 'not_a_tool', rationale: null, history: [] });
    expect(inference).toEqual({ workflow: 'unknown', confidence: 0.2, tools: [] });
  });

  it('is deterministic: the same sequence always gives the same label and confidence', () => {
    const input = {
      tool: 'execute_query',
      rationale: 'Total the spending per merchant.',
      history: ['load_transactions', 'process_data', 'execute_query'],
    };
    expect(classifyIntent(input)).toEqual(classifyIntent(input));
  });

  it('lets the rationale pull a generic ETL call towards the workflow it serves', () => {
    const generic = classifyIntent({
      tool: 'execute_query',
      rationale: null,
      history: ['execute_query'],
    });
    const aboutCards = classifyIntent({
      tool: 'execute_query',
      rationale: 'Which cards are locked right now?',
      history: ['load_cards', 'process_data', 'execute_query'],
    });
    expect(generic.workflow).toBe('spend_analysis');
    expect(aboutCards.workflow).toBe('card_control');
  });
});

describe('when intent.inferred is emitted', () => {
  it('emits on the first call of a workflow and again when it closes', async () => {
    const registry = createTools();
    const context = createFakeToolContext();
    const table = (
      (
        await registry.call(
          'load_transactions',
          {
            from_date: '2026-01-01',
            to_date: '2026-12-31',
            rationale:
              'The user asked where their money went, so load the postings before aggregating.',
          },
          context,
        )
      ).structuredContent as { table_name: string }
    ).table_name;
    expect(context.xray.ofType('intent.inferred')).toHaveLength(1);

    await registry.call(
      'process_data',
      {
        table_name: table,
        cols: ['merchant_name', 'amount_cents'],
        rationale: 'Build the table to total spending.',
      },
      context,
    );
    await registry.call(
      'execute_query',
      {
        table_name: table,
        query: `SELECT * FROM "${table}"`,
        rationale: 'Total the spending per merchant.',
      },
      context,
    );
    // Same workflow, nothing closed: no new event, because the intent panel is not a log.
    expect(context.xray.ofType('intent.inferred')).toHaveLength(1);

    await registry.call(
      'clear_table',
      {
        table_name: table,
        rationale: 'The category breakdown is answered, so free the table budget.',
      },
      context,
    );
    const emitted = context.xray.ofType('intent.inferred');
    expect(emitted).toHaveLength(2);
    expect(emitted[1]?.data).toEqual({
      workflow: 'spend_analysis',
      confidence: 0.85,
      source: 'classifier',
      model_authored: false,
      tools: ['load_transactions', 'process_data', 'execute_query', 'clear_table'],
    });
  });

  it('emits again when the workflow changes', async () => {
    const registry = createTools();
    const context = createFakeToolContext();
    await registry.call('load_cards', { rationale: 'The user asked about their cards.' }, context);
    await registry.call(
      'load_accounts',
      { rationale: 'The user asked how much is available in their checking account.' },
      context,
    );
    const workflows = context.xray.ofType('intent.inferred').map((event) => event.data.workflow);
    expect(workflows).toEqual(['card_control', 'balance_check']);
  });

  it('never marks an inference as model-authored, and always carries the correlation', async () => {
    const registry = createTools();
    const context = createFakeToolContext();
    await registry.call('get_current_user', { rationale: 'Who is connected?' }, context);
    const event = context.xray.lastOfType('intent.inferred');
    expect(event?.data.model_authored).toBe(false);
    expect(event?.data.source).toBe('classifier');
    expect(event?.xs).toBe('xs_demo01');
    expect(event?.login_id).toBe('lgn_demo01');
    expect(event?.persona_id).toBe('per_ava01');
  });

  it('does not classify a call it refused', async () => {
    const registry = createTools();
    const context = createFakeToolContext({ auth: { scopes: [] } });
    await registry.call('load_cards', { rationale: 'The user asked about their cards.' }, context);
    expect(context.xray.ofType('intent.inferred')).toHaveLength(0);
    expect(context.xray.ofType('intent.declared')).toHaveLength(1);
  });

  it('keeps one history per session and evicts the oldest under the cap', () => {
    const classifier = createIntentClassifier({ maxSessions: 2, historyLength: 3 });
    expect(classifier.observe('xs_a', 'load_cards', null)?.workflow).toBe('card_control');
    expect(classifier.observe('xs_b', 'load_accounts', null)?.workflow).toBe('balance_check');
    // A third session evicts the first, whose next call therefore looks like a fresh workflow.
    expect(classifier.observe('xs_c', 'load_payees', null)?.workflow).toBe('payment');
    expect(classifier.size()).toBe(2);
    expect(classifier.observe('xs_a', 'load_cards', null)?.workflow).toBe('card_control');
  });
});
