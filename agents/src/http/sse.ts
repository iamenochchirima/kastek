export function formatSseEvent(event: Record<string, unknown>): string {
  const sequence = event.sequence_number === undefined ? "" : `id: ${String(event.sequence_number)}\n`;
  const publicEvent = toPublicEvent(event);
  return `${sequence}event: ${String(publicEvent.event_type)}\ndata: ${JSON.stringify(publicEvent)}\n\n`;
}

/**
 * Advance a reconnect cursor without allowing malformed, duplicate, or
 * out-of-order event rows to move it backwards. The stream endpoint persists
 * the returned cursor only in the connection; clients resume from the last
 * emitted event id on the next request.
 */
export function advanceSseCursor(
  current: number,
  events: readonly Record<string, unknown>[],
): number {
  let cursor = current;
  for (const event of events) {
    const value = event.sequence_number;
    const sequence = typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value)
        : Number.NaN;
    if (Number.isSafeInteger(sequence) && sequence > cursor) cursor = sequence;
  }
  return cursor;
}

export function toPublicEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = typeof event.event_type === "string" ? event.event_type : "agent.event";
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? Object.fromEntries(Object.entries(event.payload as Record<string, unknown>).filter(([key]) => PUBLIC_PAYLOAD_FIELDS.has(key)))
    : {};
  return {
    ...(typeof event.id === "string" ? { event_id: event.id } : {}),
    ...(typeof event.run_id === "string" ? { run_id: event.run_id } : {}),
    sequence_number: event.sequence_number,
    event_type: type,
    payload,
    created_at: event.created_at,
  };
}

const PUBLIC_PAYLOAD_FIELDS = new Set([
  "message", "reason", "retryable", "code", "failureClass", "provider", "model", "finishReason",
  "toolCallCount", "latencyMs", "name", "argumentsHash", "resumed", "estimatedTokens",
  "omittedMessageCount", "retrievalRequested", "messageCount", "memoryMatchCount", "knowledgeMatchCount",
  "totalTokens", "status", "handoffId", "conversationId", "installationId", "agentDefinitionId",
  "agentVersionId", "runId", "channelType", "priority", "actorType", "conversationState",
  "messageId", "deliveryStatus", "resolution", "resolutionCode",
  "authorizationRequired",
  "execution",
]);

export function formatSseComment(value: string): string {
  return `: ${value}\n\n`;
}
