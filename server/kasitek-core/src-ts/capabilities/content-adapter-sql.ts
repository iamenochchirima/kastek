export const SQL = {
    "newest_connected_channel": [
        "SELECT id\n           FROM \"SocialChannelConnection\"\n           WHERE \"orgId\" = $1\n             AND platform = CAST($2 AS \"SocialPlatform\")\n             AND status = 'CONNECTED'::\"SocialChannelStatus\"\n           ORDER BY \"updatedAt\" DESC, \"createdAt\" DESC\n           LIMIT 1"
    ],
    "connected_channel_by_id": [
        "SELECT id\n           FROM \"SocialChannelConnection\"\n           WHERE id = $1\n             AND \"orgId\" = $2\n             AND status = 'CONNECTED'::\"SocialChannelStatus\"\n           LIMIT 1"
    ],
    "connected_channel_by_selector": [
        "SELECT id\n           FROM \"SocialChannelConnection\"\n           WHERE \"orgId\" = $1\n             AND platform = CAST($2 AS \"SocialPlatform\")\n             AND status = 'CONNECTED'::\"SocialChannelStatus\"\n             AND (\n                 id = $3\n                 OR lower(trim(coalesce(handle, ''))) = lower(trim($3))\n                 OR lower(trim(\"displayName\")) = lower(trim($3))\n             )\n           ORDER BY\n             CASE\n                 WHEN id = $3 THEN 0\n                 WHEN lower(trim(coalesce(handle, ''))) = lower(trim($3)) THEN 1\n                 ELSE 2\n             END,\n             \"updatedAt\" DESC,\n             \"createdAt\" DESC\n           LIMIT 1"
    ],
    "create_draft": [
        "SELECT \"ownerId\" FROM \"Organization\" WHERE id = $1"
    ],
    "update_draft": [
        "SELECT \"ownerId\" FROM \"Organization\" WHERE id = $1"
    ],
    "publish": [
        "UPDATE \"SocialPublishJob\"\n           SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{_kasitek_agent_idempotency_key}', to_jsonb($2::text), true), \"updatedAt\" = NOW()\n           WHERE id = $1\n             AND (\n               metadata->>'_kasitek_agent_idempotency_key' IS NULL\n               OR (\n                 status = 'FAILED'::\"SocialPublishJobStatus\"\n                 AND metadata->>'_kasitek_agent_idempotency_key' = $3\n               )\n             )"
    ],
    "schedule": [
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        "SELECT id FROM \"SocialPost\" WHERE \"orgId\" = $1 AND metadata->>'_kasitek_agent_schedule_idempotency_key' = $2 LIMIT 1",
        "UPDATE \"SocialPost\"\n           SET status = 'SCHEDULED'::\"SocialPostStatus\", \"scheduledFor\" = $2, metadata = $3, \"updatedAt\" = NOW()\n           WHERE id = $1 AND \"orgId\" = $4",
        "UPDATE \"SocialPublishJob\"\n           SET status = 'QUEUED'::\"SocialPublishJobStatus\", \"scheduledFor\" = $2, \"updatedAt\" = NOW()\n           WHERE \"postId\" = $1 AND status IN ('PENDING'::\"SocialPublishJobStatus\", 'FAILED'::\"SocialPublishJobStatus\", 'QUEUED'::\"SocialPublishJobStatus\")"
    ],
    "unschedule": [
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        "SELECT status::text, metadata FROM \"SocialPost\" WHERE id = $1 AND \"orgId\" = $2",
        "UPDATE \"SocialPost\"\n           SET status = 'DRAFT'::\"SocialPostStatus\", \"scheduledFor\" = NULL, metadata = $3, \"updatedAt\" = NOW()\n           WHERE id = $1 AND \"orgId\" = $2",
        "UPDATE \"SocialPublishJob\"\n           SET status = 'PENDING'::\"SocialPublishJobStatus\", \"scheduledFor\" = NULL, \"updatedAt\" = NOW()\n           WHERE \"postId\" = $1 AND status = 'QUEUED'::\"SocialPublishJobStatus\""
    ],
    "delete_post": [
        "SELECT status::text FROM \"SocialPost\" WHERE id = $1 AND \"orgId\" = $2"
    ]
} as const;
