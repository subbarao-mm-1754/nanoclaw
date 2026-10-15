import { describe, expect, it } from 'vitest';
import {
  DECISION_OPTION_TOKEN_LIMIT,
  DECISION_OPTIONS_TOTAL_LIMIT,
  DECISION_ROUTING_BLURB_CHARS,
} from '../../config.js';
import {
  buildRoutingDescription,
  clampToDecisionTokens,
  estimateDecisionTokens,
  formatOptionCriteria,
  MASTER_ROUTING_DESCRIPTION,
  perOptionTokenBudget,
  truncateRoutingBlurb,
} from './routing-description.js';
import type { GatewayWorkspace } from '../types.js';

describe('routing-description', () => {
  it('truncates long blurbs to the configured routing blurb size', () => {
    const long = 'x'.repeat(DECISION_ROUTING_BLURB_CHARS + 500);
    const out = truncateRoutingBlurb(long);
    expect(out.length).toBeLessThanOrEqual(DECISION_ROUTING_BLURB_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('builds master description', () => {
    const d = buildRoutingDescription({ name: 'MasterAgent', is_master: true });
    expect(d).toContain('MasterAgent');
    expect(d).toContain(MASTER_ROUTING_DESCRIPTION.slice(0, 20));
  });

  it('prefers explicit specialty text', () => {
    expect(
      buildRoutingDescription({
        name: 'Billing',
        explicit: 'invoices and refunds only',
      }),
    ).toBe('invoices and refunds only');
  });

  it('derives from CLAUDE.local.md when needed', () => {
    const d = buildRoutingDescription({
      name: 'HR',
      files: [
        {
          path: 'CLAUDE.local.md',
          content: '# HR\n\nHandles hiring, offers, and employee policies.\n',
        },
      ],
    });
    expect(d).toContain('HR');
    expect(d.toLowerCase()).toContain('hiring');
  });

  it('skips title-only H1 and prefers You-are role line for specialty', () => {
    const d = buildRoutingDescription({
      name: 'SoloAssistant',
      files: [
        {
          path: 'CLAUDE.local.md',
          content:
            '# SoloAssistant\n\nYou are **SoloAssistant**, a business operations assistant for a solopreneur.\n\n' +
            '## Your role\n\n' +
            '- **Invoicing** — draft and send invoices.\n' +
            '- **Clients / contacts** — create and look up client records.\n' +
            '- **Payments** — check paid vs unpaid.\n',
        },
      ],
    });
    expect(d.toLowerCase()).toContain('contact');
    expect(d.toLowerCase()).toContain('invoicing');
    expect(d).not.toBe('SoloAssistant — SoloAssistant');
  });

  it('keeps option criteria under per-option and shared budgets', () => {
    const agent = {
      workspace_id: 'ws-deadfc926889e3db',
      name: 'MasterAgent',
      is_master: true,
      routing_description:
        'General-purpose assistant for everyday questions, research, drafting, and tasks not owned by a specialist',
      agent_kind: 'agent',
    } as GatewayWorkspace;

    const budget = perOptionTokenBudget(5);
    const criteria = formatOptionCriteria(agent, true, budget);
    expect(estimateDecisionTokens(criteria)).toBeLessThanOrEqual(DECISION_OPTION_TOKEN_LIMIT);
    expect(estimateDecisionTokens(criteria)).toBeLessThanOrEqual(budget);
    expect(estimateDecisionTokens(clampToDecisionTokens('word '.repeat(80), 20))).toBeLessThanOrEqual(
      20,
    );
    expect(perOptionTokenBudget(8) * 8).toBeLessThanOrEqual(DECISION_OPTIONS_TOTAL_LIMIT);
  });
});
