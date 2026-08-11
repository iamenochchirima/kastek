export function formatSseEvent(event: Record<string, unknown>): string {
  const sequence = event.sequence_number === undefined ? "" : `id: ${String(event.sequence_number)}\n`;
  const type = typeof event.event_type === "string" ? event.event_type : "agent.event";
  return `${sequence}event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatSseComment(value: string): string {
  return `: ${value}\n\n`;
}
