import type { IconType } from "react-icons";
import { FaLinkedin } from "react-icons/fa";
import {
  SiAirtable,
  SiAlgolia,
  SiAsana,
  SiBluesky,
  SiCanva,
  SiClickup,
  SiCloudflare,
  SiDiscord,
  SiDropbox,
  SiFacebook,
  SiFigma,
  SiGithub,
  SiGitlab,
  SiGmail,
  SiGoogledrive,
  SiGooglecalendar,
  SiHubspot,
  SiInstagram,
  SiIntercom,
  SiLinear,
  SiMessenger,
  SiMiro,
  SiModelcontextprotocol,
  SiNotion,
  SiOpenai,
  SiPostgresql,
  SiShopify,
  SiSlack,
  SiSpotify,
  SiStripe,
  SiTelegram,
  SiThreads,
  SiTiktok,
  SiTrello,
  SiTwilio,
  SiVercel,
  SiWhatsapp,
  SiWordpress,
  SiX,
  SiZapier,
} from "react-icons/si";

export type PlatformIcon = IconType;

function platformKey(platform: string) {
  const lastSegment = platform.trim().split(/[/:]/).filter(Boolean).at(-1) ?? platform;
  return lastSegment.toUpperCase().replaceAll(/[^A-Z0-9]/g, "");
}

export function getPlatformBrandIcon(platform: string): PlatformIcon | null {
  switch (platformKey(platform)) {
    case "AIRTABLE":
      return SiAirtable;
    case "ALGOLIA":
      return SiAlgolia;
    case "ASANA":
      return SiAsana;
    case "BLUESKY":
      return SiBluesky;
    case "CANVA":
      return SiCanva;
    case "CLICKUP":
      return SiClickup;
    case "CLOUDFLARE":
      return SiCloudflare;
    case "DISCORD":
      return SiDiscord;
    case "DROPBOX":
      return SiDropbox;
    case "FACEBOOK":
      return SiFacebook;
    case "FACEBOOKMESSENGER":
    case "MESSENGER":
      return SiMessenger;
    case "FIGMA":
      return SiFigma;
    case "GITHUB":
      return SiGithub;
    case "GITLAB":
      return SiGitlab;
    case "GMAIL":
      return SiGmail;
    case "GOOGLEDRIVE":
      return SiGoogledrive;
    case "GOOGLECALENDAR":
      return SiGooglecalendar;
    case "HUBSPOT":
      return SiHubspot;
    case "INSTAGRAM":
      return SiInstagram;
    case "INTERCOM":
      return SiIntercom;
    case "LINEAR":
      return SiLinear;
    case "LINKEDIN":
      return FaLinkedin;
    case "MIRO":
      return SiMiro;
    case "NOTION":
      return SiNotion;
    case "OPENAI":
      return SiOpenai;
    case "POSTGRESQL":
    case "POSTGRES":
      return SiPostgresql;
    case "SHOPIFY":
      return SiShopify;
    case "SLACK":
      return SiSlack;
    case "SPOTIFY":
      return SiSpotify;
    case "STRIPE":
      return SiStripe;
    case "TELEGRAM":
      return SiTelegram;
    case "THREADS":
      return SiThreads;
    case "TIKTOK":
      return SiTiktok;
    case "TRELLO":
      return SiTrello;
    case "TWILIO":
      return SiTwilio;
    case "VERCEL":
      return SiVercel;
    case "WHATSAPP":
      return SiWhatsapp;
    case "WORDPRESS":
      return SiWordpress;
    case "X":
      return SiX;
    case "MCP":
      return SiModelcontextprotocol;
    case "ZAPIER":
      return SiZapier;
    default:
      return null;
  }
}

export function getPlatformBrandColor(platform: string) {
  switch (platformKey(platform)) {
    case "AIRTABLE":
      return "!text-[#18BFFF]";
    case "ALGOLIA":
      return "!text-[#5468FF]";
    case "ASANA":
      return "!text-[#F06A6A]";
    case "BLUESKY":
      return "!text-[#1185FE]";
    case "CANVA":
      return "!text-[#00C4CC]";
    case "CLICKUP":
      return "!text-[#FF02F0]";
    case "CLOUDFLARE":
      return "!text-[#F38020]";
    case "DISCORD":
      return "!text-[#5865F2]";
    case "DROPBOX":
      return "!text-[#0061FF]";
    case "FACEBOOK":
    case "MESSENGER":
    case "FACEBOOKMESSENGER":
      return "!text-[#0084FF]";
    case "FIGMA":
      return "!text-[#F24E1E]";
    case "GITHUB":
      return "!text-foreground";
    case "GITLAB":
      return "!text-[#FC6D26]";
    case "GMAIL":
      return "!text-[#EA4335]";
    case "GOOGLEDRIVE":
    case "GOOGLECALENDAR":
      return "!text-[#4285F4]";
    case "HUBSPOT":
      return "!text-[#FF7A59]";
    case "INSTAGRAM":
      return "!text-[#E4405F]";
    case "INTERCOM":
      return "!text-[#1F8DED]";
    case "LINEAR":
      return "!text-[#5E6AD2]";
    case "LINKEDIN":
      return "!text-[#0A66C2]";
    case "MIRO":
      return "!text-[#FFD02F]";
    case "NOTION":
      return "!text-foreground";
    case "OPENAI":
      return "!text-foreground";
    case "POSTGRESQL":
    case "POSTGRES":
      return "!text-[#336791]";
    case "SHOPIFY":
      return "!text-[#96BF48]";
    case "SLACK":
      return "!text-[#36C5F0]";
    case "SPOTIFY":
      return "!text-[#1ED760]";
    case "STRIPE":
      return "!text-[#635BFF]";
    case "TELEGRAM":
      return "!text-[#229ED9]";
    case "THREADS":
    case "X":
      return "!text-foreground";
    case "TIKTOK":
      return "!text-[#25F4EE]";
    case "TRELLO":
      return "!text-[#0C66E4]";
    case "TWILIO":
      return "!text-[#F22F46]";
    case "VERCEL":
      return "!text-foreground";
    case "WHATSAPP":
      return "!text-[#25D366]";
    case "WORDPRESS":
      return "!text-[#21759B]";
    case "MCP":
      return "!text-[#A855F7]";
    case "ZAPIER":
      return "!text-[#FF4F00]";
    default:
      return "!text-muted-foreground";
  }
}
