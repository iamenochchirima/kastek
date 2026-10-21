import { z } from "zod";
import type { PoolClient } from "pg";
import type { ActionScope } from "../../contracts/connections";
import type { ChannelSendRequest } from "../../contracts/channel-adapters";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import type { ChannelStore } from "./channel-store";

/** Retrieved 2026-10-21: https://business.whatsapp.com/policy section 2. No human-response exception is implied. */
export const whatsappCustomerServiceWindowMs = 24 * 60 * 60 * 1000;
export const whatsappPolicySource = "https://business.whatsapp.com/policy";
const fail = (code: string, status = 409) => new PlatformError(code, status, "WhatsApp message is unavailable");
const text = z.string().min(1).max(4096);
const parameters = z.strictObject({ header: z.array(text).max(32).default([]), body: z.array(text).max(32).default([]) });
const category = z.enum(["UTILITY", "MARKETING", "AUTHENTICATION"]);
const nativeTemplate = z.object({ id: z.string().min(1).max(512), name: z.string().regex(/^[a-z0-9_]{1,512}$/), language: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  status: z.string(), category, components: z.array(z.record(z.string(), z.unknown())).max(32) });
type NativeTemplate = z.infer<typeof nativeTemplate>;
const authorizationSchema = z.strictObject({ templateId: z.string(), definitionDigest: z.string().regex(/^[a-f0-9]{64}$/), consentRevision: z.number().int().positive(),
  payloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
  conversationId: z.uuid(), ownershipGeneration: z.string().regex(/^\d+$/), connectionRevision: z.number().int().positive(), credentialRevision: z.number().int().positive() });
export type WhatsappTemplateAuthorization = z.infer<typeof authorizationSchema>;
export interface PreparedWhatsappTemplate { template: NonNullable<ChannelSendRequest["template"]>; preview: string; authorization: WhatsappTemplateAuthorization }

function render(definition: NativeTemplate, raw: z.infer<typeof parameters>): { template: PreparedWhatsappTemplate["template"]; preview: string } {
  const components: { type: string; parameters: { type: "text"; text: string }[] }[] = [], sections: string[] = [], used = new Set<string>();
  for (const part of definition.components) {
    const type = String(part.type).toUpperCase();
    if (!["HEADER", "BODY", "FOOTER"].includes(type) || type === "HEADER" && part.format !== "TEXT" || typeof part.text !== "string" || used.has(type)) throw fail("WHATSAPP_TEMPLATE_FORMAT_UNSUPPORTED");
    used.add(type); const values = type === "HEADER" ? raw.header : type === "BODY" ? raw.body : [];
    const slots = [...part.text.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1]));
    const count = slots.length ? Math.max(...slots) : 0;
    if (count !== values.length || new Set(slots).size !== count || slots.some(slot => slot < 1)) throw fail("WHATSAPP_TEMPLATE_PARAMETERS_INVALID", 400);
    if (/\{\{|\}\}/.test(part.text.replace(/\{\{\d+\}\}/g, ""))) throw fail("WHATSAPP_TEMPLATE_FORMAT_UNSUPPORTED");
    const rendered = part.text.replace(/\{\{(\d+)\}\}/g, (_match, index) => values[Number(index) - 1]!);
    sections.push(rendered); if (values.length) components.push({ type: type.toLowerCase(), parameters: values.map(value => ({ type: "text", text: value })) });
  }
  if (!used.has("BODY") || !used.has("HEADER") && raw.header.length || Buffer.byteLength(sections.join("\n\n")) > 32768) throw fail("WHATSAPP_TEMPLATE_PARAMETERS_INVALID", 400);
  return { template: { name: definition.name, language: definition.language, ...(components.length ? { components } : {}) }, preview: sections.join("\n\n") };
}

