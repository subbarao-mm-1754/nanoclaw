import { describe, it, expect } from 'vitest';

import {
  platformMessageIdFromSession,
  sessionInboundMessageId,
} from './session-message-id.js';

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

describe('platformMessageIdFromSession', () => {
  it('strips an exact agent group suffix', () => {
    expect(
      platformMessageIdFromSession(
        '1789723664704_2863465488564:ag-c5c35a46a1db13c4',
        'ag-c5c35a46a1db13c4',
      ),
    ).toBe('1789723664704_2863465488564');
  });

  it('strips trailing :ag-… without an explicit agent group id', () => {
    expect(
      platformMessageIdFromSession('1789723664704_2863465488564:ag-c5c35a46a1db13c4'),
    ).toBe('1789723664704_2863465488564');
  });

  it('preserves platform ids that already contain colons', () => {
    expect(platformMessageIdFromSession('6037840640:42:ag-1', 'ag-1')).toBe('6037840640:42');
    expect(platformMessageIdFromSession('6037840640:42:ag-1')).toBe('6037840640:42');
  });

  it('leaves non-namespaced ids unchanged', () => {
    expect(platformMessageIdFromSession('1789723664704_2863465488564')).toBe(
      '1789723664704_2863465488564',
    );
  });
});
