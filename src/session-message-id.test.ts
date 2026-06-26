import { describe, it, expect } from 'vitest';

import { sessionInboundMessageId } from './session-message-id.js';

describe('sessionInboundMessageId', () => {
  it('namespaces platform ids by agent group', () => {
    expect(sessionInboundMessageId('1782463173318_12936646455', 'ag-1')).toBe(
      '1782463173318_12936646455:ag-1',
    );
  });

  it('generates a base id when platform id is empty', () => {
    const id = sessionInboundMessageId('', 'ag-1');
    expect(id.endsWith(':ag-1')).toBe(true);
    expect(id.length).toBeGreaterThan('ag-1'.length + 2);
  });
});
