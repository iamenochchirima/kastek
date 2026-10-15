-- Connection projection integration fixture. The source rows are seeded here
-- because an empty local clone does not contain the application's backfill
-- dataset. The transaction is rolled back so this remains safe to rerun.
BEGIN;

INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES
    ('connection-integration-owner-a', 'connection-integration-owner-a@example.test', NOW(), NOW()),
    ('connection-integration-owner-b', 'connection-integration-owner-b@example.test', NOW(), NOW());

INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt") VALUES
    ('org_connections_a', 'Connection Integration A', 'connection-integration-a', 'connection-integration-owner-a', NOW(), NOW()),
    ('org_connections_b', 'Connection Integration B', 'connection-integration-b', 'connection-integration-owner-b', NOW(), NOW());

INSERT INTO "ExternalConnection" (
    id, "orgId", provider, "sourceType", "sourceId", "displayName", status,
    "credentialStatus", "healthStatus", "webhookStatus", "createdAt", "updatedAt"
) VALUES
    (
        'connection-integration-wa-a', 'org_connections_a', 'WHATSAPP', 'WHATSAPP',
        'wa_connections_a', 'WhatsApp A', 'CONNECTED'::"ExternalConnectionStatus",
        'ACTIVE', 'HEALTHY', 'UNKNOWN', NOW(), NOW()
    ),
    (
        'connection-integration-social-a', 'org_connections_a', 'FACEBOOK', 'SOCIAL',
        'social_connections_a', 'Facebook A', 'CONNECTED'::"ExternalConnectionStatus",
        'ACTIVE', 'HEALTHY', 'UNKNOWN', NOW(), NOW()
    ),
    (
        'connection-integration-social-b', 'org_connections_b', 'FACEBOOK', 'SOCIAL',
        'social_connections_b', 'Facebook B', 'CONNECTED'::"ExternalConnectionStatus",
        'ACTIVE', 'HEALTHY', 'UNKNOWN', NOW(), NOW()
    );

INSERT INTO "ExternalConnectionCapability" (
    id, "connectionId", key, enabled, "createdAt", "updatedAt"
)
SELECT
    'connection-integration-cap-' || row_number() OVER (), connection.id, capability.key,
    true, NOW(), NOW()
FROM "ExternalConnection" connection
CROSS JOIN (VALUES
    ('MESSAGING_INBOUND'), ('MESSAGING_OUTBOUND'), ('CAMPAIGNS_SEND'),
    ('TEMPLATES_MANAGE'), ('AGENT_CHANNEL')
) AS capability(key)
WHERE connection.id = 'connection-integration-wa-a';

INSERT INTO "ExternalConnectionConsumer" (
    id, "connectionId", "productKey", "createdAt", "updatedAt"
)
SELECT
    'connection-integration-consumer-' || row_number() OVER (), connection.id,
    consumer.product_key, NOW(), NOW()
FROM "ExternalConnection" connection
CROSS JOIN (VALUES ('inbox'), ('social'), ('agents')) AS consumer(product_key)
WHERE connection.id = 'connection-integration-social-a';

DO $$
DECLARE
    org_a_connections integer;
    org_b_connections integer;
    whatsapp_capabilities integer;
    facebook_consumers integer;
BEGIN
    SELECT count(*) INTO org_a_connections
    FROM "ExternalConnection" WHERE "orgId" = 'org_connections_a';
    SELECT count(*) INTO org_b_connections
    FROM "ExternalConnection" WHERE "orgId" = 'org_connections_b';

    IF org_a_connections <> 2 OR org_b_connections <> 1 THEN
        RAISE EXCEPTION 'connection backfill did not preserve organization ownership: org_a=%, org_b=%',
            org_a_connections, org_b_connections;
    END IF;

    SELECT count(*) INTO whatsapp_capabilities
    FROM "ExternalConnectionCapability" capability
    JOIN "ExternalConnection" connection ON connection.id = capability."connectionId"
    WHERE connection."sourceId" = 'wa_connections_a' AND capability.enabled = true;

    IF whatsapp_capabilities <> 5 THEN
        RAISE EXCEPTION 'expected 5 WhatsApp capabilities, got %', whatsapp_capabilities;
    END IF;

    SELECT count(*) INTO facebook_consumers
    FROM "ExternalConnectionConsumer" consumer
    JOIN "ExternalConnection" connection ON connection.id = consumer."connectionId"
    WHERE connection."sourceId" = 'social_connections_a' AND consumer."productKey" IN ('inbox', 'social', 'agents');

    IF facebook_consumers <> 3 THEN
        RAISE EXCEPTION 'expected Facebook to be shared by 3 products, got %', facebook_consumers;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "ExternalConnection" connection
        JOIN "ExternalConnectionCapability" capability ON capability."connectionId" = connection.id
        WHERE connection."orgId" = 'org_connections_b'
          AND connection."sourceId" <> 'social_connections_b'
    ) THEN
        RAISE EXCEPTION 'organization B can see capabilities attached to another organization';
    END IF;
END $$;

DO $$
BEGIN
    BEGIN
        INSERT INTO "ExternalConnection" (
            id, "orgId", provider, "sourceType", "sourceId", "displayName", "createdAt", "updatedAt"
        ) VALUES (
            'duplicate_source', 'org_connections_a', 'WHATSAPP', 'WHATSAPP', 'wa_connections_a',
            'Duplicate', NOW(), NOW()
        );
        RAISE EXCEPTION 'duplicate organization source was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;
END $$;

ROLLBACK;
