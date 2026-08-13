export function formatSseEvent(event: Record<string, unknown>): string {
  const sequence = event.sequence_number === undefined ? "" : `id: ${String(event.sequence_number)}\n`;
  const publicEvent = toPublicEvent(event);
  return `${sequence}event: ${String(publicEvent.event_type)}\ndata: ${JSON.stringify(publicEvent)}\n\n`;
}

export function toPublicEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = typeof event.event_type === "string" ? event.event_type : "agent.event";
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? Object.fromEntries(Object.entries(event.payload as Record<string, unknown>).filter(([key]) => PUBLIC_PAYLOAD_FIELDS.has(key)))
    : {};
  return { sequence_number: event.sequence_number, event_type: type, payload, created_at: event.created_at };
}

const PUBLIC_PAYLOAD_FIELDS = new Set([
  "message", "reason", "retryable", "code", "failureClass", "provider", "model", "finishReason",
  "toolCallCount", "latencyMs", "name", "argumentsHash", "resumed", "estimatedTokens",
  "omittedMessageCount", "retrievalRequested", "messageCount", "memoryMatchCount", "knowledgeMatchCount",
  "totalTokens", "status",
]);

export function formatSseComment(value: string): string {
  return `: ${value}\n\n`;
}
