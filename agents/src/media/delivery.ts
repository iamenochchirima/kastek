import type { AgentResponse } from "./contracts";

export interface ResolvedAgentMedia {
  assetId: string;
  kind: string;
  fileName?: string | null;
  previewUrl: string;
}

/**
 * Materializes transport links only inside the final channel call. The
 * returned string is a compatibility representation for gateways that still
 * accept text; the durable response remains typed and URL-free.
 */
export function materializeResponseLinks(response: AgentResponse, resolved: readonly ResolvedAgentMedia[]): string {
  const byAsset = new Map(resolved.map((item) => [item.assetId, item]));
  const mediaText = response.media.flatMap((item) => {
    const preview = byAsset.get(item.assetId);
    if (!preview) return [];
    const label = item.caption || item.fileName || preview.fileName || item.altText || "Attachment";
    return [item.kind === "image" ? `![${label}](${preview.previewUrl})` : `[${label}](${preview.previewUrl})`];
  });
  return [response.text, ...mediaText].filter(Boolean).join("\n\n");
}
