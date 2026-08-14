CREATE TYPE "ContentMediaKind" AS ENUM ('IMAGE', 'VIDEO');
CREATE TYPE "ContentMediaProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');
CREATE TYPE "ContentMediaScanStatus" AS ENUM ('PENDING', 'CLEAN', 'REJECTED', 'FAILED');

CREATE TABLE "ContentMediaAsset" (
    id TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    kind "ContentMediaKind" NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    checksum TEXT,
    width INTEGER,
    height INTEGER,
    "durationMs" INTEGER,
    "storageKey" TEXT NOT NULL,
    "previewStorageKey" TEXT,
    "processingStatus" "ContentMediaProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "scanStatus" "ContentMediaScanStatus" NOT NULL DEFAULT 'PENDING',
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentMediaAsset_pkey" PRIMARY KEY (id)
);

CREATE TABLE "ContentMediaRendition" (
    id TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    purpose TEXT NOT NULL,
    platform "SocialPlatform",
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    width INTEGER,
    height INTEGER,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentMediaRendition_pkey" PRIMARY KEY (id)
);

CREATE TABLE "SocialPostMedia" (
    id TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "altText" TEXT,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPostMedia_pkey" PRIMARY KEY (id)
);

CREATE TABLE "SocialPostVariantMedia" (
    id TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "postMediaId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "altText" TEXT,
    crop JSONB,
    metadata JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialPostVariantMedia_pkey" PRIMARY KEY (id)
);

ALTER TABLE "SocialPublishJob" ADD COLUMN "deliverySnapshot" JSONB;

CREATE UNIQUE INDEX "ContentMediaAsset_storageKey_key" ON "ContentMediaAsset"("storageKey");
CREATE INDEX "ContentMediaAsset_orgId_processingStatus_scanStatus_idx" ON "ContentMediaAsset"("orgId", "processingStatus", "scanStatus");
CREATE INDEX "ContentMediaAsset_orgId_checksum_idx" ON "ContentMediaAsset"("orgId", checksum);
CREATE INDEX "ContentMediaAsset_uploadedById_idx" ON "ContentMediaAsset"("uploadedById");

CREATE UNIQUE INDEX "ContentMediaRendition_storageKey_key" ON "ContentMediaRendition"("storageKey");
CREATE INDEX "ContentMediaRendition_assetId_purpose_idx" ON "ContentMediaRendition"("assetId", purpose);
CREATE INDEX "ContentMediaRendition_assetId_platform_idx" ON "ContentMediaRendition"("assetId", platform);

CREATE UNIQUE INDEX "SocialPostMedia_postId_assetId_key" ON "SocialPostMedia"("postId", "assetId");
CREATE UNIQUE INDEX "SocialPostMedia_postId_sortOrder_key" ON "SocialPostMedia"("postId", "sortOrder");
CREATE INDEX "SocialPostMedia_assetId_idx" ON "SocialPostMedia"("assetId");

CREATE UNIQUE INDEX "SocialPostVariantMedia_variantId_postMediaId_key" ON "SocialPostVariantMedia"("variantId", "postMediaId");
CREATE UNIQUE INDEX "SocialPostVariantMedia_variantId_sortOrder_key" ON "SocialPostVariantMedia"("variantId", "sortOrder");
CREATE INDEX "SocialPostVariantMedia_postMediaId_idx" ON "SocialPostVariantMedia"("postMediaId");

ALTER TABLE "ContentMediaAsset"
    ADD CONSTRAINT "ContentMediaAsset_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "ContentMediaAsset_uploadedById_fkey"
    FOREIGN KEY ("uploadedById") REFERENCES "User"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ContentMediaRendition"
    ADD CONSTRAINT "ContentMediaRendition_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "ContentMediaAsset"(id)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SocialPostMedia"
    ADD CONSTRAINT "SocialPostMedia_postId_fkey"
    FOREIGN KEY ("postId") REFERENCES "SocialPost"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "SocialPostMedia_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "ContentMediaAsset"(id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SocialPostVariantMedia"
    ADD CONSTRAINT "SocialPostVariantMedia_variantId_fkey"
    FOREIGN KEY ("variantId") REFERENCES "SocialPostVariant"(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "SocialPostVariantMedia_postMediaId_fkey"
    FOREIGN KEY ("postMediaId") REFERENCES "SocialPostMedia"(id)
    ON DELETE CASCADE ON UPDATE CASCADE;
