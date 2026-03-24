import crypto from "node:crypto";
import { SocialChannelStatus, SocialPlatform } from "@kasitek/database";
import { prisma } from "@/lib/prisma";
import { socialChannelPublicSelect } from "@/lib/social/db";
import { encryptSocialSecret, decryptSocialSecret } from "@/lib/social/crypto";
import { getRequiredSocialEnv, getSocialAppUrl } from "@/lib/social/env";

const LINKEDIN_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const LINKEDIN_UGC_POSTS_URL = "https://api.linkedin.com/v2/ugcPosts";

function getLinkedInClientId() {
  return getRequiredSocialEnv("AUTH_LINKEDIN_CLIENT_ID");
}

function getLinkedInClientSecret() {
  return getRequiredSocialEnv("AUTH_LINKEDIN_CLIENT_SECRET");
}

function getLinkedInRedirectUri() {
  return `${getSocialAppUrl()}/api/social/oauth/linkedin/callback`;
}

function getLinkedInScopes() {
  return ["openid", "profile", "email", "w_member_social"];
}

function createRandomState() {
  return crypto.randomUUID().replace(/-/g, "");
}

type LinkedInTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
};

type LinkedInUserInfoResponse = {
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  email?: string;
};

function base64BasicAuth(clientId: string, clientSecret: string) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
}

async function fetchLinkedInJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ payload: T; response: Response }> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as
    | T
    | {
        error?: string;
        error_description?: string;
        message?: string;
      }
    | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && payload !== null
        ? "error_description" in payload && typeof payload.error_description === "string"
          ? payload.error_description
          : "message" in payload && typeof payload.message === "string"
            ? payload.message
            : "error" in payload && typeof payload.error === "string"
              ? payload.error
              : "LinkedIn API request failed"
        : "LinkedIn API request failed";
    throw new Error(message);
  }

  return {
    payload: payload as T,
    response,
  };
}

export function createLinkedInOAuthState() {
  return createRandomState();
}

export function buildLinkedInAuthorizeUrl(state: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getLinkedInClientId(),
    redirect_uri: getLinkedInRedirectUri(),
    state,
    scope: getLinkedInScopes().join(" "),
  });

  return `${LINKEDIN_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeLinkedInCodeForTokens(code: string) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: getLinkedInClientId(),
    client_secret: getLinkedInClientSecret(),
    redirect_uri: getLinkedInRedirectUri(),
  });

  const { payload } = await fetchLinkedInJson<LinkedInTokenResponse>(LINKEDIN_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${base64BasicAuth(getLinkedInClientId(), getLinkedInClientSecret())}`,
    },
    body: params.toString(),
  });

  if (!payload.access_token) {
    throw new Error("LinkedIn OAuth exchange did not return an access token");
  }

  return payload;
}

export async function fetchLinkedInProfile(accessToken: string) {
  const { payload } = await fetchLinkedInJson<LinkedInUserInfoResponse>(LINKEDIN_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!payload.sub) {
    throw new Error("LinkedIn profile lookup did not return a member identifier");
  }

  return payload;
}

export async function upsertLinkedInConnectionForUser({
  userId,
  tokens,
  profile,
}: {
  userId: string;
  tokens: LinkedInTokenResponse;
  profile: LinkedInUserInfoResponse & { sub: string };
}) {
  const now = Date.now();
  const expiresAt = tokens.expires_in ? new Date(now + tokens.expires_in * 1000) : null;

  return prisma.socialChannelConnection.upsert({
    where: {
      userId_platform_externalAccountId: {
        userId,
        platform: SocialPlatform.LINKEDIN,
        externalAccountId: profile.sub,
      },
    },
    create: {
      userId,
      platform: SocialPlatform.LINKEDIN,
      status: SocialChannelStatus.CONNECTED,
      displayName: profile.name || "LinkedIn profile",
      handle: null,
      externalAccountId: profile.sub,
      accessToken: encryptSocialSecret(tokens.access_token as string),
      refreshToken: tokens.refresh_token ? encryptSocialSecret(tokens.refresh_token) : null,
      lastSyncedAt: new Date(),
      metadata: {
        provider: "linkedin",
        scope: tokens.scope || getLinkedInScopes().join(" "),
        expiresAt: expiresAt?.toISOString() || null,
        picture: profile.picture || null,
        email: profile.email || null,
        actorUrn: `urn:li:person:${profile.sub}`,
      },
    },
    update: {
      status: SocialChannelStatus.CONNECTED,
      displayName: profile.name || "LinkedIn profile",
      handle: null,
      accessToken: encryptSocialSecret(tokens.access_token as string),
      refreshToken: tokens.refresh_token ? encryptSocialSecret(tokens.refresh_token) : null,
      lastSyncedAt: new Date(),
      metadata: {
        provider: "linkedin",
        scope: tokens.scope || getLinkedInScopes().join(" "),
        expiresAt: expiresAt?.toISOString() || null,
        picture: profile.picture || null,
        email: profile.email || null,
        actorUrn: `urn:li:person:${profile.sub}`,
      },
    },
    select: socialChannelPublicSelect,
  });
}

function getActorUrn({
  externalAccountId,
  metadata,
}: {
  externalAccountId?: string | null;
  metadata?: unknown;
}) {
  if (metadata && typeof metadata === "object" && metadata !== null) {
    const actorUrn = "actorUrn" in metadata ? metadata.actorUrn : null;
    if (typeof actorUrn === "string" && actorUrn.trim()) {
      return actorUrn;
    }
  }

  if (!externalAccountId) {
    throw new Error("LinkedIn connection is missing a member identifier");
  }

  return `urn:li:person:${externalAccountId}`;
}

export async function publishPostToLinkedIn({
  accessTokenEncrypted,
  externalAccountId,
  metadata,
  text,
}: {
  accessTokenEncrypted: string;
  externalAccountId?: string | null;
  metadata?: unknown;
  text: string;
}) {
  const accessToken = decryptSocialSecret(accessTokenEncrypted);
  const actorUrn = getActorUrn({ externalAccountId, metadata });

  const { payload, response } = await fetchLinkedInJson<{ id?: string }>(LINKEDIN_UGC_POSTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({
      author: actorUrn,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: {
            text,
          },
          shareMediaCategory: "NONE",
        },
      },
      visibility: {
        "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
      },
    }),
  });

  return {
    id: response.headers.get("x-restli-id") || payload.id || null,
    text,
  };
}
