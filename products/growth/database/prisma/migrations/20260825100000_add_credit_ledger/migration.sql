-- Credit balances are consumable usage accounting. They are deliberately
-- separate from feature entitlements and the legacy UsageEvent meters.

CREATE TABLE "CreditAccount" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "reservedBalance" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAccount_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditAccount_balance_check" CHECK ("balance" >= 0),
    CONSTRAINT "CreditAccount_reservedBalance_check" CHECK ("reservedBalance" >= 0 AND "reservedBalance" <= "balance")
);

CREATE UNIQUE INDEX "CreditAccount_orgId_key" ON "CreditAccount"("orgId");
ALTER TABLE "CreditAccount"
  ADD CONSTRAINT "CreditAccount_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreditGrant" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "remainingAmount" BIGINT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "reason" TEXT,
    "reference" TEXT,
    "createdByAdminId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditGrant_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "CreditGrant_remaining_check" CHECK ("remainingAmount" >= 0 AND "remainingAmount" <= "amount"),
    CONSTRAINT "CreditGrant_source_check" CHECK ("source" IN ('PLAN', 'TRIAL', 'REFERRAL', 'PURCHASE', 'MANUAL', 'PROMOTIONAL', 'MIGRATION', 'COMPENSATION'))
);

CREATE INDEX "CreditGrant_orgId_endsAt_startsAt_idx"
  ON "CreditGrant"("orgId", "endsAt", "startsAt");
CREATE INDEX "CreditGrant_accountId_remainingAmount_idx"
  ON "CreditGrant"("accountId", "remainingAmount");
ALTER TABLE "CreditGrant"
  ADD CONSTRAINT "CreditGrant_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditGrant"
  ADD CONSTRAINT "CreditGrant_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreditLedgerEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "grantId" TEXT,
    "type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "balanceAfter" BIGINT NOT NULL,
    "actionKey" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "idempotencyKey" TEXT,
    "pricingVersion" TEXT,
    "createdByAdminId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditLedgerEntry_balanceAfter_check" CHECK ("balanceAfter" >= 0),
    CONSTRAINT "CreditLedgerEntry_type_check" CHECK ("type" IN ('GRANT', 'RESERVE', 'DEBIT', 'REFUND', 'RELEASE', 'EXPIRY', 'ADJUSTMENT'))
);

CREATE UNIQUE INDEX "CreditLedgerEntry_idempotencyKey_key"
  ON "CreditLedgerEntry"("idempotencyKey");
CREATE INDEX "CreditLedgerEntry_orgId_createdAt_idx"
  ON "CreditLedgerEntry"("orgId", "createdAt");
CREATE INDEX "CreditLedgerEntry_accountId_createdAt_idx"
  ON "CreditLedgerEntry"("accountId", "createdAt");
CREATE INDEX "CreditLedgerEntry_orgId_type_createdAt_idx"
  ON "CreditLedgerEntry"("orgId", "type", "createdAt");
ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_grantId_fkey"
  FOREIGN KEY ("grantId") REFERENCES "CreditGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CreditReservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "estimatedCredits" BIGINT NOT NULL,
    "capturedCredits" BIGINT NOT NULL DEFAULT 0,
    "releasedCredits" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "sourceType" TEXT,
    "sourceId" TEXT,
    "pricingVersion" TEXT,
    "idempotencyKey" TEXT,
    "expiresAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditReservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditReservation_estimated_check" CHECK ("estimatedCredits" > 0),
    CONSTRAINT "CreditReservation_status_check" CHECK ("status" IN ('RESERVED', 'CAPTURED', 'RELEASED', 'EXPIRED'))
);

CREATE UNIQUE INDEX "CreditReservation_idempotencyKey_key"
  ON "CreditReservation"("idempotencyKey");
CREATE INDEX "CreditReservation_orgId_status_expiresAt_idx"
  ON "CreditReservation"("orgId", "status", "expiresAt");
CREATE INDEX "CreditReservation_accountId_createdAt_idx"
  ON "CreditReservation"("accountId", "createdAt");
ALTER TABLE "CreditReservation"
  ADD CONSTRAINT "CreditReservation_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditReservation"
  ADD CONSTRAINT "CreditReservation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreditUsageEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ledgerEntryId" TEXT,
    "actionKey" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL DEFAULT 1,
    "creditsCharged" BIGINT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "fundingSource" TEXT,
    "inputTokens" BIGINT,
    "outputTokens" BIGINT,
    "providerCostUsd" DECIMAL(18,8),
    "pricingVersion" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditUsageEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditUsageEvent_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "CreditUsageEvent_credits_check" CHECK ("creditsCharged" >= 0)
);

CREATE UNIQUE INDEX "CreditUsageEvent_ledgerEntryId_key"
  ON "CreditUsageEvent"("ledgerEntryId");
CREATE UNIQUE INDEX "CreditUsageEvent_idempotencyKey_key"
  ON "CreditUsageEvent"("idempotencyKey");
CREATE INDEX "CreditUsageEvent_orgId_actionKey_createdAt_idx"
  ON "CreditUsageEvent"("orgId", "actionKey", "createdAt");
CREATE INDEX "CreditUsageEvent_accountId_createdAt_idx"
  ON "CreditUsageEvent"("accountId", "createdAt");
ALTER TABLE "CreditUsageEvent"
  ADD CONSTRAINT "CreditUsageEvent_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditUsageEvent"
  ADD CONSTRAINT "CreditUsageEvent_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditUsageEvent"
  ADD CONSTRAINT "CreditUsageEvent_ledgerEntryId_fkey"
  FOREIGN KEY ("ledgerEntryId") REFERENCES "CreditLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "CreditAdminOperation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "amount" BIGINT,
    "source" TEXT,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "actorId" TEXT NOT NULL,
    "beforeBalance" BIGINT NOT NULL,
    "afterBalance" BIGINT NOT NULL,
    "beforeReservedBalance" BIGINT NOT NULL DEFAULT 0,
    "afterReservedBalance" BIGINT NOT NULL DEFAULT 0,
    "ledgerEntryId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditAdminOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditAdminOperation_status_check" CHECK ("status" IN ('COMPLETED', 'FAILED', 'PENDING'))
);

CREATE UNIQUE INDEX "CreditAdminOperation_idempotencyKey_key"
  ON "CreditAdminOperation"("idempotencyKey");
CREATE INDEX "CreditAdminOperation_orgId_createdAt_idx"
  ON "CreditAdminOperation"("orgId", "createdAt");
CREATE INDEX "CreditAdminOperation_actorId_createdAt_idx"
  ON "CreditAdminOperation"("actorId", "createdAt");
CREATE INDEX "CreditAdminOperation_operationType_createdAt_idx"
  ON "CreditAdminOperation"("operationType", "createdAt");
ALTER TABLE "CreditAdminOperation"
  ADD CONSTRAINT "CreditAdminOperation_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "CreditAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditAdminOperation"
  ADD CONSTRAINT "CreditAdminOperation_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
