-- Seed the two rows required by the ignored Core database ownership tests.
-- The caller owns the disposable database lifecycle; this fixture intentionally
-- persists until both Rust tests finish.

INSERT INTO "User" (id, email, "createdAt", "updatedAt") VALUES
  ('seeded-core-owner-a', 'seeded-core-owner-a@example.test', NOW(), NOW()),
  ('seeded-core-owner-b', 'seeded-core-owner-b@example.test', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Organization" (id, name, slug, "ownerId", "createdAt", "updatedAt") VALUES
  ('org_connections_a', 'Seeded Connections A', 'seeded-connections-a', 'seeded-core-owner-a', NOW(), NOW()),
  ('org_connections_b', 'Seeded Connections B', 'seeded-connections-b', 'seeded-core-owner-b', NOW(), NOW()),
  ('org_meta_a', 'Seeded Inbox A', 'seeded-inbox-a', 'seeded-core-owner-a', NOW(), NOW()),
  ('org_meta_b', 'Seeded Inbox B', 'seeded-inbox-b', 'seeded-core-owner-b', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "ExternalConnection" (
  id, "orgId", provider, "sourceType", "sourceId", "displayName",
  status, "credentialStatus", "healthStatus", "webhookStatus", "createdAt", "updatedAt"
) VALUES
  ('seeded-core-connection-wa-a', 'org_connections_a', 'WHATSAPP', 'WHATSAPP',
   'wa_connections_a', 'Seeded WhatsApp A', 'CONNECTED'::"ExternalConnectionStatus",
   'ACTIVE', 'HEALTHY', 'UNKNOWN', NOW(), NOW()),
  ('seeded-core-connection-social-a', 'org_connections_a', 'FACEBOOK', 'SOCIAL',
   'social_connections_a', 'Seeded Facebook A', 'CONNECTED'::"ExternalConnectionStatus",
   'ACTIVE', 'HEALTHY', 'UNKNOWN', NOW(), NOW()),
  ('seeded-core-connection-social-b', 'org_connections_b', 'FACEBOOK', 'SOCIAL',
   'social_connections_b', 'Seeded Facebook B', 'CONNECTED'::"ExternalConnectionStatus",
   'ACTIVE', 'HEALTHY', 'UNKNOWN', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Conversation" (
  id, channel, "customerIdentifier", "customerName", status,
  "lastMessageAt", "unreadCount", starred, "orgId", "createdAt", "updatedAt"
) VALUES
  ('conversation_meta_a', 'whatsapp', 'seeded-meta-customer-a', 'Seeded Customer A',
   'active', NOW(), 0, false, 'org_meta_a', NOW(), NOW()),
  ('conversation_meta_b', 'whatsapp', 'seeded-meta-customer-b', 'Seeded Customer B',
   'active', NOW(), 0, false, 'org_meta_b', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
