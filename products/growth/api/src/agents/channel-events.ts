import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  growthAgentChannelEventSchema,
  type GrowthAgentChannelEvent,
  type GrowthAgentChannelProvider,
} from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { growthAgentActor, growthAgentApiUrl, growthAgentDigest, signGrowthAgentCommand } from "./security.js";
import { metrics } from "@opentelemetry/api";

const channelMeter = metrics.getMeter("kasitek.growth.agent-channels");
const channelEventCount = channelMeter.createCounter("growth.agent_channel.webhook_event.count");
type ChannelEventStage = "queued" | "duplicate" | "delivered" | "retry_scheduled" | "quarantined";
function recordChannelEvent(provider: GrowthAgentChannelProvider, stage: ChannelEventStage, count = 1): void {
  if (count > 0) channelEventCount.add(count, { provider, stage });
}

type Fields = Record<string, unknown>;
type ChannelLogger = { info(fields: Record<string, unknown>): void; warn(fields: Record<string, unknown>): void };
type AgentGrant = {
  id: string;
  agentsWorkspaceId: string;
  agentsAgentId: string;
  agentsConnectionId: string;
  actorId: string;
  provider: GrowthAgentChannelProvider;
  providerAssetId: string;
};

const obj = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Fields).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function eventHash(kind: string, assetId: string, identity: unknown): string {
  return `growth:${kind}:${createHash("sha256").update(canonical({ assetId, identity })).digest("hex")}`;
}

function timestamp(value: unknown, seconds = false): string | null {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) return null;
  const milliseconds = Number(number) * (seconds ? 1000 : 1);
  if (milliseconds > 8_640_000_000_000_000) return null;
  return new Date(milliseconds).toISOString();
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? url.href : undefined;
  } catch { return undefined; }
}

