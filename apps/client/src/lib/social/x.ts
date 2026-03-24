import crypto from "node:crypto";
import { SocialChannelStatus, SocialPlatform } from "@kasitek/database";
import { prisma } from "@/lib/prisma";
import { socialChannelPublicSelect } from "@/lib/social/db";
import { encryptSocialSecret, decryptSocialSecret } from "@/lib/social/crypto";
import { getRequiredSocialEnv, getSocialAppUrl } from "@/lib/social/env";

const X_AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_ME_URL = "https://api.x.com/2/users/me?user.fields=id,name,username,profile_image_url";
const X_POST_TWEET_URL = "https://api.x.com/2/tweets";

function base64Url(input: Buffer) {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getXClientId() {
  return getRequiredSocialEnv("AUTH_X_CLIENT_ID");
}

function getXClientSecret() {
  return process.env.AUTH_X_CLIENT_SECRET || "";
}

function getXRedirectUri() {
  return `${getSocialAppUrl()}/api/social/oauth/x/callback`;
}

function getXScopes() {
  return ["tweet.read", "tweet.write", "users.read", "offline.access"];
}

export function createXOAuthState() {
  const verifier = base64Url(crypto.randomBytes(48));
  const state = base64Url(crypto.randomBytes(24));
  const challenge = base64Url(
    crypto.createHash("sha256").update(verifier).digest(),
  );

  return { verifier, state, challenge };
}

export function buildXAuthorizeUrl({
  state,
  challenge,
}: {
  state: string;
  challenge: string;
}) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: getXClientId(),
    redirect_uri: getXRedirectUri(),
    scope: getXScopes().join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  return `${X_AUTHORIZE_URL}?${params.toString()}`;
}

type XTokenResponse = {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type XMeResponse = {
  data?: {
    id: string;
    name?: string;
    username?: string;
    profile_image_url?: string;
  };
};

async function fetchXJson<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json().catch(() => null)) as T | {
    title?: string;
    detail?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && payload !== null
        ? "detail" in payload && typeof payload.detail === "string"
          ? payload.detail
          : "error" in payload && typeof payload.error === "string"
            ? payload.error
            : "title" in payload && typeof payload.title === "string"
              ? payload.title
              : "X API request failed"
        : "X API request failed";
    throw new Error(message);
  }

  return payload as T;
}

export async function exchangeXCodeForTokens({
  code,
  codeVerifier,
}: {
  code: string;
  codeVerifier: string;
}) {
  const params = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    client_id: getXClientId(),
    redirect_uri: getXRedirectUri(),
    code_verifier: codeVerifier,
  });

  const clientSecret = getXClientSecret();
  const headers: HeadersInit = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(
      `${getXClientId()}:${clientSecret}`,
    ).toString("base64")}`;
  }

  const tokens = await fetchXJson<XTokenResponse>(X_TOKEN_URL, {
    method: "POST",
    headers,
    body: params.toString(),
  });

  if (!tokens.access_token) {
    throw new Error("X OAuth exchange did not return an access token");
  }

  return tokens;
}

export async function fetchXMe(accessToken: string) {
  const me = await fetchXJson<XMeResponse>(X_ME_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!me.data?.id) {
    throw new Error("X account lookup did not return a user");
  }

  return me.data;
}

export async function upsertXConnectionForUser({
  userId,
  tokens,
  profile,
}: {
  userId: string;
  tokens: XTokenResponse;
  profile: NonNullable<XMeResponse["data"]>;
}) {
  const now = Date.now();
  const expiresAt = tokens.expires_in ? new Date(now + tokens.expires_in * 1000) : null;

  return prisma.socialChannelConnection.upsert({
    where: {
      userId_platform_externalAccountId: {
        userId,
        platform: SocialPlatform.X,
        externalAccountId: profile.id,
      },
    },
    create: {
      userId,
      platform: SocialPlatform.X,
      status: SocialChannelStatus.CONNECTED,
      displayName: profile.name || profile.username || "X account",
      handle: profile.username ? `@${profile.username}` : null,
      externalAccountId: profile.id,
      accessToken: encryptSocialSecret(tokens.access_token as string),
      refreshToken: tokens.refresh_token
        ? encryptSocialSecret(tokens.refresh_token)
        : null,
      lastSyncedAt: new Date(),
      metadata: {
        provider: "x",
        tokenType: tokens.token_type || "bearer",
        scope: tokens.scope || getXScopes().join(" "),
        expiresAt: expiresAt?.toISOString() || null,
        avatarUrl: profile.profile_image_url || null,
      },
    },
    update: {
      status: SocialChannelStatus.CONNECTED,
      displayName: profile.name || profile.username || "X account",
      handle: profile.username ? `@${profile.username}` : null,
      accessToken: encryptSocialSecret(tokens.access_token as string),
      refreshToken: tokens.refresh_token
        ? encryptSocialSecret(tokens.refresh_token)
        : null,
      lastSyncedAt: new Date(),
      metadata: {
        provider: "x",
        tokenType: tokens.token_type || "bearer",
        scope: tokens.scope || getXScopes().join(" "),
        expiresAt: expiresAt?.toISOString() || null,
        avatarUrl: profile.profile_image_url || null,
      },
    },
    select: socialChannelPublicSelect,
  });
}

export async function publishPostToX({
  accessTokenEncrypted,
  text,
}: {
  accessTokenEncrypted: string;
  text: string;
}) {
  const accessToken = decryptSocialSecret(accessTokenEncrypted);

  const result = await fetchXJson<{ data?: { id: string; text?: string } }>(
    X_POST_TWEET_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
      }),
    },
  );

  if (!result.data?.id) {
    throw new Error("X publish did not return a post id");
  }

  return result.data;
}
