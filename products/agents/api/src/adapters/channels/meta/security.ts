import { createHmac, timingSafeEqual } from "node:crypto";
import { ChannelAdapterError, type ChannelWebhookRequest } from "../../../contracts/channel-adapters";

export function verifyMetaWebhook(request: ChannelWebhookRequest): void {
  const secret = request.secrets.appSecret;
  const signature = Object.entries(request.headers).find(([name]) => name.toLowerCase() === "x-hub-signature-256")?.[1];
  if (!secret || !signature || !/^sha256=[a-fA-F0-9]{64}$/.test(signature)) {
    throw new ChannelAdapterError("CHANNEL_WEBHOOK_AUTHENTICATION_FAILED", "rejected", 403);
  }
  const actual = Buffer.from(signature.slice(7), "hex"), expected = createHmac("sha256", secret).update(request.rawBody).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ChannelAdapterError("CHANNEL_WEBHOOK_AUTHENTICATION_FAILED", "rejected", 403);
  }
}
export function verifyMetaChallenge(query: Readonly<Record<string, string | undefined>>, token: string): string {
  const received = query["hub.verify_token"], challenge = query["hub.challenge"];
  if (!token || !received || query["hub.mode"] !== "subscribe" || !challenge) {
    throw new ChannelAdapterError("CHANNEL_WEBHOOK_CHALLENGE_INVALID", "rejected", 403);
  }
  const actual = Buffer.from(received), expected = Buffer.from(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ChannelAdapterError("CHANNEL_WEBHOOK_CHALLENGE_INVALID", "rejected", 403);
  }
  return challenge;
}
