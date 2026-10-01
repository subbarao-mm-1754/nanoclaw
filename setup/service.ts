/**
 * Step: service — Install gateway + worker as separate OS services.
 *
 * Replaces the classic single-process host (dist/index.js) with:
 *   - nanoclaw-*-gateway  → dist/gateway/index.js
 *   - nanoclaw-*-worker   → dist/worker/index.js
 *
 * Role via NANOCLAW_ROLE / --role: both (default) | gateway | worker.
 * Split-machine: install gateway on one host, worker on another.
 */
import os from 'os';
import path from 'path';
import fs from 'fs';

import { log } from '../src/log.js';
import { installServices } from './services/install.js';

/** Symlink bin/zclaw into ~/.local/bin. */
function installCliSymlinks(projectRoot: string, homeDir: string): void {
  const targetDir = path.join(homeDir, '.local', 'bin');
  fs.mkdirSync(targetDir, { recursive: true });

  const source = path.join(projectRoot, 'bin', 'zclaw');
  const target = path.join(targetDir, 'zclaw');
  if (!fs.existsSync(source)) return;
  try {
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(target);
      } else {
        log.warn('~/.local/bin/zclaw exists and is not a symlink — skipping', {
          target,
        });
        return;
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }
    fs.symlinkSync(source, target);
    log.info('Installed zclaw CLI symlink', { target, source });
  } catch (err) {
    log.warn('Could not install zclaw CLI symlink (non-fatal)', { err });
  }
}

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const result = installServices(process.env.NANOCLAW_ROLE);
  installCliSymlinks(projectRoot, os.homedir());
  log.info('Service step complete', {
    role: result.role,
    kinds: result.kinds,
    serviceType: result.serviceType,
  });
}
