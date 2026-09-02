import { execFile } from 'child_process';
import { promisify } from 'util';

import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from '../../config.js';
import { log } from '../../log.js';

const execFileAsync = promisify(execFile);

let onecliClient: OneCLI | null = null;

function getOnecliClient(): OneCLI {
  if (!onecliClient) {
    onecliClient = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });
  }
  return onecliClient;
}

export async function ensureOnecliAgent(input: {
  name: string;
  identifier: string;
}): Promise<void> {
  await getOnecliClient().ensureAgent({
    name: input.name,
    identifier: input.identifier,
  });
  // ensureAgent creates agents in selective mode with an empty allow-list.
  // Gateway user agents need Anthropic + any vault secrets with matching host
  // patterns (incl. remote MCP). Flip to "all" immediately.
  const agentId = await findAgentIdByIdentifier(input.identifier);
  if (agentId) {
    await setAgentSecretModeAll(agentId);
  }
}

async function setAgentSecretModeAll(agentId: string): Promise<void> {
  await runOnecli(['agents', 'set-secret-mode', '--id', agentId, '--mode', 'all']);
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

/**
 * Create or update a OneCLI generic secret that injects the current access token.
 * Returns the OneCLI secret id.
 */
export async function upsertAccessTokenSecret(spec: OnecliSecretSpec): Promise<string> {
  const headerName = spec.headerName ?? 'Authorization';
  const valueFormat = spec.valueFormat ?? 'Bearer {value}';

  if (spec.existingSecretId) {
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
  }

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

export async function findAgentIdByIdentifier(identifier: string): Promise<string | null> {
  const listed = await runOnecli(['agents', 'list']);
  const agents = extractList(listed);
  for (const agent of agents) {
    if (agent.identifier === identifier || agent.id === identifier) {
      return typeof agent.id === 'string' ? agent.id : null;
    }
  }
  return null;
}

/**
 * Ensure a secret is usable by a Gateway agent.
 *
 * Prefer secret-mode `all` over `set-secrets`: OneCLI's `set-secrets` forces
 * selective mode and replaces the allow-list, which previously wiped Anthropic
 * access when we only assigned the Zoho MCP secret after OAuth.
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

  // Mode "all" picks up this secret (and Anthropic) by host pattern — no
  // selective allow-list to maintain. Avoid set-secrets: it flips the agent
  // back to selective and can drop unrelated vault secrets.
  log.info('Ensuring OneCLI agent secret mode all for gateway MCP access', {
    agentId,
    agentIdentifier,
    secretId,
  });
  await setAgentSecretModeAll(agentId);
}