function normalizeMeta(provider: "facebook" | "instagram", assetId: string, rawEntry: unknown): GrowthAgentChannelEvent[] {
  const entry = obj(rawEntry), events: GrowthAgentChannelEvent[] = [];
  for (const rawEvent of arr(entry.messaging)) {
    const event = obj(rawEvent), senderId = str(obj(event.sender).id), recipientId = str(obj(event.recipient).id);
    if (!senderId || !recipientId || senderId !== assetId && recipientId !== assetId) continue;
    const message = obj(event.message), echo = message.is_echo === true || message.is_self === true || senderId === assetId;
    const customerId = echo ? recipientId : senderId;
    if (!customerId || customerId === assetId) continue;
    const occurredAt = timestamp(event.timestamp), externalConversationId = `${assetId}:${customerId}`;
    const base = { assetId, externalConversationId, senderId, occurredAt, providerMessageId: null, attachments: [], echo };
    const receipt = event.delivery !== undefined ? obj(event.delivery) : event.read !== undefined ? obj(event.read) : null;
    if (receipt) {
      const status = event.delivery !== undefined ? "delivered" as const : "read" as const;
      const watermarkValue = receipt.watermark;
      const receiptWatermark = typeof watermarkValue === "string" && /^\d+$/.test(watermarkValue)
        ? watermarkValue : typeof watermarkValue === "number" && Number.isSafeInteger(watermarkValue) && watermarkValue >= 0
          ? String(watermarkValue) : undefined;
      const messageIds = [...new Set([...arr(receipt.mids), receipt.mid, receipt.message_id]
        .filter((value): value is string => typeof value === "string" && value.length > 0))];
      for (const providerMessageId of messageIds.length ? messageIds : receiptWatermark ? [null] : []) {
        const item = growthAgentChannelEventSchema.parse({ ...base, kind: "receipt", status, providerMessageId,
          eventId: eventHash(status, assetId, { senderId, providerMessageId, watermark: receiptWatermark ?? null }),
          ...(receiptWatermark ? { receiptWatermark } : {}), occurredAt: occurredAt ?? timestamp(receiptWatermark) });
        events.push(item);
      }
      continue;
    }
    if (event.reaction !== undefined) {
      const reaction = obj(event.reaction), providerMessageId = str(reaction.mid);
      if (providerMessageId) events.push(growthAgentChannelEventSchema.parse({ ...base, kind: "interaction", providerMessageId,
        eventId: eventHash("reaction", assetId, event), interaction: canonical({ type: "reaction", action: str(reaction.action) ?? "react",
          emoji: str(reaction.reaction) ?? str(reaction.emoji) ?? null }) }));
      continue;
    }
    if (event.postback !== undefined) {
      const postback = obj(event.postback);
      events.push(growthAgentChannelEventSchema.parse({ ...base, kind: "interaction", providerMessageId: str(postback.mid) ?? null,
        eventId: eventHash("postback", assetId, event), interaction: canonical({ type: "postback", payload: str(postback.payload) ?? null,
          title: str(postback.title) ?? null }) }));
      continue;
    }
    if (event.message === undefined) continue;
    const mid = str(message.mid), text = str(message.text), replyToProviderMessageId = str(obj(message.reply_to).mid);
    if (message.is_deleted === true || message.is_unsupported === true) {
      events.push(growthAgentChannelEventSchema.parse({ ...base, kind: "interaction", providerMessageId: mid ?? null,
        eventId: eventHash("message-state", assetId, event), interaction: canonical({
          type: message.is_deleted === true ? "message_deleted" : "message_unsupported", ...(text ? { text } : {}),
        }) }));
      continue;
    }
    const attachments = [] as GrowthAgentChannelEvent["attachments"];
    for (const rawAttachment of arr(message.attachments)) {
      const attachment = obj(rawAttachment), payload = obj(attachment.payload), sourceType = str(attachment.type) ?? "unknown";
      const type = sourceType === "image_share" ? "image" : sourceType === "video_share" ? "video"
        : ["file", "document"].includes(sourceType) ? "document" : sourceType;
      const url = safeUrl(payload.url), providerMediaId = str(payload.id) ?? str(payload.attachment_id);
      if (!["image", "audio", "video", "document"].includes(type) || !url && !providerMediaId) continue;
      attachments.push({ kind: type as "image" | "audio" | "video" | "document", ...(sourceType !== type ? { providerType: sourceType } : {}),
        ...(url ? { url } : {}), ...(providerMediaId ? { providerMediaId } : {}),
        ...(str(payload.mime_type) ? { mimeType: str(payload.mime_type) } : {}),
        ...(str(payload.name) ?? str(payload.filename) ? { fileName: str(payload.name) ?? str(payload.filename) } : {}) });
      if (attachments.length === 16) break;
    }
    if (text || attachments.length) events.push(growthAgentChannelEventSchema.parse({ ...base, kind: "message", providerMessageId: mid ?? null,
      eventId: eventHash(echo ? "echo" : "message", assetId, mid ?? event), ...(text ? { text } : {}), attachments,
      ...(replyToProviderMessageId ? { replyToProviderMessageId } : {}),
      ...(message.quick_reply ? { interaction: canonical({ type: "quick_reply", payload: str(obj(message.quick_reply).payload) ?? null }) } : {}) }));
  }
  return events;
}

