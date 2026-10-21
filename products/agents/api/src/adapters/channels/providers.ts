import type { ChannelProviderAdapter, MessagingChannelKind } from "../../contracts/channel-adapters";
import { telegramAdapter } from "./telegram/adapter";
import { whatsappAdapter } from "./whatsapp/adapter";
import { facebookChannelAdapter, instagramChannelAdapter } from "./meta";

const adapters: Readonly<Record<MessagingChannelKind, ChannelProviderAdapter>> = Object.freeze({
  telegram: telegramAdapter, whatsapp: whatsappAdapter,
  facebook: facebookChannelAdapter, instagram: instagramChannelAdapter,
});
export const installedChannelHandlers: ReadonlySet<string> = new Set(["website", ...Object.keys(adapters)]);
export function messagingChannelAdapter(kind: MessagingChannelKind): ChannelProviderAdapter { return adapters[kind]; }
