import type { GatewayAgentFile } from '../types.js';
import type { OrchestratorGraph, ParsedSpecialistSpec } from './types.js';

function formatGraph(graph: OrchestratorGraph | undefined): string {
  if (!graph?.nodes?.length) {
    return [
      'No fixed graph was registered. Decide the next specialist based on the goal,',
      'delegate with send_message(to="<specialist>"), wait for their reply, then continue',
      'or reply to the user via the default client destination.',
    ].join(' ');
  }

  const lines: string[] = ['### Registered graph', ''];
  if (graph.entry) lines.push(`- Entry node: \`${graph.entry}\``);
  lines.push('- Nodes:');
  for (const n of graph.nodes) {
    lines.push(
      `  - \`${n.id}\`${n.agent ? ` → agent \`${n.agent}\`` : ''}${n.type ? ` (${n.type})` : ''}${n.description ? `: ${n.description}` : ''}`,
    );
  }
  if (graph.edges?.length) {
    lines.push('- Edges:');
    for (const e of graph.edges) {
      lines.push(`  - \`${e.from}\` → \`${e.to}\`${e.when ? ` when ${e.when}` : ''}`);
    }
  }
  if (graph.loops?.length) {
    lines.push('- Loops (respect max_iterations):');
    for (const l of graph.loops) {
      lines.push(
        `  - \`${l.from}\` ↻ \`${l.to}\` max ${l.max_iterations}${l.when ? ` when ${l.when}` : ''}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * Ensure orchestrator instructions include delegation rules + graph + specialist list.
 * Merges into existing CLAUDE.local.md rather than replacing user content.
 */
export function composeOrchestratorFiles(input: {
  files: GatewayAgentFile[];
  specialists: ParsedSpecialistSpec[];
  graph?: OrchestratorGraph;
}): GatewayAgentFile[] {
  const files = [...input.files];
  const idx = files.findIndex((f) => f.path === 'CLAUDE.local.md' || f.path === 'CLAUDE.md');
  const existing = idx >= 0 ? files[idx]!.content : `# Orchestrator\n`;

  const specialistLines = input.specialists.map((s) => {
    const role = s.role ? ` — ${s.role}` : '';
    return `- \`${s.name}\`${role}`;
  });

  const appendix = `

## Multi-agent orchestration (Gateway)

You are an **orchestrator**. Coordinate specialists; do not do their specialized work yourself when a specialist exists.

### Specialists (send_message destinations)
${specialistLines.length ? specialistLines.join('\n') : '- (none registered)'}

${formatGraph(input.graph)}

### Rules
1. Talk to the user on the default / \`client\` destination.
2. Delegate tasks with \`send_message\` to a specialist destination name above.
3. Follow the graph and loop limits. Prefer reuse of prior specialist results over re-asking.
4. When the goal is met, summarize for the user and stop.
5. Never invent credentials. Never claim a specialist finished unless you received their reply.
`;

  const marker = '## Multi-agent orchestration (Gateway)';
  const content = existing.includes(marker)
    ? existing.replace(/## Multi-agent orchestration \(Gateway\)[\s\S]*$/, appendix.trimStart())
    : `${existing.trimEnd()}\n${appendix}`;

  const path = idx >= 0 ? files[idx]!.path : 'CLAUDE.local.md';
  const next = { path, content };
  if (idx >= 0) {
    files[idx] = next;
  } else {
    files.unshift(next);
  }
  return files;
}
