import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import { ApiError } from "../../error.js";
import {
  decryptSocialSecret,
  encryptSocialSecret,
} from "../../integrations/crypto.js";
import { fetchMetaPermissions } from "../../integrations/provider-auth.js";
import * as projection from "../connections.js";
import {
  GRAPH_BASE,
  fetchGraphJson,
  selectConnectionSql,
  type ProviderOptions,
  bad,
  missing,
  internal,
} from "./common.js";
import { syncConnectionTemplates } from "./templates.js";
import type { WhatsappConnectionRow } from "./types.js";
import { SQL } from "./connections-sql.js";

interface GraphPhone {
  id: string;
  display_phone_number?: string | null;
  verified_name?: string | null;
  quality_rating?: string | null;
  code_verification_status?: string | null;
  name_status?: string | null;
  messaging_limit_tier?: string | null;
}
export function mapQualityRating(value?: string | null): string {
  const normalized = value?.toUpperCase();
  return normalized && ["GREEN", "YELLOW", "RED"].includes(normalized)
    ? normalized
    : "UNKNOWN";
}
export function estimateDailyLimit(value?: string | null): number | null {
  return (
    (
      {
        TIER_1: 1000,
        TIER_2: 10000,
        TIER_3: 100000,
        TIER_4: 1000000,
      } as Record<string, number>
    )[value?.toUpperCase() ?? ""] ?? null
  );
}
function defaultLimit(options: ProviderOptions): number {
  const value = options.config.rawEnv.WHATSAPP_DEFAULT_DAILY_LIMIT;
  const parsed =
    value !== undefined && /^[+-]?\d+$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(parsed) &&
    parsed >= -2147483648 &&
    parsed <= 2147483647
    ? parsed
    : 250;
}
function label(phone: GraphPhone, manual?: string | null): string | null {
  const normalized = manual?.trim();
  return normalized
    ? normalized
    : (phone.verified_name ?? phone.display_phone_number ?? null);
}
function decodePhone(
  value: unknown,
  message = "Failed to decode Graph API response",
): GraphPhone {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw internal(message);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string") throw internal(message);
  for (const key of [
    "display_phone_number",
    "verified_name",
    "quality_rating",
    "code_verification_status",
    "name_status",
    "messaging_limit_tier",
  ]) {
    if (row[key] != null && typeof row[key] !== "string")
      throw internal(message);
  }
  return row as unknown as GraphPhone;
}
const verified = (phone: GraphPhone) =>
  phone.code_verification_status === "VERIFIED" ||
  phone.name_status === "APPROVED";