function normalizeWhatsAppValue(valueRaw: unknown): { assetId: string; events: GrowthAgentChannelEvent[] } | null {
  const value = obj(valueRaw), assetId = str(obj(value.metadata).phone_number_id);
  if (!assetId) return null;
  const events: GrowthAgentChannelEvent[] = [];
  for (const rawMessage of [...arr(value.messages), ...arr(value.message_echoes)]) {
    const message = obj(rawMessage), senderId = str(message.from), providerMessageId = str(message.id);
    const echo = arr(value.message_echoes).includes(rawMessage) || message.echo === true || message.is_echo === true;
    const customerId = echo ? str(message.to) : senderId;
    if (!senderId || !customerId || !providerMessageId) continue;
    const kind = str(message.type) ?? "";
    let text = str(obj(message.text).body), interaction: string | undefined;
    const attachments = [] as GrowthAgentChannelEvent["attachments"];
    if (kind === "interactive") {
      const button = obj(obj(message.interactive).button_reply ?? obj(message.interactive).list_reply);
      interaction = str(button.id);
      text = str(button.title);
    } else if (kind === "button") {
      interaction = str(obj(message.button).payload);
      text = str(obj(message.button).text);
    }
    for (const [field, normalized] of [["image", "image"], ["sticker", "image"], ["audio", "audio"], ["video", "video"], ["document", "document"]] as const) {
      if (kind !== field) continue;
      const media = obj(message[field]), mediaId = str(media.id);
      if (mediaId) attachments.push({ kind: normalized, ...(field === "sticker" ? { providerType: "sticker" } : {}),
        providerMediaId: mediaId, ...(str(media.mime_type) ? { mimeType: str(media.mime_type) } : {}),
        ...(str(media.filename) ? { fileName: str(media.filename) } : {}) });
      text = str(media.caption);
    }
    if (!text && !attachments.length && !interaction) continue;
    events.push(growthAgentChannelEventSchema.parse({ kind: interaction ? "interaction" : "message", assetId,
      eventId: providerMessageId, externalConversationId: customerId, senderId, privateChat: !echo && /^\d{1,32}$/.test(senderId),
      senderLabel: senderId, occurredAt: timestamp(message.timestamp, true), providerMessageId,
      ...(text ? { text } : {}), attachments, echo, ...(interaction ? { interaction } : {}),
      ...(str(obj(message.context).id) ? { replyToProviderMessageId: str(obj(message.context).id) } : {}) }));
  }
  for (const rawStatus of arr(value.statuses)) {
    const status = obj(rawStatus), providerMessageId = str(status.id), recipientId = str(status.recipient_id);
    const state = str(status.status);
    if (!providerMessageId || !recipientId || !["sent", "delivered", "read", "failed"].includes(state ?? "")) continue;
    events.push(growthAgentChannelEventSchema.parse({ kind: "receipt", assetId,
      eventId: eventHash("whatsapp-receipt", assetId, [providerMessageId, state, status.timestamp ?? null]),
      externalConversationId: recipientId, senderId: recipientId, occurredAt: timestamp(status.timestamp, true), providerMessageId,
      attachments: [], echo: false, status, ...(obj(arr(status.errors)[0]).code !== undefined ? { errorCode: String(obj(arr(status.errors)[0]).code) } : {}) }));
  }
  return { assetId, events };
}

async function enqueueForAgent(pool: Pool, provider: GrowthAgentChannelProvider, assetId: string,
  events: GrowthAgentChannelEvent[], logger: ChannelLogger): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const grant = (await client.query<AgentGrant>(`SELECT id,"agentsWorkspaceId","agentsAgentId","agentsConnectionId","actorId",provider,"providerAssetId"
      FROM "GrowthAgentChannelGrant" WHERE provider=$1 AND "providerAssetId"=$2 AND state IN ('active','needs_attention') AND "routeOwner"='agents' FOR SHARE`,
    [provider, assetId])).rows[0];
    if (!grant) { await client.query("COMMIT"); return false; }
    let insertedCount = 0;
    for (const raw of events) {
      const event = growthAgentChannelEventSchema.parse(raw);
      if (event.assetId !== assetId) throw new ApiError(400, "agent_channel_event_invalid", "Channel event asset does not match");
      const digest = growthAgentDigest(event);
      const inserted = await client.query(`INSERT INTO "GrowthAgentChannelEvent"(id,"grantId","eventId",digest,payload)
        VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT ("grantId","eventId") DO NOTHING`,
      [randomUUID(), grant.id, event.eventId, digest, JSON.stringify(event)]);
      if (inserted.rowCount) insertedCount++;
      if (!inserted.rowCount) {
        const existing = (await client.query<{ digest: string }>(`SELECT digest FROM "GrowthAgentChannelEvent" WHERE "grantId"=$1 AND "eventId"=$2 FOR SHARE`,
          [grant.id, event.eventId])).rows[0];
        if (existing?.digest !== digest) throw new ApiError(409, "agent_channel_event_reused", "The provider event ID was reused with different content");
      }
    }
    await client.query("COMMIT");
    const duplicateCount = events.length - insertedCount;
    recordChannelEvent(provider, "queued", insertedCount);
    recordChannelEvent(provider, "duplicate", duplicateCount);
    if (events.length) logger.info({ event: "growth.agent_channel.webhook.received", provider,
      outcome: "accepted", queued_events: insertedCount, duplicate_events: duplicateCount, grant_id: grant.id });
    return true;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function routeGrowthManagedMetaPayload(core: CoreContext, payloadRaw: unknown, logger: ChannelLogger = console): Promise<unknown> {
  const payload = obj(payloadRaw), object = str(payload.object);
  if (object !== "page" && object !== "instagram") return payloadRaw;
  const provider = object === "page" ? "facebook" as const : "instagram" as const;
  const output = { ...payload, entry: [] as Fields[] };
  for (const rawEntry of arr(payload.entry)) {
    const entry = obj(rawEntry), assetId = str(entry.id);
    if (!assetId) { output.entry.push(entry); continue; }
    const events = normalizeMeta(provider, assetId, entry);
    const routed = await enqueueForAgent(core.pool, provider, assetId, events, logger);
    if (routed) output.entry.push({ ...entry, messaging: [] });
    else output.entry.push(entry);
  }
  return output;
}

