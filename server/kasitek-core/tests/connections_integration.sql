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