const base = (options: ProviderOptions) => options.graphBase ?? GRAPH_BASE;
function permissionRecord(
  permissions: string[],
  authMethod: string,
): Record<string, unknown> {
  return { permissions, permissionsInspected: true, authMethod };
}
export function addWhatsappCapabilityChecks(
  value: unknown,
  webhookSubscribed: boolean,
  phoneLookupSucceeded: boolean,
): Record<string, unknown> | null {
  if (value == null) return null;
  const record = Array.isArray(value)
    ? { permissions: value, permissionsInspected: true }
    : typeof value === "object"
      ? { ...value }
      : null;
  if (!record) return null;
  const permissions = Array.isArray(
    (record as Record<string, unknown>).permissions,
  )
    ? (record as { permissions: unknown[] }).permissions
    : [];
  const messaging = permissions.includes("whatsapp_business_messaging");
  const management =
    permissions.includes("whatsapp_business_management") ||
    permissions.includes("business_management");
  return {
    ...record,
    capabilityChecks: {
      MESSAGING_INBOUND: messaging && webhookSubscribed,
      MESSAGING_OUTBOUND: messaging && phoneLookupSucceeded,
      MEDIA_PUBLISH: management && phoneLookupSucceeded,
    },
  };
}
export function publicConnection(row: WhatsappConnectionRow) {
  return {
    id: row.id,
    userId: row.user_id,
    phoneNumberId: row.phone_number_id,
    phoneDisplayNumber: row.phone_display_number,
    wabaId: row.waba_id,
    currentQualityRating: row.current_quality_rating,
    dailyLimitEstimate: row.daily_limit_estimate,
    verified: row.verified,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export async function listWhatsappConnections(pool: Pool, orgId: string) {
  return (
    await pool.query<WhatsappConnectionRow>(
      `${selectConnectionSql} WHERE "orgId"=$1 ORDER BY "createdAt" DESC`,
      [orgId],
    )
  ).rows.map(publicConnection);
}
export async function getConnectionIncludingInactive(
  pool: Pool,
  orgId: string,
  id: string,
): Promise<WhatsappConnectionRow | undefined> {
  return (
    await pool.query<WhatsappConnectionRow>(
      `${selectConnectionSql} WHERE id=$1 AND "orgId"=$2 LIMIT 1`,
      [id, orgId],
    )
  ).rows[0];
}
async function fetchPhone(
  token: string,
  id: string,
  options: ProviderOptions,
): Promise<GraphPhone> {
  const url = `${base(options)}/${id}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier&access_token=${encodeURIComponent(token)}`;
  return decodePhone(await fetchGraphJson(url, {}, options));
}
async function subscribe(
  token: string,
  wabaId: string,
  options: ProviderOptions,
): Promise<void> {
  await fetchGraphJson(
    `${base(options)}/${wabaId}/subscribed_apps`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscribed_fields: [
          "calls",
          "messages",
          "message_template_status_update",
          "message_template_quality_update",
          "message_template_components_update",
        ],
        access_token: token,
      }),
    },
    options,
  );
}
async function inspectedPermissions(
  token: string,
  authMethod: string,
  options: ProviderOptions,
): Promise<Record<string, unknown> | null> {
  try {
    return permissionRecord(
      await fetchMetaPermissions(options.config, token, options.fetch),
      authMethod,
    );
  } catch {
    return null;
  }
}
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "External request failed";
export async function connectManualConnection(
  pool: Pool,
  userId: string,
  orgId: string,
  wabaId: string,
  phoneId: string,
  token: string,
  displayNumber: string | null,
  options: ProviderOptions,
) {
  return connectConnection(
    pool,
    userId,
    orgId,
    wabaId,
    phoneId,
    token,
    displayNumber,
    "whatsapp_manual",
    options,
  );
}
async function connectConnection(
  pool: Pool,
  userId: string,
  orgId: string,
  wabaId: string,
  phoneId: string,
  token: string,
  displayNumber: string | null,
  authMethod: string,
  options: ProviderOptions,
) {
  if (!wabaId.trim() || !phoneId.trim() || !token.trim())
    throw bad("WABA ID, phone number ID, and access token are required");
  const phone = await fetchPhone(token, phoneId, options);
  const permissions = await inspectedPermissions(token, authMethod, options);
  const owner = (await pool.query(SQL.connect_connection[0], [phoneId])).rows[0]
    ?.orgId;
  if (owner != null && owner !== orgId)
    throw new ApiError(
      409,
      "conflict",
      "This WhatsApp number is already connected to another account",
    );
  await pool.query(SQL.connect_connection[1], [
    createId(),
    userId,
    orgId,
    phoneId,
    label(phone, displayNumber),
    encryptSocialSecret(options.config, token),
    wabaId.trim(),
    authMethod,
    mapQualityRating(phone.quality_rating),
    estimateDailyLimit(phone.messaging_limit_tier) ?? defaultLimit(options),
    verified(phone),
    permissions,
  ]);
  const connection = (
    await pool.query<WhatsappConnectionRow>(
      `${selectConnectionSql} WHERE "orgId"=$1 AND "phoneNumberId"=$2 LIMIT 1`,
      [orgId, phoneId],
    )
  ).rows[0];
  if (!connection) throw internal("Database operation failed");
  let webhookError: string | null = null;
  try {
    await subscribe(token, wabaId, options);
  } catch (error) {
    webhookError = errorMessage(error);
  }
  await projection.recordSourceHealth(
    pool,
    orgId,
    "WHATSAPP",
    connection.id,
    webhookError === null,
    webhookError === null ? "HEALTHY" : "FAILED",
    webhookError,
  );
  let templateSync: unknown = { attempted: true, success: false };
  try {
    templateSync = await syncConnectionTemplates(
      pool,
      userId,
      orgId,
      connection.id,
      options,
    );
  } catch {
    /* source best effort */
  }
  await pool.query(SQL.connect_connection[2], [
    addWhatsappCapabilityChecks(
      permissions ?? connection.provider_permissions,
      webhookError === null,
      true,
    ),
    connection.id,
  ]);
  return {
    connection: publicConnection(connection),
    externalConnectionId: `ext_${connection.id}`,
    webhookSubscribed: webhookError === null,
    webhookError,
    templateSync,
  };
}
async function exchangeCode(
  code: string,
  options: ProviderOptions,
): Promise<string> {
  const env = options.config.rawEnv;
  if (env.AUTH_META_APP_ID === undefined)
    throw internal("AUTH_META_APP_ID is required");
  if (env.AUTH_META_APP_SECRET === undefined)
    throw internal("AUTH_META_APP_SECRET is required");
  const query = `client_id=${encodeURIComponent(env.AUTH_META_APP_ID)}&client_secret=${encodeURIComponent(env.AUTH_META_APP_SECRET)}`;
  const short = await fetchGraphJson(
    `${base(options)}/oauth/access_token?${query}&code=${encodeURIComponent(code)}`,
    {},
    options,
  );
  if (typeof short.access_token !== "string")
    throw internal("Meta OAuth exchange did not return an access token");
  try {
    const long = await fetchGraphJson(
      `${base(options)}/oauth/access_token?grant_type=fb_exchange_token&${query}&fb_exchange_token=${encodeURIComponent(short.access_token)}`,
      {},
      options,
    );
    if (typeof long.access_token === "string") return long.access_token;
  } catch {
    /* short-lived token is retained when the optional exchange fails */
  }
  return short.access_token;
}
async function resolveWaba(
  token: string,
  preferred: string | null,
  options: ProviderOptions,
): Promise<string> {
  if (preferred?.trim()) return preferred.trim();
  const response = await fetchGraphJson(
    `${base(options)}/me/businesses?fields=id,owned_whatsapp_business_accounts{id},client_whatsapp_business_accounts{id}&access_token=${encodeURIComponent(token)}`,
    {},
    options,
  );
  for (const business of Array.isArray(response.data) ? response.data : []) {
    const owned = Array.isArray(business?.owned_whatsapp_business_accounts)
      ? business.owned_whatsapp_business_accounts[0]?.id
      : undefined;
    const client = Array.isArray(business?.client_whatsapp_business_accounts)
      ? business.client_whatsapp_business_accounts[0]?.id
      : undefined;
    if (typeof owned === "string") return owned;
    if (typeof client === "string") return client;
  }
  throw bad("No WhatsApp Business Account found for this Meta account");
}
async function resolvePhone(
  token: string,
  wabaId: string,
  preferred: string | null,
  options: ProviderOptions,
): Promise<GraphPhone> {
  const response = await fetchGraphJson(
    `${base(options)}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier&access_token=${encodeURIComponent(token)}`,
    {},
    options,
  );
  const phones = Array.isArray(response.data) ? response.data : [];
  if (!phones.length)
    throw bad(
      "No phone numbers found under the selected WhatsApp Business Account",
    );
  return decodePhone(
    phones.find((phone) => phone?.id === preferred) ?? phones[0],
    "Failed to decode phone number",
  );
}
export async function completeEmbeddedSignup(
  pool: Pool,
  userId: string,
  orgId: string,
  code: string,
  wabaId: string | null,
  phoneId: string | null,
  options: ProviderOptions,
) {
  const token = await exchangeCode(code, options);
  const waba = await resolveWaba(token, wabaId, options);
  const phone = await resolvePhone(token, waba, phoneId, options);
  const result = await connectConnection(
    pool,
    userId,
    orgId,
    waba,
    phone.id,
    token,
    phone.display_phone_number ?? null,
    "whatsapp_embedded_signup",
    options,
  );
  return {
    ...result,
    diagnostics: [
      {
        step: "exchange_code",
        ok: true,
        detail: "Authorization code exchanged for access token.",
      },
      { step: "resolve_waba", ok: true, detail: `Selected WABA: ${waba}` },
      {
        step: "resolve_phone",
        ok: true,
        detail: `Selected phone number id: ${phone.id}`,
      },
    ],
  };
}
async function refreshInner(
  pool: Pool,
  orgId: string,
  id: string,
  options: ProviderOptions,
) {
  const connection = await getConnectionIncludingInactive(pool, orgId, id);
  if (!connection) throw missing("Connection not found");
  const token = decryptSocialSecret(
    options.config,
    connection.access_token_encrypted,
  );
  const phone = await fetchPhone(token, connection.phone_number_id, options);
  const permissions = await inspectedPermissions(
    token,
    connection.auth_method,
    options,
  );
  await pool.query(SQL.refresh_connection_inner[0], [
    label(phone),
    mapQualityRating(phone.quality_rating),
    verified(phone),
    estimateDailyLimit(phone.messaging_limit_tier) ?? defaultLimit(options),
    permissions,
    id,
  ]);
  const refreshed = await getConnectionIncludingInactive(pool, orgId, id);
  if (!refreshed) throw internal("Failed to reload connection");
  await projection.recordSourceHealth(
    pool,
    orgId,
    "WHATSAPP",
    id,
    true,
    null,
    null,
  );
  await pool.query(SQL.refresh_connection_inner[1], [
    addWhatsappCapabilityChecks(
      permissions ?? connection.provider_permissions,
      true,
      true,
    ),
    id,
  ]);
  return {
    connection: publicConnection(refreshed),
    messagingLimitTier: phone.messaging_limit_tier ?? null,
  };
}
export async function refreshWhatsappConnection(
  pool: Pool,
  orgId: string,
  id: string,
  options: ProviderOptions,
) {
  let record = false;
  try {
    record =
      (await getConnectionIncludingInactive(pool, orgId, id)) !== undefined;
  } catch {
    /* source records only known attempts */
  }
  const attemptId = createId(),
    startedAt = performance.now();
  let outcome = "succeeded",
    failureClass = "none";
  try {
    return await refreshInner(pool, orgId, id, options);
  } catch (error) {
    outcome = "failed";
    failureClass =
      error instanceof ApiError
        ? projection.providerSyncFailureClass(error)
        : "internal";
    throw error;
  } finally {
    if (record) {
      try {
        await projection.recordProviderSyncOutcome(
          pool,
          orgId,
          id,
          "WHATSAPP",
          "connection_refresh",
          attemptId,
          outcome,
          failureClass,
          Math.floor(performance.now() - startedAt),
        );
      } catch {
        /* analytics recording must not replace the provider outcome */
      }
    }
  }
}
export async function updateWhatsappAccessToken(
  pool: Pool,
  orgId: string,
  id: string,
  token: string,
  options: ProviderOptions,
) {
  const connection = await getConnectionIncludingInactive(pool, orgId, id);
  if (!connection) throw missing("Connection not found");
  if (!token.trim()) throw bad("Access token is required");
  const phone = await fetchPhone(token, connection.phone_number_id, options);
  const permissions = await inspectedPermissions(
    token,
    connection.auth_method,
    options,
  );
  await pool.query(SQL.update_connection_access_token[0], [
    encryptSocialSecret(options.config, token),
    label(phone, connection.phone_display_number),
    mapQualityRating(phone.quality_rating),
    verified(phone),
    estimateDailyLimit(phone.messaging_limit_tier) ?? defaultLimit(options),
    permissions,
    id,
  ]);
  const updated = await getConnectionIncludingInactive(pool, orgId, id);
  if (!updated) throw internal("Failed to reload connection");
  let webhookError: string | null = null;
  try {
    await subscribe(token, updated.waba_id, options);
  } catch (error) {
    webhookError = errorMessage(error);
  }
  await projection.recordSourceHealth(
    pool,
    orgId,
    "WHATSAPP",
    id,
    webhookError === null,
    webhookError === null ? "HEALTHY" : "FAILED",
    webhookError,
  );
  await pool.query(SQL.update_connection_access_token[1], [
    addWhatsappCapabilityChecks(
      permissions ?? connection.provider_permissions,
      webhookError === null,
      true,
    ),
    id,
  ]);
  return {
    connection: publicConnection(updated),
    webhookSubscribed: webhookError === null,
    webhookError,
  };
}
export async function whatsappConnectionHealth(
  pool: Pool,
  orgId: string,
  id: string,
  options: ProviderOptions,
) {
  const connection = await getConnectionIncludingInactive(pool, orgId, id);
  if (!connection) throw missing("Connection not found");
  const token = decryptSocialSecret(
    options.config,
    connection.access_token_encrypted,
  );
  let tokenValid = false,
    webhookSubscribed = false,
    qualityRating = connection.current_quality_rating;
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  const permissions =
    (await inspectedPermissions(token, connection.auth_method, options)) ??
    connection.provider_permissions;
  try {
    const phone = await fetchPhone(token, connection.phone_number_id, options);
    tokenValid = true;
    qualityRating = mapQualityRating(phone.quality_rating);
    steps.push({
      step: "token_validation",
      ok: true,
      detail: "Access token can query phone number details.",
    });
  } catch (error) {
    steps.push({
      step: "token_validation",
      ok: false,
      detail: errorMessage(error),
    });
  }
  if (tokenValid) {
    try {
      const response = await fetchGraphJson(
        `${base(options)}/${connection.waba_id}/subscribed_apps?access_token=${encodeURIComponent(token)}`,
        {},
        options,
      );
      const apps = response.data ?? [];
      if (
        !Array.isArray(apps) ||
        apps.some(
          (app) =>
            !app ||
            typeof app !== "object" ||
            Array.isArray(app) ||
            (app.id != null && typeof app.id !== "string"),
        )
      ) {
        throw internal("Failed to decode Graph API response");
      }
      const appId =
        options.config.rawEnv.AUTH_META_APP_ID ??
        options.config.rawEnv.NEXT_PUBLIC_META_APP_ID;
      webhookSubscribed = apps.some(
        (app) => appId === undefined || app.id === appId,
      );
      steps.push({
        step: "webhook_subscription",
        ok: webhookSubscribed,
        detail: webhookSubscribed
          ? "WABA is subscribed to this app for webhooks."
          : "WABA is not subscribed to this app. Reconnect or resubscribe.",
      });
    } catch (error) {
      steps.push({
        step: "webhook_subscription",
        ok: false,
        detail: errorMessage(error),
      });
    }
  }
  await projection.recordSourceHealth(
    pool,
    orgId,
    "WHATSAPP",
    id,
    tokenValid && webhookSubscribed,
    webhookSubscribed ? "HEALTHY" : "FAILED",
    tokenValid && webhookSubscribed
      ? null
      : "WhatsApp token validation or webhook subscription failed",
  );
  await pool.query(SQL.connection_health[0], [
    addWhatsappCapabilityChecks(permissions, webhookSubscribed, tokenValid),
    id,
  ]);
  return {
    connection: {
      id,
      wabaId: connection.waba_id,
      phoneNumberId: connection.phone_number_id,
      phoneDisplayNumber: connection.phone_display_number,
      qualityRating,
      verified: connection.verified,
      dailyLimitEstimate: connection.daily_limit_estimate,
      updatedAt: connection.updated_at,
    },
    tokenValid,
    webhookSubscribed,
    healthy: tokenValid && webhookSubscribed,
    steps,
  };
}
