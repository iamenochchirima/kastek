import type { ChannelProviderAdapter, ChannelSendRequest, ChannelProviderContext } from "../../../contracts/channel-adapters";
import { normalizeMetaWebhook } from "./normalize";
import { sendMetaMessage } from "./send";
import { verifyMetaChallenge, verifyMetaWebhook } from "./security";

function adapter(kind: "facebook" | "instagram"): ChannelProviderAdapter {
  return Object.freeze({ kind, verifyWebhook: verifyMetaWebhook, verifyChallenge: verifyMetaChallenge,
    normalize: (payload: unknown) => normalizeMetaWebhook(kind, payload), send: (request: ChannelSendRequest, context: ChannelProviderContext) => sendMetaMessage(kind, request, context) });
}
export const facebookChannelAdapter = adapter("facebook");
export const instagramChannelAdapter = adapter("instagram");
export { normalizeMetaWebhook } from "./normalize";
export { sendMetaMessage } from "./send";
export { verifyMetaChallenge, verifyMetaWebhook } from "./security";
