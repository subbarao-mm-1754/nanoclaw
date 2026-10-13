import { describe, expect, it } from 'vitest';
import {
  buildRoutingDescription,
  clampToLayaTokens,
  estimateLayaTokens,
  formatLayaOptionCriteria,
  LAYA_OPTION_TOKEN_LIMIT,
  LAYA_OPTIONS_TOTAL_LIMIT,
  MASTER_ROUTING_DESCRIPTION,
  perOptionTokenBudget,
  truncateRoutingBlurb,
} from './routing-description.js';
import type { GatewayWorkspace } from '../types.js';

describe('routing-description', () => {
  it('truncates long blurbs', () => {
    const long = 'x'.repeat(200);
    expect(truncateRoutingBlurb(long).length).toBeLessThanOrEqual(120);
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

  it('keeps Laya option criteria under per-option and shared budgets', () => {
    const agent = {
      workspace_id: 'ws-deadfc926889e3db',
      name: 'MasterAgent',
      is_master: true,
      routing_description:
        'General-purpose assistant for everyday questions, research, drafting, and tasks not owned by a specialist',
      agent_kind: 'agent',
    } as GatewayWorkspace;

    const budget = perOptionTokenBudget(5);
    const criteria = formatLayaOptionCriteria(agent, true, budget);
    expect(estimateLayaTokens(criteria)).toBeLessThanOrEqual(LAYA_OPTION_TOKEN_LIMIT);
    expect(estimateLayaTokens(criteria)).toBeLessThanOrEqual(budget);
    expect(estimateLayaTokens(clampToLayaTokens('word '.repeat(80), 20))).toBeLessThanOrEqual(20);
    expect(perOptionTokenBudget(8) * 8).toBeLessThanOrEqual(LAYA_OPTIONS_TOTAL_LIMIT);
  });
});
