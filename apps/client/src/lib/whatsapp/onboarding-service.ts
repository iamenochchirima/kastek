import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/whatsapp/crypto";
import { syncWhatsappTemplates } from "@/lib/whatsapp/template-service";

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

type GraphPhoneNumber = {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  quality_rating?: string;
  code_verification_status?: string;
  name_status?: string;
  messaging_limit_tier?: string;
};

type EmbeddedSignupCompleteInput = {
  userId: string;
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
};

type ManualConnectionInput = {
  userId: string;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  phoneDisplayNumber?: string;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function mapQualityRating(value?: string): "GREEN" | "YELLOW" | "RED" | "UNKNOWN" {
  const normalized = value?.toUpperCase();
  if (normalized === "GREEN") return "GREEN";
  if (normalized === "YELLOW") return "YELLOW";
  if (normalized === "RED") return "RED";
  return "UNKNOWN";
}

async function fetchGraphJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & {
    error?: {
      message?: string;
      code?: number;
      error_subcode?: number;
    };
  };

  if (!response.ok) {
    throw new Error(
      `Graph API request failed (${response.status}): ${body.error?.message || "Unknown error"}`
    );
  }

  return body;
}

async function exchangeCodeForAccessToken(code: string): Promise<string> {
  const clientId = getRequiredEnv("AUTH_META_APP_ID");
  const clientSecret = getRequiredEnv("AUTH_META_APP_SECRET");

  const shortToken = await fetchGraphJson<{ access_token?: string }>(
    `${GRAPH_BASE}/oauth/access_token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&code=${encodeURIComponent(code)}`
  );

  const firstToken = shortToken.access_token;
  if (!firstToken) {
    throw new Error("Meta OAuth exchange did not return an access token");
  }

  // Best effort long-lived token exchange. If this fails, continue with short token.
  try {
    const longToken = await fetchGraphJson<{ access_token?: string }>(
      `${GRAPH_BASE}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&fb_exchange_token=${encodeURIComponent(firstToken)}`
    );

    if (longToken.access_token) {
      return longToken.access_token;
    }
  } catch {
    // no-op fallback to first token
  }

  return firstToken;
}

async function resolveWabaId(accessToken: string, preferredWabaId?: string): Promise<string> {
  if (preferredWabaId) return preferredWabaId;

  const businesses = await fetchGraphJson<{
    data?: Array<{
      owned_whatsapp_business_accounts?: Array<{ id: string }>;
      client_whatsapp_business_accounts?: Array<{ id: string }>;
    }>;
  }>(
    `${GRAPH_BASE}/me/businesses?fields=id,owned_whatsapp_business_accounts{id},client_whatsapp_business_accounts{id}&access_token=${encodeURIComponent(accessToken)}`
  );

  const firstBusiness = businesses.data?.[0];
  const firstOwned = firstBusiness?.owned_whatsapp_business_accounts?.[0]?.id;
  const firstClient = firstBusiness?.client_whatsapp_business_accounts?.[0]?.id;

  const resolved = firstOwned || firstClient;
  if (!resolved) {
    throw new Error("No WhatsApp Business Account found for this Meta account");
  }

  return resolved;
}

async function resolvePhoneNumber(
  accessToken: string,
  wabaId: string,
  preferredPhoneNumberId?: string
): Promise<GraphPhoneNumber> {
  const response = await fetchGraphJson<{ data?: GraphPhoneNumber[] }>(
    `${GRAPH_BASE}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status&access_token=${encodeURIComponent(accessToken)}`
  );

  const phones = response.data || [];
  if (!phones.length) {
    throw new Error("No phone numbers found under the selected WhatsApp Business Account");
  }

  if (preferredPhoneNumberId) {
    const exact = phones.find((phone) => phone.id === preferredPhoneNumberId);
    if (exact) return exact;
  }

  return phones[0];
}

async function subscribeWabaWebhook(accessToken: string, wabaId: string): Promise<void> {
  await fetchGraphJson<{ success?: boolean }>(
    `${GRAPH_BASE}/${wabaId}/subscribed_apps`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscribed_fields: [
          "messages",
          "message_template_status_update",
          "message_template_quality_update",
          "message_template_components_update",
        ],
        access_token: accessToken,
      }),
    }
  );
}

function estimateDailyLimitFromTier(tier?: string): number | null {
  const normalized = tier?.toUpperCase();
  if (normalized === "TIER_1") return 1000;
  if (normalized === "TIER_2") return 10000;
  if (normalized === "TIER_3") return 100000;
  if (normalized === "TIER_4") return 1_000_000;
  return null;
}

