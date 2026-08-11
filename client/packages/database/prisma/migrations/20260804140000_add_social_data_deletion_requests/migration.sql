CREATE TABLE "SocialDataDeletionRequest" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialDataDeletionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialDataDeletionRequest_confirmationCode_key"
    ON "SocialDataDeletionRequest"("confirmationCode");

CREATE INDEX "SocialDataDeletionRequest_provider_status_idx"
    ON "SocialDataDeletionRequest"("provider", "status");
