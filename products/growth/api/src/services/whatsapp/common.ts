import { parseSerdeValueJson } from "../../json.js";
import { sourceIsConnected } from "../connections.js";
import type { Pool } from "pg";
import type { CoreConfig } from "../../config.js";
import { canonicalJson, SerdeFloat } from "@kasitek-labs/server-support/json";
import { ApiError } from "../../error.js";
import { parseOptionalDatetime } from "../social/common.js";
import type {
  Row,
  WhatsappConnectionRow,
  WhatsappContactRow,
  WhatsappAudienceFilterRequest,
} from "./types.js";
import { SQL } from "./common-sql.js";
export const GRAPH_BASE = "https://graph.facebook.com/v19.0";
export interface ProviderOptions {
  config: CoreConfig;
  fetch?: typeof fetch;
  graphBase?: string;
}
export interface MarketingOptions extends ProviderOptions {
  publishEvent(orgId: string, event: unknown): Promise<void>;
  logger?: Pick<Console, "info" | "warn" | "error">;
}
export const bad = (message: string) =>
    new ApiError(400, "bad_request", message),
  missing = (message: string) => new ApiError(404, "not_found", message),
  conflict = (message: string) => new ApiError(409, "conflict", message),
  internal = (message: string) => new ApiError(500, "internal_error", message);
export const trimmed = (value: string | null | undefined): string | null =>
  value?.trim() || null;
export const json = (value: unknown): string | null =>
  value == null ? null : canonicalJson(value);
export const mapTemplateStatus = (value: string | null | undefined): string =>
  ["APPROVED", "PENDING", "REJECTED"].includes(value?.toUpperCase() ?? "")
    ? value!.toUpperCase()
    : "DISABLED";
export const mapTemplateCategory = (
  value: string | null | undefined,
): string | null =>
  ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(
    value?.toUpperCase() ?? "",
  )
    ? value!.toUpperCase()
    : null;
export function variablesCount(body: string | null | undefined): number {
  let count = 0,
    index = 0;
  while (body && (index = body.indexOf("{{", index)) !== -1) {
    if (body.slice(index).includes("}}")) count++;
    index += 2;
  }
  return count;
}
export function envInteger(
  config: CoreConfig,
  key: string,
  fallback: number,
  unsigned = false,
): number {
  const value = config.rawEnv[key];
  if (
    value === undefined ||
    !(unsigned ? /^\+?\d+$/ : /^[+-]?\d+$/).test(value)
  )
    return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}
