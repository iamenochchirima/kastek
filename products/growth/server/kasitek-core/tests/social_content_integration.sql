-- Social/content integration fixture. The whole script runs in a transaction and
-- rolls back, so it is safe to execute against a disposable local database.
BEGIN;

INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES
  ('social-integration-owner-a', 'social-integration-owner-a@example.test', NOW(), NOW()),
  ('social-integration-owner-b', 'social-integration-owner-b@example.test', NOW(), NOW());

INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt") VALUES
  ('social-integration-org-a', 'Social Integration A', 'social-integration-a', 'social-integration-owner-a', NOW(), NOW()),
  ('social-integration-org-b', 'Social Integration B', 'social-integration-b', 'social-integration-owner-b', NOW(), NOW());

INSERT INTO "OrganizationMember" (id, "orgId", "userId", role, "joinedAt", "createdAt", "updatedAt") VALUES
  ('social-integration-member-a', 'social-integration-org-a', 'social-integration-owner-a', 'OWNER', NOW(), NOW(), NOW()),
  ('social-integration-member-b', 'social-integration-org-b', 'social-integration-owner-b', 'OWNER', NOW(), NOW(), NOW());

INSERT INTO "SocialChannelConnection" (
  id, "userId", "orgId", platform, status, "displayName", "externalAccountId", "createdAt", "updatedAt"
) VALUES
  (
    'social-integration-channel-a', 'social-integration-owner-a', 'social-integration-org-a',
    'TIKTOK', 'CONNECTED', 'TikTok A', 'social-external-a', NOW(), NOW()
  ),
  (
    'social-integration-channel-b', 'social-integration-owner-b', 'social-integration-org-b',
    'TIKTOK', 'CONNECTED', 'TikTok B', 'social-external-b', NOW(), NOW()
  );

INSERT INTO "SocialPost" (
  id, "userId", "orgId", "primaryChannelId", content, channels, status, "createdAt", "updatedAt"
) VALUES
  (
    'social-integration-post-a', 'social-integration-owner-a', 'social-integration-org-a',
    'social-integration-channel-a', 'Org A post', ARRAY['TIKTOK']::"SocialPlatform"[],
    'PROCESSING', NOW(), NOW()
  ),
  (
    'social-integration-post-b', 'social-integration-owner-b', 'social-integration-org-b',
    'social-integration-channel-b', 'Org B post', ARRAY['TIKTOK']::"SocialPlatform"[],
    'DRAFT', NOW(), NOW()
  ),
  (
    'social-integration-post-a2', 'social-integration-owner-a', 'social-integration-org-a',
    'social-integration-channel-a', 'Org A partial batch post', ARRAY['TIKTOK']::"SocialPlatform"[],
    'PROCESSING', NOW(), NOW()
  ),
  (
    'social-integration-post-a3', 'social-integration-owner-a', 'social-integration-org-a',
    'social-integration-channel-a', 'Org A ambiguous post', ARRAY['TIKTOK']::"SocialPlatform"[],
    'PROCESSING', NOW(), NOW()
  );

INSERT INTO "SocialPublishJob" (
  id, "userId", "orgId", "postId", "channelConnectionId", platform, status, "createdAt", "updatedAt"
) VALUES (
  'social-integration-job-a', 'social-integration-owner-a', 'social-integration-org-a',
  'social-integration-post-a', 'social-integration-channel-a', 'TIKTOK', 'PROCESSING', NOW(), NOW()
), (
  'social-integration-job-a2', 'social-integration-owner-a', 'social-integration-org-a',
  'social-integration-post-a2', 'social-integration-channel-a', 'TIKTOK', 'PROCESSING', NOW(), NOW()
), (
  'social-integration-job-a3', 'social-integration-owner-a', 'social-integration-org-a',
  'social-integration-post-a3', 'social-integration-channel-a', 'TIKTOK', 'PROCESSING', NOW(), NOW()
);

-- The webhook event key is the raw-body digest in the service. A retried body
-- must therefore create one durable event, not two provider effects.
INSERT INTO "SocialWebhookEvent" (
  id, provider, "eventKey", "eventType", "externalAccountId", payload, status,
  attempts, "nextAttemptAt", "receivedAt", "createdAt", "updatedAt"
) VALUES (
  'social-integration-webhook-a', 'TIKTOK', 'social-event-key-a', 'post.publish.complete',
  'social-external-a', '{"publish_id":"provider-post-a"}'::jsonb, 'RECEIVED',
  0, NOW(), NOW(), NOW(), NOW()
)
ON CONFLICT (provider, "eventKey") DO NOTHING;

