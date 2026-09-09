import { describe, it, expect } from 'vitest';

import { computeWorkspaceContentHash } from './workspace-content-hash.js';

describe('computeWorkspaceContentHash', () => {
  const base = {
    agent_group_id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    cli_scope: 'group',
    container_config: {
      provider: 'claude',
      skills: 'all' as const,
      mcpServers: {},
      packages: { apt: [] as string[], npm: [] as string[] },
      additionalMounts: [],
    },
    files: [{ path: 'CLAUDE.local.md', content: 'hello' }],
  };

  it('is stable for equivalent payloads', () => {
    const a = computeWorkspaceContentHash(base);
    const b = computeWorkspaceContentHash({
      ...base,
      files: [{ path: 'CLAUDE.local.md', content: 'hello' }],
      container_config: {
        additionalMounts: [],
        packages: { npm: [], apt: [] },
        mcpServers: {},
        skills: 'all',
        provider: 'claude',
      },
    });
    expect(a).toBe(b);
  });

  it('changes when file content changes', () => {
    const a = computeWorkspaceContentHash(base);
    const b = computeWorkspaceContentHash({
      ...base,
      files: [{ path: 'CLAUDE.local.md', content: 'changed' }],
    });
    expect(a).not.toBe(b);
  });

  it('is order-independent for files', () => {
    const a = computeWorkspaceContentHash({
      ...base,
      files: [
        { path: 'a.md', content: '1' },
        { path: 'b.md', content: '2' },
      ],
    });
    const b = computeWorkspaceContentHash({
      ...base,
      files: [
        { path: 'b.md', content: '2' },
        { path: 'a.md', content: '1' },
      ],
    });
    expect(a).toBe(b);
  });
});