export function marketingCooldownDays(config?: CoreConfig): number {
  return config
    ? envInteger(config, "WHATSAPP_MARKETING_MIN_DAYS", 10)
    : /^[-+]?\d+$/.test(process.env.WHATSAPP_MARKETING_MIN_DAYS ?? "")
      ? Number(process.env.WHATSAPP_MARKETING_MIN_DAYS)
      : 10;
}
export async function fetchGraphJson(
  url: string,
  init: RequestInit,
  options: ProviderOptions,
  timeout = false,
): Promise<Row> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      ...init,
      ...(timeout
        ? {
            signal: AbortSignal.timeout(
              envInteger(
                options.config,
                "WHATSAPP_HTTP_TIMEOUT_MS",
                30000,
                true,
              ),
            ),
          }
        : {}),
    });
  } catch (error) {
    throw providerRequestError(error);
  }
  const body = await response.text();
  if (!response.ok) {
    if (response.status === 429)
      throw new ApiError(429, "rate_limited", "Provider rate limit exceeded");
    let value: Row | undefined;
    try {
      value = parseSerdeValueJson(body) as Row;
    } catch {}
    throw bad(
      typeof value?.error?.message === "string"
        ? value.error.message
        : `Graph API request failed (${response.status} ${response.statusText})`,
    );
  }
  try {
    return parseSerdeValueJson(body) as Row;
  } catch {
    throw internal("Failed to decode Graph API response");
  }
}
export function parseScheduledAt(
  value: string | null | undefined,
): Date | null {
  try {
    return parseOptionalDatetime(value);
  } catch {
    throw bad("Scheduled time is invalid");
  }
}
export const hasConfirmedImportConsent = (
  includes: boolean,
  confirmed: boolean,
): boolean => !includes || confirmed;
export function sanitizeListLabel(input: string | null | undefined): string {
  return (
    (input ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "default"
  );
}
const RESERVED = [
  "phone",
  "mobile",
  "whatsapp",
  "whatsappNumber",
  "number",
  "fullName",
  "name",
  "contactName",
  "location",
  "city",
  "province",
  "region",
  "tags",
  "segment",
  "groups",
  "notes",
  "note",
  "optIn",
  "opt_in",
  "optedIn",
  "subscribed",
  "consent",
  "optInSource",
  "consentSource",
  "listLabel",
  "list",
].map((value) => value.toLowerCase());
export function extractContactMetadata(
  row: Record<string, string>,
): Row | null {
  const values = Object.entries(row)
    .filter(
      ([key, value]) => !RESERVED.includes(key.toLowerCase()) && value.trim(),
    )
    .map(([key, value]) => [key.trim(), value.trim()]);
  return values.length ? Object.fromEntries(values) : null;
}
export function metadataString(value: unknown, key: string): string {
  const child =
    value !== null && typeof value === "object"
      ? (value as Row)[key]
      : undefined;
  return typeof child === "string"
    ? child
    : typeof child === "number" ||
        typeof child === "bigint" ||
        typeof child === "boolean"
      ? String(child)
      : child instanceof SerdeFloat
        ? canonicalJson(child)
        : "";
}
export function normalizePhone(raw: string, config?: CoreConfig): string {
  const cleaned = raw.trim().replace(/[ ()-]/g, "");
  if (!cleaned) return "";
  const valid = (phone: string) =>
    /^\+[1-9][0-9]{7,14}$/.test(phone) ? phone : "";
  if (cleaned.startsWith("+")) return valid(cleaned);
  if (cleaned.startsWith("00")) return valid(`+${cleaned.slice(2)}`);
  const digits = cleaned.replace(/[^0-9]/g, "");
  if (!digits) return "";
  return valid(
    digits.startsWith("0")
      ? `${config?.rawEnv.WHATSAPP_DEFAULT_COUNTRY_CODE ?? process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ?? "+27"}${digits.slice(1)}`
      : `+${digits}`,
  );
}
export const sanitizeTags = (tags: string[]): string[] => [
  ...new Set(tags.map((tag) => tag.trim()).filter(Boolean)),
];
export function parseBoolLike(raw: string): boolean | null {
  const normalized = raw.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
  return ["true", "1", "yes", "y"].includes(normalized)
    ? true
    : ["false", "0", "no", "n"].includes(normalized)
      ? false
      : null;
}
export function pickFirst(
  row: Record<string, string>,
  keys: string[],
): string | null {
  const key = keys.find((key) => row[key] !== undefined);
  return key === undefined ? null : trimmed(row[key]);
}
export const parseCsvTags = (value: string | null) =>
  value
    ?.split(",")
    .map((tag) => tag.trim())
    .filter(Boolean) ?? [];
export const sanitizeFilename = (value: string): string =>
  Array.from(value)
    .map((char) => (/^[a-zA-Z0-9._-]$/.test(char) ? char : "_"))
    .join("");
export function contactEligible(
  contact: WhatsappContactRow,
  config?: CoreConfig,
  now = new Date(),
): [string, boolean] {
  if (!contact.opt_in) return ["not_opted_in", false];
  if (contact.excluded) return ["excluded", false];
  if (
    contact.last_marketing_sent &&
    contact.last_marketing_sent.getTime() >
      now.getTime() - marketingCooldownDays(config) * 86400000
  )
    return ["cooldown", false];
  return ["ok", true];
}
export function contactMatchesAudience(
  contact: WhatsappContactRow,
  audience: WhatsappAudienceFilterRequest | null | undefined,
  config?: CoreConfig,
  now = new Date(),
): boolean {
  if (!audience) return true;
  const contains = (value: string | null | undefined, search: string) =>
    value?.toLowerCase().includes(search) ?? false;
  const search = trimmed(audience.search)?.toLowerCase();
  if (
    search &&
    !contact.tags.some((tag) => contains(tag, search)) &&
    !contains(contact.full_name, search) &&
    !contains(contact.phone, search) &&
    !contains(contact.location, search)
  )
    return false;
  const location = trimmed(audience.location)?.toLowerCase();
  if (location && !contains(contact.location, location)) return false;
  const label = trimmed(audience.list_label);
  if (label && contact.list_label.toLowerCase() !== label.toLowerCase())
    return false;
  const tags = (audience.tags ?? [])
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  if (
    tags.length &&
    !contact.tags.some((tag) => tags.includes(tag.toLowerCase()))
  )
    return false;
  if (
    (audience.opt_in_status === "opted_in" && !contact.opt_in) ||
    (audience.opt_in_status === "not_opted_in" && contact.opt_in)
  )
    return false;
  const excluded = audience.excluded_status ?? "active_only";
  if (
    (excluded === "active_only" && contact.excluded) ||
    (excluded === "excluded_only" && !contact.excluded)
  )
    return false;
  const cutoff = now.getTime() - marketingCooldownDays(config) * 86400000,
    mode = audience.cooldown_status ?? "passed";
  if (
    mode === "passed" &&
    contact.last_marketing_sent &&
    contact.last_marketing_sent.getTime() > cutoff
  )
    return false;
  if (
    mode === "recent" &&
    (!contact.last_marketing_sent ||
      contact.last_marketing_sent.getTime() <= cutoff)
  )
    return false;
  return true;
}
export const selectConnectionSql = `SELECT id,"userId" AS user_id,"orgId" AS org_id,"phoneNumberId" AS phone_number_id,"phoneDisplayNumber" AS phone_display_number,"accessTokenEncrypted" AS access_token_encrypted,"wabaId" AS waba_id,"authMethod" AS auth_method,"currentQualityRating"::text AS current_quality_rating,"dailyLimitEstimate" AS daily_limit_estimate,verified,"providerPermissions" AS provider_permissions,"createdAt" AT TIME ZONE 'UTC' AS created_at,"updatedAt" AT TIME ZONE 'UTC' AS updated_at FROM "WhatsappConnection"`;
export async function getConnectionRowForOrg(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<WhatsappConnectionRow | undefined> {
  const row = (
    await pool.query<WhatsappConnectionRow>(
      `${selectConnectionSql} WHERE id=$1 AND "orgId"=$2 LIMIT 1`,
      [id, orgId],
    )
  ).rows[0];
  if (row && !(await sourceIsConnected(pool, orgId, "WHATSAPP", id)))
    throw conflict(
      "This WhatsApp connection is not active. Reconnect it from Connections.",
    );
  return row;
}
export async function selectListContactRow(
  pool: Pick<Pool, "query">,
  orgId: string,
  id: string,
): Promise<Row | undefined> {
  return (await pool.query(SQL.select_list_contact_row[0], [id, orgId]))
    .rows[0];
}
export async function selectCampaignContactRow(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<WhatsappContactRow | undefined> {
  return (
    await pool.query<WhatsappContactRow>(SQL.select_campaign_contact_row[0], [
      id,
      orgId,
    ])
  ).rows[0];
}
export function providerRequestError(error: unknown): ApiError {
  return error instanceof Error &&
    ["TimeoutError", "AbortError"].includes(error.name)
    ? new ApiError(504, "gateway_timeout", "Provider request timed out")
    : internal("External request failed");
}
