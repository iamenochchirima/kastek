import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookVerificationInput {
  rawBody: string | Buffer;
  signature: string;
  secret: string;
  now?: number;
  toleranceSeconds?: number;
}

export function verifyWebhookSignature(input: WebhookVerificationInput): { timestamp: number } {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(input.signature.trim());
  if (!match) throw new Error("Invalid webhook signature format");
  const timestamp = Number(match[1]);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tolerance = Math.max(1, Math.min(input.toleranceSeconds ?? 300, 3_600));
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > tolerance) throw new Error("Webhook signature is outside the replay window");
  const expected = createHmac("sha256", input.secret).update(`${timestamp}.${input.rawBody}`).digest();
  const provided = Buffer.from(match[2]!, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("Webhook signature mismatch");
  return { timestamp };
}

export function signWebhookPayload(rawBody: string | Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}
