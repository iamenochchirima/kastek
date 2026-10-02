import { parseSerdeValueJson } from "../../json.js";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import { ApiError } from "../../error.js";
import { bad, internal } from "./common.js";
type Env = Record<string, string | undefined>;
const unauthorized = () => new ApiError(401, "unauthorized", "Unauthorized");
function required(env: Env, name: string): string {
  if (env[name] === undefined) throw internal(`${name} is required`);
  return env[name];
}
function i64(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined || !/^[-+]?\d+$/.test(value)) return fallback;
  const result = BigInt(value);
  return result >= -(1n << 63n) && result < 1n << 63n ? result : fallback;
}
export function verifyTiktokWebhookSignature(
  header: string | undefined,
  body: Buffer,
  env: Env = process.env,
  now = BigInt(Math.floor(Date.now() / 1000)),
): void {
  const secret = required(env, "AUTH_TIKTOK_CLIENT_SECRET");
  const configured = i64(env.TIKTOK_WEBHOOK_MAX_AGE_SECONDS, 300n);
  const maxAge =
    configured < 30n ? 30n : configured > 3600n ? 3600n : configured;
  let timestamp: bigint | undefined;
  let signature: string | undefined;
  if (header === undefined) throw unauthorized();
  for (const item of header.split(",")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    const key = item.slice(0, index).trim(),
      value = item.slice(index + 1).trim();
    if (key === "t") {
      timestamp = /^[-+]?\d+$/.test(value) ? i64(value, 1n << 63n) : undefined;
      if (timestamp === 1n << 63n) timestamp = undefined;
    }
    if (key === "s") signature = value;
  }
  if (
    timestamp === undefined ||
    signature === undefined ||
    !/^([a-fA-F0-9]{2})*$/.test(signature)
  )
    throw unauthorized();
  const age = now - timestamp;
  if ((age < 0n ? -age : age) > maxAge) throw unauthorized();
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();
  const received = Buffer.from(signature, "hex");
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    throw unauthorized();
}
export function parseTiktokWebhookEnvelope(
  body: Buffer,
  env: Env = process.env,
): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = parseSerdeValueJson(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    throw bad("Invalid TikTok webhook payload");
  }
  const expected = required(env, "AUTH_TIKTOK_CLIENT_KEY");
  const data = payload as Record<string, unknown> | null;
  if (typeof data?.client_key !== "string")
    throw bad("TikTok webhook is missing client_key");
  if (data.client_key !== expected)
    throw new ApiError(403, "forbidden", "TikTok webhook client key mismatch");
  if (typeof data.event !== "string")
    throw bad("TikTok webhook is missing event");
  return data;
}
export async function recordTiktokWebhookEvent(
  pool: Pool,
  payload: Record<string, unknown>,
  body: Buffer,
): Promise<boolean> {
  return (
    (
      await pool.query(
        `INSERT INTO "SocialWebhookEvent"(id,provider,"eventKey","eventType","externalAccountId",payload,status,attempts,"nextAttemptAt","receivedAt","createdAt","updatedAt") VALUES($1,'TIKTOK',$2,$3,$4,$5,'RECEIVED',0,NOW(),NOW(),NOW(),NOW()) ON CONFLICT(provider,"eventKey") DO NOTHING`,
        [
          createId(),
          createHash("sha256").update(body).digest("hex"),
          typeof payload.event === "string" ? payload.event : "unknown",
          typeof payload.user_openid === "string" ? payload.user_openid : null,
          canonicalJson(payload),
        ],
      )
    ).rowCount === 1
  );
}
