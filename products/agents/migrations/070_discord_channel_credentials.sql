-- 061 created the provider check before Discord channel credentials existed.
-- Recreate only the constraint so existing encrypted credentials remain intact.
ALTER TABLE channel_credentials DROP CONSTRAINT IF EXISTS channel_credentials_provider_check;
ALTER TABLE channel_credentials ADD CONSTRAINT channel_credentials_provider_check CHECK (provider IN ('telegram', 'discord'));
