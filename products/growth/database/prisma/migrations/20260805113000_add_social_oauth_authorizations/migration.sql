CREATE TABLE "SocialOAuthAuthorization" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "handle" TEXT,
    "pdsUrl" TEXT NOT NULL,
    "authorizationUrl" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "dpopPrivateKey" TEXT NOT NULL,
    "dpopNonce" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SocialOAuthAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialOAuthAuthorization_state_key" ON "SocialOAuthAuthorization"("state");
CREATE INDEX "SocialOAuthAuthorization_provider_expiresAt_idx" ON "SocialOAuthAuthorization"("provider", "expiresAt");

UPDATE "SocialChannelConnection"
SET status = 'NEEDS_REAUTH'::"SocialChannelStatus",
    "accessToken" = NULL,
    "refreshToken" = NULL,
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
      'authMethod', 'oauth',
      'legacyAppPasswordSessionRemovedAt', CURRENT_TIMESTAMP
    ),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE platform = 'BLUESKY'::"SocialPlatform"
  AND COALESCE(metadata->>'authMethod', '') <> 'oauth';
