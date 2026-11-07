export const QUERY_ROWS_0 = `WITH events AS (
          SELECT conversation.id, (conversation."createdAt" AT TIME ZONE 'UTC'), 'core', 'conversations', 'conversation.created', UPPER(conversation.status), 'info', 'system', NULL, conversation."orgId", 'conversation', conversation.id, NULL, jsonb_build_object('channel', conversation.channel)
          FROM "Conversation" conversation
          WHERE conversation."orgId" IS NOT NULL AND conversation."createdAt" >= $1 AND conversation."createdAt" < $2
          UNION ALL
          SELECT message.id, (message."timestamp" AT TIME ZONE 'UTC'), 'core', 'messaging', CASE WHEN message.sender = 'bot' THEN 'message.sent' ELSE 'message.received' END, 'RECORDED', 'info', message.sender, NULL, conversation."orgId", 'message', message.id, NULL, jsonb_build_object('channel', conversation.channel, 'sender', message.sender, 'contentType', message."contentType")
          FROM "Message" message JOIN "Conversation" conversation ON conversation.id = message."conversationId"
          WHERE conversation."orgId" IS NOT NULL AND message."timestamp" >= $1 AND message."timestamp" < $2
          UNION ALL
          SELECT send.id, (send."createdAt" AT TIME ZONE 'UTC'), 'core', 'campaigns', 'campaign.message', send.status::text, CASE WHEN send.status::text IN ('FAILED', 'BLOCKED') THEN 'error' ELSE 'info' END, 'system', NULL, send."orgId", 'whatsapp_send_event', send.id, NULL, jsonb_build_object('campaignId', send."campaignId", 'templateName', send."templateName")
          FROM "WhatsappSendEvent" send
          WHERE send."orgId" IS NOT NULL AND send."createdAt" >= $1 AND send."createdAt" < $2
          UNION ALL
          SELECT job.id, (job."createdAt" AT TIME ZONE 'UTC'), 'core', 'content', 'content.publish', job.status::text, CASE WHEN job.status::text = 'FAILED' THEN 'error' ELSE 'info' END, 'system', NULL, job."orgId", 'social_publish_job', job.id, NULL, jsonb_build_object('platform', job.platform::text)
          FROM "SocialPublishJob" job
          WHERE job."orgId" IS NOT NULL AND job."createdAt" >= $1 AND job."createdAt" < $2
          UNION ALL
          SELECT notification.id, (notification."createdAt" AT TIME ZONE 'UTC'), 'core', 'notifications', notification."eventType", notification.severity::text, LOWER(notification.severity::text), notification."actorType", notification."actorId", NULL, 'notification_event', notification.id, NULL, jsonb_build_object('entityType', notification."entityType", 'entityId', notification."entityId")
          FROM "NotificationEvent" notification
          WHERE notification."createdAt" >= $1 AND notification."createdAt" < $2
          UNION ALL
          SELECT audit.id, (audit."createdAt" AT TIME ZONE 'UTC'), 'core', 'security', audit.action, 'RECORDED', 'warning', 'admin', audit."actorId", access_grant."organizationId", 'support_access_audit', audit.id, NULL, jsonb_build_object('resourceType', access_grant."resourceType", 'resourceId', access_grant."resourceId")
          FROM "AdminSupportAccessAuditEvent" audit JOIN "AdminSupportAccessGrant" access_grant ON access_grant.id = audit."grantId"
          WHERE audit."createdAt" >= $1 AND audit."createdAt" < $2
          UNION ALL
          SELECT audit.id, (audit."createdAt" AT TIME ZONE 'UTC'), 'core', 'security', audit.action, 'RECORDED', 'warning', 'admin', audit."actorId", NULL, 'webhook_replay_audit', audit.id, NULL, jsonb_build_object('commandId', audit."commandId")
          FROM "AdminWebhookReplayAuditEvent" audit
          WHERE audit."createdAt" >= $1 AND audit."createdAt" < $2
          UNION ALL
          SELECT export.id, (export."createdAt" AT TIME ZONE 'UTC'), 'core', 'reports', 'report.export', export.status, 'info', 'admin', export."adminId", NULL, 'report_export', export.id, NULL, jsonb_build_object('reportKey', export."reportKey", 'days', export.days, 'format', export.format)
          FROM "AdminReportExportAuditEvent" export
          WHERE export."createdAt" >= $1 AND export."createdAt" < $2
        )
        SELECT id, occurred_at, source, domain, action, status, severity, actor_type, actor_id,
          organization_id, resource_type, resource_id, correlation_id, metadata
        FROM events
        WHERE ($3::timestamptz IS NULL OR occurred_at < $3 OR (occurred_at = $3 AND id < COALESCE($4, '')))
          AND ($5::text IS NULL OR domain = $5)
          AND ($6::text IS NULL OR action = $6)
          AND ($7::text IS NULL OR status = $7)
          AND ($8::text IS NULL OR severity = $8)
          AND ($9::text IS NULL OR organization_id = $9)
        ORDER BY occurred_at DESC, id DESC
        LIMIT $10`;
