import type { AgentMediaReference } from "./contracts";

export type AgentMediaFallback = "link" | "text";

export interface ChannelMediaProfile {
  channelType: string;
  nativeKinds: ReadonlySet<AgentMediaReference["kind"]>;
  fallback: AgentMediaFallback;
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