/** Staff-only template preparation and dispatch-time revalidation. This service never sends a message. */
export class WhatsappTemplates {
  constructor(private readonly channels: ChannelStore, private readonly transport: typeof fetch, private readonly pageLimit = 20) {
    z.number().int().min(1).max(100).parse(pageLimit);
  }
  private async conversation(db: PoolClient, scope: ActionScope, id: string, expectedRevision?: string) {
    await requireActionMember(db, scope);
    const row = (await db.query(`SELECT c.*,d.connection_id FROM agents_platform.customer_conversations c
      JOIN agents_platform.channel_deployments d ON d.id=c.channel_deployment_id
      WHERE c.organization_id=$1 AND c.id=$2 AND c.channel_kind='whatsapp' FOR SHARE OF c,d`, [scope.organizationId, id])).rows[0];
    if (!row) throw fail("INBOX_NOT_FOUND", 404);
    if (expectedRevision !== undefined && String(row.revision) !== expectedRevision) throw fail("INBOX_CONFLICT");
    return row;
  }
  async recordConsent(scope: ActionScope, raw: unknown) {
    const input = z.strictObject({ conversationId: z.uuid(), expectedRevision: z.string().regex(/^\d+$/), expectedConsentRevision: z.number().int().nonnegative(),
      granted: z.boolean(), categories: z.array(category).min(1).max(3), evidence: z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("customer_message"), messageId: z.uuid() }),
        z.strictObject({ kind: z.literal("external_record"), reference: z.string().trim().min(1).max(2048) }),
      ]) }).parse(raw);
    return transaction(this.channels.pool, async db => {
      const row = await this.conversation(db, scope, input.conversationId, input.expectedRevision);
      if (row.state !== "human_owned" || row.assignee_account_id !== scope.accountId) throw fail("ACCESS_DENIED", 403);
      if (input.evidence.kind === "customer_message" && !(await db.query("SELECT 1 FROM agents_platform.customer_messages WHERE id=$1 AND conversation_id=$2 AND author_kind='visitor'", [input.evidence.messageId, row.id])).rowCount) throw fail("WHATSAPP_CONSENT_EVIDENCE_INVALID", 400);
      const values = [scope.organizationId, row.connection_id, row.external_sender_id, input.granted, [...new Set(input.categories)], input.evidence, scope.accountId];
      const result = input.expectedConsentRevision === 0
        ? await db.query(`INSERT INTO agents_platform.channel_contact_consents(organization_id,connection_id,recipient_id,revision,granted,categories,evidence,recorded_by)
          VALUES($1,$2,$3,1,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING revision,granted,categories,recorded_at`, values)
        : await db.query(`UPDATE agents_platform.channel_contact_consents SET revision=revision+1,granted=$4,categories=$5,evidence=$6,recorded_by=$7,recorded_at=now()
          WHERE organization_id=$1 AND connection_id=$2 AND recipient_id=$3 AND revision=$8 RETURNING revision,granted,categories,recorded_at`, [...values, input.expectedConsentRevision]);
      if (!result.rowCount) throw fail("WHATSAPP_CONSENT_CHANGED"); return result.rows[0];
    });
  }
  async consent(scope: ActionScope, conversationId: string) {
    z.uuid().parse(conversationId);
    return transaction(this.channels.pool, async db => { const row = await this.conversation(db, scope, conversationId);
      return (await db.query("SELECT revision,granted,categories,recorded_at FROM agents_platform.channel_contact_consents WHERE organization_id=$1 AND connection_id=$2 AND recipient_id=$3", [scope.organizationId, row.connection_id, row.external_sender_id])).rows[0] ?? { revision: 0, granted: false, categories: [] }; });
  }
  private async context(connectionId: string, organizationId: string) {
    const row = (await this.channels.pool.query("SELECT * FROM agents_platform.channel_connections WHERE organization_id=$1 AND id=$2 AND kind='whatsapp' AND state='active'", [organizationId, connectionId])).rows[0];
    if (row?.metadata.evaluationFixture || row?.metadata.evaluationTrialId) throw fail("CHANNEL_EVALUATION_FIXTURE_LIVE_IO_DENIED", 403);
    if (!row || !/^v\d+\.\d+$/.test(row.metadata.apiVersion ?? "") || !/^[A-Za-z0-9_-]+$/.test(row.metadata.wabaId ?? "")) throw fail("WHATSAPP_CONNECTION_UNAVAILABLE");
    const credentials = await this.channels.resolveCredential({ organizationId, connectionId, expectedRevision: row.revision, credentialRevision: row.credential_revision });
    return { row, credential: credentials.accessToken! };
  }
  private async page(connectionId: string, organizationId: string, cursor?: string) {
    const { row, credential } = await this.context(connectionId, organizationId), url = new URL(`https://graph.facebook.com/${row.metadata.apiVersion}/${row.metadata.wabaId}/message_templates`);
    url.searchParams.set("fields", "id,name,status,language,category,components"); if (cursor) url.searchParams.set("after", z.string().min(1).max(2048).parse(cursor));
    let response: Response; try { response = await this.transport(url.href, { redirect: "error", headers: { authorization: `Bearer ${credential}` } }); } catch { throw fail("WHATSAPP_TEMPLATES_UNAVAILABLE", 502); }
    let data: any; try { data = await response.json(); } catch { throw fail("WHATSAPP_TEMPLATES_UNAVAILABLE", 502); }
    if (!response.ok || data.error || !Array.isArray(data.data)) throw fail("WHATSAPP_TEMPLATES_UNAVAILABLE", 502);
    const templates = data.data.map((item: unknown) => nativeTemplate.parse(item)) as NativeTemplate[];
    const nextCursor = data.paging?.next ? z.string().min(1).max(2048).parse(data.paging?.cursors?.after) : null;
    if (nextCursor === cursor) throw fail("WHATSAPP_TEMPLATE_CURSOR_INVALID", 502);
    return { templates, nextCursor, row };
  }
  async list(scope: ActionScope, raw: unknown) {
    const input = z.strictObject({ connectionId: z.uuid(), cursor: z.string().min(1).max(2048).optional() }).parse(raw); await this.channels.get(scope, input.connectionId);
    const page = await this.page(input.connectionId, scope.organizationId, input.cursor);
    return { templates: page.templates.filter(item => item.status === "APPROVED").map(item => {
      const supported = item.components.some(part => part.type === "BODY") && item.components.every(part => ["HEADER", "BODY", "FOOTER"].includes(String(part.type)) && (part.type !== "HEADER" || part.format === "TEXT") && typeof part.text === "string");
      return { ...item, supported };
    }), nextCursor: page.nextCursor };
  }
  private async find(connectionId: string, organizationId: string, id: string): Promise<NativeTemplate> {
    let cursor: string | undefined; const seen = new Set<string>();
    for (let index = 0; index < this.pageLimit; index++) {
      const page = await this.page(connectionId, organizationId, cursor), found = page.templates.find(item => item.id === id);
      if (found) { if (found.status !== "APPROVED") throw fail("WHATSAPP_TEMPLATE_NOT_APPROVED"); return found; }
      if (!page.nextCursor) break; if (seen.has(page.nextCursor)) throw fail("WHATSAPP_TEMPLATE_CURSOR_INVALID", 502); seen.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw fail("WHATSAPP_TEMPLATE_UNAVAILABLE");
  }
  async prepare(scope: ActionScope, raw: unknown): Promise<PreparedWhatsappTemplate> {
    const input = z.strictObject({ conversationId: z.uuid(), expectedRevision: z.string().regex(/^\d+$/), templateId: z.string().min(1).max(512), parameters }).parse(raw);
    const row = await transaction(this.channels.pool, db => this.conversation(db, scope, input.conversationId, input.expectedRevision));
    if (row.state !== "human_owned" || row.assignee_account_id !== scope.accountId) throw fail("ACCESS_DENIED", 403);
    const definition = await this.find(row.connection_id, scope.organizationId, input.templateId), rendered = render(definition, input.parameters), consent = await this.consent(scope, row.id);
    if (!consent.granted || !consent.categories.includes(definition.category)) throw fail("WHATSAPP_CUSTOMER_OPT_IN_REQUIRED");
    const { row: connection } = await this.context(row.connection_id, scope.organizationId);
    return { ...rendered, authorization: { templateId: definition.id, definitionDigest: requestDigest(definition), payloadDigest: requestDigest(rendered.template), consentRevision: consent.revision,
      conversationId: row.id, ownershipGeneration: String(row.ownership_generation), connectionRevision: connection.revision, credentialRevision: connection.credential_revision } };
  }
  async assertDispatch(input: { organizationId: string; connectionId: string; conversationId: string; ownershipGeneration: string; messageBody: string; request: ChannelSendRequest & { templateAuthorization?: unknown } }): Promise<void> {
    const authorization = authorizationSchema.parse(input.request.templateAuthorization);
    if (!input.request.template || input.request.text || input.request.attachments?.length || authorization.conversationId !== input.conversationId || authorization.ownershipGeneration !== input.ownershipGeneration) throw fail("WHATSAPP_TEMPLATE_AUTHORITY_CHANGED");
    const definition = await this.find(input.connectionId, input.organizationId, authorization.templateId);
    if (requestDigest(definition) !== authorization.definitionDigest || definition.name !== input.request.template.name || definition.language !== input.request.template.language) throw fail("WHATSAPP_TEMPLATE_CHANGED");
    const parsed = parameters.parse({ header: [], body: [] });
    for (const raw of input.request.template.components ?? []) {
      const component = z.strictObject({ type: z.enum(["header", "body"]), parameters: z.array(z.strictObject({ type: z.literal("text"), text })).max(32) }).parse(raw);
      if (parsed[component.type].length) throw fail("WHATSAPP_TEMPLATE_PARAMETERS_INVALID"); parsed[component.type] = component.parameters.map(item => item.text);
    }
    const rendered = render(definition, parsed);
    if (requestDigest(rendered.template) !== requestDigest(input.request.template) || authorization.payloadDigest !== requestDigest(rendered.template) || input.messageBody !== rendered.preview) throw fail("WHATSAPP_TEMPLATE_CHANGED");
    await transaction(this.channels.pool, async db => {
      const authority = await db.query(`SELECT 1 FROM agents_platform.customer_conversations c JOIN agents_platform.channel_deployments d ON d.id=c.channel_deployment_id
        JOIN agents_platform.channel_connections n ON n.id=d.connection_id JOIN agents_platform.channel_contact_consents s ON s.connection_id=n.id AND s.organization_id=n.organization_id AND s.recipient_id=c.external_sender_id
        WHERE c.organization_id=$1 AND c.id=$2 AND c.ownership_generation=$3 AND n.id=$4 AND n.state='active' AND d.state='active'
        AND n.revision=$5 AND n.credential_revision=$6 AND s.revision=$7 AND s.granted=true AND $8=ANY(s.categories)
        AND c.external_sender_id=$9 AND n.asset_id=$10 FOR SHARE OF c,d,n,s`, [input.organizationId, input.conversationId, input.ownershipGeneration, input.connectionId,
        authorization.connectionRevision, authorization.credentialRevision, authorization.consentRevision, definition.category, input.request.recipientId, input.request.assetId]);
      if (!authority.rowCount) throw fail("WHATSAPP_TEMPLATE_AUTHORITY_CHANGED");
    });
  }
}
