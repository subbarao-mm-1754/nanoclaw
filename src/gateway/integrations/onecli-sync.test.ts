import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFileMock, setUpdateFailCount } = vi.hoisted(() => {
  let updateFailCount = 0;
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

  function runMockedOnecli(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const joined = args.join(' ');
    if (joined.includes('secrets update') && updateFailCount > 0) {
      updateFailCount -= 1;
      return Promise.reject(
        new Error(
          'Command failed: onecli secrets update\n{\n  "error": "updating secret: Internal Server Error",\n  "code": "ERROR"\n}\n',
        ),
      );
    }
    if (joined.includes('secrets create')) {
      return Promise.resolve({ stdout: JSON.stringify({ id: 'secret-new-1' }), stderr: '' });
    }
    if (joined.includes('secrets update')) {
      return Promise.resolve({
        stdout: JSON.stringify({ id: args[args.indexOf('--id') + 1], status: 'updated' }),
        stderr: '',
      });
    }
    return Promise.resolve({ stdout: '{}', stderr: '' });
  }

  const execFileMock = Object.assign(
    vi.fn(
      (
        _cmd: string,
        args: string[],
        _opts: unknown,
        cb?: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        void runMockedOnecli(args).then(
          (r) => cb?.(null, r.stdout, r.stderr),
          (err) => cb?.(err as Error, '', ''),
        );
      },
    ),
    {
      [promisifyCustom]: (_cmd: string, args: string[]) => runMockedOnecli(args),
    },
  );
  return {
    execFileMock,
    setUpdateFailCount: (n: number) => {
      updateFailCount = n;
    },
  };
});

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

import { upsertAccessTokenSecret } from './onecli-sync.js';

beforeEach(() => {
  setUpdateFailCount(0);
  execFileMock.mockClear();
});

describe('upsertAccessTokenSecret', () => {
  it('returns existing id when update succeeds', async () => {
    const id = await upsertAccessTokenSecret({
      name: 'gateway-user-test-zoho',
      value: 'atk',
      hostPattern: 'mcp.example.com',
      existingSecretId: 'secret-old-1',
    });
    expect(id).toBe('secret-old-1');
  });

  it('retries once then recreates after persistent Internal Server Error', async () => {
    setUpdateFailCount(2);
    const id = await upsertAccessTokenSecret({
      name: 'gateway-user-test-zoho',
      value: 'atk',
      hostPattern: 'mcp.example.com',
      existingSecretId: 'secret-old-1',
    });
    expect(id).toBe('secret-new-1');
  });

  it('succeeds on retry without recreating', async () => {
    setUpdateFailCount(1);
    const id = await upsertAccessTokenSecret({
      name: 'gateway-user-test-zoho',
      value: 'atk',
      hostPattern: 'mcp.example.com',
      existingSecretId: 'secret-old-1',
    });
    expect(id).toBe('secret-old-1');
  });
});
