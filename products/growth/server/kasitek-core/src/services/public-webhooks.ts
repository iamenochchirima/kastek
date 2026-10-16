import { createId } from "@paralleldrive/cuid2";
import { randomBytes, createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Pool } from "pg";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import {
  canonicalJson,
  timestamp,
  SerdeFloat,
} from "@kasitek-labs/server-support/json";
import {
  encryptWithAes256Gcm,
  decryptWithAes256Gcm,
} from "@kasitek-labs/server-support/crypto";
type Row = Record<string, unknown>;
const SQL = {
  create_subscription: [
    'SELECT "id" FROM "PublicApiWebhookSubscription"\n               WHERE "orgId" = $1 AND "idempotencyKey" = $2',
    '\n        INSERT INTO "PublicApiWebhookSubscription"\n            ("id", "orgId", "url", "idempotencyKey", "secretCiphertext", "eventTypes", "status", "updatedAt")\n        VALUES ($1, $2, $3, $4, $5, $6, \'ACTIVE\', NOW())\n        ON CONFLICT ("orgId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL DO NOTHING\n        RETURNING "id", "orgId", "url", "eventTypes", "status", "failureCount",\n                  "lastDeliveredAt", "lastFailureAt", "disabledAt", "disabledReason",\n                  "createdAt", "updatedAt"\n        ',
    'SELECT "id" FROM "PublicApiWebhookSubscription"\n           WHERE "orgId" = $1 AND "idempotencyKey" = $2',
  ],
  replay_created_subscription: [
    'SELECT "id", "orgId", "url", "eventTypes", "status", "failureCount",\n                   "lastDeliveredAt", "lastFailureAt", "disabledAt", "disabledReason",\n                   "createdAt", "updatedAt"\n            FROM "PublicApiWebhookSubscription" WHERE "id" = $1',
    'SELECT "secretCiphertext" FROM "PublicApiWebhookSubscription" WHERE "id" = $1',
  ],
  list_subscriptions: [
    '\n        SELECT "id", "orgId", "url", "eventTypes", "status", "failureCount",\n               "lastDeliveredAt", "lastFailureAt", "disabledAt", "disabledReason",\n               "createdAt", "updatedAt"\n        FROM "PublicApiWebhookSubscription"\n        WHERE "orgId" = $1\n        ORDER BY "createdAt" DESC\n        LIMIT 100\n        ',
  ],
  update_subscription: [
    'SELECT "url", "eventTypes" FROM "PublicApiWebhookSubscription" WHERE "id" = $1 AND "orgId" = $2',
    '\n        UPDATE "PublicApiWebhookSubscription"\n        SET "url" = $3,\n            "eventTypes" = $4,\n            "status" = CASE WHEN $5::boolean IS NULL THEN "status"\n                             WHEN $5::boolean THEN \'ACTIVE\' ELSE \'DISABLED\' END,\n            "disabledAt" = CASE WHEN $5::boolean IS NULL THEN "disabledAt"\n                                 WHEN $5::boolean THEN NULL ELSE NOW() END,\n            "disabledReason" = CASE WHEN $5::boolean IS NULL THEN "disabledReason"\n                                     WHEN $5::boolean THEN NULL ELSE \'disabled_by_consumer\' END,\n            "updatedAt" = NOW()\n        WHERE "id" = $1 AND "orgId" = $2\n        RETURNING "id", "orgId", "url", "eventTypes", "status", "failureCount",\n                  "lastDeliveredAt", "lastFailureAt", "disabledAt", "disabledReason",\n                  "createdAt", "updatedAt"\n        ',
  ],
  delete_subscription: [
    '\n        UPDATE "PublicApiWebhookSubscription"\n        SET "status" = \'DISABLED\', "disabledAt" = NOW(),\n            "disabledReason" = \'deleted_by_consumer\', "updatedAt" = NOW()\n        WHERE "id" = $1 AND "orgId" = $2\n        ',
  ],
  list_deliveries: [
    'SELECT EXISTS(\n                SELECT 1 FROM "PublicApiWebhookSubscription"\n                WHERE "id" = $1 AND "orgId" = $2\n            )',
    '\n        SELECT d."id", d."subscriptionId", d."eventId", d."eventType", d."status",\n               d."attemptCount", d."nextAttemptAt", d."lastStatusCode", d."lastError",\n               d."deliveredAt", d."createdAt", d."updatedAt"\n        FROM "PublicApiWebhookDelivery" d\n        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"\n        WHERE s."orgId" = $1 AND ($2::text IS NULL OR d."subscriptionId" = $2)\n        ORDER BY d."createdAt" DESC\n        LIMIT 100\n        ',
  ],
  enqueue_request_event: [
    'SELECT "orgId", "route", "method", "action", "principalType", "principalId", "correlationId"\n           FROM "PublicApiRequest" WHERE "id" = $1',
  ],
  enqueue_event: [
    'SELECT "id" FROM "PublicApiWebhookSubscription"\n           WHERE "orgId" = $1 AND "status" = \'ACTIVE\'\n             AND "eventTypes" @> $2::jsonb',
    '\n            INSERT INTO "PublicApiWebhookDelivery"\n                ("id", "subscriptionId", "eventId", "eventType", "payload", "status", "updatedAt")\n            VALUES ($1, $2, $3, $4, $5, \'PENDING\', NOW())\n            ON CONFLICT ("subscriptionId", "eventId") DO NOTHING\n            ',
  ],
  claim_delivery: [
    '\n        WITH candidate AS (\n            SELECT d."id", d."subscriptionId"\n            FROM "PublicApiWebhookDelivery" d\n            JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"\n            WHERE (d."status" = \'PENDING\'\n                   OR (d."status" = \'DELIVERING\' AND d."updatedAt" < NOW() - INTERVAL \'5 minutes\'))\n              AND d."nextAttemptAt" <= NOW() AND s."status" = \'ACTIVE\'\n            ORDER BY d."nextAttemptAt", d."createdAt"\n            FOR UPDATE SKIP LOCKED\n            LIMIT 1\n        )\n        UPDATE "PublicApiWebhookDelivery" d\n        SET "status" = \'DELIVERING\', "attemptCount" = d."attemptCount" + 1, "updatedAt" = NOW()\n        FROM candidate c\n        JOIN "PublicApiWebhookSubscription" s ON s."id" = c."subscriptionId"\n        WHERE d."id" = c."id"\n        RETURNING d."id", d."subscriptionId", d."eventId", d."eventType", d."payload",\n                  d."attemptCount", s."url", s."secretCiphertext"\n        ',
  ],
  record_delivery_result: [
    'UPDATE "PublicApiWebhookDelivery"\n               SET "status" = \'DELIVERED\', "deliveredAt" = NOW(), "lastStatusCode" = $2,\n                   "lastError" = NULL, "updatedAt" = NOW() WHERE "id" = $1',
    'UPDATE "PublicApiWebhookSubscription"\n               SET "failureCount" = 0, "lastDeliveredAt" = NOW(), "updatedAt" = NOW()\n               WHERE "id" = $1',
    'UPDATE "PublicApiWebhookDelivery"\n           SET "status" = $2, "lastStatusCode" = $3, "lastError" = $4,\n               "nextAttemptAt" = NOW() + ($5::bigint * INTERVAL \'1 second\'), "updatedAt" = NOW()\n           WHERE "id" = $1',
    'UPDATE "PublicApiWebhookSubscription"\n           SET "failureCount" = "failureCount" + 1, "lastFailureAt" = NOW(),\n               "status" = CASE WHEN $2::boolean THEN \'DISABLED\' ELSE "status" END,\n               "disabledAt" = CASE WHEN $2::boolean THEN NOW() ELSE "disabledAt" END,\n               "disabledReason" = CASE WHEN $2::boolean THEN \'delivery_attempt_limit\' ELSE "disabledReason" END,\n               "updatedAt" = NOW()\n           WHERE "id" = $1',
  ],
} as const;
export const REQUEST_COMPLETED_EVENT = "public_api.request.completed",
  CONTENT_POST_CREATED_EVENT = "content.post.created",
  CONTENT_POST_UPDATED_EVENT = "content.post.updated";
