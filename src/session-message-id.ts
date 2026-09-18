/**
 * Namespace platform message ids per agent group before writing to session
 * inbound.db. messages_in.id is PRIMARY KEY — the same platform id must not
 * collide across sessions or on gateway re-delivery after a prior run.
 */
export function sessionInboundMessageId(
  platformMessageId: string | undefined,
  agentGroupId: string,
): string {
  const base =
    platformMessageId && platformMessageId.length > 0
      ? platformMessageId
      : `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${base}:${agentGroupId}`;
}

/**
 * Undo {@link sessionInboundMessageId} before calling channel APIs
 * (reactions, edits). Session inbound ids are `${platformId}:${agentGroupId}`.
 *
 * When `agentGroupId` is known, strip that exact suffix. Otherwise strip a
 * trailing `:ag-…` namespace (gateway agent group ids from `generateId('ag')`).
 */
export function platformMessageIdFromSession(
  sessionMessageId: string,
  agentGroupId?: string,
): string {
  if (agentGroupId && sessionMessageId.endsWith(`:${agentGroupId}`)) {
    return sessionMessageId.slice(0, -(agentGroupId.length + 1));
  }
  const idx = sessionMessageId.lastIndexOf(':ag-');
  if (idx > 0 && !sessionMessageId.slice(idx + 1).includes(':')) {
    return sessionMessageId.slice(0, idx);
  }
  return sessionMessageId;
}
