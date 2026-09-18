/**
 * Claude Code phones home to api.anthropic.com for bootstrap, event logging,
 * and metrics even when ANTHROPIC_BASE_URL points elsewhere. Those calls are
 * off by default; set CLAUDE_CODE_ALLOW_NONESSENTIAL_TRAFFIC=true to opt in.
 *
 * Claude Code treats any non-empty value of DISABLE_* / CLAUDE_CODE_DISABLE_*
 * as enabled — do not use "0"/"false" to re-enable; leave the vars unset.
 */
export const CLAUDE_CODE_PRIVACY_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DO_NOT_TRACK: '1',
};

export function isClaudeCodeNonessentialTrafficAllowed(
  value: string | undefined | null,
): boolean {
  const v = (value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** Merge privacy defaults into a Docker/container env map (mutates + returns). */
export function applyClaudeCodePrivacyEnv(
  env: Record<string, string>,
  allowNonessentialTraffic: boolean,
): Record<string, string> {
  if (allowNonessentialTraffic) {
    for (const key of Object.keys(CLAUDE_CODE_PRIVACY_ENV)) {
      delete env[key];
    }
    return env;
  }
  Object.assign(env, CLAUDE_CODE_PRIVACY_ENV);
  return env;
}
