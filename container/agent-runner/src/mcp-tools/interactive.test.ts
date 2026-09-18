import { describe, expect, test, beforeEach } from 'bun:test';
import {
  closeSessionDb,
  initTestSessionDb,
  getOutboundDb,
  getInboundDb,
} from '../db/connection.js';
import {
  findPlainTextQuestionAnswer,
  findQuestionResponse,
  markCompleted,
  markProcessing,
  resolveQuestionChoice,
} from '../db/messages-in.js';

beforeEach(() => {
  closeSessionDb();
  initTestSessionDb();
});

describe('ask_user_question plain-text answers', () => {
  test('resolveQuestionChoice matches number, label, and free text', () => {
    const opts = [
      { label: 'Jaipur', value: 'Jaipur' },
      { label: 'Udaipur', value: 'Udaipur' },
    ];
    expect(resolveQuestionChoice('1', opts)).toBe('Jaipur');
    expect(resolveQuestionChoice('jaipur', opts)).toBe('Jaipur');
    expect(resolveQuestionChoice('somewhere else', opts)).toBe('somewhere else');
  });

  test('findPlainTextQuestionAnswer accepts chat replies after ask time', () => {
    const inbound = getInboundDb();
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES (?, 1, 'chat', ?, 'pending', ?)`,
      )
      .run(
        'msg-1',
        '2026-09-18T12:00:00.000Z',
        JSON.stringify({ text: 'Jaipur' }),
      );

    const hit = findPlainTextQuestionAnswer('2026-09-18T11:59:00.000Z');
    expect(hit?.id).toBe('msg-1');

    markProcessing(['msg-1']);
    // Still visible while processing (follow-up poll may have claimed it).
    const still = findPlainTextQuestionAnswer('2026-09-18T11:59:00.000Z');
    expect(still?.id).toBe('msg-1');

    markCompleted(['msg-1']);
    expect(findPlainTextQuestionAnswer('2026-09-18T11:59:00.000Z')).toBeUndefined();
  });

  test('findQuestionResponse prefers tagged questionId replies', () => {
    const inbound = getInboundDb();
    inbound
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, content)
         VALUES (?, 1, 'chat', ?, 'pending', ?)`,
      )
      .run(
        'msg-q',
        '2026-09-18T12:00:00.000Z',
        JSON.stringify({ questionId: 'q-1', selectedOption: 'Jaipur' }),
      );
    expect(findQuestionResponse('q-1')?.id).toBe('msg-q');
    expect(findQuestionResponse('other')).toBeUndefined();
  });
});
