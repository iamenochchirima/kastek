import { parseSerdeValueJson } from "../../json.js";
import type { Pool } from "pg";
import { createId } from "@paralleldrive/cuid2";
import { transaction } from "../../db.js";
import * as analytics from "../../analytics/campaigns.js";
import {
  requireCapability,
  requireMeterAvailable,
  recordMeterUsage,
} from "../billing.js";
import { decryptSocialSecret } from "../../integrations/crypto.js";
import { wireInteger } from "@kasitek-labs/server-support/json";
import type {
  Row,
  WhatsappCampaignCreateRequest,
  WhatsappContactRow,
} from "./types.js";
import { rowView } from "./types.js";
import { SQL } from "./campaigns-sql.js";
import {
  bad,
  missing,
  conflict,
  internal,
  trimmed,
  json,
  sanitizeListLabel,
  parseScheduledAt,
  contactEligible,
  contactMatchesAudience,
  getConnectionRowForOrg,
  metadataString,
  selectCampaignContactRow,
  GRAPH_BASE,
  envInteger,
  providerRequestError,
  type MarketingOptions,
  type ProviderOptions,
} from "./common.js";
const MAX_BATCH = 2147483647;
export async function getCampaignRow(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<Row | undefined> {
  return (await pool.query(SQL.get_campaign_row[0], [id, orgId])).rows[0];
}
async function requireCampaign(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<Row> {
  const row = await getCampaignRow(pool, orgId, id);
  if (!row) throw missing("Campaign not found");
  return row;
}
export async function listCampaigns(pool: Pool, orgId: string): Promise<Row> {
  const rows = (await pool.query(SQL.list_campaigns[0], [orgId])).rows;
  return {
    campaigns: rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
          value,
        ]),
      ),
    ),
  };
}
export async function publishCampaignUpdated(
  pool: Pool,
  userId: string,
  id: string,
  options: MarketingOptions,
): Promise<void> {
  const orgId = (
    await pool.query(
      'SELECT "orgId" FROM "WhatsappCampaign" WHERE id=$1 LIMIT 1',
      [id],
    )
  ).rows[0]?.orgId;
  if (!orgId) return;
  const row = await getCampaignRow(pool, orgId, id);
  if (!row) return;
  const campaign: Row = {
    id: row.id,
    status: row.status,
    updatedAt: row.updated_at,
  };
  for (const key of [
    "total_recipients",
    "sent_count",
    "delivered_count",
    "read_count",
    "failed_count",
    "blocked_count",
    "unsubscribed_count",
  ])
    campaign[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] =
      row[key];
  try {
    await options.publishEvent(orgId, {
      type: "campaign.updated",
      campaignId: id,
      campaign,
    });
  } catch (error) {
    (options.logger ?? console).warn({
      event: "operation.failed",
      operation: "whatsapp.realtime_publish",
      error_type: error instanceof Error ? error.name : "unknown",
    });
  }
}
export async function createCampaign(
  pool: Pool,
  userId: string,
  orgId: string,
  input: WhatsappCampaignCreateRequest,
  options: MarketingOptions,
): Promise<Row> {
  const name = trimmed(input.name);
  if (!name) throw bad("Campaign name is required");
  const connection = await getConnectionRowForOrg(
    pool,
    orgId,
    input.connection_id ?? "",
  );
  if (!connection) throw missing("WhatsApp connection not found");
  const template = (
    await pool.query(SQL.create_campaign[0], [input.template_id ?? "", orgId])
  ).rows[0];
  if (!template) throw missing("Template not found");
  if (template.category !== "MARKETING")
    throw bad("Only MARKETING templates are allowed for campaigns");
  if (template.status !== "APPROVED")
    throw bad("Only APPROVED templates can be used in campaigns");
  const label =
      input.list_label != null ? sanitizeListLabel(input.list_label) : null,
    excluded = input.excluded_contact_ids ?? [],
    batch =
      input.batch_size != null && input.batch_size > 0
        ? input.batch_size
        : null,
    scheduled = parseScheduledAt(input.scheduled_at);
  const index = input.recipient_ids != null ? (label ? 1 : 2) : label ? 3 : 4,
    values =
      input.recipient_ids != null
        ? label
          ? [orgId, input.recipient_ids, label]
          : [orgId, input.recipient_ids]
        : label
          ? [orgId, label]
          : [orgId];
  const contacts = (
    await pool.query<WhatsappContactRow>(SQL.create_campaign[index]!, values)
  ).rows.filter(
    (contact) =>
      input.recipient_ids != null ||
      contactMatchesAudience(contact, input.audience, options.config),
  );
  const byId = new Map(contacts.map((contact) => [contact.id, contact])),
    eligible: string[] = [],
    skipped = { notOptedIn: 0, excluded: 0, cooldown: 0 };
  for (const contact of contacts) {
    if (excluded.includes(contact.id)) {
      skipped.excluded++;
      continue;
    }
    const [reason, ok] = contactEligible(contact, options.config);
    if (ok) eligible.push(contact.id);
    else if (reason === "not_opted_in") skipped.notOptedIn++;
    else if (reason === "excluded") skipped.excluded++;
    else if (reason === "cooldown") skipped.cooldown++;
  }
  if (!eligible.length)
    throw bad(
      `No eligible recipients found for this campaign. Skipped: ${skipped.notOptedIn} not opted in, ${skipped.excluded} excluded/manual, ${skipped.cooldown} in cooldown.`,
    );
  const id = createId();
  await pool.query(SQL.create_campaign[5], [
    id,
    userId,
    orgId,
    connection.id,
    template.id,
    name,
    trimmed(input.description),
    template.template_name,
    template.language,
    json(input.variable_mappings),
    label,
    batch,
    scheduled && scheduled > new Date() ? "SCHEDULED" : "DRAFT",
    scheduled?.toISOString() ?? null,
    eligible.length,
  ]);
  for (const contactId of eligible) {
    const contact = byId.get(contactId)!;
    await pool.query(SQL.create_campaign[6], [
      createId(),
      id,
      contactId,
      contact.phone,
      contact.full_name,
      contact.location,
      contact.list_label,
      json(contact.metadata),
    ]);
  }
  for (const contactId of excluded) {
    const contact = byId.get(contactId);
    if (!contact) continue;
    const recipient = createId(),
      now = new Date();
    await transaction(pool, async (tx) => {
      const result = await tx.query(SQL.create_campaign[7], [
        recipient,
        id,
        contactId,
        contact.phone,
        contact.full_name,
        contact.location,
        contact.list_label,
        json(contact.metadata),
      ]);
      if (result.rowCount)
        await analytics.enqueueRecipientSuppressed(
          tx,
          orgId,
          id,
          recipient,
          "whatsapp",
          "meta",
          "manual_exclusion",
          now,
        );
    });
  }
  const count = Object.values(
    (await pool.query(SQL.create_campaign[8], [id])).rows[0]!,
  )[0] as string;
  await transaction(pool, (tx) =>
    analytics.enqueueManifest(tx, orgId, count, new Date()),
  );
  const campaign = await getCampaignRow(pool, orgId, id);
  if (!campaign) throw internal("Failed to reload campaign");
  return {
    campaign: rowView("WhatsappCampaignRow", campaign),
    createdRecipients: eligible.length,
    skipped,
  };
}
export async function getCampaign(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<Row> {
  const campaign = await requireCampaign(pool, orgId, id);
  const recipients = (await pool.query(SQL.get_campaign[0], [id])).rows;
  return {
    campaign: {
      campaign: rowView("WhatsappCampaignRow", campaign),
      recipients: recipients.map((row) =>
        rowView("WhatsappCampaignRecipientDetailRow", row),
      ),
    },
  };
}
export async function getCampaignSummary(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<Row> {
  return {
    campaign: rowView(
      "WhatsappCampaignRow",
      await requireCampaign(pool, orgId, id),
    ),
  };
}
export async function launchCampaign(
  pool: Pool,
  userId: string,
  orgId: string,
  id: string,
  scheduledAt: string | null | undefined,
  batchSize: number | null | undefined,
  options: MarketingOptions,
): Promise<Row> {
  const campaign = await requireCampaign(pool, orgId, id),
    limit =
      (await getConnectionRowForOrg(pool, orgId, campaign.connection_id))
        ?.daily_limit_estimate ?? MAX_BATCH,
    max =
      batchSize != null && batchSize > 0
        ? batchSize
        : (campaign.default_batch_size ?? MAX_BATCH);
  const recipients = (
    await pool.query(SQL.launch_campaign[0], [id, max])
  ).rows.map((row) => row.id);
  if (!recipients.length) throw bad("Campaign has no recipients to launch");
  await requireMeterAvailable(
    pool,
    orgId,
    "campaign_recipients",
    recipients.length,
  );
  if (recipients.length > limit)
    throw conflict(
      `Launch batch size (${recipients.length}) exceeds estimated daily portfolio limit (${limit})`,
    );
  const when = parseScheduledAt(scheduledAt) ?? campaign.scheduled_at,
    scheduled = when !== null && when > new Date();
  if (!(await pool.query(SQL.launch_campaign[1], [recipients])).rowCount)
    throw bad("No recipients were queued for launch");
  await pool.query(SQL.launch_campaign[2], [
    scheduled ? "SCHEDULED" : "SENDING",
    when?.toISOString() ?? null,
    scheduled,
    id,
  ]);
  await publishCampaignUpdated(pool, userId, id, options);
  return {
    campaignId: id,
    queuedRecipients: recipients.length,
    batchSize: max === MAX_BATCH ? null : max,
    scheduledAt: when,
    status: scheduled ? "SCHEDULED" : "SENDING",
  };
}
export async function pauseCampaign(
  pool: Pool,
  userId: string,
  orgId: string,
  id: string,
  options: MarketingOptions,
): Promise<Row> {
  const campaign = await requireCampaign(pool, orgId, id);
  if (!["SENDING", "SCHEDULED"].includes(campaign.status))
    throw bad("Only active or scheduled campaigns can be paused");
  const result = await pool.query(SQL.pause_campaign[0], [id]);
  await pool.query(SQL.pause_campaign[1], [id]);
  await recomputeCampaignStats(pool, id);
  await publishCampaignUpdated(pool, userId, id, options);
  return {
    campaignId: id,
    pausedRecipients: result.rowCount ?? 0,
    status: "PAUSED",
  };
}
export async function resumeCampaign(
  pool: Pool,
  userId: string,
  orgId: string,
  id: string,
  scheduledAt: string | null | undefined,
  options: MarketingOptions,
): Promise<Row> {
  const campaign = await requireCampaign(pool, orgId, id);
  if (campaign.status !== "PAUSED")
    throw bad("Only paused campaigns can be resumed");
  const recipients = (await pool.query(SQL.resume_campaign[0], [id])).rows.map(
    (row) => row.id,
  );
  if (!recipients.length)
    throw bad("Campaign has no paused recipients to resume");
  const when = parseScheduledAt(scheduledAt) ?? campaign.scheduled_at,
    scheduled = when !== null && when > new Date();
  if (!(await pool.query(SQL.resume_campaign[1], [recipients])).rowCount)
    throw bad("No paused recipients were queued for resume");
  await pool.query(SQL.resume_campaign[2], [
    scheduled ? "SCHEDULED" : "SENDING",
    when?.toISOString() ?? null,
    id,
  ]);
  await publishCampaignUpdated(pool, userId, id, options);
  return {
    campaignId: id,
    resumedRecipients: recipients.length,
    status: scheduled ? "SCHEDULED" : "SENDING",
  };
}
export async function cancelCampaign(
  pool: Pool,
  userId: string,
  orgId: string,
  id: string,
  options: MarketingOptions,
): Promise<Row> {
  await requireCampaign(pool, orgId, id);
  const result = await pool.query(SQL.cancel_campaign[0], [id]);
  await pool.query(SQL.cancel_campaign[1], [id]);
  await recomputeCampaignStats(pool, id);
  await publishCampaignUpdated(pool, userId, id, options);
  return {
    campaignId: id,
    cancelledRecipients: result.rowCount ?? 0,
    status: "FAILED",
  };
}
export async function retryFailedCampaign(
  pool: Pool,
  orgId: string,
  id: string,
  options: MarketingOptions,
): Promise<Row> {
  const campaign = await requireCampaign(pool, orgId, id);
  if (["SENDING", "SCHEDULED"].includes(campaign.status))
    throw bad("Pause the active campaign before retrying failed recipients");
  const count = await transaction(pool, async (tx) => {
    const recipients = (await tx.query(SQL.retry_failed_campaign[0], [id]))
      .rows;
    if (!recipients.length)
      throw bad("This campaign has no failed recipients to retry");
    const now = new Date();
    for (const recipient of recipients)
      await analytics.enqueueRecipientRetry(
        tx,
        orgId,
        id,
        recipient.id,
        "whatsapp",
        "meta",
        recipient.attempt_number,
        "manual",
        now,
      );
    await tx.query(SQL.retry_failed_campaign[1], [id]);
    return recipients.length;
  });
  await recomputeCampaignStats(pool, id);
  await publishCampaignUpdated(pool, campaign.user_id, id, options);
  return { campaignId: id, retriedRecipients: count, status: "SENDING" };
}
export async function repairCampaignStatus(
  pool: Pool,
  userId: string,
  orgId: string,
  id: string,
  options: MarketingOptions,
): Promise<Row> {
  const previous = await requireCampaign(pool, orgId, id);
  await recomputeCampaignStats(pool, id);
  const campaign = await requireCampaign(pool, orgId, id);
  await publishCampaignUpdated(pool, userId, id, options);
  return {
    campaignId: id,
    repaired: true,
    previousStatus: previous.status,
    status: campaign.status,
    totalRecipients: campaign.total_recipients,
    sentCount: campaign.sent_count,
    deliveredCount: campaign.delivered_count,
    readCount: campaign.read_count,
    failedCount: campaign.failed_count,
    blockedCount: campaign.blocked_count,
    unsubscribedCount: campaign.unsubscribed_count,
    completedAt: campaign.completed_at,
  };
}
export async function deleteCampaign(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<Row> {
  const campaign = await requireCampaign(pool, orgId, id);
  if (["SENDING", "SCHEDULED"].includes(campaign.status))
    throw bad("Cannot delete an active campaign. Pause or cancel it first.");
  await pool.query(SQL.delete_campaign[0], [id, orgId]);
  return { deleted: true, campaignId: id };
}
export async function sendMoreCampaign(
  pool: Pool,
  userId: string,
  orgId: string,
  id: string,
  batchSize: number | null | undefined,
  excludedIds: string[],
  options: MarketingOptions,
): Promise<Row> {
  const campaign = await requireCampaign(pool, orgId, id),
    queued = BigInt(
      Object.values(
        (await pool.query(SQL.send_more_campaign[0], [id])).rows[0]!,
      )[0] as string,
    );
  if (
    !["COMPLETED", "FAILED", "PAUSED"].includes(campaign.status) &&
    !(campaign.status === "SENDING" && queued === 0n)
  )
    throw bad(
      "Can only add recipients to completed, failed, paused, or idle sending campaigns",
    );
  const size =
      batchSize != null && batchSize > 0
        ? batchSize
        : (campaign.default_batch_size ?? 200),
    ids = (await pool.query(SQL.send_more_campaign[1], [id])).rows.map(
      (row) => row.contactId as string,
    );
  if (!ids.length)
    throw bad("This campaign has no pending recipients left for another batch");
  const excluded = new Set(excludedIds),
    selected = ids.filter((id) => !excluded.has(id)).slice(0, size),
    skipped = ids.filter((id) => excluded.has(id)).length;
  if (excluded.size)
    await pool.query(SQL.send_more_campaign[2], [id, [...excluded]]);
  if (!selected.length)
    throw bad("No pending recipients selected for this batch");
  const result = await pool.query(SQL.send_more_campaign[3], [id, selected]);
  if (!result.rowCount) {
    await recomputeCampaignStats(pool, id);
    await publishCampaignUpdated(pool, userId, id, options);
    throw bad("No pending recipients were queued for this batch");
  }
  await pool.query(SQL.send_more_campaign[4], [id]);
  await publishCampaignUpdated(pool, userId, id, options);
  return {
    campaignId: id,
    queuedRecipients: result.rowCount,
    skippedManual: skipped,
    status: "SENDING",
  };
}
export async function recomputeCampaignStats(
  pool: Pool,
  id: string,
): Promise<void> {
  const [rows, total] = await Promise.all([
    pool.query(SQL.recompute_campaign_stats[0], [id]),
    pool.query(SQL.recompute_campaign_stats[1], [id]),
  ]);
  const counts = new Map(
    rows.rows.map((row) => [row.status, Number(row.count) | 0]),
  );
  const n = (key: string) => counts.get(key) ?? 0;
  if (!(await pool.query(SQL.recompute_campaign_stats[2], [id])).rows.length)
    return;
  await pool.query(SQL.recompute_campaign_stats[3], [
    Number(Object.values(total.rows[0]!)[0]) | 0,
    n("SENT") + n("DELIVERED") + n("READ"),
    n("DELIVERED") + n("READ"),
    n("READ"),
    n("FAILED"),
    n("BLOCKED"),
    n("UNSUBSCRIBED"),
    n("QUEUED") + n("PROCESSING"),
    id,
  ]);
}
export function buildBodyParameters(
  contact: WhatsappContactRow,
  mappings: unknown[] | null | undefined,
): string[] {
  return (mappings ?? []).map((raw) => {
    const value = raw !== null && typeof raw === "object" ? (raw as Row) : {},
      source = typeof value.source === "string" ? value.source : "contact",
      key = typeof value.key === "string" ? value.key : "";
    if (source === "static") return key;
    switch (key) {
      case "fullName":
      case "name":
        return contact.full_name ?? "";
      case "phone":
        return contact.phone;
      case "location":
        return contact.location ?? "";
      case "tags":
        return contact.tags.join(", ");
      default:
        return metadataString(contact.metadata, key);
    }
  });
}
export async function sendMarketingTemplate(
  phoneNumberId: string,
  token: string,
  phone: string,
  name: string,
  language: string,
  parameters: string[],
  options: ProviderOptions,
): Promise<[string, unknown]> {
  const payload = {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name,
      language: { code: language },
      components: parameters.length
        ? [
            {
              type: "body",
              parameters: parameters.map((text) => ({ type: "text", text })),
            },
          ]
        : null,
    },
  };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(
      `${options.graphBase ?? GRAPH_BASE}/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(
          envInteger(options.config, "WHATSAPP_HTTP_TIMEOUT_MS", 30000, true),
        ),
      },
    );
  } catch (error) {
    throw providerRequestError(error);
  }
  let raw: Row | null = null;
  try {
    raw = parseSerdeValueJson(await response.text()) as Row;
  } catch {}
  if (!response.ok)
    throw bad(
      `WhatsApp Cloud API send failed (${response.status} ${response.statusText}): ${typeof raw?.error?.message === "string" ? raw.error.message : "Unknown error"}`,
    );
  const id = raw?.messages?.[0]?.id;
  if (typeof id !== "string")
    throw internal("WhatsApp Cloud API did not return a message id");
  return [id, raw];
}
export function errorDisplay(error: unknown): string {
  if (error instanceof Error && "status" in error) {
    const status = (
      error as {
        status: number;
      }
    ).status;
    return `${({ 400: "bad request", 401: "unauthorized", 403: "forbidden", 404: "not found", 409: "conflict", 429: "too many requests", 500: "internal", 502: "bad gateway", 503: "service unavailable", 504: "gateway timeout" } as Row)[status] ?? "upstream"}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
export function parseFailureDetails(
  error: unknown,
): [string | null, string, boolean] {
  const message = errorDisplay(error),
    code = message.split("(#")[1]?.split(")")[0]?.trim() ?? null;
  return [
    code,
    message,
    ["131026", "131048"].includes(code ?? "") ||
      message.toLowerCase().includes("blocked"),
  ];
}
export async function claimQueuedCampaignRecipient(
  pool: Pool,
  id: string,
): Promise<boolean> {
  return (
    (await pool.query(SQL.claim_queued_campaign_recipient[0], [id]))
      .rowCount === 1
  );
}
export async function releaseProcessingCampaignRecipient(
  pool: Pool,
  id: string,
): Promise<void> {
  await pool.query(SQL.release_processing_campaign_recipient[0], [id]);
}
export async function recoverStuckProcessingCampaignRecipients(
  pool: Pool,
  options: MarketingOptions,
): Promise<Row[]> {
  const cutoff = new Date(
    Date.now() -
      envInteger(
        options.config,
        "WHATSAPP_CAMPAIGN_PROCESSING_TIMEOUT_SECONDS",
        120,
      ) *
        1000,
  );
  return (
    await pool.query({
      text: SQL.recover_stuck_processing_campaign_recipients[0],
      values: [cutoff.toISOString()],
      rowMode: "array",
    })
  ).rows.map((row) => ({ userId: row[0], id: row[1], recipientId: row[2] }));
}
export async function processClaimedCampaignRecipient(
  pool: Pool,
  id: string,
  options: MarketingOptions,
): Promise<[string, string] | null> {
  const recipient = (
    await pool.query(SQL.process_claimed_campaign_recipient[0], [id])
  ).rows[0];
  if (!recipient || recipient.status !== "PROCESSING") return null;
  const campaign = (
    await pool.query(SQL.process_claimed_campaign_recipient[1], [
      recipient.campaign_id,
    ])
  ).rows[0];
  if (!campaign) throw missing("Campaign not found");
  const orgId = campaign.org_id;
  if (orgId === null) throw internal("Campaign is not assigned to a workspace");
  const contact = await selectCampaignContactRow(pool, orgId, id);
  if (!contact) throw missing("Campaign contact not found");
  const changed: [string, string] = [campaign.user_id, recipient.campaign_id];
  const existing = (
    await pool.query(SQL.process_claimed_campaign_recipient[2], [
      recipient.campaign_id,
      contact.id,
    ])
  ).rows[0]?.whatsappMessageId;
  if (existing != null) {
    await transaction(pool, async (tx) => {
      await tx.query(SQL.process_claimed_campaign_recipient[3], [existing, id]);
      await analytics.enqueueRecipientSent(
        tx,
        orgId,
        recipient.campaign_id,
        id,
        "whatsapp",
        "meta",
        new Date(),
      );
    });
    await recomputeCampaignStats(pool, recipient.campaign_id);
    return changed;
  }
  const [reason, eligible] = contactEligible(contact, options.config);
  if (!eligible) {
    await transaction(pool, async (tx) => {
      await tx.query(SQL.process_claimed_campaign_recipient[4], [
        reason === "excluded" ? "UNSUBSCRIBED" : "SKIPPED",
        reason,
        "Recipient no longer matches marketing safety requirements",
        id,
      ]);
      await analytics.enqueueRecipientSuppressed(
        tx,
        orgId,
        recipient.campaign_id,
        id,
        "whatsapp",
        "meta",
        reason === "excluded"
          ? "contact_excluded"
          : ["not_opted_in", "cooldown"].includes(reason)
            ? reason
            : "policy_guard",
        new Date(),
      );
    });
    await recomputeCampaignStats(pool, recipient.campaign_id);
    return changed;
  }
  try {
    await requireCapability(pool, orgId, "feature.campaigns.send");
  } catch (error) {
    await transaction(pool, async (tx) => {
      await tx.query(SQL.process_claimed_campaign_recipient[5], [
        errorDisplay(error),
        id,
      ]);
      await analytics.enqueueRecipientFailed(
        tx,
        orgId,
        recipient.campaign_id,
        id,
        "whatsapp",
        "meta",
        "entitlement_required",
        new Date(),
      );
    });
    await recomputeCampaignStats(pool, recipient.campaign_id);
    return changed;
  }
  const connection = await getConnectionRowForOrg(
    pool,
    orgId,
    campaign.connection_id,
  );
  if (!connection) throw missing("Connection not found");
  const token = decryptSocialSecret(
      options.config,
      connection.access_token_encrypted,
    ),
    parameters = buildBodyParameters(
      contact,
      Array.isArray(campaign.variable_mappings)
        ? campaign.variable_mappings
        : null,
    ),
    request = {
      templateName: campaign.template_name,
      language: campaign.template_language,
      bodyParameters: parameters,
    };
  let result: [string, unknown];
  try {
    result = await sendMarketingTemplate(
      connection.phone_number_id,
      token,
      contact.phone,
      campaign.template_name,
      campaign.template_language,
      parameters,
      options,
    );
  } catch (error) {
    const [code, message, blocked] = parseFailureDetails(error),
      status = blocked ? "BLOCKED" : "FAILED";
    await transaction(pool, async (tx) => {
      await tx.query(SQL.process_claimed_campaign_recipient[9], [
        status,
        code,
        message,
        id,
      ]);
      await tx.query(SQL.process_claimed_campaign_recipient[10], [
        createId(),
        campaign.user_id,
        orgId,
        campaign.connection_id,
        campaign.id,
        id,
        contact.id,
        contact.phone,
        campaign.template_name,
        status,
        json(request),
        json({ error: errorDisplay(error) }),
        code,
        message,
      ]);
      if (blocked)
        await analytics.enqueueRecipientBlocked(
          tx,
          orgId,
          campaign.id,
          id,
          "whatsapp",
          "meta",
          "provider_blocked",
          new Date(),
        );
      else
        await analytics.enqueueRecipientFailed(
          tx,
          orgId,
          campaign.id,
          id,
          "whatsapp",
          "meta",
          "provider_rejected",
          new Date(),
        );
    });
    await recomputeCampaignStats(pool, recipient.campaign_id);
    return changed;
  }
  const [messageId, raw] = result;
  await transaction(pool, async (tx) => {
    await tx.query(SQL.process_claimed_campaign_recipient[6], [messageId, id]);
    await tx.query(SQL.process_claimed_campaign_recipient[7], [contact.id]);
    await tx.query(SQL.process_claimed_campaign_recipient[8], [
      createId(),
      campaign.user_id,
      orgId,
      campaign.connection_id,
      campaign.id,
      id,
      contact.id,
      contact.phone,
      campaign.template_name,
      messageId,
      json(request),
      json(raw),
    ]);
    await analytics.enqueueRecipientSent(
      tx,
      orgId,
      campaign.id,
      id,
      "whatsapp",
      "meta",
      new Date(),
    );
  });
  await recordMeterUsage(
    pool,
    orgId,
    "campaign_recipients",
    1,
    "campaign_recipient",
    id,
    `reach-campaign-recipient:${id}`,
  );
  await recomputeCampaignStats(pool, recipient.campaign_id);
  return changed;
}
export async function processQueuedCampaignRecipients(
  pool: Pool,
  limit: number,
  options: MarketingOptions,
): Promise<number> {
  const changed = new Map<string, [string, string]>();
  const remember = (userId: string, id: string) =>
    changed.set(`${userId}\0${id}`, [userId, id]);
  for (const row of await recoverStuckProcessingCampaignRecipients(
    pool,
    options,
  ))
    remember(row.userId, row.id);
  const ids = (
    await pool.query(SQL.process_queued_campaign_recipients[0], [
      Math.max(1, limit),
    ])
  ).rows.map((row) => row.id);
  if (!ids.length) {
    for (const row of (
      await pool.query(SQL.reconcile_active_campaigns_without_queue[0])
    ).rows)
      remember(row.userId, row.id);
    for (const [user, id] of changed.values())
      try {
        await publishCampaignUpdated(pool, user, id, options);
      } catch {}
    return 0;
  }
  let count = 0;
  for (const id of ids) {
    if (!(await claimQueuedCampaignRecipient(pool, id))) continue;
    try {
      const result = await processClaimedCampaignRecipient(pool, id, options);
      if (result) {
        remember(...result);
        count++;
      }
    } catch (error) {
      (options.logger ?? console).error({
        event: "queue.item.failed",
        worker: "whatsapp_campaigns",
        recipient_id: id,
        error_type: error instanceof Error ? error.name : "unknown",
      });
      try {
        await releaseProcessingCampaignRecipient(pool, id);
      } catch (releaseError) {
        (options.logger ?? console).warn({
          event: "operation.failed",
          operation: "whatsapp_campaigns.release_claim",
          recipient_id: id,
          error_type:
            releaseError instanceof Error ? releaseError.name : "unknown",
        });
      }
      throw error;
    }
  }
  for (const [user, id] of changed.values())
    try {
      await publishCampaignUpdated(pool, user, id, options);
    } catch {}
  return count;
}
