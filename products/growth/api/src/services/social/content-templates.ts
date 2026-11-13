import { createHash } from "node:crypto";
import { createId } from "@paralleldrive/cuid2";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../../db.js";
import { ApiError } from "../../error.js";
import type { RequestContext } from "../../identity/request-context.js";
import { isValidPlatform } from "./common.js";
import { platformMediaError, textLengthError } from "../../capabilities/content-batch.js";
import { getSocialPost } from "./posts.js";
import type { SocialPostUpsertRequest } from "./types.js";

type Db = Pick<Pool, "query"> | PoolClient;
export interface TemplateField { key: string; label: string; required?: boolean; defaultValue?: string }
export interface TemplateMedia { assetId: string; sortOrder?: number; altText?: string | null }
export interface TemplateVariantMedia extends TemplateMedia { crop?: Record<string, unknown> | null }
export interface TemplateVariant { platform: string; content: string; media?: TemplateVariantMedia[] }
export interface TemplatePlatformMedia { platform: string; media: TemplateVariantMedia[] }
export interface TemplateInput {
  name: string; description?: string | null; category?: string | null; content: string;
  channels: string[]; variants?: TemplateVariant[];
  fields?: TemplateField[]; media?: TemplateMedia[];
}
export interface ContentTemplate extends TemplateInput {
  id: string; orgId: string; revision: number; creatorId: string | null; updatedById: string | null;
  archivedAt: string | null; createdAt: string; updatedAt: string;
  media: TemplateMedia[]; fields: TemplateField[]; variants: TemplateVariant[];
}
export interface TemplateRenderInput {
  expectedRevision: number; values?: Record<string, string>; media?: TemplateMedia[];
  channelSelections?: Record<string, string>; primaryChannelId?: string;
}
function fail(code: string, message: string, status = 400): never { throw new ApiError(status, code, message); }
const digest = (value: unknown): string => createHash("sha256").update(canonicalJson(value)).digest("hex");
function text(value: unknown, label: string, maximum: number, required = false): string {
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim()))
    return fail("template_invalid", `${label} is invalid`);
  return value;
}
function placeholders(content: string): string[] {
  const keys: string[] = [];
  const rest = content.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g, (_, key: string) => { keys.push(key); return ""; });
  if (rest.includes("{{") || rest.includes("}}")) fail("template_invalid", "Use literal fields such as {{name}}");
  return keys;
}
export function validateTemplateInput(input: TemplateInput): TemplateInput {
  if (!input || typeof input !== "object") fail("template_invalid", "Template is required");
  const name = text(input.name, "Name", 240, true).trim();
  const content = text(input.content, "Content", 32768);
  const description = input.description == null ? null : text(input.description, "Description", 2000).trim();
  const category = input.category == null ? null : text(input.category, "Category", 120).trim();
  if (!Array.isArray(input.channels) || !input.channels.length || input.channels.length > 7 || input.channels.some(v => typeof v !== "string" || !isValidPlatform(v)) || new Set(input.channels).size !== input.channels.length)
    fail("template_invalid", "Choose supported platforms");
  const variants = input.variants ?? [];
  if (!Array.isArray(variants) || variants.length > 7 || variants.some(v => !v || typeof v !== "object") || new Set(variants.map(v => v.platform)).size !== variants.length) fail("template_invalid", "Versions are invalid");
  for (const v of variants) { if (!input.channels.includes(v.platform)) fail("template_invalid", "Version platform must be selected"); text(v.content, "Version content", 32768); }
  const fields = input.fields ?? [];
  if (!Array.isArray(fields) || fields.length > 32) fail("template_invalid", "Fields are invalid");
  const keys = new Set<string>();
  for (const field of fields) {
    if (!field || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.key) || ["constructor", "prototype", "__proto__"].includes(field.key) || keys.has(field.key)) fail("template_invalid", "Field names must be unique identifiers");
    keys.add(field.key); text(field.label, "Field label", 120, true);
    if (field.required !== undefined && typeof field.required !== "boolean") fail("template_invalid", "Field requirement is invalid");
    if (field.defaultValue !== undefined) text(field.defaultValue, "Default value", 8192);
  }
  for (const key of [content, ...variants.map(v => v.content)].flatMap(placeholders)) if (!keys.has(key)) fail("template_field_unknown", `Declare field: ${key}`);
  const media = normalizeMedia(input.media ?? []);
  const normalizedVariants = variants.map(v => ({ platform: v.platform, content: v.content, ...(v.media === undefined ? {} : { media: normalizeVariantMedia(v.media, media) }) }));
  return { name, content, description, category, channels: [...input.channels], variants: normalizedVariants, fields: fields.map(f => ({ key: f.key, label: f.label, required: f.required ?? true, ...(f.defaultValue === undefined ? {} : { defaultValue: f.defaultValue }) })), media };
}
function normalizeMedia(media: TemplateMedia[]): TemplateMedia[] {
  if (!Array.isArray(media) || media.length > 20) fail("template_invalid", "Media is invalid");
  const ids = new Set<string>();
  return media.map((m, i) => {
    if (!m || typeof m.assetId !== "string" || !m.assetId || ids.has(m.assetId)) fail("template_invalid", "Media must reference unique assets");
    ids.add(m.assetId);
    if (m.altText != null) text(m.altText, "Alt text", 4000);
    if (m.sortOrder !== undefined && (!Number.isInteger(m.sortOrder) || m.sortOrder < 0 || m.sortOrder > 100)) fail("template_invalid", "Media order is invalid");
    return { assetId: m.assetId, sortOrder: m.sortOrder ?? i, ...(m.altText === undefined ? {} : { altText: m.altText }) };
  }).sort((a, b) => a.sortOrder - b.sortOrder).map((item, index) => ({ ...item, sortOrder: index }));
}
function normalizeVariantMedia(input: TemplateVariantMedia[], common: TemplateMedia[]): TemplateVariantMedia[] {
  const normalized = normalizeMedia(input);
  return normalized.map(item => {
    if (!common.some(m => m.assetId === item.assetId)) fail("template_invalid", "Platform media must belong to the template media");
    let crop = input.find(source => source.assetId === item.assetId)?.crop;
    if (crop !== undefined && crop !== null) {
      try { crop = JSON.parse(canonicalJson(crop)); } catch { fail("template_invalid", "Media crop is invalid"); }
    }
    if (crop !== undefined && crop !== null) {
      if (typeof crop !== "object" || Array.isArray(crop)) fail("template_invalid", "Media crop must be a JSON object");
      const validate = (value: unknown, depth: number): void => {
        if (depth > 4 || typeof value === "number" && !Number.isFinite(value)) fail("template_invalid", "Media crop is invalid");
        if (value && typeof value === "object") {
          if (Object.keys(value).length > 20) fail("template_invalid", "Media crop is too large");
          for (const [key, child] of Object.entries(value)) {
            if (["__proto__", "constructor", "prototype"].includes(key)) fail("template_invalid", "Media crop is invalid");
            validate(child, depth + 1);
          }
        } else if (!["string", "number", "boolean"].includes(typeof value) && value !== null) fail("template_invalid", "Media crop is invalid");
      };
      validate(crop, 0);
      if (JSON.stringify(crop).length > 4000) fail("template_invalid", "Media crop is too large");
    }
    return { ...item, ...(crop === undefined ? {} : { crop }) };
  });
}
async function readyMedia(db: Db, org: string, input: TemplateMedia[], lock = false): Promise<(TemplateMedia & { kind: string })[]> {
  const media = normalizeMedia(input);
  if (!media.length) return [];
  const result = await db.query(`SELECT id, kind::text, "processingStatus"::text, "scanStatus"::text, "archivedAt", "defaultAltText" FROM "ContentMediaAsset" WHERE "orgId"=$1 AND id=ANY($2::text[])${lock ? " FOR SHARE" : ""}`, [org, media.map(m => m.assetId)]);
  return media.map(m => {
    const asset = result.rows.find(a => a.id === m.assetId);
    if (!asset) fail("template_media_missing", "Template media was not found in this workspace", 409);
    if (asset.archivedAt) fail("template_media_archived", "Replace or remove archived template media", 409);
    if (!["IMAGE", "VIDEO"].includes(asset.kind) || asset.processingStatus !== "READY" || asset.scanStatus !== "CLEAN") fail("template_media_not_ready", "Replace or remove media that is not ready", 409);
    return { ...m, kind: asset.kind, altText: m.altText === undefined ? asset.defaultAltText ?? null : m.altText };
  });
}
async function get(db: Db, org: string, id: string, lock = ""): Promise<ContentTemplate> {
  const result = await db.query(`SELECT id,"orgId",name,description,category,content,channels,variants,fields,revision,"creatorId","updatedById","archivedAt"::text,"createdAt"::text,"updatedAt"::text,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('assetId',m."assetId",'sortOrder',m."sortOrder",'altText',m."altText") ORDER BY m."sortOrder",m.id) FROM "ContentTemplateMedia" m WHERE m."templateId"="ContentTemplate".id),'[]'::jsonb) AS media
    FROM "ContentTemplate" WHERE id=$1 AND "orgId"=$2 ${lock}`, [id, org]);
  if (!result.rows[0]) fail("template_not_found", "Template was not found", 404);
  return result.rows[0] as ContentTemplate;
}
export function getContentTemplate(pool: Pool, org: string, id: string): Promise<ContentTemplate> { return get(pool, org, id); }
export async function listContentTemplates(pool: Pool, org: string, options: { search?: string; category?: string; archived?: boolean; limit?: number; cursor?: string } = {}) {
  const limit = options.limit ?? 30;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("template_invalid", "Limit must be between 1 and 100");
  const values: unknown[] = [org, options.archived ?? false];
  const where = ['"orgId"=$1', '("archivedAt" IS NOT NULL)=$2'];
  if (options.search) { text(options.search, "Search", 256); values.push(options.search); where.push(`(name ILIKE '%' || $${values.length} || '%' OR content ILIKE '%' || $${values.length} || '%')`); }
  if (options.category) { values.push(text(options.category, "Category", 120)); where.push(`category=$${values.length}`); }
  if (options.cursor) {
    let cursor: unknown;
    try { cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString()); } catch { fail("template_invalid", "Cursor is invalid"); }
    if (!Array.isArray(cursor) || cursor.length !== 2 || cursor.some(v => typeof v !== "string") || Number.isNaN(Date.parse(cursor[0]))) fail("template_invalid", "Cursor is invalid");
    values.push(cursor[0], cursor[1]); where.push(`("createdAt",id)<($${values.length - 1}::timestamptz,$${values.length})`);
  }
  values.push(limit + 1);
  const result = await pool.query(`SELECT id,"createdAt"::text FROM "ContentTemplate" WHERE ${where.join(" AND ")} ORDER BY "createdAt" DESC,id DESC LIMIT $${values.length}`, values);
  const selected = result.rows.slice(0, limit);
  const last = selected.at(-1);
  return { items: await Promise.all(selected.map(r => get(pool, org, r.id))), nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url") : null };
}
async function writeMedia(db: Db, id: string, media: TemplateMedia[]) {
  await db.query('DELETE FROM "ContentTemplateMedia" WHERE "templateId"=$1', [id]);
  for (const m of media) await db.query('INSERT INTO "ContentTemplateMedia" (id,"templateId","assetId","sortOrder","altText") VALUES ($1,$2,$3,$4,$5)', [createId(), id, m.assetId, m.sortOrder, m.altText ?? null]);
}
async function mutationReceipt(db: Db, org: string, key: string | null, action: string, inputDigest: string): Promise<ContentTemplate | null> {
  if (!key) return null;
  const prior = await db.query('SELECT action,"inputDigest",result FROM "ContentTemplateMutation" WHERE "orgId"=$1 AND "operationKey"=$2', [org, key]);
  if (!prior.rows[0]) return null;
  if (prior.rows[0].action !== action || prior.rows[0].inputDigest !== inputDigest) fail("idempotency_conflict", "Idempotency key was used with different input", 409);
  return prior.rows[0].result as ContentTemplate;
}
async function recordMutation(db: Db, ctx: RequestContext, action: string, inputDigest: string, result: ContentTemplate): Promise<void> {
  if (ctx.idempotencyKey) await db.query('INSERT INTO "ContentTemplateMutation" ("orgId","operationKey","templateId",action,"inputDigest",result) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [ctx.organizationId, ctx.idempotencyKey, result.id, action, inputDigest, canonicalJson(result)]);
}
export async function createContentTemplate(pool: Pool, ctx: RequestContext, input: { template?: TemplateInput; sourcePostId?: string }): Promise<ContentTemplate> {
  const inputDigest = digest(input);
  const receipt = await mutationReceipt(pool, ctx.organizationId, ctx.idempotencyKey, "create", inputDigest);
  if (receipt) return receipt;
  return transaction(pool, async db => {
    if (ctx.idempotencyKey) {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ctx.organizationId + ":template:" + ctx.idempotencyKey]);
      const receipt = await mutationReceipt(db, ctx.organizationId, ctx.idempotencyKey, "create", inputDigest);
      if (receipt) return receipt;
    }
    let source: Partial<TemplateInput> = {};
    if (input.sourcePostId) {
      const locked = await db.query('SELECT id FROM "SocialPost" WHERE id=$1 AND "orgId"=$2 FOR SHARE', [input.sourcePostId, ctx.organizationId]);
      if (!locked.rowCount) fail("post_not_found", "Source post was not found", 404);
      const post = await getSocialPost(db as unknown as Pool, ctx.organizationId, input.sourcePostId);
      if (!post) fail("post_not_found", "Source post was not found", 404);
      const overrides = (await db.query<TemplateVariantMedia & { platform: string }>(`SELECT v.platform::text,m."assetId",vm."sortOrder",vm."altText",vm.crop
        FROM "SocialPostVariantMedia" vm JOIN "SocialPostVariant" v ON v.id=vm."variantId"
        JOIN "SocialPostMedia" m ON m.id=vm."postMediaId" AND m."postId"=v."postId"
        JOIN "SocialPost" p ON p.id=v."postId" WHERE p.id=$1 AND p."orgId"=$2 ORDER BY v.platform,vm."sortOrder",vm.id`, [input.sourcePostId, ctx.organizationId])).rows;
      const emptyMediaPlatforms = new Set(post.media.length ? post.publishJobs.filter(job => {
        const snapshot = job.deliverySnapshot;
        return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && Array.isArray((snapshot as Record<string, unknown>).media) && ((snapshot as Record<string, unknown>).media as unknown[]).length === 0;
      }).map(job => job.platform) : []);
      source = { name: post.title || "Untitled template", content: post.content ?? "", channels: post.channels,
        variants: post.variants.map(v => ({ platform: v.platform, content: v.content, ...(emptyMediaPlatforms.has(v.platform) ? { media: [] } : overrides.some(m => m.platform === v.platform) ? { media: overrides.filter(m => m.platform === v.platform).map(({ platform: _, ...media }) => media) } : {}) })),
        media: post.media.map(m => ({ assetId: m.asset_id, altText: m.alt_text })) };
    }
    const candidate = { ...source, ...input.template } as TemplateInput;
    if (input.template?.variants && source.variants) candidate.variants = input.template.variants.map(variant => {
      const original = source.variants!.find(v => v.platform === variant.platform);
      return { ...variant, ...(variant.media === undefined && original?.media !== undefined ? { media: original.media } : {}) };
    });
    const template = validateTemplateInput(candidate);
    const media = await readyMedia(db, ctx.organizationId, template.media ?? [], true);
    const id = createId();
    await db.query(`INSERT INTO "ContentTemplate" (id,"orgId",name,description,category,content,channels,variants,fields,"creatorId","updatedById","sourcePostId","sourceKey","inputDigest") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$10,$11,$12,$13)`, [id, ctx.organizationId, template.name, template.description, template.category, template.content, template.channels, JSON.stringify(template.variants), JSON.stringify(template.fields), ctx.userId, input.sourcePostId ?? null, ctx.idempotencyKey, inputDigest]);
    await writeMedia(db, id, media);
    const result = await get(db, ctx.organizationId, id);
    await recordMutation(db, ctx, "create", inputDigest, result);
    return result;
  });
}

