import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';

function assertSafeContainerName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
}

/**
 * agent-browser's stream server binds 127.0.0.1 inside the container, so Docker
 * `-p` cannot reach it. Relay TCP through `docker/podman exec` + node.
 */
export function spawnContainerLocalhostRelay(
  containerName: string,
  port: number,
): ChildProcessWithoutNullStreams {
  assertSafeContainerName(containerName);
  const safePort = Number(port);
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  // Bidirectional byte pipe. Avoid stdin.pipe()/stdout.pipe() — under
  // docker/podman exec, pipe backpressure from large screencast frames can
  // stall the opposite direction and drop live mouse/keyboard messages.
  const script = `
const net=require('net');
const s=net.connect({host:'127.0.0.1',port:${safePort}});
s.setNoDelay(true);
s.on('error',(e)=>{try{process.stderr.write(String(e&&e.message?e.message:e));}catch(_){} process.exit(1);});
s.on('connect',()=>{ try{process.stdin.resume();}catch(_){} });
function pump(src, dst){
  src.on('data',(chunk)=>{
    if(!dst.write(chunk)){
      src.pause();
      dst.once('drain',()=>src.resume());
    }
  });
  src.on('end',()=>{ try{dst.end();}catch(_){} });
  src.on('error',()=>{ try{dst.destroy();}catch(_){} });
}
pump(process.stdin, s);
pump(s, process.stdout);
`;

  // Clear proxy env inside the exec: container agents often set HTTP(S)_PROXY
  // for OneCLI, and Node's EnvHttpProxyAgent can interfere with loopback I/O.
  return spawn(
    CONTAINER_RUNTIME_BIN,
    [
      'exec',
      '-i',
      '-e',
      'HTTP_PROXY=',
      '-e',
      'HTTPS_PROXY=',
      '-e',
      'http_proxy=',
      '-e',
      'https_proxy=',
      '-e',
      'ALL_PROXY=',
      '-e',
      'all_proxy=',
      '-e',
      'NODE_USE_ENV_PROXY=0',
      containerName,
      'node',
      '-e',
      script,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

/** True when something accepts TCP on 127.0.0.1:port inside the container. */
export function probeContainerLocalhostPort(
  containerName: string,
  port: number,
  timeoutMs = 1500,
): Promise<boolean> {
  assertSafeContainerName(containerName);
  const safePort = Number(port);
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    return Promise.resolve(false);
  }

  const script = `require('net').connect({host:'127.0.0.1',port:${safePort}},()=>process.exit(0)).on('error',()=>process.exit(1))`;

  return new Promise((resolve) => {
    const child = spawn(
      CONTAINER_RUNTIME_BIN,
      ['exec', containerName, 'node', '-e', script],
      { stdio: 'ignore' },
    );
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
