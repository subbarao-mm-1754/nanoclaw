/**
 * Claude provider container config — registered when using a custom
 * Anthropic-compatible endpoint (e.g. Ollama). Setup may append
 * `import './claude.js'` to providers/index.ts; or add it manually.
 *
 * For real Anthropic custom gateways, OneCLI can rewrite Authorization
 * on matching hosts. For Ollama, NO_PROXY bypasses the OneCLI proxy so
 * inference goes direct; Ollama ignores the placeholder key.
 *
 * Anthropic telemetry / bootstrap / metrics traffic is disabled by default
 * (see claude-code-privacy.ts). Opt in with CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC=true.
 */
import {
  applyClaudeCodePrivacyEnv,
  isClaudeCodeNonessentialTrafficAllowed,
} from '../claude-code-privacy.js';
import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('claude', () => {
  const dotenv = readEnvFile([
    'ANTHROPIC_BASE_URL',
    'NO_PROXY',
    'no_proxy',
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC',
  ]);
  const env: Record<string, string> = {};

  const allowRaw =
    process.env.CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC ||
    dotenv.CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC;
  const allow = isClaudeCodeNonessentialTrafficAllowed(allowRaw);
  applyClaudeCodePrivacyEnv(env, allow);
  // Pass the opt-in through so the agent-runner does not re-apply privacy blocks.
  if (allow) {
    env.CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC = 'true';
  }
  if (!dotenv.ANTHROPIC_BASE_URL) return { env };

  env.ANTHROPIC_BASE_URL = dotenv.ANTHROPIC_BASE_URL;
  env.ANTHROPIC_AUTH_TOKEN = 'placeholder';
  env.ANTHROPIC_API_KEY = dotenv.ANTHROPIC_API_KEY || 'ollama';

  let baseHost = '';
  try {
    baseHost = new URL(dotenv.ANTHROPIC_BASE_URL).hostname;
  } catch {
    // ignore invalid URL — still pass through as configured
  }

  const noProxyParts = new Set<string>();
  for (const raw of [dotenv.NO_PROXY, dotenv.no_proxy, baseHost, 'localhost', '127.0.0.1']) {
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed) noProxyParts.add(trimmed);
    }
  }
  if (noProxyParts.size > 0) {
    const joined = [...noProxyParts].join(',');
    env.NO_PROXY = joined;
    env.no_proxy = joined;
  }

  return { env };
});
