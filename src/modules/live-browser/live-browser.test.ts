import { afterEach, describe, expect, it } from 'vitest';

import {
  getLiveBrowserByWorkspace,
  registerEndpoint,
  resetLiveBrowserRegistryForTests,
  setControl,
  unregisterEndpoint,
} from './registry.js';
import {
  consumeLiveBrowserTicket,
  issueLiveBrowserTicket,
  resetLiveBrowserTicketsForTests,
} from './tickets.js';

describe('live-browser registry', () => {
  afterEach(() => {
    resetLiveBrowserRegistryForTests();
    resetLiveBrowserTicketsForTests();
  });

  it('indexes endpoints by workspace', () => {
    registerEndpoint({
      sessionId: 's1',
      workspaceId: 'ws1',
      agentGroupId: 'ag1',
      containerName: 'c1',
      containerPort: 9223,
      control: 'agent',
      registeredAt: Date.now(),
    });
    expect(getLiveBrowserByWorkspace('ws1')?.sessionId).toBe('s1');
    setControl('s1', 'human');
    expect(getLiveBrowserByWorkspace('ws1')?.control).toBe('human');
    unregisterEndpoint('s1');
    expect(getLiveBrowserByWorkspace('ws1')).toBeUndefined();
  });

  it('issues and validates tickets for the same workspace', () => {
    const { ticket } = issueLiveBrowserTicket({
      userId: 'u1',
      workspaceId: 'ws1',
    });
    const row = consumeLiveBrowserTicket(ticket);
    expect(row?.userId).toBe('u1');
    expect(row?.workspaceId).toBe('ws1');
    expect(consumeLiveBrowserTicket('bogus')).toBeNull();
  });
});
