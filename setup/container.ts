/**
 * Step: container — Build container image and verify with test run.
 * Linux/WSL: Podman via docker CLI shim (setup/install-docker.sh).
 * macOS: Docker Desktop if already installed, otherwise Colima (never installs Desktop).
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';

import { log } from '../src/log.js';
import { getDefaultContainerImage } from '../src/install-slug.js';
import { commandExists, getPlatform } from './platform.js';
import { emitStatus } from './status.js';

type DockerStatus = 'ok' | 'no-permission' | 'no-daemon' | 'other';

function dockerStatus(): DockerStatus {
  const res = spawnSync('docker', ['info'], { encoding: 'utf-8' });
  if (res.status === 0) return 'ok';
  const err = `${res.stderr ?? ''}\n${res.stdout ?? ''}`;
  if (/permission denied/i.test(err)) return 'no-permission';
  if (/cannot connect|is the docker daemon running|no such file/i.test(err)) return 'no-daemon';
  return 'other';
}

function dockerRunning(): boolean {
  return dockerStatus() === 'ok';
}

/**
 * Try to start the container runtime if installed but idle. Poll up to 60s.
 * Bail immediately on group-permission errors for Docker Engine (caller may
 * re-exec under `sg docker`). On Linux+Podman, prefer the user socket.
 */
function preferPodmanOnLinux(): boolean {
  return getPlatform() === 'linux' && commandExists('podman');
}

function macosDockerDesktopInstalled(): boolean {
  return (
    fs.existsSync('/Applications/Docker.app') ||
    fs.existsSync(path.join(os.homedir(), 'Applications', 'Docker.app'))
  );
}

/** Colima is the macOS default when Docker Desktop is not installed. */
function preferColimaOnMac(): boolean {
  return getPlatform() === 'macos' && commandExists('colima') && !macosDockerDesktopInstalled();
}

function macosEngineLabel(): string {
  if (macosDockerDesktopInstalled()) return 'docker-desktop';
  if (commandExists('colima')) return 'colima';
  return 'docker';
}

/** Point DOCKER_HOST at the rootless Podman user socket when present. */
function usePodmanUserSocket(): void {
  if (process.env.DOCKER_HOST) return;
  try {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid == null) return;
    const sock = `/run/user/${uid}/podman/podman.sock`;
    if (fs.existsSync(sock)) {
      process.env.DOCKER_HOST = `unix://${sock}`;
      log.info('Using Podman user socket', { DOCKER_HOST: process.env.DOCKER_HOST });
    }
  } catch {
    // ignore
  }
}

function startMacosRuntime(): void {
  if (macosDockerDesktopInstalled()) {
    log.info('Starting Docker Desktop');
    execSync('open -a Docker', { stdio: 'ignore' });
    return;
  }
  if (commandExists('colima')) {
    const status = spawnSync('colima', ['status'], { encoding: 'utf-8' });
    const out = `${status.stdout ?? ''}\n${status.stderr ?? ''}`;
    if (status.status === 0 && /is running/i.test(out)) {
      log.info('Colima already running');
      return;
    }
    // Blocks until the VM is ready (first start can take several minutes).
    log.info('Starting Colima');
    execSync('colima start', {
      stdio: 'inherit',
      timeout: 300_000,
    });
    return;
  }
  // Last resort — user may have Desktop without the usual app path.
  log.info('Starting Docker Desktop (fallback)');
  execSync('open -a Docker', { stdio: 'ignore' });
}

async function tryStartDocker(): Promise<DockerStatus> {
  const platform = getPlatform();
  log.info('Container runtime not running — attempting to start', { platform });

  try {
    if (platform === 'macos') {
      startMacosRuntime();
      // Colima start already waits for readiness; still poll briefly for Desktop.
      if (preferColimaOnMac() && dockerStatus() === 'ok') {
        log.info('Container runtime is up');
        return 'ok';
      }
    } else if (platform === 'linux') {
      // Linux default is Podman (+ docker CLI shim). Start sockets first;
      // fall back to Docker Engine for older installs that still use it.
      if (preferPodmanOnLinux()) {
        try {
          execSync('systemctl --user enable --now podman.socket', {
            stdio: 'ignore',
          });
        } catch (err) {
          log.warn('systemctl --user start podman.socket failed', { err });
        }
        try {
          execSync('sudo -n systemctl enable --now podman.socket', {
            stdio: 'ignore',
          });
        } catch {
          // system socket optional on pure rootless setups / no passwordless sudo
        }
        usePodmanUserSocket();
      } else {
        // Inherit stdio so sudo can prompt for a password if needed.
        execSync('sudo systemctl start docker', { stdio: 'inherit' });
      }
    } else {
      return 'other';
    }
  } catch (err) {
    log.warn('Start command failed', { err });
    return 'other';
  }

  // Docker Desktop / Podman: poll up to 60s. Colima already blocked in start.
  const polls = preferColimaOnMac() ? 15 : 30;
  for (let i = 0; i < polls; i++) {
    await sleep(2000);
    const s = dockerStatus();
    if (s === 'ok') {
      log.info('Container runtime is up');
      return 'ok';
    }
    if (s === 'no-permission') {
      if (preferPodmanOnLinux()) {
        usePodmanUserSocket();
        if (dockerStatus() === 'ok') {
          log.info('Container runtime is up via Podman user socket');
          return 'ok';
        }
      }
      log.info('Container runtime is up but socket is not accessible (group membership)');
      return 'no-permission';
    }
  }
  log.warn('Container runtime did not become ready within timeout');
  return 'no-daemon';
}

