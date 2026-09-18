import { describe, it, expect } from 'vitest';

import {
  inferSpecialistReplyStatus,
  isTerminalSpecialistStatus,
  parseSpecialistReply,
} from './specialist-protocol.js';

describe('specialist reply protocol', () => {
  it('parses explicit orchestration field', () => {
    const parsed = parseSpecialistReply(
      {
        text: 'ignored body',
        orchestration: { status: 'completed', payload: { places: ['Amer Fort'] } },
      },
      '',
    );
    expect(parsed.status).toBe('completed');
    expect(parsed.explicit).toBe(true);
    expect(parsed.text).toContain('Amer Fort');
    expect(isTerminalSpecialistStatus(parsed.status)).toBe(true);
  });

  it('parses nanoclaw-result fence', () => {
    const text = `Here you go\n\`\`\`nanoclaw-result\n{"status":"blocked","summary":"API down"}\n\`\`\``;
    const parsed = parseSpecialistReply({ text }, text);
    expect(parsed.status).toBe('blocked');
    expect(parsed.explicit).toBe(true);
    expect(parsed.text).toContain('API down');
  });

  it('defaults notify_orchestrator: false for ack, true for progress', () => {
    expect(
      parseSpecialistReply({ orchestration: { status: 'ack' }, text: 'On it' }, 'On it')
        .notify_orchestrator,
    ).toBe(false);
    expect(
      parseSpecialistReply(
        { orchestration: { status: 'progress' }, text: 'Downloaded 2/6' },
        'Downloaded 2/6',
      ).notify_orchestrator,
    ).toBe(true);
  });

  it('infers ack from legacy "On it" text', () => {
    expect(inferSpecialistReplyStatus('On it — researching a single-day Jaipur loop')).toBe('ack');
    const parsed = parseSpecialistReply(
      {
        text: 'On it. Heads-up: the research result came back as "on it"',
      },
      '',
    );
    expect(parsed.status).toBe('ack');
    expect(parsed.explicit).toBe(false);
    expect(isTerminalSpecialistStatus(parsed.status)).toBe(false);
  });

  it('infers completed for substantial legacy payloads', () => {
    const json = `{\n  "daily_routes": [{ "day": 1 }]\n}`;
    expect(inferSpecialistReplyStatus(json)).toBe('completed');
    expect(isTerminalSpecialistStatus('completed')).toBe(true);
  });
});
