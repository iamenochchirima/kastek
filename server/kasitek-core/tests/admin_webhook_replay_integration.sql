-- Core-owned public webhook replay boundary. Run this file inside a test
-- database; the transaction is rolled back so it leaves no fixture rows.
BEGIN;

INSERT INTO "User" (id, email, "createdAt", "updatedAt")
VALUES ('webhook-replay-owner', 'webhook-replay-owner@example.test', NOW(), NOW());
INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt")
VALUES ('webhook-replay-org', 'Webhook Replay', 'webhook-replay-integration', 'webhook-replay-owner', NOW(), NOW());
INSERT INTO "PublicApiWebhookSubscription" (
  id, "orgId", url, "secretCiphertext", "eventTypes", status, "createdAt", "updatedAt"
) VALUES (
  'webhook-replay-subscription', 'webhook-replay-org', 'https://example.com/webhook', 'ciphertext',
  '["public_api.request.completed"]'::jsonb, 'ACTIVE', NOW(), NOW()
);
INSERT INTO "PublicApiWebhookDelivery" (
  id, "subscriptionId", "eventId", "eventType", payload, status, "attemptCount",
  "nextAttemptAt", "createdAt", "updatedAt"
) VALUES (
  'webhook-replay-delivery', 'webhook-replay-subscription', 'event-replay-1',
  'public_api.request.completed', '{"id":"event-replay-1"}'::jsonb, 'FAILED', 10,
  NOW(), NOW(), NOW()
);

INSERT INTO "AdminWebhookReplayCommand" (
  id, "idempotencyKey", "deliveryId", "actorId", "expectedStatus", "expectedAttemptCount",
  "approverIds", status, "createdAt", "updatedAt"
) VALUES (
  'webhook-replay-command', 'webhook-replay-idempotency', 'webhook-replay-delivery',
  'operator-a', 'FAILED', 10, ARRAY['operator-a']::text[], 'awaiting_approval', NOW(), NOW()
);
INSERT INTO "AdminWebhookReplayAuditEvent" (id, "commandId", "actorId", action, metadata)
VALUES ('webhook-replay-audit-request', 'webhook-replay-command', 'operator-a', 'replay_requested',
        '{"deliveryId":"webhook-replay-delivery","expectedAttemptCount":10}'::jsonb);

-- A distinct second operator can approve the exact version and queue it.
UPDATE "AdminWebhookReplayCommand"
SET "approverIds" = ARRAY['operator-a', 'operator-b']::text[], status = 'completed',
    result = '{"deliveryId":"webhook-replay-delivery","status":"PENDING","attemptCount":0}'::jsonb,
    "completedAt" = NOW(), "updatedAt" = NOW()
WHERE id = 'webhook-replay-command' AND status = 'awaiting_approval'
  AND "expectedStatus" = 'FAILED' AND "expectedAttemptCount" = 10;
UPDATE "PublicApiWebhookDelivery"
SET status = 'PENDING', "attemptCount" = 0, "nextAttemptAt" = NOW(),
    "lastStatusCode" = NULL, "lastError" = NULL, "deliveredAt" = NULL, "updatedAt" = NOW()
WHERE id = 'webhook-replay-delivery' AND status = 'FAILED' AND "attemptCount" = 10;
INSERT INTO "AdminWebhookReplayAuditEvent" (id, "commandId", "actorId", action, metadata)
VALUES ('webhook-replay-audit-queued', 'webhook-replay-command', 'operator-b', 'replay_queued',
        '{"deliveryId":"webhook-replay-delivery","previousAttemptCount":10}'::jsonb);

DO $$
BEGIN
  IF (SELECT status FROM "PublicApiWebhookDelivery" WHERE id = 'webhook-replay-delivery') <> 'PENDING' THEN
    RAISE EXCEPTION 'replay did not queue the failed delivery';
  END IF;
  IF (SELECT "attemptCount" FROM "PublicApiWebhookDelivery" WHERE id = 'webhook-replay-delivery') <> 0 THEN
    RAISE EXCEPTION 'replay did not reset the delivery attempt version';
  END IF;
  IF (SELECT cardinality("approverIds") FROM "AdminWebhookReplayCommand" WHERE id = 'webhook-replay-command') <> 2 THEN
    RAISE EXCEPTION 'replay did not retain both distinct approvers';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "AdminWebhookReplayAuditEvent"
    WHERE "commandId" = 'webhook-replay-command' AND metadata::text LIKE '%payload%'
  ) THEN
    RAISE EXCEPTION 'replay audit metadata leaked payload content';
  END IF;
END $$;

ROLLBACK;
