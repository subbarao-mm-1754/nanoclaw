/**
 * NanoClaw Gateway — channel connections + customer message queue.
 *
 * Receives messages from channel adapters, stores them in gateway.db,
 * forwards to the worker for agent processing, delivers responses,
 * then deletes completed messages from the gateway database.
 */
import '../channels/index.js';
import { registerZohoCliqMultiAdapter } from './channels/zoho-cliq-multi.js';
registerZohoCliqMultiAdapter();
import './http-channel.js';

import {
  GATEWAY_DEFAULT_AGENT_GROUP_ID,
  GATEWAY_DEFAULT_WORKSPACE_ID,
  GATEWAY_DEFAULT_WORKSPACE_NAME,
  GATEWAY_PROCESS_INTERVAL_MS,
} from '../config.js';
import { log } from '../log.js';
import { closeKnowledgePool, initKnowledgeSchema } from '../knowledge/store.js';
import { startGatewayChannels, stopGatewayChannels } from './channel-manager.js';
import { initGatewayDb, closeGatewayDb } from './db/connection.js';
import { startMessageProcessor, stopMessageProcessor } from './processor.js';
import { startGatewayServer, stopGatewayServer } from './server.js';
import { getWorkspace, registerWorkspace } from './store/workspaces.js';

function seedDefaultWorkspace(): void {
  if (!GATEWAY_DEFAULT_WORKSPACE_ID) return;

  const existing = getWorkspace(GATEWAY_DEFAULT_WORKSPACE_ID);
  if (existing?.is_default) return;

  if (!GATEWAY_DEFAULT_AGENT_GROUP_ID) {
    log.warn('GATEWAY_DEFAULT_WORKSPACE_ID set but GATEWAY_DEFAULT_AGENT_GROUP_ID missing — skip auto-register');
    return;
  }

  registerWorkspace({
    workspace_id: GATEWAY_DEFAULT_WORKSPACE_ID,
    agent_group_id: GATEWAY_DEFAULT_AGENT_GROUP_ID,
    name: GATEWAY_DEFAULT_WORKSPACE_NAME,
    is_default: true,
  });
  log.info('Gateway default workspace registered', { workspaceId: GATEWAY_DEFAULT_WORKSPACE_ID });
}

async function main(): Promise<void> {
  log.info('NanoClaw gateway starting');

  initGatewayDb();
  await initKnowledgeSchema();
  seedDefaultWorkspace();

  await startGatewayServer();
  await startGatewayChannels();
  startMessageProcessor(GATEWAY_PROCESS_INTERVAL_MS);

  log.info('NanoClaw gateway ready');
}

async function shutdown(signal: string): Promise<void> {
  log.info('Gateway shutdown signal received', { signal });
  stopMessageProcessor();
  await stopGatewayChannels();
  await stopGatewayServer();
  await closeKnowledgePool();
  closeGatewayDb();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((err) => {
  log.fatal('Gateway startup failed', { err });
  process.exit(1);
});
