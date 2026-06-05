import type { WorkerJobRequest } from './types.js';

export class WorkerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerValidationError';
  }
}

function requireString(obj: Record<string, unknown>, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WorkerValidationError(`${path}.${key} must be a non-empty string`);
  }
  return value;
}

function requireObject(obj: unknown, path: string): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new WorkerValidationError(`${path} must be an object`);
  }
  return obj as Record<string, unknown>;
}

/** Validate and normalize a worker job payload from the gateway. */
export function parseWorkerJobRequest(body: unknown): WorkerJobRequest {
  const root = requireObject(body, 'body');

  const jobId = requireString(root, 'job_id', 'body');
  const session = requireObject(root.session, 'body.session');
  const delivery = requireObject(root.delivery, 'body.delivery');
  const inbound = requireObject(root.inbound, 'body.inbound');
  const agentSnapshot = requireObject(root.agent_snapshot, 'body.agent_snapshot');

  const sessionId = requireString(session, 'id', 'body.session');
  const agentGroupId = requireString(session, 'agent_group_id', 'body.session');

  const channelType = requireString(delivery, 'channel_type', 'body.delivery');
  const platformId = requireString(delivery, 'platform_id', 'body.delivery');
  const threadId =
    delivery.thread_id === null || delivery.thread_id === undefined
      ? null
      : typeof delivery.thread_id === 'string'
        ? delivery.thread_id
        : (() => {
            throw new WorkerValidationError('body.delivery.thread_id must be a string or null');
          })();

  const inboundId = requireString(inbound, 'id', 'body.inbound');
  const inboundKind = requireString(inbound, 'kind', 'body.inbound');
  const inboundTimestamp = requireString(inbound, 'timestamp', 'body.inbound');
  const inboundContent = requireObject(inbound.content, 'body.inbound.content');

  const agentName = requireString(agentSnapshot, 'name', 'body.agent_snapshot');
  const containerConfig = requireObject(agentSnapshot.container_config, 'body.agent_snapshot.container_config');

  let sender: WorkerJobRequest['inbound']['sender'];
  if (inbound.sender !== undefined) {
    const senderObj = requireObject(inbound.sender, 'body.inbound.sender');
    sender = {
      id: requireString(senderObj, 'id', 'body.inbound.sender'),
      display_name:
        typeof senderObj.display_name === 'string' ? senderObj.display_name : undefined,
    };
  }

  let files: WorkerJobRequest['agent_snapshot']['files'];
  if (agentSnapshot.files !== undefined) {
    if (!Array.isArray(agentSnapshot.files)) {
      throw new WorkerValidationError('body.agent_snapshot.files must be an array');
    }
    files = agentSnapshot.files.map((entry, i) => {
      const file = requireObject(entry, `body.agent_snapshot.files[${i}]`);
      return {
        path: requireString(file, 'path', `body.agent_snapshot.files[${i}]`),
        content: typeof file.content === 'string' ? file.content : '',
      };
    });
  }

  let options: WorkerJobRequest['options'];
  if (root.options !== undefined) {
    const opts = requireObject(root.options, 'body.options');
    options = {};
    if (opts.timeout_ms !== undefined) {
      if (typeof opts.timeout_ms !== 'number' || opts.timeout_ms <= 0) {
        throw new WorkerValidationError('body.options.timeout_ms must be a positive number');
      }
      options.timeout_ms = opts.timeout_ms;
    }
    if (opts.trigger !== undefined) {
      if (opts.trigger !== 0 && opts.trigger !== 1) {
        throw new WorkerValidationError('body.options.trigger must be 0 or 1');
      }
      options.trigger = opts.trigger;
    }
  }

  return {
    job_id: jobId,
    session: { id: sessionId, agent_group_id: agentGroupId },
    delivery: { channel_type: channelType, platform_id: platformId, thread_id: threadId },
    inbound: {
      id: inboundId,
      kind: inboundKind,
      timestamp: inboundTimestamp,
      content: inboundContent,
      sender,
    },
    agent_snapshot: {
      name: agentName,
      folder: typeof agentSnapshot.folder === 'string' ? agentSnapshot.folder : undefined,
      container_config: containerConfig as WorkerJobRequest['agent_snapshot']['container_config'],
      instructions: typeof agentSnapshot.instructions === 'string' ? agentSnapshot.instructions : undefined,
      cli_scope: typeof agentSnapshot.cli_scope === 'string' ? agentSnapshot.cli_scope : undefined,
      files,
    },
    options,
  };
}
