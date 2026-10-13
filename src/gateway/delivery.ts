import fs from 'fs';
import path from 'path';

import { getChannelAdapter } from '../channels/channel-registry.js';
import type { OutboundFile } from '../channels/adapter.js';
import { AUTO_AGENT_ROUTE } from '../config.js';
import { log } from '../log.js';
import { platformMessageIdFromSession } from '../session-message-id.js';
import { labelOutboundText } from './agent-route/auto-route.js';
import { getConversation } from './store/conversations.js';
import { getWorkspace } from './store/workspaces.js';
import type { CustomerMessage } from './types.js';

/** Reaction/edit payloads carry session-namespaced inbound ids — strip for channel APIs. */
function contentForChannelDelivery(
  content: unknown,
  agentGroupId?: string,
  agentName?: string | null,
  channelType?: string,
): unknown {
  if (!content || typeof content !== 'object') return content;
  const record = content as Record<string, unknown>;
  const op = record.operation;
  if (
    (op === 'reaction' || op === 'edit') &&
    typeof record.messageId === 'string' &&
    record.messageId.length > 0
  ) {
    return {
      ...record,
      messageId: platformMessageIdFromSession(record.messageId, agentGroupId),
    };
  }
  if (agentName) {
    const next: Record<string, unknown> = { ...record, agent_name: agentName };
    // External channels get a visible prefix; HTTP chat UI uses agent_name metadata.
    if (
      AUTO_AGENT_ROUTE &&
      channelType !== 'http' &&
      typeof record.text === 'string' &&
      record.text.trim()
    ) {
      next.text = labelOutboundText(record.text, agentName);
    }
    return next;
  }
  return content;
}

export async function deliverOutboundMessage(
  message: CustomerMessage,
  opts?: { agentName?: string | null; agentWorkspaceId?: string | null },
): Promise<void> {
  const adapter = getChannelAdapter(message.channel_type);
  if (!adapter) {
    throw new Error(`No channel adapter for type: ${message.channel_type}`);
  }

  const rawContent = JSON.parse(message.content_json) as unknown;
  const conversation = message.conversation_id
    ? getConversation(message.conversation_id)
    : null;
  const agentGroupId = conversation?.agent_group_id ?? undefined;
  const workspace =
    (opts?.agentWorkspaceId ? getWorkspace(opts.agentWorkspaceId) : null) ??
    (conversation ? getWorkspace(conversation.workspace_id) : null);
  const agentName = opts?.agentName ?? workspace?.name ?? null;
  const content = contentForChannelDelivery(
    rawContent,
    agentGroupId,
    agentName,
    message.channel_type,
  );
  let files: OutboundFile[] | undefined;
  if (message.files_json) {
    const raw = JSON.parse(message.files_json) as Array<{ filename: string; data_base64: string }>;
    files = raw.map((f) => ({
      filename: f.filename,
      data: Buffer.from(f.data_base64, 'base64'),
    }));
  }

  await adapter.deliver(message.platform_id, message.thread_id, {
    kind: message.kind,
    content,
    files,
  });

  log.info('Gateway delivered outbound message', {
    messageId: message.id,
    channelType: message.channel_type,
    platformId: message.platform_id,
  });
}

export function applyMemoryPatch(
  groupDir: string,
  patch: { files?: Array<{ path: string; content: string; deleted?: boolean }> },
): void {
  if (!patch.files?.length) return;

  for (const file of patch.files) {
    if (file.path.includes('..') || path.isAbsolute(file.path)) {
      log.warn('Skipping invalid memory patch path', { path: file.path });
      continue;
    }
    const filePath = path.join(groupDir, file.path.replace(/\\/g, '/'));
    if (file.deleted) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      continue;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, file.content, 'utf8');
  }
}
