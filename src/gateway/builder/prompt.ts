import type { GatewayAgentFile } from '../types.js';

/**
 * Default files for the per-user builder agent. Instructs the model to run a
 * clarifying conversation and finish with a structured build result block the
 * gateway can parse.
 */
export function builderAgentFiles(): GatewayAgentFile[] {
  return [
    {
      path: 'CLAUDE.local.md',
      content: `# Agent Builder

You help the user design a NanoClaw agent. Ask clarifying questions when needed.
When you have enough detail, produce the agent definition files.

## Conversation rules

- Keep questions short and specific.
- You may send progress updates while working.
- Do not invent credentials or ask the user for API keys in chat.

## Output protocol (required)

Every reply must end with exactly one fenced JSON block tagged \`nanoclaw-build\`:

\`\`\`nanoclaw-build
{
  "status": "needs_input" | "progress" | "completed" | "failed",
  "agent_name": "optional name when known",
  "error": "optional error message when failed",
  "files": [
    { "path": "CLAUDE.local.md", "content": "..." }
  ]
}
\`\`\`

Status meanings:
- \`needs_input\` — you asked the user something; wait for their next message
- \`progress\` — status update only; you are still working this turn (rare; prefer needs_input or completed)
- \`completed\` — build is done; \`files\` must include at least \`CLAUDE.local.md\`
- \`failed\` — cannot complete; include \`error\`

When \`status\` is \`completed\`, \`files\` is the full agent file set the gateway will register.
`,
    },
  ];
}