export interface CreateSubscriptionInput {
  url: string;
  eventTypes?: string[];
  secret?: string;
}
export interface UpdateSubscriptionInput {
  url?: string;
  eventTypes?: string[];
  enabled?: boolean;
}
const bad = (message: string): never => {
  throw new ApiError(400, "bad_request", message);
};
const missing = (): never => {
  throw new ApiError(404, "not_found", "Webhook subscription not found");
};
function encryptionKey(config: CoreConfig): string {
  const env = config.env,
    key =
      env.PUBLIC_WEBHOOK_ENCRYPTION_KEY ??
      env.SOCIAL_TOKEN_ENCRYPTION_KEY ??
      env.WHATSAPP_TOKEN_ENCRYPTION_KEY;
  if (key === undefined)
    throw new ApiError(
      500,
      "internal_error",
      "PUBLIC_WEBHOOK_ENCRYPTION_KEY or an existing token encryption key is required",
    );
  return key;
}
const projection = (row: Row): Row => {
  const { orgId: _, ...publicRow } = row;
  return publicRow;
};
async function row(
  pool: Pool,
  sql: string,
  args: unknown[] = [],
): Promise<Row | undefined> {
  return (await pool.query(sql, args)).rows[0];
}
export function supportedEventTypes(values?: string[]): string[] {
  values ??= [REQUEST_COMPLETED_EVENT];
  if (!Array.isArray(values) || values.length < 1 || values.length > 8)
    bad("eventTypes must contain between 1 and 8 events");
  const output: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") bad("eventTypes must contain strings");
    const normalized = value.trim();
    if (
      ![
        REQUEST_COMPLETED_EVENT,
        CONTENT_POST_CREATED_EVENT,
        CONTENT_POST_UPDATED_EVENT,
      ].includes(normalized)
    )
      bad(`unsupported webhook event type: ${normalized}`);
    if (!output.includes(normalized)) output.push(normalized);
  }
  return output;
}
export function isPublicIp(value: string): boolean {
  if (isIP(value) === 4) {
    const [a, b] = value.split(".").map(Number);
    return !(
      a === 10 ||
      a === 127 ||
      value === "0.0.0.0" ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (isIP(value) === 6) {
    const ip = value.toLowerCase();
    return !(
      ["::", "::1"].includes(ip) ||
      /^f[cd]/.test(ip) ||
      /^fe[89ab]/.test(ip)
    );
  }
  return false;
}
export async function validateDestinationUrl(
  value: string,
  config: CoreConfig,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    bad("webhook url must be a valid URL");
  }
  const host = url!.hostname.replace(/^\[|\]$/g, ""),
    local =
      config.environment.toLowerCase() !== "production" &&
      ["http:", "https:"].includes(url!.protocol) &&
      (host.toLowerCase() === "localhost" || host.endsWith(".localhost"));
  if ((url!.protocol !== "https:" && !local) || url!.username || url!.password)
    bad(
      "webhook url must use public HTTPS (loopback HTTP is development-only)",
    );
  if (isIP(host)) {
    if (!local && !isPublicIp(host))
      bad("webhook url host must resolve to a public address");
    return url!;
  }
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    bad("webhook url host could not be resolved");
  }
  if (
    !addresses!.length ||
    (!local && addresses!.some((address) => !isPublicIp(address.address)))
  )
    bad("webhook url host must resolve to a public address");
  return url!;
}
async function replay(
  pool: Pool,
  id: string,
  config: CoreConfig,
): Promise<{ subscription: Row; secret: string; replayed: boolean }> {
  const value = (await row(pool, SQL.replay_created_subscription[0], [id]))!,
    ciphertext = (await row(pool, SQL.replay_created_subscription[1], [id]))!;
  return {
    subscription: projection(value),
    secret: decryptWithAes256Gcm(
      encryptionKey(config),
      String(ciphertext.secretCiphertext),
    ),
    replayed: true,
  };
}
export async function createSubscription(
  pool: Pool,
  org: string,
  input: CreateSubscriptionInput,
  config: CoreConfig,
  key: string | null,
): Promise<{ subscription: Row; secret: string; replayed: boolean }> {
  if (key !== null && !key.trim()) bad("idempotency-key must not be empty");
  if (key !== null) {
    const previous = await row(pool, SQL.create_subscription[0], [org, key]);
    if (previous) return replay(pool, String(previous.id), config);
  }
  const url = await validateDestinationUrl(input.url, config),
    types = supportedEventTypes(input.eventTypes),
    secret = input.secret ?? `whsec_${randomBytes(32).toString("hex")}`;
  if (
    typeof secret !== "string" ||
    Buffer.byteLength(secret.trim()) < 32 ||
    Buffer.byteLength(secret) > 512
  )
    bad("webhook secret must be between 32 and 512 characters");
  const created = await row(pool, SQL.create_subscription[1], [
    createId(),
    org,
    url.toString(),
    key,
    encryptWithAes256Gcm(encryptionKey(config), secret),
    canonicalJson(types),
  ]);
  if (created)
    return { subscription: projection(created), secret, replayed: false };
  if (key === null)
    throw new ApiError(
      409,
      "conflict",
      "Webhook subscription could not be created",
    );
  return replay(
    pool,
    String((await row(pool, SQL.create_subscription[2], [org, key]))!.id),
    config,
  );
}
export async function listSubscriptions(
  pool: Pool,
  org: string,
): Promise<Row[]> {
  return (await pool.query(SQL.list_subscriptions[0], [org])).rows.map(
    projection,
  );
}
export async function updateSubscription(
  pool: Pool,
  org: string,
  id: string,
  input: UpdateSubscriptionInput,
  config: CoreConfig,
): Promise<Row> {
  const current = await row(pool, SQL.update_subscription[0], [id, org]);
  if (!current) missing();
  if (input.enabled != null && typeof input.enabled !== "boolean")
    bad("enabled must be boolean");
  const url =
      input.url == null
        ? current!.url
        : (await validateDestinationUrl(input.url, config)).toString(),
    types =
      input.eventTypes == null
        ? Array.isArray(current!.eventTypes)
          ? current!.eventTypes.filter((v) => typeof v === "string")
          : []
        : supportedEventTypes(input.eventTypes),
    updated = await row(pool, SQL.update_subscription[1], [
      id,
      org,
      url,
      canonicalJson(types),
      input.enabled ?? null,
    ]);
  if (!updated) missing();
  return projection(updated!);
}
export async function deleteSubscription(
  pool: Pool,
  org: string,
  id: string,
): Promise<void> {
  if ((await pool.query(SQL.delete_subscription[0], [id, org])).rowCount === 0)
    missing();
}
export async function listDeliveries(
  pool: Pool,
  org: string,
  id: string | null,
): Promise<Row[]> {
  if (
    id !== null &&
    !(await row(pool, SQL.list_deliveries[0], [id, org]))!.exists
  )
    missing();
  return (await pool.query(SQL.list_deliveries[1], [org, id])).rows;
}
export function stableEventId(type: string, data: Row): string {
  const key = data.requestId ?? data.postId;
  return typeof key === "string" ? `${type}:${key}` : createId();
}
const wireData = (value: unknown): unknown =>
  value instanceof SerdeFloat
    ? value
    : value instanceof Date
      ? timestamp(value)
      : Array.isArray(value)
        ? value.map(wireData)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([key, child]) => [
                key,
                wireData(child),
              ]),
            )
          : value === undefined
            ? null
            : value;
