import type { AgentMediaReference, AgentResponse } from "./contracts";
import type { AgentUi, UiBlock } from "./dynamic-ui";
import type { ChannelMediaProfile } from "./profiles";
import { channelUiProfile, type ChannelUiProfile } from "./profiles";

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

function uiValue(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function safeAppLink(href: string, appUrl: string | undefined): string | undefined {
  if (!appUrl) return undefined;
  try {
    const origin = new URL(appUrl);
    if (!/^https?:$/.test(origin.protocol)) return undefined;
    const url = new URL(href, origin);
    return url.origin === origin.origin && url.protocol === origin.protocol ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function blockFallback(block: UiBlock, profile: ChannelUiProfile, appUrl: string | undefined): string[] {
  if (block.type === "summary") {
    return [
      block.title ? `${uiValue(block.title)}:` : "",
      ...block.items.slice(0, 8).map((item) => `${uiValue(item.label)}: ${uiValue(item.value)}`),
    ].filter(Boolean);
  }
  if (block.type === "list") {
    return [
      block.title ? `${uiValue(block.title)}:` : "",
      ...block.items.slice(0, 8).map((item, index) => {
        const details = [item.description, item.meta].filter((value): value is string => Boolean(value)).map(uiValue).join(" · ");
        return `${index + 1}. ${uiValue(item.title)}${details ? ` — ${details}` : ""}`;
      }),
      ...(block.items.length > 8 ? [`${block.items.length - 8} more items available in the app.`] : []),
    ].filter(Boolean);
  }
  if (block.type === "progress") {
    return [
      block.title ? `${uiValue(block.title)}:` : "",
      ...block.steps.slice(0, 12).map((step) => `${step.status === "complete" ? "✓" : step.status === "error" ? "!" : "•"} ${uiValue(step.label)}${step.detail ? ` — ${uiValue(step.detail)}` : ""}`),
    ].filter(Boolean);
  }
  if (block.type === "workspace") {
    const link = profile.supportsLinks ? safeAppLink(block.href, appUrl) : undefined;
    return [uiValue(block.title), uiValue(block.description), link ? `Open in KasiTek: ${link}` : "Open this workspace in KasiTek."].filter(Boolean);
  }
  if (block.type === "choice") {
    return [
      block.title ? uiValue(block.title) : "Choose an option:",
      ...(block.description ? [uiValue(block.description)] : []),
      ...block.options.slice(0, 8).map((option, index) => `${index + 1}. ${uiValue(option.label)}${option.description ? ` — ${uiValue(option.description)}` : ""}`),
      "Reply with the number or option name.",
    ];
  }
  return [
    block.title ? uiValue(block.title) : "Please provide the requested details.",
    ...(block.description ? [uiValue(block.description)] : []),
    ...block.fields.slice(0, 8).map((field) => `${uiValue(field.label)}${field.required ? " *" : ""}${field.type === "select" ? `: ${field.options.slice(0, 6).map((option) => uiValue(option.label)).join(", ")}` : ""}`),
  ];
}

/**
 * Converts a rich response into a bounded channel-safe representation. This
 * is intentionally presentation-only: it never exposes action prompts or
 * backend capability names to an external channel.
 */
export function buildChannelUiFallback(ui: AgentUi | undefined, channelType: string, appUrl?: string): string {
  if (!ui) return "";
  const profile = channelUiProfile(channelType);
  if (profile.mode === "rich") return "";
  const lines = ui.blocks.slice(0, 6).flatMap((block) => blockFallback(block, profile, appUrl));
  return lines.join("\n").slice(0, 6_000);
}

export interface ChannelUiNavigationButton {
  label: string;
  url: string;
}

/** Returns only reviewed app-local links that the native channel can render. */
export function channelUiNavigationButtons(
  ui: AgentUi | undefined,
  channelType: string,
  appUrl: string | undefined,
): ChannelUiNavigationButton[] {
  const profile = channelUiProfile(channelType);
  if (!ui || !profile.supportsButtons || !appUrl) return [];
  let origin: URL;
  try {
    origin = new URL(appUrl);
    if (!/^https?:$/.test(origin.protocol)) return [];
  } catch {
    return [];
  }
  const links: ChannelUiNavigationButton[] = [];
  for (const block of ui.blocks) {
    const actions = "actions" in block ? block.actions ?? [] : [];
    for (const action of actions) {
      if (action.kind !== "navigate" || !action.href || links.length >= 5) continue;
      const url = new URL(action.href, origin);
      if (url.origin !== origin.origin || url.protocol !== origin.protocol) continue;
      links.push({ label: uiValue(action.label), url: url.toString() });
    }
  }
  return links;
}