async function fetchConnectionPhone(accessToken: string, phoneNumberId: string) {
  return fetchGraphJson<GraphPhoneNumber>(
    `${GRAPH_BASE}/${phoneNumberId}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status,messaging_limit_tier&access_token=${encodeURIComponent(accessToken)}`
  );
}

export async function connectManualWhatsappConnection(input: ManualConnectionInput) {
  const diagnostics: Array<{ step: string; ok: boolean; detail: string }> = [];

  const accessToken = input.accessToken.trim();
  const phoneNumberId = input.phoneNumberId.trim();
  const wabaId = input.wabaId.trim();

  if (!accessToken || !phoneNumberId || !wabaId) {
    throw new Error("WABA ID, phone number ID, and access token are required");
  }

  const phone = await fetchConnectionPhone(accessToken, phoneNumberId);
  diagnostics.push({
    step: "validate_phone",
    ok: true,
    detail: `Phone number validated: ${phone.id}`,
  });

  const existing = await prisma.whatsappConnection.findUnique({
    where: {
      phoneNumberId,
    },
    select: {
      id: true,
      userId: true,
    },
  });

  if (existing && existing.userId !== input.userId) {
    throw new Error("This WhatsApp number is already connected to another account");
  }

  const encryptedToken = encryptSecret(accessToken);
  const defaultDailyLimit = Number(process.env.WHATSAPP_DEFAULT_DAILY_LIMIT || "250");

  const connection = await prisma.whatsappConnection.upsert({
    where: {
      phoneNumberId,
    },
    update: {
      userId: input.userId,
      wabaId,
      phoneDisplayNumber:
        input.phoneDisplayNumber?.trim() || phone.display_phone_number || null,
      accessTokenEncrypted: encryptedToken,
      currentQualityRating: mapQualityRating(phone.quality_rating),
      verified:
        phone.code_verification_status === "VERIFIED" ||
        phone.name_status === "APPROVED" ||
        false,
      dailyLimitEstimate:
        estimateDailyLimitFromTier(phone.messaging_limit_tier) || defaultDailyLimit,
    },
    create: {
      userId: input.userId,
      wabaId,
      phoneNumberId,
      phoneDisplayNumber:
        input.phoneDisplayNumber?.trim() || phone.display_phone_number || null,
      accessTokenEncrypted: encryptedToken,
      currentQualityRating: mapQualityRating(phone.quality_rating),
      verified:
        phone.code_verification_status === "VERIFIED" ||
        phone.name_status === "APPROVED" ||
        false,
      dailyLimitEstimate:
        estimateDailyLimitFromTier(phone.messaging_limit_tier) || defaultDailyLimit,
    },
    select: {
      id: true,
      phoneNumberId: true,
      phoneDisplayNumber: true,
      wabaId: true,
      currentQualityRating: true,
      verified: true,
      dailyLimitEstimate: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  diagnostics.push({
    step: "save_connection",
    ok: true,
    detail: "Connection saved and token encrypted.",
  });

  let webhookSubscribed = true;
  let webhookError: string | null = null;

  try {
    await subscribeWabaWebhook(accessToken, wabaId);
    diagnostics.push({
      step: "subscribe_webhook",
      ok: true,
      detail: "Webhook subscribed to messages events.",
    });
  } catch (error) {
    webhookSubscribed = false;
    webhookError = error instanceof Error ? error.message : "Webhook subscription failed";
    diagnostics.push({
      step: "subscribe_webhook",
      ok: false,
      detail: webhookError,
    });
  }

  let templateSync = {
    attempted: true,
    success: true,
    fetched: 0,
    marketing: 0,
    synced: 0,
    error: null as string | null,
  };

  try {
    const syncResult = await syncWhatsappTemplates(accessToken, input.userId, wabaId, connection.id);
    templateSync = {
      ...templateSync,
      fetched: syncResult.fetched,
      marketing: syncResult.marketing,
      synced: syncResult.synced,
    };
    diagnostics.push({
      step: "sync_templates",
      ok: true,
      detail: `Synced ${syncResult.synced} WhatsApp templates.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Template sync failed";
    templateSync = {
      ...templateSync,
      success: false,
      error: message,
    };
    diagnostics.push({
      step: "sync_templates",
      ok: false,
      detail: message,
    });
  }

  return {
    connection,
    webhookSubscribed,
    webhookError,
    templateSync,
    diagnostics,
  };
}

export async function syncWhatsappConnectionTemplates(userId: string, connectionId: string) {
  const connection = await prisma.whatsappConnection.findFirst({
    where: {
      id: connectionId,
      userId,
    },
    select: {
      id: true,
      wabaId: true,
      accessTokenEncrypted: true,
    },
  });

  if (!connection) {
    throw new Error("Connection not found");
  }

  const accessToken = decryptSecret(connection.accessTokenEncrypted);
  const syncResult = await syncWhatsappTemplates(
    accessToken,
    userId,
    connection.wabaId,
    connection.id
  );

  return {
    connectionId: connection.id,
    ...syncResult,
  };
}

export async function refreshWhatsappConnection(userId: string, connectionId: string) {
  const connection = await prisma.whatsappConnection.findFirst({
    where: {
      id: connectionId,
      userId,
    },
    select: {
      id: true,
      accessTokenEncrypted: true,
      phoneNumberId: true,
    },
  });

  if (!connection) {
    throw new Error("Connection not found");
  }

  const accessToken = decryptSecret(connection.accessTokenEncrypted);
  const phone = await fetchConnectionPhone(accessToken, connection.phoneNumberId);
  const defaultDailyLimit = Number(process.env.WHATSAPP_DEFAULT_DAILY_LIMIT || "250");

  const updated = await prisma.whatsappConnection.update({
    where: {
      id: connection.id,
    },
    data: {
      phoneDisplayNumber: phone.display_phone_number || null,
      currentQualityRating: mapQualityRating(phone.quality_rating),
      verified:
        phone.code_verification_status === "VERIFIED" ||
        phone.name_status === "APPROVED" ||
        false,
      dailyLimitEstimate:
        estimateDailyLimitFromTier(phone.messaging_limit_tier) || defaultDailyLimit,
    },
    select: {
      id: true,
      phoneNumberId: true,
      phoneDisplayNumber: true,
      wabaId: true,
      currentQualityRating: true,
      verified: true,
      dailyLimitEstimate: true,
      updatedAt: true,
    },
  });

  return {
    connection: updated,
    messagingLimitTier: phone.messaging_limit_tier || null,
  };
}

export async function updateWhatsappConnectionAccessToken(
  userId: string,
  connectionId: string,
  accessTokenInput: string
) {
  const accessToken = accessTokenInput.trim();
  if (!accessToken) {
    throw new Error("Access token is required");
  }

  const connection = await prisma.whatsappConnection.findFirst({
    where: {
      id: connectionId,
      userId,
    },
    select: {
      id: true,
      wabaId: true,
      phoneNumberId: true,
      phoneDisplayNumber: true,
    },
  });

  if (!connection) {
    throw new Error("Connection not found");
  }

  const diagnostics: Array<{ step: string; ok: boolean; detail: string }> = [];
  const phone = await fetchConnectionPhone(accessToken, connection.phoneNumberId);
  diagnostics.push({
    step: "validate_token",
    ok: true,
    detail: `Access token validated for phone ${phone.id}.`,
  });

  const defaultDailyLimit = Number(process.env.WHATSAPP_DEFAULT_DAILY_LIMIT || "250");
  const encryptedToken = encryptSecret(accessToken);

  const updated = await prisma.whatsappConnection.update({
    where: {
      id: connection.id,
    },
    data: {
      accessTokenEncrypted: encryptedToken,
      phoneDisplayNumber: connection.phoneDisplayNumber || phone.display_phone_number || null,
      currentQualityRating: mapQualityRating(phone.quality_rating),
      verified:
        phone.code_verification_status === "VERIFIED" ||
        phone.name_status === "APPROVED" ||
        false,
      dailyLimitEstimate:
        estimateDailyLimitFromTier(phone.messaging_limit_tier) || defaultDailyLimit,
    },
    select: {
      id: true,
      phoneNumberId: true,
      phoneDisplayNumber: true,
      wabaId: true,
      currentQualityRating: true,
      verified: true,
      dailyLimitEstimate: true,
      updatedAt: true,
    },
  });
  diagnostics.push({
    step: "save_token",
    ok: true,
    detail: "Encrypted token saved to the connection.",
  });

  let webhookSubscribed = true;
  let webhookError: string | null = null;

  try {
    await subscribeWabaWebhook(accessToken, connection.wabaId);
    diagnostics.push({
      step: "subscribe_webhook",
      ok: true,
      detail: "Webhook subscription refreshed for this connection.",
    });
  } catch (error) {
    webhookSubscribed = false;
    webhookError = error instanceof Error ? error.message : "Webhook subscription failed";
    diagnostics.push({
      step: "subscribe_webhook",
      ok: false,
      detail: webhookError,
    });
  }

  return {
    connection: updated,
    webhookSubscribed,
    webhookError,
    diagnostics,
  };
}

export async function completeEmbeddedSignup(input: EmbeddedSignupCompleteInput) {
  const diagnostics: Array<{ step: string; ok: boolean; detail: string }> = [];

  const accessToken = await exchangeCodeForAccessToken(input.code);
  diagnostics.push({
    step: "exchange_code",
    ok: true,
    detail: "Authorization code exchanged for access token.",
  });

  const wabaId = await resolveWabaId(accessToken, input.wabaId);
  diagnostics.push({
    step: "resolve_waba",
    ok: true,
    detail: `Selected WABA: ${wabaId}`,
  });

  const phone = await resolvePhoneNumber(accessToken, wabaId, input.phoneNumberId);
  diagnostics.push({
    step: "resolve_phone",
    ok: true,
    detail: `Selected phone number id: ${phone.id}`,
  });

  const existing = await prisma.whatsappConnection.findUnique({
    where: {
      phoneNumberId: phone.id,
    },
    select: {
      id: true,
      userId: true,
    },
  });

  if (existing && existing.userId !== input.userId) {
    throw new Error("This WhatsApp number is already connected to another account");
  }

  const encryptedToken = encryptSecret(accessToken);
  const defaultDailyLimit = Number(process.env.WHATSAPP_DEFAULT_DAILY_LIMIT || "250");

  const connection = await prisma.whatsappConnection.upsert({
    where: {
      phoneNumberId: phone.id,
    },
    update: {
      userId: input.userId,
      wabaId,
      phoneDisplayNumber: phone.display_phone_number || null,
      accessTokenEncrypted: encryptedToken,
      currentQualityRating: mapQualityRating(phone.quality_rating),
      verified:
        phone.code_verification_status === "VERIFIED" ||
        phone.name_status === "APPROVED" ||
        false,
      dailyLimitEstimate: defaultDailyLimit,
    },
    create: {
      userId: input.userId,
      wabaId,
      phoneNumberId: phone.id,
      phoneDisplayNumber: phone.display_phone_number || null,
      accessTokenEncrypted: encryptedToken,
      currentQualityRating: mapQualityRating(phone.quality_rating),
      verified:
        phone.code_verification_status === "VERIFIED" ||
        phone.name_status === "APPROVED" ||
        false,
      dailyLimitEstimate: defaultDailyLimit,
    },
    select: {
      id: true,
      phoneNumberId: true,
      phoneDisplayNumber: true,
      wabaId: true,
      currentQualityRating: true,
      verified: true,
      dailyLimitEstimate: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  diagnostics.push({
    step: "save_connection",
    ok: true,
    detail: "Connection saved and token encrypted.",
  });

  let webhookSubscribed = true;
  let webhookError: string | null = null;

  try {
    await subscribeWabaWebhook(accessToken, wabaId);
    diagnostics.push({
      step: "subscribe_webhook",
      ok: true,
      detail: "Webhook subscribed to messages events.",
    });
  } catch (error) {
    webhookSubscribed = false;
    webhookError = error instanceof Error ? error.message : "Webhook subscription failed";
    diagnostics.push({
      step: "subscribe_webhook",
      ok: false,
      detail: webhookError,
    });
  }

  let templateSync = {
    attempted: true,
    success: true,
    fetched: 0,
    marketing: 0,
    synced: 0,
    error: null as string | null,
  };

  try {
    const syncResult = await syncWhatsappTemplates(
      accessToken,
      input.userId,
      wabaId,
      connection.id
    );

    templateSync = {
      ...templateSync,
      fetched: syncResult.fetched,
      marketing: syncResult.marketing,
      synced: syncResult.synced,
    };

    diagnostics.push({
      step: "sync_templates",
      ok: true,
      detail: `Synced ${syncResult.synced} WhatsApp templates.`,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Template sync failed";

    templateSync = {
      ...templateSync,
      success: false,
      error: message,
    };

    diagnostics.push({
      step: "sync_templates",
      ok: false,
      detail: message,
    });
  }

  return {
    connection,
    webhookSubscribed,
    webhookError,
    templateSync,
    diagnostics,
  };
}