export async function enqueueEvent(
  pool: Pool,
  org: string,
  type: string,
  data: Row,
): Promise<void> {
  const subscriptions = (
    await pool.query(SQL.enqueue_event[0], [org, canonicalJson([type])])
  ).rows;
  if (!subscriptions.length) return;
  const id = stableEventId(type, data),
    payload = canonicalJson({
      id,
      type,
      occurredAt: timestamp(new Date()).replace(/Z$/, "+00:00"),
      data: wireData(data),
    });
  for (const subscription of subscriptions)
    await pool.query(SQL.enqueue_event[1], [
      createId(),
      subscription.id,
      id,
      type,
      payload,
    ]);
}
export async function enqueueDomainEvent(
  pool: Pool,
  org: string,
  type: string,
  data: Row,
): Promise<void> {
  if (![CONTENT_POST_CREATED_EVENT, CONTENT_POST_UPDATED_EVENT].includes(type))
    bad("unsupported public webhook event type");
  await enqueueEvent(pool, org, type, data);
}
export async function enqueueRequestEvent(
  pool: Pool,
  id: string,
  statusCode: number,
): Promise<void> {
  const audit = await row(pool, SQL.enqueue_request_event[0], [id]);
  if (!audit) return;
  await enqueueEvent(pool, String(audit.orgId), REQUEST_COMPLETED_EVENT, {
    requestId: id,
    route: audit.route,
    method: audit.method,
    action: audit.action,
    statusCode,
    principalType: audit.principalType,
    principalId: audit.principalId,
    correlationId: audit.correlationId,
  });
}
export const webhookSignature = (
  secret: string,
  time: number,
  body: Buffer,
): string =>
  `v1=${createHmac("sha256", secret).update(String(time)).update(".").update(body).digest("hex")}`;
