import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { canonicalJson, wireInteger } from "@kasitek-labs/server-support/json";
import { ApiError } from "../../error.js";
import { transaction } from "../../db.js";
import type { ContentMediaAssetView } from "./media.js";

export interface LibraryMediaAsset extends ContentMediaAssetView {
  displayName: string | null;
  tags: string[];
  defaultAltText: string | null;
  archivedAt: string | null;
  revision: number;
  updatedAt: string;
}
export interface LibraryMediaListInput {
  limit?: number;
  cursor?: string;
  search?: string;
  kind?: "IMAGE" | "VIDEO";
  tags?: string[];
  archived?: boolean;
}
export interface LibraryMediaUpdateInput {
  expectedRevision: number;
  displayName?: string | null;
  tags?: string[];
  defaultAltText?: string | null;
}
export const MEDIA_LIBRARY_MUTATION_ACTIONS = {
  update: "content.media.update",
  archive: "content.media.archive",
  restore: "content.media.restore",
} as const;
export interface LibraryMediaMutationOptions {
  operationKey?: string;
}
const fail = (message: string) =>
  new ApiError(400, "media_arguments_invalid", message);
const missing = () => new ApiError(404, "not_found", "Media asset not found");
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
const columns = `id, kind::text, "mimeType", "fileName", "byteSize", checksum, width, height,
  "durationMs", "processingStatus"::text, "scanStatus"::text, "createdAt", "updatedAt",
  "displayName", tags, "defaultAltText", "archivedAt", revision`;
interface MediaRow {
  id: string;
  kind: string;
  mimeType: string;
  fileName: string | null;
  byteSize: string;
  checksum: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  processingStatus: string;
  scanStatus: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  displayName: string | null;
  tags: string[];
  defaultAltText: string | null;
  archivedAt: Date | string | null;
  revision: number;
  cursorAt: string;
}
function view(row: MediaRow): LibraryMediaAsset {
  const iso = (v: Date | string) =>
    v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mimeType,
    fileName: row.fileName,
    byteSize: wireInteger(row.byteSize),
    checksum: row.checksum,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    processingStatus: row.processingStatus,
    scanStatus: row.scanStatus,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    displayName: row.displayName,
    tags: row.tags,
    defaultAltText: row.defaultAltText,
    archivedAt: row.archivedAt ? iso(row.archivedAt) : null,
    revision: row.revision,
  };
}
function text(value: unknown, name: string, max: number): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw fail(`${name} is invalid`);
  return value.trim() || null;
}
function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20)
    throw fail("Use at most 20 tags");
  return [
    ...new Set(
      value.map((v) => {
        const tag = text(v, "Tag", 50)?.toLowerCase();
        if (!tag || /[\r\n\t]/.test(tag)) throw fail("Tag is invalid");
        return tag;
      }),
    ),
  ].sort();
}
function limit(value?: number): number {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 1 || value > 100)
  )
    throw fail("Limit must be between 1 and 100");
  return value ?? 24;
}
function cursor(value: string | undefined, scope: string): string[] | null {
  if (!value) return null;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      parsed.scope !== scope ||
      !Array.isArray(parsed.position) ||
      parsed.position.length !== 2 ||
      parsed.position.some(
        (v: unknown) => typeof v !== "string" || v.length > 256,
      )
    )
      throw Error();
    return parsed.position;
  } catch {
    throw fail("Cursor is invalid for these filters");
  }
}
const encode = (scope: string, position: string[]) =>
  Buffer.from(JSON.stringify({ scope, position })).toString("base64url");
