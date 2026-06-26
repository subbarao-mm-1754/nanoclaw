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
