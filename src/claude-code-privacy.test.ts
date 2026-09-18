import { describe, expect, it } from 'vitest';

import {
  applyClaudeCodePrivacyEnv,
  CLAUDE_CODE_PRIVACY_ENV,
  isClaudeCodeNonessentialTrafficAllowed,
} from './claude-code-privacy.js';

describe('claude-code-privacy', () => {
  it('allows only explicit truthy opt-in values', () => {
    expect(isClaudeCodeNonessentialTrafficAllowed(undefined)).toBe(false);
    expect(isClaudeCodeNonessentialTrafficAllowed('')).toBe(false);
    expect(isClaudeCodeNonessentialTrafficAllowed('0')).toBe(false);
    expect(isClaudeCodeNonessentialTrafficAllowed('false')).toBe(false);
    expect(isClaudeCodeNonessentialTrafficAllowed('true')).toBe(true);
    expect(isClaudeCodeNonessentialTrafficAllowed('1')).toBe(true);
    expect(isClaudeCodeNonessentialTrafficAllowed('YES')).toBe(true);
  });

  it('applies privacy env by default and clears on opt-in', () => {
    const env: Record<string, string> = { FOO: 'bar' };
    applyClaudeCodePrivacyEnv(env, false);
    expect(env).toMatchObject(CLAUDE_CODE_PRIVACY_ENV);
    expect(env.FOO).toBe('bar');

    applyClaudeCodePrivacyEnv(env, true);
    for (const key of Object.keys(CLAUDE_CODE_PRIVACY_ENV)) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.FOO).toBe('bar');
  });
});
