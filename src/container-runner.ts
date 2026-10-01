/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import {
  CONTAINER_IMAGE,
  CONTAINER_INSTALL_LABEL,
  GROUPS_DIR,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
  WORKER_SKIP_ONECLI,
} from './config.js';
import type { ContainerConfig } from './container-config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { ensureClaudeSharedFilesystem } from './group-init.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  type ProviderContainerContribution,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup (async
 * buildContainerArgs, OneCLI gateway apply, etc.) — otherwise a second
 * wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing
 * racy double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

/** Worker-provided paths and config — bypasses central DB and groups/ lookups. */
export interface WorkerSpawnContext {
  agentGroup: AgentGroup;
  groupDir: string;
  claudeSharedDir: string;
  containerConfig: ContainerConfig;
  /** Gateway workspace id — used by live-browser module for stream routing. */
  workspaceId?: string;
}

export interface BuildMountOptions {
  groupDir: string;
  claudeSharedDir: string;
}

const containerStopWaiters = new Map<string, Array<() => void>>();

function notifyContainerStopped(sessionId: string): void {
  const waiters = containerStopWaiters.get(sessionId);
  if (waiters) {
    for (const resolve of waiters) resolve();
    containerStopWaiters.delete(sessionId);
  }
}

export function onContainerExit(sessionId: string, listener: () => void): () => void {
  if (!activeContainers.has(sessionId)) {
    queueMicrotask(listener);
    return () => {};
  }
  let waiters = containerStopWaiters.get(sessionId);
  if (!waiters) {
    waiters = [];
    containerStopWaiters.set(sessionId, waiters);
  }
  waiters.push(listener);
  return () => removeWaiter(sessionId, listener);
}

/** Wait until the container for a session exits, or until timeoutMs elapses. */
export function waitForContainerStop(sessionId: string, timeoutMs: number): Promise<boolean> {
  if (!activeContainers.has(sessionId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      removeWaiter(sessionId, onStop);
      resolve(false);
    }, timeoutMs);
    const onStop = () => {
      clearTimeout(timer);
      resolve(true);
    };
    let waiters = containerStopWaiters.get(sessionId);
    if (!waiters) {
      waiters = [];
      containerStopWaiters.set(sessionId, waiters);
    }
    waiters.push(onStop);
  });
}

function removeWaiter(sessionId: string, fn: () => void): void {
  const waiters = containerStopWaiters.get(sessionId);
  if (!waiters) return;
  const idx = waiters.indexOf(fn);
  if (idx >= 0) waiters.splice(idx, 1);
  if (waiters.length === 0) containerStopWaiters.delete(sessionId);
}

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * Requires a worker spawn context (materialized workspace + container config).
 * The container runs the agent-runner which polls the session DB.
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). The worker
 * leaves the inbound row pending and can retry on the next job.
 */
