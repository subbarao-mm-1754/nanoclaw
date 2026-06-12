import type {
  WorkerAgentFile,
  WorkerPrepareWorkspaceRequest,
  WorkerProcessMessageRequest,
} from './types.js';

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

function parseAgentFiles(files: unknown, pathPrefix: string): WorkerAgentFile[] {
  if (files === undefined) return [];
  if (!Array.isArray(files)) {
    throw new WorkerValidationError(`${pathPrefix} must be an array`);
  }
  return files.map((entry, i) => {
    const file = requireObject(entry, `${pathPrefix}[${i}]`);
    const pathValue = requireString(file, 'path', `${pathPrefix}[${i}]`);
    if (typeof file.content_base64 === 'string' && file.content_base64.length > 0) {
      return { path: pathValue, content: Buffer.from(file.content_base64, 'base64') };
    }
    return {
      path: pathValue,
      content: typeof file.content === 'string' ? file.content : '',
    };
  });
}

/** Merge inline JSON files with multipart attachments; attachments win on duplicate paths. */
export function mergeAgentFiles(inline: WorkerAgentFile[], attachments: WorkerAgentFile[]): WorkerAgentFile[] {
  const byPath = new Map<string, WorkerAgentFile>();
  for (const file of inline) byPath.set(file.path.replace(/\\/g, '/'), file);
  for (const file of attachments) byPath.set(file.path.replace(/\\/g, '/'), file);
  return [...byPath.values()];
}

function parseContainerConfig(obj: Record<string, unknown>, path: string) {
  return requireObject(obj, path) as WorkerPrepareWorkspaceRequest['agent']['container_config'];
}

function parseProcessOptions(root: Record<string, unknown>): WorkerProcessMessageRequest['options'] {
  if (root.options === undefined) return undefined;
  const opts = requireObject(root.options, 'body.options');
  const options: NonNullable<WorkerProcessMessageRequest['options']> = {};
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
  if (opts.run_container !== undefined) {
    if (typeof opts.run_container !== 'boolean') {
      throw new WorkerValidationError('body.options.run_container must be a boolean');
    }
    options.run_container = opts.run_container;
  }
  return options;
}

/** Validate and normalize a prepare-workspace payload from the gateway. */
export function parsePrepareWorkspaceRequest(
  body: unknown,
  attachmentFiles: WorkerAgentFile[] = [],
): WorkerPrepareWorkspaceRequest {
  const root = requireObject(body, 'body');
  const workspaceId = requireString(root, 'workspace_id', 'body');
  const agent = requireObject(root.agent, 'body.agent');

  const agentGroupId = requireString(agent, 'agent_group_id', 'body.agent');
  const name = requireString(agent, 'name', 'body.agent');
  const containerConfig = parseContainerConfig(agent, 'body.agent.container_config');
  const files = mergeAgentFiles(parseAgentFiles(agent.files, 'body.agent.files'), attachmentFiles);
  if (files.length === 0) {
    throw new WorkerValidationError(
      'at least one agent file is required (inline files, content_base64, or multipart attachments)',
    );
  }

  let options: WorkerPrepareWorkspaceRequest['options'];
  if (root.options !== undefined) {
    const opts = requireObject(root.options, 'body.options');
    options = {};
    if (opts.replace !== undefined) {
      if (typeof opts.replace !== 'boolean') {
        throw new WorkerValidationError('body.options.replace must be a boolean');
      }
      options.replace = opts.replace;
    }
  }

  return {
    workspace_id: workspaceId,
    agent: {
      agent_group_id: agentGroupId,
      name,
      folder: typeof agent.folder === 'string' ? agent.folder : undefined,
      container_config: containerConfig,
      cli_scope: typeof agent.cli_scope === 'string' ? agent.cli_scope : undefined,
      files,
    },
    options,
  };
}

/** Validate and normalize a process-message payload from the gateway. */
export function parseProcessMessageRequest(body: unknown): WorkerProcessMessageRequest {
  const root = requireObject(body, 'body');

  const jobId = requireString(root, 'job_id', 'body');
  const workspaceId = requireString(root, 'workspace_id', 'body');
  const session = requireObject(root.session, 'body.session');
  const delivery = requireObject(root.delivery, 'body.delivery');
  const inbound = requireObject(root.inbound, 'body.inbound');

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

  let deliveryName: string | undefined;
  if (delivery.name !== undefined) {
    deliveryName = requireString(delivery, 'name', 'body.delivery');
  }
  let deliveryDisplayName: string | undefined;
  if (delivery.display_name !== undefined) {
    deliveryDisplayName =
      typeof delivery.display_name === 'string' && delivery.display_name.trim() !== ''
        ? delivery.display_name
        : (() => {
            throw new WorkerValidationError('body.delivery.display_name must be a non-empty string');
          })();
  }

  const inboundId = requireString(inbound, 'id', 'body.inbound');
  const inboundKind = requireString(inbound, 'kind', 'body.inbound');
  const inboundTimestamp = requireString(inbound, 'timestamp', 'body.inbound');
  const inboundContent = requireObject(inbound.content, 'body.inbound.content');

  let sender: WorkerProcessMessageRequest['inbound']['sender'];
  if (inbound.sender !== undefined) {
    const senderObj = requireObject(inbound.sender, 'body.inbound.sender');
    sender = {
      id: requireString(senderObj, 'id', 'body.inbound.sender'),
      display_name:
        typeof senderObj.display_name === 'string' ? senderObj.display_name : undefined,
    };
  }

  return {
    job_id: jobId,
    workspace_id: workspaceId,
    session: { id: sessionId, agent_group_id: agentGroupId },
    delivery: {
      channel_type: channelType,
      platform_id: platformId,
      thread_id: threadId,
      name: deliveryName,
      display_name: deliveryDisplayName,
    },
    inbound: {
      id: inboundId,
      kind: inboundKind,
      timestamp: inboundTimestamp,
      content: inboundContent,
      sender,
    },
    options: parseProcessOptions(root),
  };
}
