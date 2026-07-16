BEGIN;

INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES
  ('billing-user-a', 'billing-a@example.test', NOW(), NOW()),
  ('billing-user-b', 'billing-b@example.test', NOW(), NOW());
INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt") VALUES
  ('billing-org-a', 'Billing A', 'billing-test-a', 'billing-user-a', NOW(), NOW()),
  ('billing-org-b', 'Billing B', 'billing-test-b', 'billing-user-b', NOW(), NOW());
INSERT INTO "Product" (id, key, name, active, "createdAt", "updatedAt")
VALUES ('billing-product', 'billing-test', 'Billing Test', true, NOW(), NOW());
INSERT INTO "ProductPlan" (id, "productId", key, name, interval, currency, "amountMinor", active, "createdAt", "updatedAt")
VALUES ('billing-plan', 'billing-product', 'billing-test-monthly', 'Test Monthly', 'MONTHLY', 'ZAR', 10000, true, NOW(), NOW());
INSERT INTO "PlanEntitlement" (id, "planId", key, value, "createdAt", "updatedAt") VALUES
  ('billing-entitlement-access', 'billing-plan', 'product.billing-test.enabled', 'true', NOW(), NOW()),
  ('billing-entitlement-limit', 'billing-plan', 'limit.billing-test.actions', '10', NOW(), NOW());
INSERT INTO "OrganizationSubscription" (id, "orgId", "planId", status, provider, "providerSubscriptionId", "createdAt", "updatedAt")
VALUES ('billing-subscription', 'billing-org-a', 'billing-plan', 'ACTIVE', 'paystack', 'SUB_TEST', NOW(), NOW());

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "orgId" = 'billing-org-a' AND status = 'ACTIVE') <> 1 THEN
    RAISE EXCEPTION 'active organisation subscription was not visible';
  END IF;
  IF (SELECT COUNT(*) FROM "OrganizationSubscription" WHERE "orgId" = 'billing-org-b') <> 0 THEN
    RAISE EXCEPTION 'subscription leaked across organisations';
  END IF;
END $$;

INSERT INTO "UsageEvent" (id, "orgId", "productKey", "metricKey", quantity, "idempotencyKey", "occurredAt", "createdAt")
VALUES ('usage-a', 'billing-org-a', 'billing-test', 'actions', 3, 'billing-usage-key', NOW(), NOW())
ON CONFLICT ("idempotencyKey") DO NOTHING;
INSERT INTO "UsageEvent" (id, "orgId", "productKey", "metricKey", quantity, "idempotencyKey", "occurredAt", "createdAt")
VALUES ('usage-b', 'billing-org-a', 'billing-test', 'actions', 3, 'billing-usage-key', NOW(), NOW())
ON CONFLICT ("idempotencyKey") DO NOTHING;

DO $$
BEGIN
  IF (SELECT SUM(quantity) FROM "UsageEvent" WHERE "orgId" = 'billing-org-a' AND "metricKey" = 'actions') <> 3 THEN
    RAISE EXCEPTION 'usage idempotency failed';
  END IF;
END $$;

INSERT INTO "BillingCheckout" (id, reference, "idempotencyKey", "orgId", "planId", "userId", email, provider, status, "createdAt", "updatedAt")
VALUES ('checkout-a', 'billing-reference-a', 'billing-checkout-key', 'billing-org-a', 'billing-plan', 'billing-user-a', 'billing-a@example.test', 'paystack', 'PENDING', NOW(), NOW())
ON CONFLICT ("orgId", provider, "idempotencyKey") DO NOTHING;
INSERT INTO "BillingCheckout" (id, reference, "idempotencyKey", "orgId", "planId", "userId", email, provider, status, "createdAt", "updatedAt")
VALUES ('checkout-b', 'billing-reference-b', 'billing-checkout-key', 'billing-org-a', 'billing-plan', 'billing-user-a', 'billing-a@example.test', 'paystack', 'PENDING', NOW(), NOW())
ON CONFLICT ("orgId", provider, "idempotencyKey") DO NOTHING;

DO $$
BEGIN
  IF (SELECT COUNT(*) FROM "BillingCheckout" WHERE "orgId" = 'billing-org-a') <> 1 THEN
    RAISE EXCEPTION 'checkout idempotency failed';
  END IF;
END $$;

INSERT INTO "BillingReconciliationIssue" (id, fingerprint, "orgId", provider, "resourceType", "resourceId", "issueType", status, details, "createdAt", "updatedAt")
VALUES ('billing-issue', 'paystack:subscription:SUB_TEST:state_mismatch', 'billing-org-a', 'paystack', 'subscription', 'SUB_TEST', 'state_mismatch', 'OPEN', '{}', NOW(), NOW());
UPDATE "BillingReconciliationIssue" SET status = 'RESOLVED', "resolvedAt" = NOW(), "updatedAt" = NOW()
WHERE fingerprint = 'paystack:subscription:SUB_TEST:state_mismatch';

DO $$
BEGIN
  IF (SELECT status FROM "BillingReconciliationIssue" WHERE id = 'billing-issue') <> 'RESOLVED' THEN
    RAISE EXCEPTION 'reconciliation issue lifecycle failed';
  END IF;
END $$;

ROLLBACK;
