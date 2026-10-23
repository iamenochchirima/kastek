-- The matching source cutover removes all callers of these obsolete widget tables.
-- Website agents now use the Agents platform's deployment/session/inbox records.
-- This migration does not touch Growth business, lead, Inbox or campaign records.
DROP TABLE IF EXISTS "AgentWebsiteDeliveryEvent";
DROP TABLE IF EXISTS "AgentWebsiteVisitorSession";
DROP TABLE IF EXISTS "AgentWebsiteDeployment";
