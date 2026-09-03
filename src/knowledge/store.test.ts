import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  KNOWLEDGE_DATABASE_URL: '',
  KNOWLEDGE_ENABLED: false,
}));

describe('knowledge store disabled', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('executeKnowledgeRequest returns disabled error when not configured', async () => {
    vi.doMock('../config.js', () => ({
      KNOWLEDGE_DATABASE_URL: '',
      KNOWLEDGE_ENABLED: false,
    }));
    const { executeKnowledgeRequest } = await import('./store.js');
    const result = await executeKnowledgeRequest({
      op: 'list',
      workspace_id: 'ws-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/disabled/i);
    }
  });
});
