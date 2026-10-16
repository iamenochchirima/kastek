export const LOAD_COMMAND_0 = `SELECT "id", "idempotencyKey" AS idempotency_key,
               "deliveryId" AS delivery_id, "actorId" AS actor_id,
               "expectedStatus" AS expected_status,
               "expectedAttemptCount" AS expected_attempt_count,
               "approverIds" AS approver_ids, "status", "error", "result",
               "completedAt" AT TIME ZONE 'UTC' AS completed_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "AdminWebhookReplayCommand"
        WHERE "idempotencyKey" = $1`;

export const RECORD_AUDIT_0 = `INSERT INTO "AdminWebhookReplayAuditEvent"
           ("id", "commandId", "actorId", "action", "metadata")
           VALUES ($1, $2, $3, $4, $5)`;

export const LIST_FAILED_DELIVERIES_0 = `SELECT d."id", d."subscriptionId" AS subscription_id,
               s."orgId" AS organization_id, d."eventId" AS event_id,
               d."eventType" AS event_type, d."status",
               d."attemptCount" AS attempt_count,
               d."updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "PublicApiWebhookDelivery" d
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE d."status" = 'FAILED' AND s."status" = 'ACTIVE'
        ORDER BY d."updatedAt" DESC
        LIMIT $1`;

export const CREATE_0 = `SELECT d."id", d."status", d."attemptCount" AS attempt_count,
               s."status" AS subscription_status, d."eventType" AS event_type
        FROM "PublicApiWebhookDelivery" d
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE d."id" = $1
        FOR UPDATE`;

export const CREATE_1 = `INSERT INTO "AdminWebhookReplayCommand"
          ("id", "idempotencyKey", "deliveryId", "actorId", "expectedStatus",
           "expectedAttemptCount", "approverIds", "status", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, $6, ARRAY[$4]::TEXT[], 'awaiting_approval', NOW())
        RETURNING "id", "idempotencyKey" AS idempotency_key,
                  "deliveryId" AS delivery_id, "actorId" AS actor_id,
                  "expectedStatus" AS expected_status,
                  "expectedAttemptCount" AS expected_attempt_count,
                  "approverIds" AS approver_ids, "status", "error", "result",
                  "completedAt" AT TIME ZONE 'UTC' AS completed_at,
                  "createdAt" AT TIME ZONE 'UTC' AS created_at,
                  "updatedAt" AT TIME ZONE 'UTC' AS updated_at`;

export const GET_0 = `SELECT "id", "idempotencyKey" AS idempotency_key,
               "deliveryId" AS delivery_id, "actorId" AS actor_id,
               "expectedStatus" AS expected_status,
               "expectedAttemptCount" AS expected_attempt_count,
               "approverIds" AS approver_ids, "status", "error", "result",
               "completedAt" AT TIME ZONE 'UTC' AS completed_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "AdminWebhookReplayCommand" WHERE "id" = $1`;

export const APPROVE_0 = `SELECT "id", "idempotencyKey" AS idempotency_key,
               "deliveryId" AS delivery_id, "actorId" AS actor_id,
               "expectedStatus" AS expected_status,
               "expectedAttemptCount" AS expected_attempt_count,
               "approverIds" AS approver_ids, "status", "error", "result",
               "completedAt" AT TIME ZONE 'UTC' AS completed_at,
               "createdAt" AT TIME ZONE 'UTC' AS created_at,
               "updatedAt" AT TIME ZONE 'UTC' AS updated_at
        FROM "AdminWebhookReplayCommand"
        WHERE "id" = $1
        FOR UPDATE`;

export const APPROVE_1 = `UPDATE "AdminWebhookReplayCommand"
               SET "approverIds" = $2, "updatedAt" = NOW()
               WHERE "id" = $1`;

export const APPROVE_2 = `SELECT d."id", d."status", d."attemptCount" AS attempt_count,
               s."status" AS subscription_status, d."eventType" AS event_type
        FROM "PublicApiWebhookDelivery" d
        JOIN "PublicApiWebhookSubscription" s ON s."id" = d."subscriptionId"
        WHERE d."id" = $1
        FOR UPDATE`;

export const APPROVE_3 = `UPDATE "PublicApiWebhookDelivery"
        SET "status" = 'PENDING', "attemptCount" = 0,
            "nextAttemptAt" = NOW(), "lastStatusCode" = NULL,
            "lastError" = NULL, "deliveredAt" = NULL, "updatedAt" = NOW()
        WHERE "id" = $1 AND "status" = $2 AND "attemptCount" = $3`;

export const APPROVE_4 = `UPDATE "AdminWebhookReplayCommand"
           SET "approverIds" = $2, "status" = 'completed', "result" = $3,
               "completedAt" = NOW(), "updatedAt" = NOW()
           WHERE "id" = $1`;

export const FAIL_COMMAND_0 = `UPDATE "AdminWebhookReplayCommand"
           SET "approverIds" = $2, "status" = 'failed', "error" = $3,
               "updatedAt" = NOW()
           WHERE "id" = $1`;
