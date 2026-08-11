-- The Agent Platform is now the only agent runtime. Historical migrations remain
-- immutable; this migration removes the retired n8n bot tables from live schemas.
DROP TABLE IF EXISTS "BotEvent";
DROP TABLE IF EXISTS "BotDeployment";
DROP TABLE IF EXISTS "BotConfiguration";