function checkRevision(template: ContentTemplate, revision: number) {
  if (!Number.isInteger(revision) || template.revision !== revision) fail("template_revision_conflict", "Template changed. Reload it before continuing", 409);
}
export async function getTemplateMutationReceipt(pool: Pool, org: string, key: string) {
  const result = await pool.query('SELECT "templateId",action,"inputDigest",result,"createdAt"::text FROM "ContentTemplateMutation" WHERE "orgId"=$1 AND "operationKey"=$2', [org, key]);
  return result.rows[0] as { templateId: string; action: string; inputDigest: string; result: ContentTemplate; createdAt: string } | undefined;
}
export async function updateContentTemplate(pool: Pool, ctx: RequestContext, id: string, input: { expectedRevision: number; template: TemplateInput }): Promise<ContentTemplate> {
  const template = validateTemplateInput(input.template);
  return mutate(pool, ctx, id, "update", input, async (db, current) => {
    if (current.archivedAt) fail("template_archived", "Restore this template before editing", 409);
    const media = await readyMedia(db, ctx.organizationId, template.media ?? [], true);
    await db.query('UPDATE "ContentTemplate" SET name=$2,description=$3,category=$4,content=$5,channels=$6,variants=$7::jsonb,fields=$8::jsonb WHERE id=$1', [id, template.name, template.description, template.category, template.content, template.channels, JSON.stringify(template.variants), JSON.stringify(template.fields)]);
    await writeMedia(db, id, media);
  });
}
async function mutate(pool: Pool, ctx: RequestContext, id: string, action: string, input: { expectedRevision: number }, apply: (db: PoolClient, current: ContentTemplate) => Promise<void>): Promise<ContentTemplate> {
  return transaction(pool, async db => {
    const inputDigest = digest({ id, ...input });
    if (ctx.idempotencyKey) await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [ctx.organizationId + ":template:" + ctx.idempotencyKey]);
    const receipt = await mutationReceipt(db, ctx.organizationId, ctx.idempotencyKey, action, inputDigest);
    if (receipt) return receipt;
    const current = await get(db, ctx.organizationId, id, "FOR UPDATE");
    checkRevision(current, input.expectedRevision);
    await apply(db, current);
    await db.query('UPDATE "ContentTemplate" SET revision=revision+1,"updatedById"=$2,"updatedAt"=now(),"lastMutationKey"=$3,"lastMutationDigest"=$4 WHERE id=$1', [id, ctx.userId, ctx.idempotencyKey, inputDigest]);
    const result = await get(db, ctx.organizationId, id);
    await recordMutation(db, ctx, action, inputDigest, result);
    return result;
  });
}
export function setContentTemplateArchived(pool: Pool, ctx: RequestContext, id: string, input: { expectedRevision: number; archived: boolean }): Promise<ContentTemplate> {
  if (typeof input.archived !== "boolean") fail("template_invalid", "Archive state is invalid");
  return mutate(pool, ctx, id, input.archived ? "archive" : "restore", input, async db => { await db.query('UPDATE "ContentTemplate" SET "archivedAt"=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1', [id, input.archived]); });
}
export function resolveTemplateValues(template: TemplateInput, supplied: Record<string, string> = {}): Record<string, string> {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) fail("template_invalid", "Field values must be an object");
  const fields = template.fields ?? [];
  for (const key of Object.keys(supplied)) if (!fields.some(f => f.key === key)) fail("template_field_unknown", `Unknown field: ${key}`);
  const values: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const value = Object.hasOwn(supplied, field.key) ? supplied[field.key] : field.defaultValue;
    if (value === undefined) { if (field.required !== false) fail("template_field_missing", `Enter ${field.label}`); values[field.key] = ""; }
    else { text(value, field.label, 8192); if (field.required !== false && !value.trim()) fail("template_field_missing", `Enter ${field.label}`); values[field.key] = value; }
  }
  return values;
}
async function render(db: Db, org: string, template: ContentTemplate, input: TemplateRenderInput, lock = false) {
  checkRevision(template, input.expectedRevision);
  if (template.archivedAt) fail("template_archived", "Restore this template before using it", 409);
  const values = resolveTemplateValues(template, input.values);
  const substitute = (content: string) => text(content.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g, (_, key: string) => values[key] ?? fail("template_field_unknown", `Unknown field: ${key}`)), "Rendered content", 32768);
  const media = await readyMedia(db, org, input.media ?? template.media, lock);
  const content = substitute(template.content).trim();
  const variants = template.variants.map(v => ({ platform: v.platform, content: substitute(v.content).trim() || content, ...(input.media === undefined && v.media !== undefined ? { media: normalizeVariantMedia(v.media, template.media) } : {}) }));
  const errors: { platform: string; code: string; message: string }[] = [];
  for (const platform of template.channels) {
    const variant = variants.find(v => v.platform === platform);
    const caption = variant?.content ?? content;
    const selected = variant?.media === undefined ? media : variant.media.map(m => media.find(a => a.assetId === m.assetId)!);
    const add = (error: [string, string] | undefined) => { if (error) errors.push({ platform, code: error[0], message: error[1] }); };
    add(textLengthError(platform, caption));
    add(platformMediaError(platform, selected.map(m => m.kind), selected.length));
    if (["INSTAGRAM", "TIKTOK"].includes(platform) && !selected.length) add(["media_required", `${platform} requires media`]);
    if (platform === "TIKTOK") {
      const maximum = selected.some(m => m.kind === "VIDEO") ? 2200 : 4000;
      if (caption.length > maximum) add(["text_length_exceeded", `TIKTOK accepts at most ${maximum} UTF-16 characters for this media type`]);
    }
  }
  return { templateId: template.id, revision: template.revision, title: template.name, content, channels: template.channels, variants, media, valuesDigest: digest({ ...values }), validation: { ready: !errors.length, errors } };

}
export async function renderContentTemplate(pool: Pool, org: string, id: string, input: TemplateRenderInput) { return render(pool, org, await get(pool, org, id), input); }
async function prepare(db: Db, ctx: RequestContext, id: string, input: TemplateRenderInput, lock = false) {
  const template = await get(db, ctx.organizationId, id, lock ? "FOR SHARE" : "");
  const rendered = await render(db, ctx.organizationId, template, input, lock);
  if (!rendered.validation.ready) fail("template_render_invalid", rendered.validation.errors.map(error => error.message).join("; "), 422);
  const draft: SocialPostUpsertRequest = { title: rendered.title, content: rendered.content, channels: [...rendered.channels], status: "DRAFT", variants: rendered.variants.map(v => ({ platform: v.platform, content: v.content, status: "DRAFT", aiGenerated: false })), media: rendered.media, metadata: { contentTemplateId: id, contentTemplateRevision: template.revision, contentTemplateValuesDigest: rendered.valuesDigest }, ...(input.channelSelections ? { channelSelections: input.channelSelections } : {}), ...(input.primaryChannelId ? { primaryChannelId: input.primaryChannelId } : {}) };
  const variantMedia: TemplatePlatformMedia[] = rendered.variants.filter(v => v.media !== undefined).map(v => ({ platform: v.platform, media: v.media! }));
  return { template, draft, variantMedia };
}
export function prepareTemplateDraft(pool: Pool, ctx: RequestContext, id: string, input: TemplateRenderInput) { return prepare(pool, ctx, id, input); }
/** Hold template and asset admission locks until the normal draft service commits its snapshot. */
export function withTemplateDraft<T>(pool: Pool, ctx: RequestContext, id: string, input: TemplateRenderInput, run: (prepared: { template: ContentTemplate; draft: SocialPostUpsertRequest; variantMedia: TemplatePlatformMedia[] }) => Promise<T>): Promise<T> {
  return transaction(pool, async db => run(await prepare(db, ctx, id, input, true)));
}
