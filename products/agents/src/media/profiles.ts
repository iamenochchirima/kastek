import type { AgentMediaReference } from "./contracts";

export type AgentMediaFallback = "link" | "text";
export type ChannelUiMode = "rich" | "native" | "numbered" | "text";

export interface ChannelMediaProfile {
  channelType: string;
  nativeKinds: ReadonlySet<AgentMediaReference["kind"]>;
  fallback: AgentMediaFallback;
}

export interface ChannelUiProfile {
  channelType: string;
  mode: ChannelUiMode;
  supportsLinks: boolean;
  supportsButtons: boolean;
}

const allKinds = new Set<AgentMediaReference["kind"]>(["image", "video", "audio", "document", "file"]);
const visualAndAudioKinds = new Set<AgentMediaReference["kind"]>(["image", "video", "audio"]);
const textOnlyKinds = new Set<AgentMediaReference["kind"]>();

const profiles: Record<string, ChannelMediaProfile> = {
  platform: { channelType: "platform", nativeKinds: allKinds, fallback: "link" },
  website: { channelType: "website", nativeKinds: allKinds, fallback: "link" },
  telegram: { channelType: "telegram", nativeKinds: allKinds, fallback: "link" },
  whatsapp: { channelType: "whatsapp", nativeKinds: visualAndAudioKinds, fallback: "link" },
  discord: { channelType: "discord", nativeKinds: new Set(["image"]), fallback: "link" },
  facebook: { channelType: "facebook", nativeKinds: textOnlyKinds, fallback: "text" },
  instagram: { channelType: "instagram", nativeKinds: textOnlyKinds, fallback: "text" },
};

export function channelMediaProfile(channelType: string): ChannelMediaProfile {
  return profiles[channelType.trim().toLowerCase()] ?? {
    channelType: channelType.trim().toLowerCase() || "unknown",
    nativeKinds: textOnlyKinds,
    fallback: "text",
  };
}

const uiProfiles: Record<string, ChannelUiProfile> = {
  platform: { channelType: "platform", mode: "rich", supportsLinks: true, supportsButtons: true },
  website: { channelType: "website", mode: "rich", supportsLinks: true, supportsButtons: true },
  telegram: { channelType: "telegram", mode: "native", supportsLinks: true, supportsButtons: true },
  discord: { channelType: "discord", mode: "native", supportsLinks: true, supportsButtons: true },
  whatsapp: { channelType: "whatsapp", mode: "numbered", supportsLinks: true, supportsButtons: false },
  facebook: { channelType: "facebook", mode: "text", supportsLinks: true, supportsButtons: false },
  instagram: { channelType: "instagram", mode: "text", supportsLinks: true, supportsButtons: false },
};

export function channelUiProfile(channelType: string): ChannelUiProfile {
  const normalized = channelType.trim().toLowerCase() || "unknown";
  return uiProfiles[normalized] ?? {
    channelType: normalized,
    mode: "text",
    supportsLinks: true,
    supportsButtons: false,
  };
}
