import type { ServiceKind } from './names.js';
import { distEntry, getLaunchdServiceLabel, getSystemdServiceUnit, logBasename } from './names.js';

export function buildLaunchdPlist(opts: {
  kind: ServiceKind;
  projectRoot: string;
  nodePath: string;
  homeDir: string;
}): string {
  const { kind, projectRoot, nodePath, homeDir } = opts;
  const label = getLaunchdServiceLabel(kind, projectRoot);
  const entry = `${projectRoot}/${distEntry(kind)}`;
  const outLog = `${projectRoot}/logs/${logBasename(kind, 'out')}`;
  const errLog = `${projectRoot}/logs/${logBasename(kind, 'err')}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${entry}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
        <key>NANOCLAW_ROLE</key>
        <string>${kind}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${outLog}</string>
    <key>StandardErrorPath</key>
    <string>${errLog}</string>
</dict>
</plist>`;
}

export function buildSystemdUnit(opts: {
  kind: ServiceKind;
  projectRoot: string;
  nodePath: string;
  homeDir: string;
  wantedBy: string;
  /** When both on one host, worker waits for gateway's network listen — soft After= only. */
  afterUnits?: string[];
}): string {
  const { kind, projectRoot, nodePath, homeDir, wantedBy, afterUnits = [] } = opts;
  const entry = `${projectRoot}/${distEntry(kind)}`;
  const outLog = `${projectRoot}/logs/${logBasename(kind, 'out')}`;
  const errLog = `${projectRoot}/logs/${logBasename(kind, 'err')}`;
  const after = ['network.target', ...afterUnits].join(' ');
  const description =
    kind === 'gateway'
      ? 'NanoClaw Gateway (channels + message queue)'
      : 'NanoClaw Worker (agent containers)';

  return `[Unit]
Description=${description}
After=${after}

[Service]
Type=simple
ExecStart=${nodePath} ${entry}
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
Environment=NANOCLAW_ROLE=${kind}
StandardOutput=append:${outLog}
StandardError=append:${errLog}

[Install]
WantedBy=${wantedBy}
`;
}

export function buildSystemdTarget(opts: {
  projectRoot: string;
  kinds: ServiceKind[];
  wantedBy: string;
}): string {
  const { projectRoot, kinds, wantedBy } = opts;
  const wants = kinds.map((k) => `${getSystemdServiceUnit(k, projectRoot)}.service`).join(' ');
  return `[Unit]
Description=NanoClaw (gateway + worker)
Wants=${wants}
After=network.target

[Install]
WantedBy=${wantedBy}
`;
}
