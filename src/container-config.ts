/**
 * Container config types and materialization for the gateway+worker product.
 *
 * Source of truth is the gateway workspace snapshot carried in worker jobs.
 * `materializeContainerJsonToDir` writes `container.json` into the worker
 * workspace at prepare time.
 */
import fs from 'fs';
import path from 'path';

import { AGENT_MODEL } from './config.js';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  instructions?: string;
}

export interface McpRemoteServerConfig {
  type: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
  instructions?: string;
  /** Optional: linked Gateway OAuth connection / provider key. */
  oauthProvider?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

export interface AdditionalMountConfig {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

/** Shape of the materialized `container.json` file read by the container runner. */
export interface ContainerConfig {
  mcpServers: Record<string, McpServerConfig>;
  packages: { apt: string[]; npm: string[] };
  imageTag?: string;
  additionalMounts: AdditionalMountConfig[];
  skills: string[] | 'all';
  provider?: string;
  groupName?: string;
  assistantName?: string;
  agentGroupId?: string;
  maxMessagesPerPrompt?: number;
  model?: string;
  effort?: string;
}

/** Build a `ContainerConfig` from a worker/gateway snapshot + agent group identity. */
export function containerConfigFromSnapshot(
  snapshot: ContainerConfigSnapshot,
  group: { id: string; name: string },
): ContainerConfig {
  return {
    mcpServers: snapshot.mcpServers ?? {},
    packages: snapshot.packages ?? { apt: [], npm: [] },
    additionalMounts: snapshot.additionalMounts ?? [],
    skills: snapshot.skills ?? 'all',
    provider: snapshot.provider,
    // Global model — ignore per-agent snapshot.model.
    model: AGENT_MODEL,
    effort: snapshot.effort,
    imageTag: snapshot.imageTag,
    assistantName: snapshot.assistantName ?? group.name,
    maxMessagesPerPrompt: snapshot.maxMessagesPerPrompt,
    groupName: group.name,
    agentGroupId: group.id,
  };
}

/** JSON shape accepted in worker job payloads for container config. */
export interface ContainerConfigSnapshot {
  provider?: string;
  model?: string;
  effort?: string;
  imageTag?: string;
  assistantName?: string;
  maxMessagesPerPrompt?: number;
  skills?: string[] | 'all';
  mcpServers?: Record<string, McpServerConfig>;
  packages?: { apt: string[]; npm: string[] };
  additionalMounts?: AdditionalMountConfig[];
}

/** Write `container.json` to an arbitrary directory (worker temp workspace). */
export function materializeContainerJsonToDir(groupDir: string, config: ContainerConfig): ContainerConfig {
  const p = path.join(groupDir, 'container.json');
  if (!fs.existsSync(groupDir)) fs.mkdirSync(groupDir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
  return config;
}