INSERT INTO "SocialWebhookEvent" (
  id, provider, "eventKey", "eventType", "externalAccountId", payload, status,
  attempts, "nextAttemptAt", "receivedAt", "createdAt", "updatedAt"
) VALUES (
  'social-integration-webhook-duplicate', 'TIKTOK', 'social-event-key-a', 'post.publish.complete',
  'social-external-a', '{"publish_id":"provider-post-a"}'::jsonb, 'RECEIVED',
  0, NOW(), NOW(), NOW(), NOW()
)
ON CONFLICT (provider, "eventKey") DO NOTHING;

DO $$
DECLARE
  org_a_posts integer;
  org_b_posts integer;
  duplicate_events integer;
  completed integer;
  duplicate_completion integer;
  late_failure integer;
  partial_published integer;
  partial_failed integer;
  ambiguous_pending integer;
  reconciled integer;
  usage_rows integer;
BEGIN
  SELECT count(*) INTO org_a_posts
  FROM "SocialPost" WHERE "orgId" = 'social-integration-org-a';
  SELECT count(*) INTO org_b_posts
  FROM "SocialPost" WHERE "orgId" = 'social-integration-org-b';
  IF org_a_posts <> 3 OR org_b_posts <> 1 THEN
    RAISE EXCEPTION 'content list is not organization scoped: org_a=%, org_b=%', org_a_posts, org_b_posts;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SocialPost" post
    LEFT JOIN "OrganizationMember" member
      ON member."orgId" = post."orgId" AND member."userId" = post."userId"
    WHERE post.id LIKE 'social-integration-%' AND member.id IS NULL
  ) THEN
    RAISE EXCEPTION 'content ownership is not tied to a workspace member';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SocialPost" post
    JOIN "SocialChannelConnection" channel ON channel.id = post."primaryChannelId"
    WHERE post.id LIKE 'social-integration-%'
      AND (channel."orgId" IS DISTINCT FROM post."orgId"
        OR NOT (channel.platform::text = ANY (SELECT unnest(post.channels)::text)))
  ) THEN
    RAISE EXCEPTION 'content primary account is outside the workspace or platform set';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "SocialPublishJob" job
    JOIN "SocialPost" post ON post.id = job."postId"
    LEFT JOIN "SocialChannelConnection" channel ON channel.id = job."channelConnectionId"
    WHERE job.id LIKE 'social-integration-%'
      AND (job."orgId" IS DISTINCT FROM post."orgId"
        OR channel."orgId" IS DISTINCT FROM job."orgId"
        OR channel.platform::text IS DISTINCT FROM job.platform::text)
  ) THEN
    RAISE EXCEPTION 'publish job account, content, and platform scopes diverged';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "SocialPost"
    WHERE id = 'social-integration-post-a' AND "orgId" = 'social-integration-org-b'
  ) THEN
    RAISE EXCEPTION 'cross-organization content lookup returned a row';
  END IF;

  SELECT count(*) INTO duplicate_events
  FROM "SocialWebhookEvent"
  WHERE provider = 'TIKTOK' AND "eventKey" = 'social-event-key-a';
  IF duplicate_events <> 1 THEN
    RAISE EXCEPTION 'duplicate provider webhook was persisted more than once: %', duplicate_events;
  END IF;

  -- This mirrors the worker's guarded state transition. Only PROCESSING can
  -- complete a job; duplicate or late failure callbacks become no-ops.
  UPDATE "SocialPublishJob"
  SET status = 'PUBLISHED'::"SocialPublishJobStatus",
      "publishedAt" = NOW(), "externalPostId" = 'provider-post-a', "updatedAt" = NOW()
  WHERE id = 'social-integration-job-a'
    AND status = 'PROCESSING'::"SocialPublishJobStatus";
  GET DIAGNOSTICS completed = ROW_COUNT;

  UPDATE "SocialPublishJob"
  SET status = 'PUBLISHED'::"SocialPublishJobStatus", "updatedAt" = NOW()
  WHERE id = 'social-integration-job-a'
    AND status = 'PROCESSING'::"SocialPublishJobStatus";
  GET DIAGNOSTICS duplicate_completion = ROW_COUNT;

  UPDATE "SocialPublishJob"
  SET status = 'FAILED'::"SocialPublishJobStatus", "errorMessage" = 'late failure', "updatedAt" = NOW()
  WHERE id = 'social-integration-job-a'
    AND status = 'PROCESSING'::"SocialPublishJobStatus";
  GET DIAGNOSTICS late_failure = ROW_COUNT;

  IF completed <> 1 OR duplicate_completion <> 0 OR late_failure <> 0 THEN
    RAISE EXCEPTION 'publish callback transitions were not idempotent: completed=%, duplicate=%, late_failure=%',
      completed, duplicate_completion, late_failure;
  END IF;

  -- A batch may have mixed provider outcomes. A failed item must not reopen or
  -- overwrite the sibling that already completed successfully.
  UPDATE "SocialPublishJob"
  SET status = 'FAILED'::"SocialPublishJobStatus", "errorMessage" = 'provider rejected', "updatedAt" = NOW()
  WHERE id = 'social-integration-job-a2'
    AND status = 'PROCESSING'::"SocialPublishJobStatus";
  UPDATE "SocialPost"
  SET status = 'FAILED'::"SocialPostStatus", "updatedAt" = NOW()
  WHERE id = 'social-integration-post-a2' AND status = 'PROCESSING'::"SocialPostStatus";
  SELECT count(*) FILTER (WHERE status = 'PUBLISHED'::"SocialPublishJobStatus"),
         count(*) FILTER (WHERE status = 'FAILED'::"SocialPublishJobStatus")
    INTO partial_published, partial_failed
  FROM "SocialPublishJob"
  WHERE "orgId" = 'social-integration-org-a';
  IF partial_published <> 1 OR partial_failed <> 1 THEN
    RAISE EXCEPTION 'partial batch outcomes were not isolated: published=%, failed=%', partial_published, partial_failed;
  END IF;

  -- A provider timeout leaves the item explicitly ambiguous until a later
  -- reconciliation result resolves the PROCESSING row.
  SELECT count(*) INTO ambiguous_pending
  FROM "SocialPublishJob"
  WHERE id = 'social-integration-job-a3' AND status = 'PROCESSING'::"SocialPublishJobStatus";
  IF ambiguous_pending <> 1 THEN
    RAISE EXCEPTION 'ambiguous provider outcome was not retained for reconciliation';
  END IF;
  UPDATE "SocialPublishJob"
  SET status = 'PUBLISHED'::"SocialPublishJobStatus",
      "publishedAt" = NOW(), "externalPostId" = 'provider-post-a3', "updatedAt" = NOW()
  WHERE id = 'social-integration-job-a3'
    AND status = 'PROCESSING'::"SocialPublishJobStatus";
  GET DIAGNOSTICS reconciled = ROW_COUNT;
  IF reconciled <> 1 THEN
    RAISE EXCEPTION 'provider reconciliation did not resolve the ambiguous job';
  END IF;

  INSERT INTO "UsageEvent" (
    id, "orgId", "productKey", "metricKey", quantity, "sourceType", "sourceId", "idempotencyKey", "occurredAt", "createdAt"
  ) VALUES (
    'social-integration-usage-a', 'social-integration-org-a', 'kasitek', 'social_publishes', 1,
    'social_publish_job', 'social-integration-job-a', 'social-publish:social-integration-job-a', NOW(), NOW()
  ) ON CONFLICT ("idempotencyKey") DO NOTHING;
  INSERT INTO "UsageEvent" (
    id, "orgId", "productKey", "metricKey", quantity, "sourceType", "sourceId", "idempotencyKey", "occurredAt", "createdAt"
  ) VALUES (
    'social-integration-usage-duplicate', 'social-integration-org-a', 'kasitek', 'social_publishes', 1,
    'social_publish_job', 'social-integration-job-a', 'social-publish:social-integration-job-a', NOW(), NOW()
  ) ON CONFLICT ("idempotencyKey") DO NOTHING;

  SELECT count(*) INTO usage_rows
  FROM "UsageEvent" WHERE "idempotencyKey" = 'social-publish:social-integration-job-a';
  IF usage_rows <> 1 THEN
    RAISE EXCEPTION 'publish usage was recorded more than once: %', usage_rows;
  END IF;
END $$;

ROLLBACK;