export function wakeContainer(session: Session, spawnContext: WorkerSpawnContext): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session, spawnContext)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — worker can retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session, spawnContext: WorkerSpawnContext): Promise<void> {
  const { agentGroup, containerConfig } = spawnContext;

  const { provider, contribution } = resolveProviderContribution(session, agentGroup, containerConfig);

  const mountOptions: BuildMountOptions = {
    groupDir: spawnContext.groupDir,
    claudeSharedDir: spawnContext.claudeSharedDir,
  };

  const mounts = buildMounts(agentGroup, session, containerConfig, contribution, mountOptions);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  const agentIdentifier = agentGroup.id;
  const { args, liveBrowser } = await buildContainerArgs(
    mounts,
    containerName,
    agentGroup,
    containerConfig,
    provider,
    contribution,
    agentIdentifier,
    true,
  );

  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  log.info('Spawning container', {
    sessionId: session.id,
    agentGroup: agentGroup.name,
    containerName,
    image: imageTag,
  });

  // Clear any orphan heartbeat from a previous container instance so a stale
  // mtime cannot look like an active agent to health checks.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  if (liveBrowser) {
    const { registerLiveBrowserEndpoint, unregisterLiveBrowserEndpoint } =
      await import('./modules/live-browser/container-hooks.js');
    registerLiveBrowserEndpoint({
      sessionId: session.id,
      workspaceId: spawnContext.workspaceId ?? null,
      agentGroupId: agentGroup.id,
      containerName,
      containerPort: liveBrowser.containerPort,
    });
    container.once('close', () => {
      void unregisterLiveBrowserEndpoint(session.id);
    });
  }

  let stderrBuf = '';

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr (buffered so non-zero exits can surface the runtime error).
  // TIMING lines from the agent-runner are promoted to info so workers can
  // see LLM round-trips / tool latency without setting LOG_LEVEL=debug.
  container.stderr?.on('data', (data) => {
    stderrBuf += data.toString();
    for (const line of data.toString().trim().split('\n')) {
      if (!line) continue;
      if (line.includes('TIMING ') || line.includes('[claude-provider] TIMING')) {
        log.info(line, { container: agentGroup.folder, sessionId: session.id });
      } else {
        log.debug(line, { container: agentGroup.folder });
      }
    }
  });

  // stdout is unused (all IO is via session DB)
  container.stdout?.on('data', () => {});

  container.on('close', (code) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    notifyContainerStopped(session.id);
    if (code !== 0 && code !== null) {
      const detail = stderrBuf.trim().slice(0, 2000);
      log.warn('Container exited with error', {
        sessionId: session.id,
        code,
        containerName,
        image: imageTag,
        stderr: detail || undefined,
      });
    } else {
      log.info('Container exited', { sessionId: session.id, code, containerName });
    }
  });

  container.on('error', (err) => {
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    notifyContainerStopped(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider
 *     → container_configs.provider
 *     → 'claude'
 *
 * Pure so the precedence can be unit-tested without a DB or filesystem.
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): { provider: string; contribution: ProviderContainerContribution } {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: ContainerConfig,
  providerContribution: ProviderContainerContribution,
  mountOptions: BuildMountOptions,
): VolumeMount[] {
  const projectRoot = process.cwd();
  const groupDir = mountOptions.groupDir;
  const claudeDir = mountOptions.claudeSharedDir;

  ensureClaudeSharedFilesystem(claudeDir);

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);

  // Session folder at /workspace (contains inbound.db, outbound.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent (RW for working files + CLAUDE.local.md)
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // container.json — nested RO mount on top of RW group dir so the agent
  // can read its config but cannot modify it.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({ hostPath: containerJsonPath, containerPath: '/workspace/agent/container.json', readonly: true });
  }

  // Composer-managed CLAUDE.md artifacts — nested RO mounts. These are
  // regenerated from the shared base + fragments on every spawn; any
  // agent-side writes would be clobbered, so enforce read-only. Only
  // CLAUDE.local.md (per-group memory) remains RW via the group-dir mount.
  // `.claude-shared.md` is a symlink whose target (`/app/CLAUDE.md`) is
  // already RO-mounted, so writes through it fail regardless — no need for
  // a nested mount there.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (fs.existsSync(composedClaudeMd)) {
    mounts.push({ hostPath: composedClaudeMd, containerPath: '/workspace/agent/CLAUDE.md', readonly: true });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (fs.existsSync(fragmentsDir)) {
    mounts.push({ hostPath: fragmentsDir, containerPath: '/workspace/agent/.claude-fragments', readonly: true });
  }

  // Global memory directory — always read-only.
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
  }

  // Shared CLAUDE.md — read-only, imported by the composed entry point via
  // the `.claude-shared.md` symlink inside the group dir.
  const sharedClaudeMd = path.join(process.cwd(), 'container', 'CLAUDE.md');
  if (fs.existsSync(sharedClaudeMd)) {
    mounts.push({ hostPath: sharedClaudeMd, containerPath: '/app/CLAUDE.md', readonly: true });
  }

  // Per-group .claude-shared at /home/node/.claude (Claude state, settings,
  // skill symlinks)
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({ hostPath: agentRunnerSrc, containerPath: '/app/src', readonly: true });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
    mounts.push({ hostPath: skillsSrc, containerPath: '/app/skills', readonly: true });
  }

  // Additional mounts from container config
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated);
  }

  // Provider-contributed mounts (e.g. opencode-xdg)
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts);
  }

  return mounts;
}

export { syncSkillSymlinks } from './skill-symlinks.js';

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
  agentIdentifier?: string,
  workerSpawn?: boolean,
): Promise<{ args: string[]; liveBrowser: import('./modules/live-browser/container-hooks.js').LiveBrowserSpawnMeta | null }> {
  const args: string[] = ['run', '--rm', '--name', containerName, '--label', CONTAINER_INSTALL_LABEL];

  // Environment — only vars read by code we don't own.
  // Everything NanoClaw-specific is in container.json (read by runner at startup).
  args.push('-e', `TZ=${TIMEZONE}`);

  // OneCLI gateway — injects HTTPS_PROXY + certs so container API calls
  // are routed through the agent vault for credential injection. Treated as
  // a transient hard failure: if we can't wire the gateway, we don't spawn.
  // The worker leaves the inbound message pending and can retry.
  if (agentIdentifier && !(workerSpawn && WORKER_SKIP_ONECLI)) {
    await onecli.ensureAgent({ name: agentGroup.name, identifier: agentIdentifier });
  }
  if (!(workerSpawn && WORKER_SKIP_ONECLI)) {
    const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
    if (!onecliApplied) {
      throw new Error('OneCLI gateway not applied — refusing to spawn container without credentials');
    }
    log.info('OneCLI gateway applied', { containerName });
  } else {
    log.warn('OneCLI skipped for worker spawn (WORKER_SKIP_ONECLI=true)');
  }

  // Provider-contributed env vars last so they win over OneCLI (e.g. NO_PROXY
  // for Ollama / custom ANTHROPIC_BASE_URL hosts).
  if (providerContribution.env) {
    for (const [key, value] of Object.entries(providerContribution.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  // Live browser stream publish (no-op when LIVE_BROWSER_ENABLED=false).
  let liveBrowser: import('./modules/live-browser/container-hooks.js').LiveBrowserSpawnMeta | null =
    null;
  {
    const { applyLiveBrowserContainerArgs } = await import('./modules/live-browser/container-hooks.js');
    liveBrowser = applyLiveBrowserContainerArgs(args);
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: run v2 entry point directly via Bun (no tsc, no stdin).
  args.push('--entrypoint', 'bash');

  // Use per-agent-group image if one has been built, otherwise base image
  const imageTag = containerConfig.imageTag || CONTAINER_IMAGE;
  args.push(imageTag);

  args.push('-c', 'exec bun run /app/src/index.ts');

  return { args, liveBrowser };
}
