import type { AgentMediaReference, AgentResponse } from "./contracts";
import type { ChannelMediaProfile } from "./profiles";

export interface ResolvedAgentMedia {
  assetId: string;
  kind: AgentMediaReference["kind"];
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

/**
 * Builds a text-only transport fallback for media that a gateway cannot render
 * natively. This deliberately uses resolved URLs only at the delivery boundary.
 */
export function materializeResolvedMediaLinks(text: string, media: readonly ResolvedAgentMedia[]): string {
  const links = media.map((item) => `[${item.fileName || (item.kind === "image" ? "Image" : "Attachment")}](${item.previewUrl})`);
  return [text.trim(), ...links].filter(Boolean).join("\n\n");
}

/**
 * Native media is delivered separately. The text portion contains only the
 * unsupported media fallback and a bounded notice for assets that could not be
 * resolved, so a stale attachment never suppresses the useful reply.
 */
export function buildChannelMediaText(
  response: AgentResponse,
  profile: ChannelMediaProfile,
  resolved: readonly ResolvedAgentMedia[],
  resolutionCandidates: readonly string[] = response.media.map((item) => item.assetId),
): string {
  const fallbackItems = response.media.filter((item) => !profile.nativeKinds.has(item.kind));
  const fallbackAssetIds = new Set(fallbackItems.map((item) => item.assetId));
  const resolvedFallback = resolved.filter((item) => fallbackAssetIds.has(item.assetId));
  const fallbackText = profile.fallback === "link"
    ? materializeResolvedMediaLinks("", resolvedFallback)
    : fallbackItems.length
      ? "Attachment unavailable on this channel."
      : "";
  const resolvedAssetIds = new Set(resolved.map((item) => item.assetId));
  const unavailableCount = resolutionCandidates.filter((assetId) => !resolvedAssetIds.has(assetId)).length;
  const unavailableText = unavailableCount > 0 && !(fallbackItems.length && profile.fallback === "text")
    ? unavailableCount === 1
      ? "One attachment could not be loaded."
      : `${unavailableCount} attachments could not be loaded.`
    : "";
  return [response.text.trim(), fallbackText, unavailableText].filter(Boolean).join("\n\n");
}
