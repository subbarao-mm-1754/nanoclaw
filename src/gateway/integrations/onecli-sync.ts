import { execFile } from 'child_process';
import { promisify } from 'util';

import { log } from '../../log.js';
import {
  ensureAgentV1,
  findAgentIdByIdentifierV1,
  grantSecretToAgentV1,
} from '../../onecli-v1.js';

const execFileAsync = promisify(execFile);

export async function ensureOnecliAgent(input: {
  name: string;
  identifier: string;
}): Promise<void> {
  // ensureAgentV1 creates the agent and grants all vault secrets (Anthropic +
  // MCP). OneCLI 1.7+ removed secret-mode "all"; grants are required.
  await ensureAgentV1({
    name: input.name,
    identifier: input.identifier,
  });
}

export interface OnecliSecretSpec {
  name: string;
  value: string;
  hostPattern: string;
  headerName?: string;
  valueFormat?: string;
  existingSecretId?: string | null;
}

async function runOnecli(args: string[]): Promise<unknown> {
  const { stdout, stderr } = await execFileAsync('onecli', args, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    env: process.env,
  });
  const out = (stdout || stderr || '').trim();
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    log.warn('onecli returned non-JSON output', { args: args.slice(0, 3), out: out.slice(0, 500) });
    return out;
  }
}

function extractId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (typeof obj.id === 'string') return obj.id;
  if (obj.data && typeof obj.data === 'object') {
    const data = obj.data as Record<string, unknown>;
    if (typeof data.id === 'string') return data.id;
  }
  return null;
}

function extractList(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload as Array<Record<string, unknown>>;
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    if (Array.isArray(obj.data)) return obj.data as Array<Record<string, unknown>>;
  }
  return [];
}

function isOnecliNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /"code"\s*:\s*"NOT_FOUND"|error"\s*:\s*"Not Found"|NOT_FOUND/i.test(message);
}

async function createAccessTokenSecret(
  spec: OnecliSecretSpec,
  headerName: string,
  valueFormat: string,
): Promise<string> {
  const created = await runOnecli([
    'secrets',
    'create',
    '--name',
    spec.name,
    '--type',
    'generic',
    '--value',
    spec.value,
    '--host-pattern',
    spec.hostPattern,
    '--header-name',
    headerName,
    '--value-format',
    valueFormat,
  ]);
  const id = extractId(created);
  if (!id) {
    throw new Error(`onecli secrets create did not return an id: ${JSON.stringify(created)}`);
  }
  return id;
}

/**
 * Create or update a OneCLI generic secret that injects the current access token.
 * Returns the OneCLI secret id (existing id on update, or a **new** id on create /
 * recreate-after-NOT_FOUND). Caller should persist the returned id.
 */
export async function upsertAccessTokenSecret(spec: OnecliSecretSpec): Promise<string> {
  const headerName = spec.headerName ?? 'Authorization';
  const valueFormat = spec.valueFormat ?? 'Bearer {value}';

  if (spec.existingSecretId) {
    try {
      await runOnecli([
        'secrets',
        'update',
        '--id',
        spec.existingSecretId,
        '--value',
        spec.value,
        '--host-pattern',
        spec.hostPattern,
        '--header-name',
        headerName,
        '--value-format',
        valueFormat,
      ]);
      return spec.existingSecretId;
    } catch (err) {
      if (!isOnecliNotFound(err)) throw err;
      // Vault was reset / secret deleted — create a fresh secret (new id).
      log.warn('OneCLI secret not found; creating a new one', {
        existingSecretId: spec.existingSecretId,
        name: spec.name,
        hostPattern: spec.hostPattern,
      });
    }
  }

  return createAccessTokenSecret(spec, headerName, valueFormat);
}

export async function findAgentIdByIdentifier(identifier: string): Promise<string | null> {
  // Prefer HTTP (max=500). CLI list page is small and misses many draft agents.
  try {
    return await findAgentIdByIdentifierV1(identifier);
  } catch (err) {
    log.warn('OneCLI HTTP agent lookup failed; falling back to CLI', { err });
  }
  const listed = await runOnecli(['agents', 'list', '--max', '500']);
  const agents = extractList(listed);
  for (const agent of agents) {
    if (agent.identifier === identifier || agent.id === identifier) {
      return typeof agent.id === 'string' ? agent.id : null;
    }
  }
  return null;
}

/**
 * Ensure a secret is usable by a Gateway agent via OneCLI grants.
 *
 * OneCLI 1.7+ removed secret-mode / set-secrets; use PUT
 * /v1/agents/:id/grants/secrets/:secretId. ensureAgentV1 also grants the full
 * vault (incl. Anthropic) so MCP assignment cannot strand Claude auth.
 *
 * Creates the OneCLI agent via ensureAgent when missing.
 */
export async function assignSecretToAgent(
  agentIdentifier: string,
  secretId: string,
  agentName?: string,
): Promise<void> {
  let agentId = await findAgentIdByIdentifier(agentIdentifier);
  if (!agentId) {
    if (!agentName?.trim()) {
      throw new Error(
        `OneCLI agent not found for identifier ${agentIdentifier}. Spawn once (ensureAgent) before assigning secrets.`,
      );
    }
    await ensureOnecliAgent({ name: agentName.trim(), identifier: agentIdentifier });
    agentId = await findAgentIdByIdentifier(agentIdentifier);
  }
  if (!agentId) {
    throw new Error(
      `OneCLI agent still missing after ensureAgent for identifier ${agentIdentifier}`,
    );
  }

  log.info('Granting OneCLI vault secret to gateway agent', {
    agentId,
    agentIdentifier,
    secretId,
  });
  await grantSecretToAgentV1(agentId, secretId);
}
