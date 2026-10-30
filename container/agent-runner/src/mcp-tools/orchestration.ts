/**
 * Orchestration artifact MCP tool.
 *
 * Full specialist output stays in gateway.db. The container only receives a
 * ref in its task packet, then reads it through the worker:
 *   MCP tool → messages_out (orchestration_artifact_request)
 *   Worker → Gateway /v1/internal/orchestration-artifacts
 *   Worker writes messages_in (orchestration_artifact_response)
 */
import { findArtifactResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `oart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

const readArtifact: McpToolDefinition = {
  tool: {
    name: 'orchestration_read_artifact',
    description:
      'Read the full specialist result for an orchestration artifact ref (oart-…) listed in your task. Only artifacts from your orchestrator are readable.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        artifact_id: { type: 'string', description: 'Artifact id from the task packet, e.g. oart-…' },
      },
      required: ['artifact_id'],
    },
  },
  async handler(args) {
    const artifactId = typeof args.artifact_id === 'string' ? args.artifact_id.trim() : '';
    if (!artifactId) return err('artifact_id is required');

    const requestId = generateId();
    writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'orchestration_artifact_request',
        requestId,
        artifact_id: artifactId,
      }),
    });
    log(`orchestration_artifact_request: ${requestId}`);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const response = findArtifactResponse(requestId);
      if (response) {
        markCompleted([response.id]);
        try {
          const parsed = JSON.parse(response.content) as {
            ok?: boolean;
            error?: string;
            data?: { content?: string };
          };
          if (!parsed.ok) return err(parsed.error || 'Artifact request failed');
          return ok(parsed.data?.content ?? '');
        } catch {
          return err('Invalid orchestration_artifact_response JSON');
        }
      }
      await sleep(250);
    }
    return err('Timed out waiting for orchestration_artifact_response');
  },
};

registerTools([readArtifact]);
