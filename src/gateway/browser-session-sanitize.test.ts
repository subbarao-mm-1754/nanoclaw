import { describe, it, expect } from 'vitest';

import { sanitizeStorageStateForOrigin } from './browser-session-sanitize.js';

describe('sanitizeStorageStateForOrigin', () => {
  it('keeps only cookies for the target host tree', () => {
    const raw = {
      cookies: [
        {
          name: 'session',
          value: 'abc',
          domain: '.example.com',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: 'other',
          value: 'nope',
          domain: 'evil.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        },
        {
          name: '_ga',
          value: 'track',
          domain: '.example.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: true,
          sameSite: 'Lax',
        },
      ],
      origins: [
        {
          origin: 'https://app.example.com',
          localStorage: [{ name: 'token', value: 'should-drop' }],
        },
      ],
    };

    const out = JSON.parse(sanitizeStorageStateForOrigin('https://app.example.com', raw));
    expect(out.cookies).toHaveLength(1);
    expect(out.cookies[0].name).toBe('session');
    expect(out.origins).toEqual([]);
  });

  it('rejects when no matching cookies remain', () => {
    expect(() =>
      sanitizeStorageStateForOrigin('https://app.example.com', {
        cookies: [{ name: 'x', value: 'y', domain: 'other.com', path: '/' }],
        origins: [],
      }),
    ).toThrow(/No cookies/);
  });
});
