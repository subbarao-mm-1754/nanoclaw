import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initGatewayTestDb, closeGatewayDb } from '../db/connection.js';
import { createUser } from './users.js';
import { registerWorkspace } from './workspaces.js';
import {
  bindBrowserSessionToWorkspace,
  browserSessionFilePath,
  browserSessionFilesForWorkspace,
  captureBrowserSessionsFromMemoryPatch,
  createBrowserSession,
  createPendingBrowserSession,
  getBrowserSessionByConnectToken,
  listBrowserSessionsForUser,
  listBrowserSessionsForWorkspace,
  mergeFilesWithBrowserSessions,
  normalizeAuthJson,
  revokeBrowserSession,
  toPublicBrowserSession,
  unbindBrowserSessionFromWorkspace,
  updateBrowserSessionAuth,
} from './browser-sessions.js';

const SAMPLE_AUTH = {
  cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }],
  origins: [],
};

beforeEach(() => {
  initGatewayTestDb();
});

afterEach(() => {
  closeGatewayDb();
});

describe('normalizeAuthJson', () => {
  it('accepts object and string forms', () => {
    expect(JSON.parse(normalizeAuthJson(SAMPLE_AUTH))).toEqual(SAMPLE_AUTH);
    expect(JSON.parse(normalizeAuthJson(JSON.stringify(SAMPLE_AUTH)))).toEqual(SAMPLE_AUTH);
  });

  it('rejects invalid payloads', () => {
    expect(() => normalizeAuthJson('')).toThrow(/empty|valid JSON/i);
    expect(() => normalizeAuthJson('[]')).toThrow(/object/);
    expect(() => normalizeAuthJson('not-json')).toThrow(/valid JSON/);
  });
});

describe('browser sessions store', () => {
  it('creates, lists publicly without auth_json, and updates auth', () => {
    const user = createUser({
      email: 'owner@example.com',
      password: 'password123',
      display_name: 'Owner',
    });

    const session = createBrowserSession({
      user_id: user.id,
      label: 'Example app',
      origin: 'https://app.example.com',
      auth_json: SAMPLE_AUTH,
    });

    expect(session.id).toMatch(/^bs-/);
    expect(session.auth_json).toContain('sid');

    const pub = toPublicBrowserSession(session);
    expect(pub).not.toHaveProperty('auth_json');
    expect(pub.has_auth).toBe(true);

    const listed = listBrowserSessionsForUser(user.id);
    expect(listed).toHaveLength(1);

    const updated = updateBrowserSessionAuth(session.id, user.id, {
      cookies: [{ name: 'sid', value: 'new', domain: 'example.com', path: '/' }],
      origins: [],
    });
    expect(updated.auth_json).toContain('new');
  });

  it('binds to workspace and materializes files for prepare', () => {
    const user = createUser({
      email: 'owner@example.com',
      password: 'password123',
      display_name: 'Owner',
    });
    registerWorkspace({
      workspace_id: 'ws-1',
      agent_group_id: 'ag-1',
      name: 'Agent',
      owner_user_id: user.id,
    });

    const session = createBrowserSession({
      user_id: user.id,
      label: 'GitHub',
      origin: 'https://github.com',
      auth_json: SAMPLE_AUTH,
    });

    bindBrowserSessionToWorkspace('ws-1', session.id, user.id);
    expect(listBrowserSessionsForWorkspace('ws-1', user.id)).toHaveLength(1);

    const files = browserSessionFilesForWorkspace('ws-1');
    expect(files.map((f) => f.path).sort()).toEqual([
      browserSessionFilePath(session.id),
      'browser-sessions/index.json',
    ]);

    const index = JSON.parse(files.find((f) => f.path.endsWith('index.json'))!.content);
    expect(index.sessions[0].origin).toBe('https://github.com');
    expect(index.sessions[0].file).toBe(browserSessionFilePath(session.id));

    const merged = mergeFilesWithBrowserSessions('ws-1', [
      { path: 'CLAUDE.local.md', content: '# hi\n' },
    ]);
    expect(merged.some((f) => f.path === 'CLAUDE.local.md')).toBe(true);
    expect(merged.some((f) => f.path === browserSessionFilePath(session.id))).toBe(true);

    // Public browsing path: no bound sessions → no extra files
    unbindBrowserSessionFromWorkspace('ws-1', session.id, user.id);
    expect(mergeFilesWithBrowserSessions('ws-1', [{ path: 'CLAUDE.local.md', content: 'x' }])).toEqual([
      { path: 'CLAUDE.local.md', content: 'x' },
    ]);
  });

  it('captures memory_patch updates back into the gateway DB', () => {
    const user = createUser({
      email: 'owner@example.com',
      password: 'password123',
      display_name: 'Owner',
    });
    registerWorkspace({
      workspace_id: 'ws-1',
      agent_group_id: 'ag-1',
      name: 'Agent',
      owner_user_id: user.id,
    });
    const session = createBrowserSession({
      user_id: user.id,
      label: 'App',
      origin: 'https://app.example.com',
      auth_json: SAMPLE_AUTH,
    });
    bindBrowserSessionToWorkspace('ws-1', session.id, user.id);

    const next = {
      cookies: [{ name: 'sid', value: 'rotated', domain: 'app.example.com', path: '/' }],
      origins: [{ origin: 'https://app.example.com', localStorage: [] }],
    };
    const n = captureBrowserSessionsFromMemoryPatch('ws-1', {
      files: [{ path: browserSessionFilePath(session.id), content: JSON.stringify(next) }],
    });
    expect(n).toBe(1);
    expect(listBrowserSessionsForUser(user.id)[0]!.auth_json).toContain('rotated');
  });

  it('revokes and clears auth_json', () => {
    const user = createUser({
      email: 'owner@example.com',
      password: 'password123',
      display_name: 'Owner',
    });
    const session = createBrowserSession({
      user_id: user.id,
      label: 'Temp',
      auth_json: SAMPLE_AUTH,
    });
    revokeBrowserSession(session.id, user.id);
    expect(listBrowserSessionsForUser(user.id)).toHaveLength(0);
  });

  it('creates pending sessions with connect token columns', () => {
    const user = createUser({
      email: 'owner@example.com',
      password: 'password123',
      display_name: 'Owner',
    });
    const pending = createPendingBrowserSession({
      user_id: user.id,
      label: 'App',
      origin: 'https://app.example.com',
      login_url: 'https://app.example.com/login',
      connect_token: 'tok-test',
      connect_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(pending.status).toBe('pending');
    expect(getBrowserSessionByConnectToken('tok-test')?.id).toBe(pending.id);
  });
});
