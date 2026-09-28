-- Reconcile Inbox readiness with the scopes already granted to existing
-- workspace mailboxes. A connected account is not reply-ready merely because
-- it has an OAuth token.
UPDATE "EmailInboxBinding" binding
SET
    "inboundStatus" = CASE
        WHEN binding.status <> 'ACTIVE' THEN 'BLOCKED'
        WHEN EXISTS (
            SELECT 1
            FROM "EmailConnection" connection
            WHERE connection.id = binding."emailConnectionId"
              AND (
                  'https://www.googleapis.com/auth/gmail.readonly' = ANY(connection.scopes)
                  OR 'Mail.Read' = ANY(connection.scopes)
              )
        ) THEN CASE WHEN binding."inboundStatus" = 'SYNCING' THEN 'SYNCING' ELSE 'PENDING' END
        ELSE 'BLOCKED'
    END,
    "outboundStatus" = CASE
        WHEN binding.status <> 'ACTIVE' THEN 'BLOCKED'
        WHEN EXISTS (
            SELECT 1
            FROM "EmailConnection" connection
            WHERE connection.id = binding."emailConnectionId"
              AND (
                  'https://www.googleapis.com/auth/gmail.send' = ANY(connection.scopes)
                  OR 'Mail.Send' = ANY(connection.scopes)
              )
        ) THEN 'READY'
        ELSE 'BLOCKED'
    END,
    "updatedAt" = CURRENT_TIMESTAMP;
