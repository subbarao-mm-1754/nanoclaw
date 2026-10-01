import fs from 'fs';
import path from 'path';

import {
  applyClaudeCodePrivacyEnv,
  isClaudeCodeNonessentialTrafficAllowed,
} from './claude-code-privacy.js';
import { readEnvFile } from './env.js';

function allowClaudeCodeNonessentialTraffic(): boolean {
  const dotenv = readEnvFile(['CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC']);
  return isClaudeCodeNonessentialTrafficAllowed(
    process.env.CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC ||
      dotenv.CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC,
  );
}

function defaultSettingsEnv(): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  };
  applyClaudeCodePrivacyEnv(env, allowClaudeCodeNonessentialTraffic());
  return env;
}

const DEFAULT_SETTINGS_JSON =
  JSON.stringify(
    {
      env: defaultSettingsEnv(),
      hooks: {
        PreCompact: [
          {
            hooks: [
              {
                type: 'command',
                command: 'bun /app/src/compact-instructions.ts',
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + '\n';

/** Initialize `.claude-shared` state at an arbitrary path (worker temp workspace). */
export function ensureClaudeSharedFilesystem(claudeDir: string): void {
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, DEFAULT_SETTINGS_JSON);
  } else {
    ensurePreCompactHook(settingsFile, []);
    ensureClaudeCodePrivacySettings(settingsFile, []);
  }

  const skillsDst = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDst)) {
    fs.mkdirSync(skillsDst, { recursive: true });
  }
}

const PRE_COMPACT_COMMAND = 'bun /app/src/compact-instructions.ts';

/**
 * Patch an existing settings.json to add the PreCompact hook if missing.
 * Runs on every group init so pre-existing groups pick up the hook.
 */
function ensurePreCompactHook(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw);

    // Check if there's already a PreCompact hook with our command.
    const existing = settings.hooks?.PreCompact as unknown[] | undefined;
    if (existing && JSON.stringify(existing).includes(PRE_COMPACT_COMMAND)) return;

    // Add the hook, preserving existing hooks.
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks.PreCompact) settings.hooks.PreCompact = [];
    settings.hooks.PreCompact.push({
      hooks: [{ type: 'command', command: PRE_COMPACT_COMMAND }],
    });

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push('settings.json (added PreCompact hook)');
  } catch {
    // Don't break init if settings.json is malformed — it'll use whatever's there.
  }
}

/**
 * Keep Claude Code privacy env in sync with CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC.
 * Runs on every group init so existing workspaces pick up the default-off policy.
 */
function ensureClaudeCodePrivacySettings(settingsFile: string, initialized: string[]): void {
  try {
    const raw = fs.readFileSync(settingsFile, 'utf-8');
    const settings = JSON.parse(raw) as { env?: Record<string, string> };
    if (!settings.env || typeof settings.env !== 'object') settings.env = {};

    const allow = allowClaudeCodeNonessentialTraffic();
    const before = JSON.stringify(settings.env);
    applyClaudeCodePrivacyEnv(settings.env, allow);
    if (JSON.stringify(settings.env) === before) return;

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
    initialized.push(
      allow
        ? 'settings.json (cleared Claude Code privacy blocks)'
        : 'settings.json (disabled Claude Code nonessential traffic)',
    );
  } catch {
    // Don't break init if settings.json is malformed.
  }
}
