CREATE TABLE "GrowthOAuthClient" (
  id text PRIMARY KEY,
  name text NOT NULL,
  "redirectUris" text[] NOT NULL,
  "registrationIpHash" text,
  "createdAt" timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX "GrowthOAuthClient_registrationIpHash_createdAt_idx" ON "GrowthOAuthClient"("registrationIpHash", "createdAt");

CREATE TABLE "GrowthOAuthRequest" (
  hash text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "GrowthOAuthClient"(id),
  "redirectUri" text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  state text NOT NULL,
  challenge text NOT NULL,
  "userId" text,
  "createdAt" timestamptz NOT NULL DEFAULT NOW(),
  "expiresAt" timestamptz NOT NULL,
  "usedAt" timestamptz
);
CREATE INDEX "GrowthOAuthRequest_expiresAt_idx" ON "GrowthOAuthRequest"("expiresAt");

CREATE TABLE "GrowthOAuthCode" (
  hash text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "GrowthOAuthClient"(id),
  "userId" text NOT NULL,
  "orgId" text NOT NULL,
  "redirectUri" text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  challenge text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "usedAt" timestamptz
);

CREATE TABLE "GrowthOAuthConnection" (
  id text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "GrowthOAuthClient"(id),
  "userId" text NOT NULL,
  "orgId" text NOT NULL,
  resource text NOT NULL,
  scopes text[] NOT NULL,
  "accessHash" text NOT NULL UNIQUE,
  "accessExpiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT NOW(),
  "lastUsedAt" timestamptz
);
CREATE INDEX "GrowthOAuthConnection_userId_orgId_idx" ON "GrowthOAuthConnection"("userId", "orgId");

CREATE TABLE "GrowthOAuthRefresh" (
  hash text PRIMARY KEY,
  "connectionId" text NOT NULL REFERENCES "GrowthOAuthConnection"(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "usedAt" timestamptz
);
CREATE INDEX "GrowthOAuthRefresh_connectionId_idx" ON "GrowthOAuthRefresh"("connectionId");
