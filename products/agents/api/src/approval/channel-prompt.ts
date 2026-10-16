/** Keep channel approval copy aligned with the durable group shown in Studio. */
export function buildChannelApprovalGroupPrompt(
  operations: readonly { capability: string }[],
): string {
  const names = [...new Set(operations.map((operation) => operation.capability))];
  const summary = names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
  return `Approve all ${operations.length} requested actions (${summary})?`;
}
