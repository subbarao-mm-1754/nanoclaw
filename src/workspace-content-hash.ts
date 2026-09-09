import { createHash } from 'crypto';

export interface WorkspaceContentHashInput {
  agent_group_id: string;
  name: string;
  folder?: string | null;
  cli_scope?: string | null;
  container_config: unknown;
  files: Array<{ path: string; content: string | Buffer }>;
}

/** Stable JSON for hashing — sorted object keys, arrays keep order. */
function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

/**
 * Content hash for a worker workspace prepare payload.
 * Used by Gateway (skip HTTP when unchanged) and Worker (skip materialize when unchanged).
 */
export function computeWorkspaceContentHash(input: WorkspaceContentHashInput): string {
  const files = input.files
    .map((f) => ({
      path: f.path.replace(/\\/g, '/'),
      content: Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8'),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const meta = canonicalize({
    agent_group_id: input.agent_group_id,
    name: input.name,
    folder: input.folder ?? null,
    cli_scope: input.cli_scope ?? 'group',
    container_config: input.container_config,
  });

  const h = createHash('sha256');
  h.update(JSON.stringify(meta));
  h.update('\n');
  for (const file of files) {
    h.update(file.path);
    h.update('\0');
    h.update(file.content);
    h.update('\n');
  }
  return h.digest('hex');
}
