import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { extractUser, resolveActiveOrgId } from "../identity/session.js";
import { requireAdmin } from "../services/orgs.js";
import { requireCapability } from "../services/billing.js";
import { publishWhatsappEvent } from "../services/realtime.js";
import * as contacts from "../services/whatsapp/contacts.js";
import * as templates from "../services/whatsapp/templates.js";
import * as campaigns from "../services/whatsapp/campaigns.js";
import {
  bad,
  parseBoolLike,
  type MarketingOptions,
} from "../services/whatsapp/common.js";
import type {
  Row,
  WhatsappContactListQuery,
} from "../services/whatsapp/types.js";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { queryI64, queryU64, typedQuery } from "../typed-query.js";
function object(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw bad("Invalid request");
  return value as Row;
}
function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw bad("Invalid request");
  return value;
}
function integer(value: unknown): number | null {
  if (value == null) return null;
  if (
    value instanceof SerdeFloat ||
    !["number", "bigint"].includes(typeof value) ||
    !Number.isInteger(Number(value)) ||
    BigInt(value as number | bigint) < -2147483648n ||
    BigInt(value as number | bigint) > 2147483647n
  )
    throw bad("Invalid request");
  return Number(value);
}
function strings(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((value) => typeof value !== "string"))
    throw bad("Invalid request");
  return value;
}
function bool(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value !== "boolean") throw bad("Invalid request");
  return value;
}
export function contactUpdateInput(body: unknown) {
  const row = object(body);
  return {
    full_name: text(row.fullName),
    phone: text(row.phone),
    location: text(row.location),
    tags: strings(row.tags),
    notes: text(row.notes),
    list_label: text(row.listLabel),
    metadata: row.metadata ?? null,
    opt_in: bool(row.optIn),
    excluded: bool(row.excluded),
  };
}
export function contactListQuery(query: unknown): WhatsappContactListQuery {
  const row = typedQuery<{
    q?: string;
    optIn?: string;
    excluded?: string;
    tag?: string;
    location?: string;
    listLabel?: string;
    limit?: string;
    cursor?: string;
  }>(query, [
    "q",
    "optIn",
    "excluded",
    "tag",
    "location",
    "listLabel",
    "limit",
    "cursor",
  ]);
  return {
    q: row.q,
    opt_in: row.optIn,
    excluded: row.excluded,
    tag: row.tag,
    location: row.location,
    list_label: row.listLabel,
    limit: queryI64(row.limit, "limit") ?? null,
    cursor: queryU64(row.cursor, "cursor") ?? null,
  };
}
export function campaignActionCapability(action: string | null): string {
  return ["resume", "retry_failed", "send_more"].includes(action ?? "")
    ? "feature.campaigns.send"
    : "feature.campaigns.manage";
}
export function campaignCreateInput(body: unknown) {
  const row = object(body),
    audience = row.audience == null ? null : object(row.audience);
  return {
    name: text(row.name),
    description: text(row.description),
    connection_id: text(row.connectionId),
    template_id: text(row.templateId),
    recipient_ids: strings(row.recipientIds),
    excluded_contact_ids: strings(row.excludedContactIds),
    list_label: text(row.listLabel),
    batch_size: integer(row.batchSize),
    scheduled_at: text(row.scheduledAt),
    variable_mappings: row.variableMappings ?? null,
    audience: audience
      ? {
          tags: strings(audience.tags),
          location: text(audience.location),
          search: text(audience.search),
          list_label: text(audience.listLabel),
          opt_in_status: text(audience.optInStatus),
          excluded_status: text(audience.excludedStatus),
          cooldown_status: text(audience.cooldownStatus),
        }
      : null,
  };
}
export const WHATSAPP_MARKETING_ROUTES = [
  ["GET", "/api/whatsapp/contacts"],
  ["PATCH", "/api/whatsapp/contacts/:id"],
  ["POST", "/api/whatsapp/contacts/import"],
  ["GET", "/api/whatsapp/contacts/lists/:label/export"],
  ["PATCH", "/api/whatsapp/contacts/lists/:label"],
  ["DELETE", "/api/whatsapp/contacts/lists/:label"],
  ["GET", "/api/whatsapp/templates"],
  ["POST", "/api/whatsapp/templates"],
  ["POST", "/api/whatsapp/connections/:id/templates/sync"],
  ["GET", "/api/whatsapp/campaigns"],
  ["POST", "/api/whatsapp/campaigns"],
  ["POST", "/api/whatsapp/campaigns/preflight"],
  ["GET", "/api/whatsapp/campaigns/:id"],
  ["GET", "/api/whatsapp/campaigns/:id/summary"],
  ["POST", "/api/whatsapp/campaigns/:id/launch"],
  ["PATCH", "/api/whatsapp/campaigns/:id"],
  ["DELETE", "/api/whatsapp/campaigns/:id"],
] as const;
/** Connections, webhooks, inbox and calls have separate registrars and owners. */
export function registerWhatsappMarketingRoutes(
  app: FastifyInstance,
  core: CoreContext,
): void {
  const options: MarketingOptions = {
    config: core.config,
    publishEvent: (org, event) => publishWhatsappEvent(core, org, event),
    logger: app.log,
  };
  const scope = async (request: FastifyRequest, capability?: string) => {
    const user = await extractUser(request, core),
      org = await resolveActiveOrgId(request, core, user.id);
    if (capability) await requireCapability(core.pool, org, capability);
    return { userId: user.id, orgId: org };
  };
  const id = (request: FastifyRequest) =>
    (
      request.params as {
        id: string;
      }
    ).id;
  const label = (request: FastifyRequest) =>
    (
      request.params as {
        label: string;
      }
    ).label;
  app.get("/api/whatsapp/contacts", async (request) => {
    const query = contactListQuery(request.query);
    const ctx = await scope(request);
    return contacts.listContacts(
      core.pool,
      ctx.orgId,
      query,
    );
  });
  app.patch("/api/whatsapp/contacts/:id", async (request) => {
    const ctx = await scope(request);
    return contacts.updateContact(
      core.pool,
      ctx.orgId,
      id(request),
      contactUpdateInput(request.body),
    );
  });
  app.post(
    "/api/whatsapp/contacts/import",
    {
      // The Rust multipart handler buffers the full CSV without a file-size
      // cap, so keep Fastify's overall parser from imposing its 2 MiB default.
      bodyLimit: Number.MAX_SAFE_INTEGER,
    },
    async (request) => {
      const ctx = await scope(request, "feature.campaigns.manage");
      let bytes: Buffer = Buffer.alloc(0),
        defaultOptIn = false,
        consentConfirmed = false,
        listLabel: string | null = null;
      for await (const part of request.parts({
        limits: { fileSize: Number.MAX_SAFE_INTEGER },
      })) {
        if (part.type === "file") {
          const content = await part.toBuffer();
          if (part.fieldname === "file") bytes = content;
        } else if (part.fieldname === "defaultOptIn")
          defaultOptIn = parseBoolLike(String(part.value)) ?? false;
        else if (part.fieldname === "consentConfirmed")
          consentConfirmed = parseBoolLike(String(part.value)) ?? false;
        else if (part.fieldname === "listLabel")
          listLabel = String(part.value).trim() || null;
      }
      return contacts.importContacts(core.pool, ctx.userId, ctx.orgId, {
        bytes,
        defaultOptIn,
        consentConfirmed,
        listLabel,
      });
    },
  );
  app.get(
    "/api/whatsapp/contacts/lists/:label/export",
    async (request, reply) => {
      const ctx = await scope(request),
        result = await contacts.exportContactList(
          core.pool,
          ctx.orgId,
          label(request),
        );
      return reply
        .type("text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          `attachment; filename="${result.filename}"`,
        )
        .header("Cache-Control", "private, max-age=60")
        .send(result.bytes);
    },
  );
  app.patch("/api/whatsapp/contacts/lists/:label", async (request) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return contacts.renameContactList(
      core.pool,
      ctx.orgId,
      label(request),
      text(object(request.body).nextLabel),
    );
  });
  app.delete("/api/whatsapp/contacts/lists/:label", async (request) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return contacts.deleteContactList(core.pool, ctx.orgId, label(request));
  });
  app.get("/api/whatsapp/templates", async (request) => {
    const query = typedQuery<{ status?: string }>(request.query, ["status"]);
    const ctx = await scope(request, "feature.templates.manage");
    return templates.listTemplates(
      core.pool,
      ctx.orgId,
      query.status ?? null,
    );
  });
  app.post("/api/whatsapp/templates", async (request, reply) => {
    const ctx = await scope(request, "feature.templates.manage"),
      body = object(request.body);
    return reply
      .code(201)
      .send(
        await templates.createTemplate(
          core.pool,
          ctx.userId,
          ctx.orgId,
          {
            connection_id: text(body.connectionId),
            template_name: text(body.templateName),
            language: text(body.language),
            category: text(body.category) ?? "MARKETING",
            header: text(body.header),
            body: text(body.body),
            footer: text(body.footer),
          },
          options,
        ),
      );
  });
  app.post("/api/whatsapp/connections/:id/templates/sync", async (request) => {
    const ctx = await scope(request);
    await requireAdmin(core.pool, ctx.orgId, ctx.userId);
    return templates.syncConnectionTemplates(
      core.pool,
      ctx.userId,
      ctx.orgId,
      id(request),
      options,
    );
  });
  app.get("/api/whatsapp/campaigns", async (request) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return campaigns.listCampaigns(core.pool, ctx.orgId);
  });
  app.post("/api/whatsapp/campaigns/preflight", async (request) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return campaigns.preflightCampaign(
      core.pool,
      ctx.orgId,
      campaignCreateInput(request.body),
      options,
    );
  });
  app.post("/api/whatsapp/campaigns", async (request, reply) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return reply
      .code(201)
      .send(
        await campaigns.createCampaign(
          core.pool,
          ctx.userId,
          ctx.orgId,
          campaignCreateInput(request.body),
          options,
        ),
      );
  });
  app.get("/api/whatsapp/campaigns/:id", async (request) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return campaigns.getCampaign(core.pool, ctx.orgId, id(request));
  });
  app.get("/api/whatsapp/campaigns/:id/summary", async (request) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return campaigns.getCampaignSummary(core.pool, ctx.orgId, id(request));
  });
  app.post("/api/whatsapp/campaigns/:id/launch", async (request) => {
    const ctx = await scope(request, "feature.campaigns.send"),
      body = object(request.body);
    return campaigns.launchCampaign(
      core.pool,
      ctx.userId,
      ctx.orgId,
      id(request),
      Object.hasOwn(body, "scheduledAt") ? text(body.scheduledAt) : undefined,
      integer(body.batchSize),
      options,
    );
  });
  app.patch("/api/whatsapp/campaigns/:id", async (request) => {
    const body = object(request.body),
      action = text(body.action);
    const ctx = await scope(request, campaignActionCapability(action));
    if (action === null) throw bad("Action is required");
    switch (action) {
      case "pause":
        return campaigns.pauseCampaign(
          core.pool,
          ctx.userId,
          ctx.orgId,
          id(request),
          options,
        );
      case "resume":
        return campaigns.resumeCampaign(
          core.pool,
          ctx.userId,
          ctx.orgId,
          id(request),
          Object.hasOwn(body, "scheduledAt") ? text(body.scheduledAt) : undefined,
          options,
        );
      case "cancel":
        return campaigns.cancelCampaign(
          core.pool,
          ctx.userId,
          ctx.orgId,
          id(request),
          options,
        );
      case "retry_failed":
        return campaigns.retryFailedCampaign(
          core.pool,
          ctx.orgId,
          id(request),
          options,
        );
      case "repair_status":
        return campaigns.repairCampaignStatus(
          core.pool,
          ctx.userId,
          ctx.orgId,
          id(request),
          options,
        );
      case "send_more":
        return campaigns.sendMoreCampaign(
          core.pool,
          ctx.userId,
          ctx.orgId,
          id(request),
          integer(body.batchSize),
          strings(body.excludedContactIds) ?? [],
          options,
        );
      default:
        throw bad("Unsupported action");
    }
  });
  app.delete("/api/whatsapp/campaigns/:id", async (request) => {
    const ctx = await scope(request, "feature.campaigns.manage");
    return campaigns.deleteCampaign(core.pool, ctx.orgId, id(request));
  });
}
