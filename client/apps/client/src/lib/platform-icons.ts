import type { IconType } from "react-icons";
import { FaLinkedin } from "react-icons/fa";
import {
  SiBluesky,
  SiDiscord,
  SiFacebook,
  SiInstagram,
  SiMessenger,
  SiModelcontextprotocol,
  SiSlack,
  SiTelegram,
  SiThreads,
  SiTiktok,
  SiWhatsapp,
  SiWordpress,
  SiX,
} from "react-icons/si";

export type PlatformIcon = IconType;

export function getPlatformBrandIcon(platform: string): PlatformIcon | null {
  switch (platform.toUpperCase()) {
    case "WHATSAPP":
    case "WHATSAPP_STATUS":
      return SiWhatsapp;
    case "MESSENGER":
      return SiMessenger;
    case "FACEBOOK":
      return SiFacebook;
    case "INSTAGRAM":
      return SiInstagram;
    case "THREADS":
      return SiThreads;
    case "TIKTOK":
      return SiTiktok;
    case "BLUESKY":
      return SiBluesky;
    case "LINKEDIN":
      return FaLinkedin;
    case "X":
      return SiX;
    case "TELEGRAM":
      return SiTelegram;
    case "DISCORD":
      return SiDiscord;
    case "SLACK":
      return SiSlack;
    case "WORDPRESS":
      return SiWordpress;
    case "MCP":
      return SiModelcontextprotocol;
    default:
      return null;
  }
}

export function getPlatformBrandColor(platform: string) {
  switch (platform.toUpperCase()) {
    case "WHATSAPP":
    case "WHATSAPP_STATUS":
      return "!text-[#25D366]";
    case "MESSENGER":
    case "FACEBOOK":
      return "!text-[#0084FF]";
    case "INSTAGRAM":
      return "!text-[#E4405F]";
    case "THREADS":
      return "!text-foreground";
    case "TIKTOK":
      return "!text-[#25F4EE]";
    case "BLUESKY":
      return "!text-[#1185FE]";
    case "LINKEDIN":
      return "!text-[#0A66C2]";
    case "X":
      return "!text-foreground";
    case "TELEGRAM":
      return "!text-[#229ED9]";
    case "DISCORD":
      return "!text-[#5865F2]";
    case "SLACK":
      return "!text-[#36C5F0]";
    case "WORDPRESS":
      return "!text-[#21759B]";
    case "MCP":
      return "!text-[#A855F7]";
    default:
      return "!text-muted-foreground";
  }
}
