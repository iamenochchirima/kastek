import type { ConnectedObservation } from "./connected-executor";

function containsNamedHandles(content: unknown, handles: unknown): boolean {
  if (handles === null || typeof handles !== "object") return content === handles;
  if (Array.isArray(handles)) return Array.isArray(content) && handles.every(handle => content.some(value => containsNamedHandles(value, handle)));
  if (content === null || typeof content !== "object" || Array.isArray(content)) return false;
  return Object.entries(handles).every(([key, value]) => Object.hasOwn(content, key) && containsNamedHandles((content as Record<string, unknown>)[key], value));
}

/** The complete receipt stays durable; the prompt needs its source text and usable references. */
export function connectedModelView(receipt: ConnectedObservation) {
  let handles = receipt.handles;
  if (handles !== undefined) {
    try { if (containsNamedHandles(JSON.parse(receipt.content), handles)) handles = undefined; }
    catch { /* Non-JSON source text cannot replace structured handles. */ }
  }
  return {
    status: receipt.status,
    content: receipt.content,
    truncated: receipt.truncated,
    evidence: { id: receipt.evidence.id, citation: receipt.evidence.citation },
    observation: { acquiredAt: receipt.observation.acquiredAt, provenance: receipt.observation.provenance },
    ...(handles !== undefined ? { handles } : {}),
  };
}
