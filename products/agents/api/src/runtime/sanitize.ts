/** Remove internal grounding markers before assistant text is persisted or displayed. */
export function sanitizeAssistantResponse(value: string): string {
  return value
    .replace(/<untrusted-data\b[^>]*>/gi, "")
    .replace(/<\/untrusted-data>/gi, "")
    .trim();
}
