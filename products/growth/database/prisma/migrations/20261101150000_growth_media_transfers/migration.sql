CREATE TABLE IF NOT EXISTS "GrowthMediaTransfer" (
  id text PRIMARY KEY,
  "orgId" text NOT NULL,
  "userId" text NOT NULL,
  "principalId" text NOT NULL,
  "principalKind" text NOT NULL,
  "requestKey" text NOT NULL,
  "fileName" text,
  "mimeType" text NOT NULL,
  "byteSize" bigint NOT NULL CHECK ("byteSize" > 0 AND "byteSize" <= 536870912),
  "expectedChecksum" text,
  checksum text,
  "storageKey" text,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','UPLOADING','READY','FINALIZED','FAILED')),
  "assetId" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("orgId","principalKind","principalId","requestKey")
);
CREATE INDEX IF NOT EXISTS "GrowthMediaTransfer_expiry_idx" ON "GrowthMediaTransfer"("expiresAt");
CREATE INDEX IF NOT EXISTS "GrowthMediaTransfer_owner_idx" ON "GrowthMediaTransfer"("orgId","userId","principalKind","principalId");
