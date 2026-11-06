CREATE TABLE "GrowthAgentChannelGrant" (
  id uuid PRIMARY KEY,
  "orgId" text NOT NULL REFERENCES "Organization"(id) ON DELETE RESTRICT,
  "connectionId" text NOT NULL REFERENCES "ExternalConnection"(id) ON DELETE RESTRICT,
  provider text NOT NULL CHECK (provider IN ('facebook','instagram','whatsapp')),
  "providerAssetId" text NOT NULL CHECK (length("providerAssetId") BETWEEN 1 AND 512),
  "agentsWorkspaceId" uuid NOT NULL,
  "agentsAgentId" uuid NOT NULL,
  "agentsConnectionId" uuid NOT NULL,
  "intentId" uuid NOT NULL,
  "actorId" text NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  capabilities jsonb NOT NULL CHECK (capabilities = '["messaging.inbound","messaging.outbound"]'::jsonb),
  "permissionRevision" text NOT NULL CHECK (length("permissionRevision") BETWEEN 1 AND 128),
  "expiresAt" timestamptz DEFAULT (now() + interval '15 minutes'),
  state text NOT NULL CHECK (state IN ('pending','active','needs_attention','revoked')),
  "routeOwner" text NOT NULL CHECK ("routeOwner" IN ('agents','growth')),
  "requestId" uuid NOT NULL,
  "requestDigest" text NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "revokedAt" timestamptz,
  UNIQUE ("agentsWorkspaceId", "agentsConnectionId"),
  UNIQUE ("agentsWorkspaceId", "requestId"),
  UNIQUE ("agentsWorkspaceId", "intentId"),
  CHECK ((state = 'revoked') = ("revokedAt" IS NOT NULL)),
  CHECK ((state = 'pending' AND "expiresAt" IS NOT NULL AND "expiresAt" > "createdAt") OR
         (state <> 'pending' AND "expiresAt" IS NULL)),
  CHECK ((state IN ('pending','revoked') AND "routeOwner" = 'growth') OR (state IN ('active','needs_attention') AND "routeOwner" = 'agents'))
);

CREATE UNIQUE INDEX growth_agent_channel_grant_active_connection
  ON "GrowthAgentChannelGrant" ("connectionId") WHERE state IN ('pending','active','needs_attention');
CREATE UNIQUE INDEX growth_agent_channel_grant_active_asset
  ON "GrowthAgentChannelGrant" (provider,"providerAssetId") WHERE state IN ('pending','active','needs_attention');
CREATE INDEX growth_agent_channel_grant_workspace
  ON "GrowthAgentChannelGrant" ("agentsWorkspaceId","agentsAgentId",state);

CREATE TABLE "GrowthAgentChannelLinkIntent" (
  id uuid PRIMARY KEY,
  "actorId" text NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "orgId" text NOT NULL REFERENCES "Organization"(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('facebook','instagram','whatsapp')),
  "loginMode" text CHECK ("loginMode" IS NULL OR "loginMode" IN ('meta_login','instagram_login','whatsapp_embedded_signup')),
  "agentsWorkspaceId" uuid NOT NULL,
  "agentsAgentId" uuid NOT NULL,
  "agentsConnectionId" uuid,
  "requestId" uuid NOT NULL,
  "requestDigest" text NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  "returnRoute" text NOT NULL CHECK ("returnRoute" ~ '^/app/agents/[0-9a-f-]{36}\?section=channels$'),
  "connectionId" text REFERENCES "ExternalConnection"(id) ON DELETE RESTRICT,
  "providerAssetId" text,
  "permissionRevision" text,
  "oauthStateHash" text CHECK ("oauthStateHash" IS NULL OR "oauthStateHash" ~ '^[a-f0-9]{64}$'),
  "oauthStateExpiresAt" timestamptz,
  "authorizedAt" timestamptz,
  "codeHash" text CHECK ("codeHash" IS NULL OR "codeHash" ~ '^[a-f0-9]{64}$'),
  "codeExpiresAt" timestamptz,
  "completedAt" timestamptz,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("agentsWorkspaceId","requestId"),
  CHECK ("expiresAt" > "createdAt"),
  CHECK (("connectionId" IS NULL AND "providerAssetId" IS NULL AND "permissionRevision" IS NULL) OR
         ("connectionId" IS NOT NULL AND "providerAssetId" IS NOT NULL AND "permissionRevision" IS NOT NULL)),
  CHECK (("codeHash" IS NULL) = ("codeExpiresAt" IS NULL)),
  CHECK (("oauthStateHash" IS NULL) = ("oauthStateExpiresAt" IS NULL)),
  CHECK ("completedAt" IS NULL OR "codeHash" IS NOT NULL)
);
CREATE INDEX growth_agent_channel_link_intent_expiry ON "GrowthAgentChannelLinkIntent" ("expiresAt");
CREATE INDEX growth_agent_channel_link_intent_code ON "GrowthAgentChannelLinkIntent" ("codeHash","codeExpiresAt")
  WHERE "codeHash" IS NOT NULL;

CREATE TABLE "GrowthAgentChannelSend" (
  "deliveryId" uuid PRIMARY KEY,
  "grantId" uuid NOT NULL REFERENCES "GrowthAgentChannelGrant"(id) ON DELETE RESTRICT,
  "requestDigest" text NOT NULL CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('sending','accepted','failed','unknown')),
  "providerMessageId" text,
  code text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX growth_agent_channel_send_grant ON "GrowthAgentChannelSend" ("grantId","createdAt");

CREATE TABLE "GrowthAgentChannelEvent" (
  id uuid PRIMARY KEY,
  "grantId" uuid NOT NULL REFERENCES "GrowthAgentChannelGrant"(id) ON DELETE RESTRICT,
  "eventId" text NOT NULL CHECK (length("eventId") BETWEEN 1 AND 512),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','delivered','quarantined')),
  attempts integer NOT NULL DEFAULT 0,
  "availableAt" timestamptz NOT NULL DEFAULT now(),
  "leaseUntil" timestamptz,
  "claimId" uuid,
  reason text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "deliveredAt" timestamptz,
  UNIQUE ("grantId","eventId")
);
CREATE INDEX growth_agent_channel_event_pending
  ON "GrowthAgentChannelEvent" ("availableAt","createdAt") WHERE state IN ('pending','processing');
