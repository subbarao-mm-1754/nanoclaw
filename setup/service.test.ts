import { describe, it, expect } from 'vitest';

import { getLaunchdServiceLabel, getSystemdServiceUnit } from './services/names.js';
import { buildLaunchdPlist, buildSystemdUnit, buildSystemdTarget } from './services/templates.js';
import { resolveRole, rolesToInstall } from './services/roles.js';

describe('roles', () => {
  it('defaults to both', () => {
    expect(resolveRole(undefined)).toBe('both');
    expect(rolesToInstall('both')).toEqual(['gateway', 'worker']);
  });

  it('supports split roles', () => {
    expect(rolesToInstall('gateway')).toEqual(['gateway']);
    expect(rolesToInstall('worker')).toEqual(['worker']);
  });
});

describe('gateway launchd plist', () => {
  it('points at dist/gateway/index.js with slug-scoped label', () => {
    const projectRoot = '/home/user/nanoclaw';
    const plist = buildLaunchdPlist({
      kind: 'gateway',
      projectRoot,
      nodePath: '/usr/bin/node',
      homeDir: '/home/user',
    });
    expect(plist).toContain(getLaunchdServiceLabel('gateway', projectRoot));
    expect(plist).toContain(`${projectRoot}/dist/gateway/index.js`);
    expect(plist).not.toContain('dist/index.js');
    expect(plist).toContain('logs/gateway.log');
  });
});

describe('worker systemd unit', () => {
  it('points at dist/worker/index.js and can After= gateway', () => {
    const projectRoot = '/home/user/nanoclaw';
    const gatewayUnit = `${getSystemdServiceUnit('gateway', projectRoot)}.service`;
    const unit = buildSystemdUnit({
      kind: 'worker',
      projectRoot,
      nodePath: '/usr/bin/node',
      homeDir: '/home/user',
      wantedBy: 'default.target',
      afterUnits: [gatewayUnit],
    });
    expect(unit).toContain(`${projectRoot}/dist/worker/index.js`);
    expect(unit).toContain(`After=network.target ${gatewayUnit}`);
    expect(unit).toContain('logs/worker.log');
  });
});

describe('systemd target', () => {
  it('Wants both gateway and worker units', () => {
    const projectRoot = '/opt/nanoclaw';
    const target = buildSystemdTarget({
      projectRoot,
      kinds: ['gateway', 'worker'],
      wantedBy: 'default.target',
    });
    expect(target).toContain(`${getSystemdServiceUnit('gateway', projectRoot)}.service`);
    expect(target).toContain(`${getSystemdServiceUnit('worker', projectRoot)}.service`);
  });
});
