import { createHmac, timingSafeEqual } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import type { CoreConfig } from "../../config.js";
import { ApiError } from "../../error.js";
import { canonicalJson } from "@kasitek/server-support/json";
import { enqueueLifecycle } from "../../analytics/connections.js";
import * as sql from "./sql.js";
type Form = Record<string, string>;
const bad = (message: string) => new ApiError(400, "bad_request", message);
const forbidden = (message: string) => new ApiError(403, "forbidden", message);
const unauthorized = () => new ApiError(401, "unauthorized", "Unauthorized");
const optional = (config: CoreConfig, key: string) =>
  config.env[key]?.trim() || undefined;
const required = (config: CoreConfig, key: string) =>
  optional(config, key) ??
  (() => {
    throw bad(`${key} is not configured`);
  })();
export function providerStatus(config: CoreConfig) {
  const inbound = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_VOICE_WEBHOOK_URL",
  ].every((key) => !!optional(config, key));
  const browser = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_API_KEY_SID",
    "TWILIO_API_KEY_SECRET",
    "TWILIO_TWIML_APP_SID",
    "TWILIO_BROWSER_TWIML_URL",
  ].every((key) => !!optional(config, key));
  return {
    providers: [
      {
        provider: "TWILIO",
        configured: inbound && browser,
        inboundConfigured: inbound,
        browserConfigured: browser,
        requiredEnvironment: [
          "TWILIO_ACCOUNT_SID",
          "TWILIO_AUTH_TOKEN",
          "TWILIO_API_KEY_SID",
          "TWILIO_API_KEY_SECRET",
          "TWILIO_TWIML_APP_SID",
          "TWILIO_VOICE_WEBHOOK_URL",
          "TWILIO_BROWSER_TWIML_URL",
        ],
      },
    ],
  };
}
export function createTwilioBrowserToken(
  config: CoreConfig,
  org: string,
  user: string,
) {
  const account = required(config, "TWILIO_ACCOUNT_SID"),
    key = required(config, "TWILIO_API_KEY_SID"),
    secret = required(config, "TWILIO_API_KEY_SECRET"),
    application = required(config, "TWILIO_TWIML_APP_SID");
  required(config, "TWILIO_BROWSER_TWIML_URL");
  const identity = `kasitek_${org}_${user}`,
    now = Math.floor(Date.now() / 1000),
    expiresAt = now + 3600;
  const encode = (value: unknown) =>
    Buffer.from(canonicalJson(value)).toString("base64url");
  const input =
    encode({ typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" }) +
    "." +
    encode({
      jti: `${key}-${createId()}`,
      iss: key,
      sub: account,
      iat: now,
      nbf: now,
      exp: expiresAt,
      grants: {
        identity,
        voice: {
          incoming: { allow: true },
          outgoing: { application_sid: application },
        },
      },
    });
  return {
    token: `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`,
    identity,
    expiresAt,
  };
}
export function webhookBaseUrl(config: CoreConfig, path: string) {
  const url =
    path.endsWith("/browser") || path.endsWith("/status")
      ? (config.env.TWILIO_BROWSER_TWIML_URL ??
        config.env.TWILIO_VOICE_WEBHOOK_URL)
      : config.env.TWILIO_VOICE_WEBHOOK_URL;
  const base = url?.split("/api/webhooks/twilio/")[0];
  return base?.trim() ? base : undefined;
}
export function verifyTwilioWebhook(
  config: CoreConfig,
  path: string,
  payload: Form,
  signature: string | undefined,
) {
  const token = optional(config, "TWILIO_AUTH_TOKEN"),
    base = webhookBaseUrl(config, path);
  if (
    !token ||
    !base ||
    !signature ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      signature,
    )
  )
    throw unauthorized();
  const received = Buffer.from(signature, "base64");
  if (received.toString("base64") !== signature) throw unauthorized();
  const data =
    base.replace(/\/+$/, "") +
    path +
    Object.keys(payload)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map((key) => key + payload[key])
      .join("");
  const expected = createHmac("sha1", token).update(data).digest();
  if (
    received.length !== expected.length ||
    !timingSafeEqual(received, expected)
  )
    throw unauthorized();
}
export function normalizeTwilioStatus(value?: string) {
  switch (value?.replace(/[A-Z]/g, (c) => c.toLowerCase())) {
    case "queued":
    case "ringing":
      return "RINGING";
    case "initiated":
    case "in-progress":
      return "ACTIVE";
    case "completed":
      return "COMPLETED";
    case "busy":
    case "no-answer":
      return "MISSED";
    case "failed":
      return "FAILED";
    case "canceled":
      return "CANCELLED";
    default:
      return "RINGING";
  }
}
export const xmlEscape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
export function inboundTwiml(config: CoreConfig) {
  const number = optional(config, "TWILIO_INBOUND_FALLBACK_NUMBER");
  return number
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true">${xmlEscape(number)}</Dial></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>';
}
export function browserTwiml(config: CoreConfig, from: string, to: string) {
  const base = webhookBaseUrl(config, "/api/webhooks/twilio/browser");
  if (!base)
    throw new ApiError(
      500,
      "internal_error",
      "Twilio webhook base URL is unavailable",
    );
  const callback = base.replace(/\/+$/, "") + "/api/webhooks/twilio/status";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${xmlEscape(from)}" answerOnBridge="true" statusCallback="${xmlEscape(callback)}" statusCallbackMethod="POST"><Number>${xmlEscape(to)}</Number></Dial></Response>`;
}
export function twilioOrgFromIdentity(value: string) {
  const identity = value.startsWith("client:") ? value.slice(7) : value;
  if (!identity.startsWith("kasitek_"))
    throw forbidden("Unknown Twilio browser identity");
  const encoded = identity.slice(8),
    index = encoded.indexOf("_");
  if (index <= 0 || index === encoded.length - 1)
    throw forbidden("Invalid Twilio browser identity");
  return encoded.slice(0, index);
}
export function validateE164Phone(value: string) {
  const phone = value.trim();
  if (!/^\+[0-9]{8,15}$/.test(phone))
    throw bad("The destination phone number must use E.164 format");
  return phone;
}
const formRequired = (payload: Form, key: string, prefix: string) => {
  const value = payload[key];
  if (!value?.trim()) throw bad(`${prefix} is missing ${key}`);
  return value;
};
export async function syncWhatsappCalls(pool: Pool, org: string) {
  await pool.query(sql.sync, [org]);
}
export async function listCalls(pool: Pool, org: string) {
  await syncWhatsappCalls(pool, org);
  const result = await pool.query(sql.list, [org]);
  return result.rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
        value,
      ]),
    ),
  );
}
export async function callSummary(
  pool: Pool,
  org: string,
  input: number | bigint,
) {
  await syncWhatsappCalls(pool, org);
  const days = Number(input < 1 ? 1 : input > 90 ? 90 : input);
  const row = (
    await pool.query({
      text: sql.summary,
      values: [org, days],
      rowMode: "array",
    })
  ).rows[0] as string[];
  const n = (index: number) => BigInt(row[index]!);
  return {
    days,
    summary: {
      totalCalls: n(0),
      inboundCalls: n(1),
      outboundCalls: n(2),
      ringingCalls: n(3),
      activeCalls: n(3),
      completedCalls: n(5),
      missedCalls: n(4),
      failedCalls: 0,
      rejectedCalls: 0,
      recentCalls: n(0),
    },
    trend: [],
  };
}
export async function recordTwilioWebhook(pool: Pool, payload: Form) {
  const sid = formRequired(payload, "CallSid", "Twilio webhook"),
    providerId = payload.ParentCallSid?.trim() ? payload.ParentCallSid : sid,
    to = formRequired(payload, "To", "Twilio webhook");
  const connection = (await pool.query(sql.lookupNumber, [to])).rows[0];
  if (!connection) {
    console.warn("Twilio call received for an unregistered number");
    return null;
  }
  const status = normalizeTwilioStatus(payload.CallStatus),
    direction = payload.Direction?.replace(/[A-Z]/g, (c) =>
      c.toLowerCase(),
    ).startsWith("outbound")
      ? "OUTBOUND"
      : "INBOUND";
  let duration: number | null = null;
  const raw = payload.CallDuration;
  if (raw && /^[+-]?\d+$/.test(raw)) {
    const value = BigInt(raw);
    if (value >= -2147483648n && value <= 2147483647n) duration = Number(value);
  }
  const row = (
    await pool.query(sql.record, [
      `call_twilio_${createId()}`,
      connection.org_id,
      providerId,
      connection.id,
      direction,
      status,
      payload.From ?? "Unknown caller",
      to,
      duration,
      canonicalJson(payload),
    ])
  ).rows[0];
  return { callId: row.id, orgId: connection.org_id, status };
}
export async function recordTwilioBrowserCall(
  pool: Pool,
  config: CoreConfig,
  payload: Form,
) {
  const from = payload.From;
  if (from === undefined) throw bad("Twilio browser request is missing From");
  const org = twilioOrgFromIdentity(from),
    id = formRequired(payload, "ConnectionId", "Twilio browser request");
  if (payload.To === undefined)
    throw bad("Twilio browser request is missing To");
  const to = validateE164Phone(payload.To),
    sid = formRequired(payload, "CallSid", "Twilio browser request");
  const connection = (await pool.query(sql.lookupBrowser, [id, org])).rows[0];
  if (!connection)
    throw forbidden(
      "The selected calling number is not available in this workspace",
    );
  await pool.query(sql.recordBrowser, [
    `call_twilio_${createId()}`,
    org,
    sid,
    connection.id,
    connection.phone_number,
    to,
    canonicalJson(payload),
  ]);
  return browserTwiml(config, connection.phone_number, to);
}
export async function createTwilioConnection(
  pool: Pool,
  org: string,
  request: { phoneNumber?: string | null; displayName?: string | null },
) {
  const phone = request.phoneNumber?.trim();
  if (!phone) throw bad("A phone number is required");
  const display = request.displayName?.trim() || phone,
    source = `twilio:${phone}`,
    tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const existing = (await tx.query(sql.existingConnection, [org, source]))
      .rows[0];
    const row = (
      await tx.query({
        text: sql.createConnection,
        values: [`voice_${createId()}`, org, source, phone, display],
        rowMode: "array",
      })
    ).rows[0] as [string, string, string, Date];
    if (!existing)
      try {
        await enqueueLifecycle(
          tx,
          org,
          row[0],
          "TWILIO",
          "created",
          "NOT_CONNECTED",
          "MISSING",
          "UNKNOWN",
          "UNKNOWN",
          row[3],
        );
      } catch (error) {
        throw new ApiError(
          500,
          "internal_error",
          `Failed to queue Connections analytics fact: ${error}`,
        );
      }
    await tx.query("COMMIT");
    return {
      id: row[0],
      provider: "TWILIO",
      displayName: row[1],
      phoneNumber: row[2],
      status: "NOT_CONNECTED",
    };
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
