// Actual Rust lifecycle queries.
export const SQL = {
  load_publish_job: [
    '\n        SELECT j.id, j."userId" AS user_id, j."orgId" AS org_id, j."postId" AS post_id, j."variantId" AS variant_id,\n               j."channelConnectionId" AS channel_connection_id, j.platform::text AS platform,\n               j.status::text AS status, j."externalPostId" AS external_post_id,\n               p.content AS post_content, p.metadata AS post_metadata, j.metadata AS job_metadata, j."deliverySnapshot" AS delivery_snapshot,\n               p."primaryChannelId" AS post_primary_channel_id,\n               v.content AS variant_content,\n               COALESCE((\n                   SELECT jsonb_agg(jsonb_build_object(\n                       \'assetId\', pm."assetId",\n                       \'_assetOrgId\', a."orgId",\n                       \'kind\', a.kind::text,\n                       \'mimeType\', a."mimeType",\n                       \'byteSize\', a."byteSize",\n                       \'altText\', pm."altText",\n                       \'sortOrder\', pm."sortOrder"\n                   ) ORDER BY pm."sortOrder" ASC)\n                   FROM "SocialPostMedia" pm\n                   LEFT JOIN "ContentMediaAsset" a ON a.id = pm."assetId"\n                   WHERE pm."postId" = p.id\n               ), \'[]\'::jsonb) AS media\n        FROM "SocialPublishJob" j\n        JOIN "SocialPost" p ON p.id = j."postId"\n        LEFT JOIN "SocialPostVariant" v ON v.id = j."variantId"\n        WHERE j.id = $1\n        LIMIT 1\n        ',
  ],
  claim_publish_job: [
    '\n        UPDATE "SocialPublishJob"\n        SET status = \'PROCESSING\'::"SocialPublishJobStatus", "errorMessage" = NULL, "updatedAt" = NOW()\n        WHERE id = $1 AND status <> \'PUBLISHED\'::"SocialPublishJobStatus" AND status = ANY(ARRAY(SELECT unnest($2::text[])::"SocialPublishJobStatus")) AND "externalPostId" IS NULL AND COALESCE(metadata->>\'_kasitek_outcome\', \'\') <> \'UNKNOWN\'\n        ',
  ],
  mark_job_failed: [
    '\n        UPDATE "SocialPublishJob"\n        SET status = \'FAILED\'::"SocialPublishJobStatus", "errorMessage" = $1,\n            metadata = (COALESCE(metadata, \'{}\'::jsonb) - \'_kasitek_outcome\') || $2,\n            "updatedAt" = NOW()\n        WHERE id = $3\n          AND status IN (\n              \'PENDING\'::"SocialPublishJobStatus",\n              \'QUEUED\'::"SocialPublishJobStatus",\n              \'PROCESSING\'::"SocialPublishJobStatus"\n          )\n        ',
    "\n        UPDATE \"SocialPost\"\n        SET status = CASE WHEN $2 = 'UNKNOWN' THEN 'PROCESSING'::\"SocialPostStatus\" ELSE 'FAILED'::\"SocialPostStatus\" END,\n            metadata = COALESCE(metadata, '{}'::jsonb) || $1,\n            \"updatedAt\" = NOW()\n        WHERE id = $3\n        ",
  ],
  process_due_social_publish_jobs: [
    '\n        SELECT id\n        FROM "SocialPublishJob"\n        WHERE status = \'QUEUED\'::"SocialPublishJobStatus"\n          AND ("scheduledFor" IS NULL OR "scheduledFor" <= NOW())\n        ORDER BY "scheduledFor" ASC NULLS FIRST, "createdAt" ASC\n        LIMIT $1\n        ',
  ],
  reconcile_tiktok_publish_jobs: [
    '\n        SELECT job.id, job."postId" AS post_id, job."orgId" AS org_id,\n               job."channelConnectionId" AS channel_connection_id, job."externalPostId" AS publish_id\n        FROM "SocialPublishJob" job\n        WHERE job.status=\'PROCESSING\'::"SocialPublishJobStatus" AND job.platform=\'TIKTOK\'::"SocialPlatform"\n          AND job."externalPostId" IS NOT NULL AND job."channelConnectionId" IS NOT NULL AND job."orgId" IS NOT NULL\n        ORDER BY job."updatedAt" ASC LIMIT $1',
    'UPDATE "SocialPublishJob" SET status=\'PUBLISHED\'::"SocialPublishJobStatus",\n                    "publishedAt"=$1,"externalPostId"=$2,metadata=COALESCE(metadata,\'{}\'::jsonb)||$3,"updatedAt"=NOW()\n                    WHERE id=$4 AND status=\'PROCESSING\'::"SocialPublishJobStatus"',
    'UPDATE "SocialPost" SET status=\'PUBLISHED\'::"SocialPostStatus","publishedAt"=$1,\n                    metadata=COALESCE(metadata,\'{}\'::jsonb)||$2,"updatedAt"=NOW() WHERE id=$3',
  ],
  find_tiktok_webhook_job: [
    '\n        SELECT job.id, job."orgId" AS org_id,\n               job."externalPostId" AS external_post_id\n        FROM "SocialPublishJob" job\n        JOIN "SocialChannelConnection" channel ON channel.id = job."channelConnectionId"\n        WHERE job.platform = \'TIKTOK\'::"SocialPlatform"\n          AND (job."externalPostId" = $1 OR job.metadata->>\'publishId\' = $1)\n          AND ($2::text IS NULL OR channel."externalAccountId" = $2)\n          AND job."orgId" IS NOT NULL\n        ORDER BY job."updatedAt" DESC\n        LIMIT 1\n    ',
  ],
  complete_tiktok_job_from_webhook: [
    '\n        UPDATE "SocialPublishJob"\n        SET status = \'PUBLISHED\'::"SocialPublishJobStatus", "publishedAt" = NOW(),\n            "externalPostId" = COALESCE($2, "externalPostId"), "errorMessage" = NULL,\n            metadata = COALESCE(metadata, \'{}\'::jsonb) || $3, "updatedAt" = NOW()\n        WHERE id = $1 AND status = \'PROCESSING\'::"SocialPublishJobStatus"\n        RETURNING "postId"\n    ',
    '\n        UPDATE "SocialPost"\n        SET status = \'PUBLISHED\'::"SocialPostStatus", "publishedAt" = NOW(),\n            metadata = COALESCE(metadata, \'{}\'::jsonb) || $1, "updatedAt" = NOW()\n        WHERE id = $2\n    ',
  ],
  fail_tiktok_job_from_webhook: [
    '\n        UPDATE "SocialPublishJob"\n        SET status = \'FAILED\'::"SocialPublishJobStatus", "errorMessage" = $2,\n            metadata = COALESCE(metadata, \'{}\'::jsonb) || $3, "updatedAt" = NOW()\n        WHERE id = $1 AND status = \'PROCESSING\'::"SocialPublishJobStatus"\n        RETURNING "postId"\n    ',
    'UPDATE "SocialPost" SET status=\'FAILED\'::"SocialPostStatus",\n        metadata=COALESCE(metadata, \'{}\'::jsonb)||$1, "updatedAt"=NOW() WHERE id=$2',
  ],
  process_tiktok_webhook_events: [],
  remove_threads_connection_data: [
    '\n        SELECT DISTINCT "orgId"\n        FROM "SocialChannelConnection"\n        WHERE platform = \'THREADS\'::"SocialPlatform"\n          AND "externalAccountId" = $1\n          AND "orgId" IS NOT NULL\n        ',
    '\n        UPDATE "SocialPost"\n        SET "primaryChannelId" = CASE\n                WHEN "primaryChannelId" IN (\n                    SELECT id\n                    FROM "SocialChannelConnection"\n                    WHERE platform = \'THREADS\'::"SocialPlatform"\n                      AND "externalAccountId" = $1\n                ) THEN NULL\n                ELSE "primaryChannelId"\n            END,\n            metadata = CASE\n                WHEN metadata->>\'latestPublishedPlatform\' = \'THREADS\'\n                    THEN metadata - \'latestPublishedPostId\' - \'latestPublishedPlatform\'\n                ELSE metadata\n            END,\n            "updatedAt" = NOW()\n        WHERE "primaryChannelId" IN (\n                  SELECT id\n                  FROM "SocialChannelConnection"\n                  WHERE platform = \'THREADS\'::"SocialPlatform"\n                    AND "externalAccountId" = $1\n              )\n           OR id IN (\n                  SELECT job."postId"\n                  FROM "SocialPublishJob" job\n                  JOIN "SocialChannelConnection" channel\n                    ON channel.id = job."channelConnectionId"\n                  WHERE channel.platform = \'THREADS\'::"SocialPlatform"\n                    AND channel."externalAccountId" = $1\n              )\n        ',
    '\n        UPDATE "SocialPublishJob"\n        SET "externalPostId" = NULL,\n            metadata = NULL,\n            "channelConnectionId" = NULL,\n            "updatedAt" = NOW()\n        WHERE "channelConnectionId" IN (\n            SELECT id\n            FROM "SocialChannelConnection"\n            WHERE platform = \'THREADS\'::"SocialPlatform"\n              AND "externalAccountId" = $1\n        )\n        ',
    '\n        DELETE FROM "SocialChannelConnection"\n        WHERE platform = \'THREADS\'::"SocialPlatform"\n          AND "externalAccountId" = $1\n        ',
    '\n            INSERT INTO "SocialDataDeletionRequest"\n                (id, provider, "confirmationCode", status, "completedAt", "createdAt", "updatedAt")\n            VALUES ($1, \'THREADS\', $2, \'COMPLETED\', NOW(), NOW(), NOW())\n            ',
  ],
  threads_data_deletion_status: [
    '\n        SELECT status\n        FROM "SocialDataDeletionRequest"\n        WHERE provider = \'THREADS\' AND "confirmationCode" = $1\n        LIMIT 1\n        ',
  ],
  save_bluesky_deletion_nonce: [
    'UPDATE "SocialChannelConnection"\n           SET metadata = COALESCE(metadata, \'{}\'::jsonb) || $1, "updatedAt" = NOW()\n           WHERE id = $2',
  ],
  execute_social_publish_job: [
    'UPDATE "SocialChannelConnection"\n                               SET status=\'NEEDS_REAUTH\'::"SocialChannelStatus",\n                                   metadata=COALESCE(metadata,\'{}\'::jsonb)||$1,\n                                   "updatedAt"=NOW()\n                               WHERE id=$2 AND "orgId"=$3',
    'UPDATE "SocialChannelConnection" SET metadata=COALESCE(metadata,\'{}\'::jsonb)||$1,"updatedAt"=NOW() WHERE id=$2',
    'UPDATE "SocialPublishJob" SET status=\'PROCESSING\'::"SocialPublishJobStatus",\n                    "externalPostId"=$1, "channelConnectionId"=$2, metadata=$3, "updatedAt"=NOW() WHERE id=$4',
    'UPDATE "SocialPost" SET status=\'PROCESSING\'::"SocialPostStatus", "updatedAt"=NOW() WHERE id=$1',
    '\n                UPDATE "SocialPublishJob"\n                SET status = \'PUBLISHED\'::"SocialPublishJobStatus",\n                    "publishedAt" = $1,\n                    "externalPostId" = $2,\n                    "errorMessage" = NULL,\n                    "channelConnectionId" = $3,\n                    metadata = $4,\n                    "updatedAt" = NOW()\n                WHERE id = $5\n                ',
    '\n                UPDATE "SocialPost"\n                SET status = \'PUBLISHED\'::"SocialPostStatus",\n                    "publishedAt" = $1,\n                    "primaryChannelId" = COALESCE("primaryChannelId", $2),\n                    metadata = COALESCE(metadata, \'{}\'::jsonb) || $3,\n                    "updatedAt" = NOW()\n                WHERE id = $4\n                ',
  ],
  claim_tiktok_webhook_event: [
    '\n        UPDATE "SocialWebhookEvent"\n        SET status = \'PROCESSING\', attempts = attempts + 1, "updatedAt" = NOW()\n        WHERE id = (\n            SELECT id FROM "SocialWebhookEvent"\n            WHERE provider = \'TIKTOK\' AND attempts < 8\n              AND ((status IN (\'RECEIVED\', \'FAILED\') AND "nextAttemptAt" <= NOW())\n                OR (status = \'PROCESSING\' AND "updatedAt" < NOW() - INTERVAL \'5 minutes\'))\n            ORDER BY "receivedAt" ASC\n            FOR UPDATE SKIP LOCKED\n            LIMIT 1\n        )\n        RETURNING id, "eventType" AS event_type, "externalAccountId" AS external_account_id, payload, attempts\n    ',
  ],
  finish_tiktok_webhook_event: [
    '\n        UPDATE "SocialWebhookEvent"\n        SET status = $2,\n            "errorMessage" = $3,\n            "processedAt" = CASE WHEN $2 IN (\'PROCESSED\', \'IGNORED\') THEN NOW() ELSE NULL END,\n            "nextAttemptAt" = CASE WHEN $4 THEN NOW() + INTERVAL \'30 seconds\' ELSE "nextAttemptAt" END,\n            "updatedAt" = NOW()\n        WHERE id = $1\n    ',
  ],
  process_tiktok_webhook_event: [
    '\n                UPDATE "SocialChannelConnection" SET status=\'NEEDS_REAUTH\'::"SocialChannelStatus",\n                    "accessToken"=NULL, "refreshToken"=NULL,\n                    metadata=COALESCE(metadata, \'{}\'::jsonb)||$1, "updatedAt"=NOW()\n                WHERE platform=\'TIKTOK\'::"SocialPlatform" AND "externalAccountId"=$2 AND "orgId" IS NOT NULL\n                RETURNING "orgId"\n            ',
  ],
  resolve_channel_for_post_deletion: [
    '\n        SELECT id, "userId" AS user_id, platform::text AS platform, status::text AS status,\n               "displayName" AS display_name, handle, "externalAccountId" AS external_account_id,\n               "accessToken" AS access_token, "refreshToken" AS refresh_token,\n               metadata, "lastSyncedAt" AT TIME ZONE \'UTC\' AS last_synced_at,\n               "createdAt" AT TIME ZONE \'UTC\' AS created_at,\n               "updatedAt" AT TIME ZONE \'UTC\' AS updated_at\n        FROM "SocialChannelConnection"\n        WHERE id = $1 AND "orgId" = $2 AND platform = $3::"SocialPlatform"\n          AND status = \'CONNECTED\'::"SocialChannelStatus"\n        LIMIT 1\n        ',
  ],
  delete_social_post_from_platforms_internal: [
    'UPDATE "SocialPublishJob"\n                   SET status = \'CANCELED\'::"SocialPublishJobStatus",\n                       "errorMessage" = $2,\n                       "updatedAt" = NOW()\n                   WHERE id = $1 AND "postId" = $3 AND status = \'PUBLISHED\'::"SocialPublishJobStatus"',
    'SELECT COUNT(*) FROM "SocialPublishJob"\n               WHERE "postId" = $1 AND status = \'PUBLISHED\'::"SocialPublishJobStatus"',
  ],
} as const;
