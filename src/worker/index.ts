/**
 * NanoClaw Worker — gateway-facing compute plane.
 *
 * Phases A–C: HTTP API, workspace materialization, session DB write.
 * Phase D (container spawn + outbound collection) will extend job-runner.
 */
import { log } from '../log.js';
import { startWorkerServer, stopWorkerServer } from './server.js';

async function main(): Promise<void> {
  log.info('NanoClaw worker starting');
  await startWorkerServer();
  log.info('NanoClaw worker ready');
}

async function shutdown(signal: string): Promise<void> {
  log.info('Worker shutdown signal received', { signal });
  await stopWorkerServer();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Worker startup failed', { err });
  process.exit(1);
});
