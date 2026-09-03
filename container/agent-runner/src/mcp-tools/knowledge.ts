/**
 * Knowledge MCP tools — durable per-agent markdown/text store in Gateway Postgres.
 *
 * Flow (container never talks to Postgres):
 *   MCP tool → messages_out (knowledge_request)
 *   Worker collects system action → Gateway /v1/internal/knowledge
 *   Worker writes messages_in (knowledge_response, trigger=0)
 *   MCP tool polls inbound.db and returns to the model
 */
import { findKnowledgeResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `knowledge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type KnowledgeOp = 'save' | 'get' | 'search' | 'list' | 'delete';

async function knowledgeRoundTrip(
  op: KnowledgeOp,
  args: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const requestId = generateId();
  writeMessageOut({
    id: requestId,
    kind: 'system',
    content: JSON.stringify({
      action: 'knowledge_request',
      requestId,
      op,
      ...args,
    }),
  });

  log(`knowledge_request ${op}: ${requestId}`);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = findKnowledgeResponse(requestId);
    if (response) {
      markCompleted([response.id]);
      try {
        const parsed = JSON.parse(response.content) as {
          type: string;
          requestId: string;
          ok: boolean;
          data?: unknown;
          error?: string;
        };
        return { ok: Boolean(parsed.ok), data: parsed.data, error: parsed.error };
      } catch {
        return { ok: false, error: 'Invalid knowledge_response JSON' };
      }
    }
    await sleep(250);
  }

  return { ok: false, error: `Timed out waiting for knowledge_response (${op})` };
}

function formatResult(result: { ok: boolean; data?: unknown; error?: string }): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  if (!result.ok) return err(result.error || 'Knowledge request failed');
  return ok(JSON.stringify(result.data, null, 2));
}

const knowledgeSave: McpToolDefinition = {
  tool: {
    name: 'knowledge_save',
    description:
      'Save or update a durable knowledge document for this agent (Markdown/text) in the Gateway Postgres store. Survives container recreate. Use paths like notes/weekly.md.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Document path, e.g. notes/report.md' },
        content: { type: 'string', description: 'Full document content (usually Markdown)' },
        title: { type: 'string', description: 'Optional title (defaults to filename)' },
      },
      required: ['path', 'content'],
    },
  },
  async handler(args) {
    const path = args.path as string;
    const content = args.content as string;
    if (!path || content == null) return err('path and content are required');
    return formatResult(
      await knowledgeRoundTrip('save', {
        path,
        content,
        title: typeof args.title === 'string' ? args.title : undefined,
      }),
    );
  },
};

const knowledgeGet: McpToolDefinition = {
  tool: {
    name: 'knowledge_get',
    description: 'Fetch a previously saved knowledge document by path for this agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Document path' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const path = args.path as string;
    if (!path) return err('path is required');
    return formatResult(await knowledgeRoundTrip('get', { path }));
  },
};

const knowledgeSearch: McpToolDefinition = {
  tool: {
    name: 'knowledge_search',
    description:
      'Full-text search this agent\'s durable knowledge store. Returns matching paths with short previews.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = args.query as string;
    if (!query) return err('query is required');
    return formatResult(
      await knowledgeRoundTrip('search', {
        query,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }),
    );
  },
};

const knowledgeList: McpToolDefinition = {
  tool: {
    name: 'knowledge_list',
    description: 'List knowledge documents stored for this agent (optional path prefix filter).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        prefix: { type: 'string', description: 'Optional path prefix, e.g. notes/' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
      required: [],
    },
  },
  async handler(args) {
    return formatResult(
      await knowledgeRoundTrip('list', {
        prefix: typeof args.prefix === 'string' ? args.prefix : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }),
    );
  },
};

const knowledgeDelete: McpToolDefinition = {
  tool: {
    name: 'knowledge_delete',
    description: 'Delete a knowledge document by path for this agent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Document path' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const path = args.path as string;
    if (!path) return err('path is required');
    return formatResult(await knowledgeRoundTrip('delete', { path }));
  },
};

registerTools([knowledgeSave, knowledgeGet, knowledgeSearch, knowledgeList, knowledgeDelete]);
