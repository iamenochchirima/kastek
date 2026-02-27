import { decryptSecret } from "@/lib/whatsapp/crypto";
import { prisma } from "@/lib/prisma";

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

type HealthCheckStep = {
  step: string;
  ok: boolean;
  detail: string;
};

type GraphSubscribedApps = {
  data?: Array<{ id?: string; name?: string }>;
};

type GraphPhoneInfo = {
  id?: string;
  quality_rating?: string;
  verified_name?: string;
};

async function fetchGraph<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T & {
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(body.error?.message || `Graph API failed (${response.status})`);
  }

  return body;
}

export async function getConnectionHealth(userId: string, connectionId: string) {
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
      accessTokenEncrypted: true,
      currentQualityRating: true,
      verified: true,
      dailyLimitEstimate: true,
      updatedAt: true,
    },
  });

  if (!connection) {
    throw new Error("Connection not found");
  }

  const appId = process.env.AUTH_META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID;

  const steps: HealthCheckStep[] = [];
  const token = decryptSecret(connection.accessTokenEncrypted);

  let tokenValid = false;
  let webhookSubscribed = false;
  let qualityRating = connection.currentQualityRating;

  try {
    const phoneInfo = await fetchGraph<GraphPhoneInfo>(
      `${GRAPH_BASE}/${connection.phoneNumberId}?fields=id,quality_rating,verified_name&access_token=${encodeURIComponent(token)}`
    );

    tokenValid = Boolean(phoneInfo.id);
    qualityRating = (phoneInfo.quality_rating?.toUpperCase() as typeof qualityRating) || qualityRating;

    steps.push({
      step: "token_validation",
      ok: tokenValid,
      detail: tokenValid ? "Access token can query phone number details." : "Token validation failed.",
    });
  } catch (error) {
    steps.push({
      step: "token_validation",
      ok: false,
      detail: error instanceof Error ? error.message : "Token validation failed",
    });
  }

  if (tokenValid) {
    try {
      const subscribedApps = await fetchGraph<GraphSubscribedApps>(
        `${GRAPH_BASE}/${connection.wabaId}/subscribed_apps?access_token=${encodeURIComponent(token)}`
      );

      webhookSubscribed = Boolean(
        subscribedApps.data?.some((app) => (appId ? app.id === appId : true))
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
        detail:
          error instanceof Error
            ? error.message
            : "Failed to verify webhook subscription",
      });
    }
  }

  return {
    connection: {
      id: connection.id,
      wabaId: connection.wabaId,
      phoneNumberId: connection.phoneNumberId,
      phoneDisplayNumber: connection.phoneDisplayNumber,
      qualityRating,
      verified: connection.verified,
      dailyLimitEstimate: connection.dailyLimitEstimate,
      updatedAt: connection.updatedAt,
    },
    tokenValid,
    webhookSubscribed,
    healthy: tokenValid && webhookSubscribed,
    steps,
  };
}
