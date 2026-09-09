/**
 * NanoClaw Worker — gateway-facing compute plane.
 *
 * Phases A–E: HTTP API, workspace materialization, container spawn,
 * outbound collection, memory patch for gateway persistence.
 */
import { ensureContainerRuntimeRunning, cleanupOrphans } from '../container-runtime.js';
import { log } from '../log.js';
import {
  startOutboundCollectorRuntime,
  stopOutboundCollectorRuntime,
} from './outbound-collector.js';
import { startWorkerServer, stopWorkerServer } from './server.js';

async function main(): Promise<void> {
  log.info('NanoClaw worker starting');

  ensureContainerRuntimeRunning();
  cleanupOrphans();

  startOutboundCollectorRuntime();
  await startWorkerServer();
  log.info('NanoClaw worker ready');
}

async function shutdown(signal: string): Promise<void> {
  log.info('Worker shutdown signal received', { signal });
  stopOutboundCollectorRuntime();
  await stopWorkerServer();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Worker startup failed', { err });
  process.exit(1);
});