function parseArgs(args: string[]): { runtime: string } {
  // `--runtime` is still accepted for backwards compatibility with the /setup
  // skill, but `docker` is the only supported value.
  let runtime = 'docker';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = getDefaultContainerImage(projectRoot);
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  if (runtime !== 'docker') {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!commandExists('docker')) {
    log.info(
      getPlatform() === 'linux'
        ? 'Container runtime not found — running setup/install-docker.sh (Podman on Linux)'
        : getPlatform() === 'macos'
          ? 'Container runtime not found — running setup/install-docker.sh (Docker Desktop if present, else Colima)'
          : 'Docker not found — running setup/install-docker.sh',
    );
    try {
      execSync('bash setup/install-docker.sh', { cwd: projectRoot, stdio: 'inherit' });
    } catch (err) {
      log.warn('install-docker.sh failed', { err });
    }
  }

  if (!commandExists('docker')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  if (preferPodmanOnLinux()) {
    usePodmanUserSocket();
  }

  {
    let status = dockerStatus();
    if (status !== 'ok') {
      status = await tryStartDocker();
    }

    // Docker Engine only: socket unreachable due to group perms — current
    // shell's supplementary groups are fixed at login. Re-exec under
    // `sg docker`. Skip for Podman (rootless user socket; no docker group).
    if (
      status === 'no-permission' &&
      getPlatform() === 'linux' &&
      !preferPodmanOnLinux() &&
      commandExists('sg')
    ) {
      const inGroup = spawnSync('id', ['-nG'], { encoding: 'utf-8' });
      if (!(inGroup.stdout ?? '').split(/\s+/).includes('docker')) {
        log.info('Adding current user to docker group');
        spawnSync('sudo', ['usermod', '-aG', 'docker', process.env.USER ?? ''], {
          stdio: 'inherit',
        });
      }

      log.info('Re-executing container step under `sg docker`');
      const res = spawnSync(
        'sg',
        ['docker', '-c', 'pnpm exec tsx setup/index.ts --step container'],
        { cwd: projectRoot, stdio: 'inherit' },
      );
      process.exit(res.status ?? 1);
    }

    if (status !== 'ok') {
      const error =
        status === 'no-permission' ? 'docker_group_not_active' : 'runtime_not_available';
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: error,
        ...(preferPodmanOnLinux()
          ? { ENGINE: 'podman' }
          : getPlatform() === 'macos'
            ? { ENGINE: macosEngineLabel() }
            : {}),
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  const buildCmd = 'docker build';
  const runCmd = 'docker';

  // Build-args from .env. Only INSTALL_CJK_FONTS is passed through today.
  // Keeps /setup and ./container/build.sh in sync — both read the same source.
  const buildArgs: string[] = [];
  try {
    const envPath = path.join(projectRoot, '.env');
    if (fs.existsSync(envPath)) {
      const match = fs.readFileSync(envPath, 'utf-8').match(/^INSTALL_CJK_FONTS=(.+)$/m);
      const val = match?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (val === 'true') buildArgs.push('--build-arg INSTALL_CJK_FONTS=true');
    }
  } catch {
    // .env is optional; absence is normal on a fresh checkout
  }

  // Build — stdio inherit so the parent setup runner can tail docker's
  // per-step output and render it in a rolling window. Previously we used
  // execSync which buffered everything; users couldn't tell whether a
  // 3–10 minute build was making progress or hung.
  let buildOk = false;
  log.info('Building container', { runtime, buildArgs });
  const buildRes = spawnSync(
    buildCmd.split(' ')[0],
    [
      ...buildCmd.split(' ').slice(1),
      ...buildArgs.flatMap((a) => a.split(' ')),
      '-t',
      image,
      '.',
    ],
    {
      cwd: path.join(projectRoot, 'container'),
      stdio: 'inherit',
    },
  );
  if (buildRes.status === 0) {
    buildOk = true;
    log.info('Container build succeeded');
  } else {
    log.error('Container build failed', { exitCode: buildRes.status });
  }

  // Test
  let testOk = false;
  if (buildOk) {
    log.info('Testing container');
    try {
      const output = execSync(
        `echo '{}' | ${runCmd} run -i --rm --entrypoint /bin/echo ${image} "Container OK"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      testOk = output.includes('Container OK');
      log.info('Container test result', { testOk });
    } catch {
      log.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    ...(preferPodmanOnLinux()
      ? { ENGINE: 'podman' }
      : getPlatform() === 'macos'
        ? { ENGINE: macosEngineLabel() }
        : {}),
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
