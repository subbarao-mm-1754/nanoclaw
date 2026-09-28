/**
 * `nanoclaw` lifecycle CLI — install / start / stop / restart / status / logs.
 *
 * Usage:
 *   nanoclaw service install [--role both|gateway|worker]
 *   nanoclaw start|stop|restart|status [--role ...]
 *   nanoclaw logs [--gateway|--worker|--all] [-f]
 */
import { installServices } from './install.js';
import { runCtl, showLogs, type CtlAction } from './ctl.js';
import { resolveRole } from './roles.js';
import type { ServiceKind } from './names.js';

function printHelp(): void {
  console.log(`nanoclaw — gateway + worker lifecycle

Usage:
  nanoclaw service install [--role both|gateway|worker]
  nanoclaw start|stop|restart|status [--role both|gateway|worker]
  nanoclaw logs [--gateway|--worker] [-f]
  nanoclaw help

Roles (also via NANOCLAW_ROLE):
  both     gateway + worker on this machine (default)
  gateway  channels/API only — set GATEWAY_WORKER_URL to the remote worker
  worker   containers only — set GATEWAY_PUBLIC_URL so the worker can callback

Remote split (different machines):
  Machine A: NANOCLAW_ROLE=gateway GATEWAY_WORKER_URL=http://worker-host:8080
  Machine B: NANOCLAW_ROLE=worker  GATEWAY_PUBLIC_URL=http://gateway-host:8090
             WORKER_HOST=0.0.0.0 WORKER_AUTH_TOKEN=... GATEWAY_AUTH_TOKEN=...
`);
}

function parseRole(argv: string[]): string | undefined {
  const i = argv.indexOf('--role');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--role='));
  if (eq) return eq.slice('--role='.length);
  return undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp();
    process.exit(0);
  }

  if (cmd === 'service') {
    const sub = argv[1];
    if (sub === 'install') {
      const role = parseRole(argv.slice(2));
      // Validate early for clear errors
      resolveRole(role);
      const result = installServices(role);
      console.log(
        `Installed ${result.serviceType} services: ${result.kinds.join(', ')}`,
      );
      for (const l of result.labels) console.log(`  - ${l}`);
      process.exit(0);
    }
    console.error('Unknown service subcommand. Try: nanoclaw service install');
    process.exit(1);
  }

  if (cmd === 'start' || cmd === 'stop' || cmd === 'restart' || cmd === 'status') {
    const role = parseRole(argv.slice(1));
    resolveRole(role);
    process.exit(runCtl(cmd as CtlAction, role));
  }

  if (cmd === 'logs') {
    const follow = argv.includes('-f') || argv.includes('--follow');
    let kind: ServiceKind | 'all' = 'all';
    if (argv.includes('--gateway')) kind = 'gateway';
    if (argv.includes('--worker')) kind = 'worker';
    process.exit(showLogs(kind, follow));
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main();