export async function routeGrowthManagedWhatsAppValue(pool: Pool, value: unknown, logger: ChannelLogger = console): Promise<boolean> {
  const normalized = normalizeWhatsAppValue(value);
  return normalized ? enqueueForAgent(pool, "whatsapp", normalized.assetId, normalized.events, logger) : false;
}

type ClaimedEvent = {
  id: string;
  claimId: string;
  grantId: string;
  eventId: string;
  payload: GrowthAgentChannelEvent;
  attempts: number;
  agentsWorkspaceId: string;
  agentsAgentId: string;
  agentsConnectionId: string;
  actorId: string;
  provider: GrowthAgentChannelProvider;
  providerAssetId: string;
};

export async function processGrowthAgentChannelEvents(
  core: CoreContext,
  limit = 25,
  signal?: AbortSignal,
  logger: ChannelLogger = console,
): Promise<number> {
  const { pool, config } = core;
  const apiUrl = growthAgentApiUrl(config);
  if (!apiUrl) return 0;
  const claimId = randomUUID();
  const claimed = (await pool.query<ClaimedEvent>(`WITH candidate AS (
      SELECT id FROM "GrowthAgentChannelEvent" WHERE state IN ('pending','processing') AND "availableAt"<=now()
        AND (state='pending' OR "leaseUntil" IS NULL OR "leaseUntil"<now())
      ORDER BY "createdAt",id LIMIT $1 FOR UPDATE SKIP LOCKED
    )
    UPDATE "GrowthAgentChannelEvent" e SET state='processing',attempts=e.attempts+1,"leaseUntil"=now()+interval '45 seconds',"claimId"=$2
    FROM candidate c,"GrowthAgentChannelGrant" g
    WHERE e.id=c.id AND g.id=e."grantId"
    RETURNING e.id,e."grantId" AS "grantId",e."eventId" AS "eventId",e.payload,e.attempts,
      g."agentsWorkspaceId" AS "agentsWorkspaceId",g."agentsAgentId" AS "agentsAgentId",g."agentsConnectionId" AS "agentsConnectionId",
      g."actorId" AS "actorId",g.provider,g."providerAssetId" AS "providerAssetId",$2::uuid AS "claimId"`,
  [Math.max(1, Math.min(100, Math.floor(limit))), claimId])).rows;
  let processed = 0;
  for (const row of claimed) {
    if (signal?.aborted) break;
    const grant = (await pool.query<{ state: string; routeOwner: string }>(`SELECT state,"routeOwner" FROM "GrowthAgentChannelGrant" WHERE id=$1`, [row.grantId])).rows[0];
    if (!grant || !["active", "needs_attention"].includes(grant.state) || grant.routeOwner !== "agents") {
      await pool.query(`UPDATE "GrowthAgentChannelEvent" SET state='quarantined',reason='grant_inactive',"leaseUntil"=NULL,"claimId"=NULL
        WHERE id=$1 AND "claimId"=$2`, [row.id, claimId]);
      recordChannelEvent(row.provider, "quarantined");
      logger.warn({ event: "growth.agent_channel.webhook.quarantined", provider: row.provider,
        grant_id: row.grantId, event_id: row.eventId, error_code: "grant_inactive" });
      processed++;
      continue;
    }
    const body = { version: "1" as const, requestId: randomUUID(), actor: growthAgentActor(config, row.actorId),
      workspaceId: row.agentsWorkspaceId, agentId: row.agentsAgentId, operation: "webhook.deliver" as const,
      grantId: row.grantId, agentsConnectionId: row.agentsConnectionId, provider: row.provider,
      providerAssetId: row.providerAssetId, event: growthAgentChannelEventSchema.parse(row.payload) };
    try {
      const authorization = await signGrowthAgentCommand(config, body);
      const response = await fetch(new URL("/internal/agents/channel-events", apiUrl), {
        method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${authorization}`, "content-type": "application/json", "x-correlation-id": body.requestId },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 16_384) throw new Error("response_limit");
      let result: unknown;
      try { result = JSON.parse(text); } catch { result = null; }
      if (response.ok && obj(result).accepted === true) {
        await pool.query(`UPDATE "GrowthAgentChannelEvent" SET state='delivered',"deliveredAt"=now(),"leaseUntil"=NULL,"claimId"=NULL,reason=NULL
          WHERE id=$1 AND "claimId"=$2`, [row.id, claimId]);
        recordChannelEvent(row.provider, "delivered");
        logger.info({ event: "growth.agent_channel.webhook.delivered", provider: row.provider,
          grant_id: row.grantId, event_id: row.eventId, correlation_id: body.requestId, attempt: row.attempts });
      } else if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        await pool.query(`UPDATE "GrowthAgentChannelEvent" SET state='quarantined',reason=$3,"leaseUntil"=NULL,"claimId"=NULL
          WHERE id=$1 AND "claimId"=$2`, [row.id, claimId, `agents_http_${response.status}`]);
        recordChannelEvent(row.provider, "quarantined");
        logger.warn({ event: "growth.agent_channel.delivery.quarantined", provider: row.provider,
          correlation_id: body.requestId, attempt: row.attempts, error_code: `agents_http_${response.status}` });
      } else {
        const retrySeconds = response.headers.get("retry-after");
        const retryMs = retrySeconds && /^\d{1,4}$/.test(retrySeconds) ? Number(retrySeconds) * 1000 : Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 8));
        if (row.attempts >= 12) {
          await pool.query(`UPDATE "GrowthAgentChannelEvent" SET state='quarantined',reason='delivery_attempts_exhausted',"leaseUntil"=NULL,"claimId"=NULL
            WHERE id=$1 AND "claimId"=$2`, [row.id, claimId]);
          recordChannelEvent(row.provider, "quarantined");
          logger.warn({ event: "growth.agent_channel.delivery.quarantined", provider: row.provider,
            correlation_id: body.requestId, attempt: row.attempts, error_code: "delivery_attempts_exhausted" });
        } else {
          await pool.query(`UPDATE "GrowthAgentChannelEvent" SET state='pending',"availableAt"=now()+($3::int * interval '1 millisecond'),
            "leaseUntil"=NULL,"claimId"=NULL,reason='agents_unavailable' WHERE id=$1 AND "claimId"=$2`, [row.id, claimId, retryMs]);
          recordChannelEvent(row.provider, "retry_scheduled");
          logger.warn({ event: "growth.agent_channel.delivery.retry.scheduled", provider: row.provider,
            correlation_id: body.requestId, attempt: row.attempts, retry_delay_ms: retryMs,
            error_code: `agents_http_${response.status}` });
        }
      }
    } catch (error) {
      const retryMs = Math.min(300_000, 1000 * 2 ** Math.min(row.attempts, 8));
      const errorType = error instanceof Error && ["AbortError", "TimeoutError", "TypeError", "FetchError"].includes(error.name)
        ? error.name : "unknown";
      if (row.attempts >= 12) {
        await pool.query(`UPDATE "GrowthAgentChannelEvent" SET state='quarantined',reason='delivery_attempts_exhausted',"leaseUntil"=NULL,"claimId"=NULL
          WHERE id=$1 AND "claimId"=$2`, [row.id, claimId]);
        recordChannelEvent(row.provider, "quarantined");
        logger.warn({ event: "growth.agent_channel.delivery.quarantined", provider: row.provider,
          correlation_id: body.requestId, attempt: row.attempts, error_code: "delivery_attempts_exhausted", error_type: errorType });
      } else {
        await pool.query(`UPDATE "GrowthAgentChannelEvent" SET state='pending',"availableAt"=now()+($3::int * interval '1 millisecond'),
          "leaseUntil"=NULL,"claimId"=NULL,reason='agents_unavailable' WHERE id=$1 AND "claimId"=$2`, [row.id, claimId, retryMs]);
        recordChannelEvent(row.provider, "retry_scheduled");
        logger.warn({ event: "growth.agent_channel.delivery.retry.scheduled", provider: row.provider,
          correlation_id: body.requestId, attempt: row.attempts, retry_delay_ms: retryMs,
          error_code: "agents_unavailable", error_type: errorType });
      }
    }
    processed++;
  }
  return processed;
}