export async function listLibraryMedia(
  pool: Pool,
  org: string,
  input: LibraryMediaListInput = {},
) {
  const count = limit(input.limit);
  if (
    input.kind !== undefined &&
    input.kind !== "IMAGE" &&
    input.kind !== "VIDEO"
  )
    throw fail("Media kind is invalid");
  if (input.archived !== undefined && typeof input.archived !== "boolean")
    throw fail("Archive filter is invalid");
  const search = text(input.search ?? "", "Search", 256) ?? "";
  const selectedTags = tags(input.tags ?? []);
  const archived = input.archived ?? false;
  const scope = digest({
    org,
    search,
    tags: selectedTags,
    kind: input.kind ?? null,
    archived,
  });
  const after = cursor(input.cursor, scope);
  if (after) {
    const at = after[0]!;
    const date = new Date(`${at}Z`);
    if (
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/.test(at) ||
      !Number.isFinite(date.getTime()) ||
      date.toISOString().slice(0, 19) !== at.slice(0, 19)
    ) {
      throw fail("Cursor timestamp is invalid");
    }
  }
  const result = await pool.query<MediaRow>(
    `SELECT ${columns}, to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "cursorAt"
    FROM "ContentMediaAsset" WHERE "orgId"=$1 AND kind::text IN ('IMAGE','VIDEO')
    AND ("archivedAt" IS NOT NULL)=$2 AND ($3::text IS NULL OR kind::text=$3)
    AND ($4='' OR strpos(lower(coalesce("displayName",'') || ' ' || coalesce("fileName",'') || ' ' || array_to_string(tags,' ')), lower($4))>0)
    AND tags @> $5::text[] AND ($6::timestamp IS NULL OR ("createdAt",id)<($6::timestamp,$7::text))
    ORDER BY "createdAt" DESC,id DESC LIMIT $8`,
    [
      org,
      archived,
      input.kind ?? null,
      search,
      selectedTags,
      after?.[0] ?? null,
      after?.[1] ?? null,
      count + 1,
    ],
  );
  const rows = result.rows.slice(0, count);
  const last = rows.at(-1);
  return {
    assets: rows.map(view),
    pagination: {
      limit: count,
      nextCursor:
        result.rows.length > count && last
          ? encode(scope, [last.cursorAt, last.id])
          : null,
    },
  };
}
export async function getLibraryMedia(
  pool: Pool | PoolClient,
  org: string,
  assetId: string,
): Promise<LibraryMediaAsset> {
  const result = await pool.query<MediaRow>(
    `SELECT ${columns} FROM "ContentMediaAsset" WHERE id=$1 AND "orgId"=$2 AND kind::text IN ('IMAGE','VIDEO')`,
    [assetId, org],
  );
  if (!result.rows[0]) throw missing();
  return view(result.rows[0]);
}
async function mutate(
  pool: Pool,
  org: string,
  assetId: string,
  expectedRevision: number,
  action: string,
  patch: Record<string, unknown>,
  options: LibraryMediaMutationOptions,
): Promise<LibraryMediaAsset> {
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
    throw fail("Expected revision is required");
  const key = options.operationKey;
  if (
    key !== undefined &&
    (typeof key !== "string" || !key || key.length > 256)
  )
    throw fail("Operation key is invalid");
  const inputDigest = digest({ assetId, expectedRevision, action, patch });
  return transaction(pool, async (client) => {
    if (key) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`${org}:media-library:${key}`],
      );
      const previous = await client.query(
        `SELECT "inputDigest",result FROM "ContentMediaLibraryMutation" WHERE "orgId"=$1 AND "operationKey"=$2`,
        [org, key],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].inputDigest !== inputDigest)
          throw new ApiError(
            409,
            "operation_identity_conflict",
            "Operation key was already used for different input",
          );
        return previous.rows[0].result as LibraryMediaAsset;
      }
    }
    const locked = await client.query(
      `SELECT revision FROM "ContentMediaAsset" WHERE id=$1 AND "orgId"=$2 AND kind::text IN ('IMAGE','VIDEO') FOR UPDATE`,
      [assetId, org],
    );
    if (!locked.rows[0]) throw missing();
    if (locked.rows[0].revision !== expectedRevision)
      throw new ApiError(
        409,
        "media_revision_conflict",
        "Media changed; reload before saving",
      );
    const entries = Object.entries(patch);
    await client.query(
      `UPDATE "ContentMediaAsset" SET ${entries.map(([field], i) => `"${field}"=$${i + 3}`).join(",")},revision=revision+1,"updatedAt"=CURRENT_TIMESTAMP WHERE id=$1 AND "orgId"=$2`,
      [assetId, org, ...entries.map(([, value]) => value)],
    );
    const result = await getLibraryMedia(client, org, assetId);
    if (key)
      await client.query(
        `INSERT INTO "ContentMediaLibraryMutation"("orgId","operationKey","assetId",action,"inputDigest",result) VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [org, key, assetId, action, inputDigest, canonicalJson(result)],
      );
    return result;
  });
}
export async function updateLibraryMedia(
  pool: Pool,
  org: string,
  assetId: string,
  input: LibraryMediaUpdateInput,
  options: LibraryMediaMutationOptions = {},
) {
  const patch: Record<string, unknown> = {};
  if (input.displayName !== undefined)
    patch.displayName = text(input.displayName, "Display name", 240);
  if (input.tags !== undefined) patch.tags = tags(input.tags);
  if (input.defaultAltText !== undefined)
    patch.defaultAltText = text(input.defaultAltText, "Default alt text", 2000);
  if (!Object.keys(patch).length) throw fail("Choose metadata to update");
  return mutate(
    pool,
    org,
    assetId,
    input.expectedRevision,
    MEDIA_LIBRARY_MUTATION_ACTIONS.update,
    patch,
    options,
  );
}
export async function setLibraryMediaArchived(
  pool: Pool,
  org: string,
  assetId: string,
  input: { expectedRevision: number; archived: boolean },
  options: LibraryMediaMutationOptions = {},
) {
  if (typeof input.archived !== "boolean")
    throw fail("Archive state is invalid");
  // The digest uses the requested state, not a changing clock value, for lost-ack replay.
  const action = input.archived
    ? MEDIA_LIBRARY_MUTATION_ACTIONS.archive
    : MEDIA_LIBRARY_MUTATION_ACTIONS.restore;
  return mutate(
    pool,
    org,
    assetId,
    input.expectedRevision,
    action,
    { archivedAt: input.archived ? "now" : null },
    options,
  );
}
export async function getLibraryMediaUsage(
  pool: Pool,
  org: string,
  assetId: string,
  input: { limit?: number; cursor?: string } = {},
) {
  await getLibraryMedia(pool, org, assetId);
  const count = limit(input.limit),
    scope = digest({ org, assetId, usage: true }),
    after = cursor(input.cursor, scope);
  const result = await pool.query(
    `WITH usage AS (
    SELECT DISTINCT 'post'::text AS type,p.id,coalesce(p.title,'') AS title,p.status::text AS status,p.channels::text[] AS platforms
    FROM "SocialPostMedia" m JOIN "SocialPost" p ON p.id=m."postId" WHERE m."assetId"=$1 AND p."orgId"=$2
    UNION ALL SELECT 'template',t.id,t.name,CASE WHEN t."archivedAt" IS NULL THEN 'ACTIVE' ELSE 'ARCHIVED' END,NULL::text[]
    FROM "ContentTemplateMedia" m JOIN "ContentTemplate" t ON t.id=m."templateId" WHERE m."assetId"=$1 AND t."orgId"=$2
  ) SELECT * FROM usage WHERE ($3::text IS NULL OR (type,id)>($3::text,$4::text)) ORDER BY type,id LIMIT $5`,
    [assetId, org, after?.[0] ?? null, after?.[1] ?? null, count + 1],
  );
  const rows = result.rows.slice(0, count),
    last = rows.at(-1);
  return {
    assetId,
    usage: rows,
    pagination: {
      limit: count,
      nextCursor:
        result.rows.length > count && last
          ? encode(scope, [last.type, last.id])
          : null,
    },
  };
}