export const retryDelay = (attempt: number): number =>
  Math.min(3600, 30 * 2 ** Math.min(10, Math.max(0, attempt - 1)));
export async function recordDeliveryResult(
  pool: Pool,
  job: Row,
  status: number | null,
  error: string | null,
): Promise<void> {
  if (status !== null && status >= 200 && status < 300) {
    await pool.query(SQL.record_delivery_result[0], [job.id, status]);
    await pool.query(SQL.record_delivery_result[1], [job.subscriptionId]);
    return;
  }
  const disable = Number(job.attemptCount) >= 10;
  await pool.query(SQL.record_delivery_result[2], [
    job.id,
    disable ? "FAILED" : "PENDING",
    status,
    error ?? "Webhook delivery failed",
    retryDelay(Number(job.attemptCount)),
  ]);
  await pool.query(SQL.record_delivery_result[3], [
    job.subscriptionId,
    disable,
  ]);
}
export async function processDueDeliveries(
  pool: Pool,
  config: CoreConfig,
  batch: number,
  signal?: AbortSignal,
): Promise<number> {
  let processed = 0;
  for (
    let index = 0;
    index < Math.min(100, Math.max(1, batch)) && !signal?.aborted;
    index++
  ) {
    const job = await row(pool, SQL.claim_delivery[0]);
    if (!job) break;
    const body = Buffer.from(canonicalJson(job.payload)),
      time = Math.floor(Date.now() / 1000);
    let status: number | null = null,
      error: string | null = null;
    try {
      const signature = webhookSignature(
          decryptWithAes256Gcm(
            encryptionKey(config),
            String(job.secretCiphertext),
          ),
          time,
          body,
        ),
        timeout = AbortSignal.timeout(10000);
      const response = await fetch(String(job.url), {
        method: "POST",
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          "content-type": "application/json",
          "user-agent": "Kasitek-Public-Webhooks/1",
          "x-kasitek-webhook-id": String(job.eventId),
          "x-kasitek-webhook-event": String(job.eventType),
          "x-kasitek-webhook-timestamp": String(time),
          "x-kasitek-webhook-signature": signature,
        },
        body,
      });
      status = response.status;
      await response.body?.cancel();
      if (status < 200 || status >= 300)
        error = `Webhook endpoint returned HTTP ${status}`;
    } catch (failure) {
      error = String(failure);
    }
    // A shutdown abort leaves the durable claim in DELIVERING so the normal
    // five-minute lease recovery path can retry it without counting a failure.
    if (signal?.aborted) break;
    await recordDeliveryResult(pool, job, status, error);
    processed++;
  }
  return processed;
}
