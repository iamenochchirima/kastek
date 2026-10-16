-- Keep provider ids in durable tables aligned with the runtime provider registry.
-- Existing deployments already ran the original four-provider checks, so this
-- is an additive migration rather than an edit to an applied migration.

ALTER TABLE credential_vault
  DROP CONSTRAINT IF EXISTS credential_vault_provider_check;

ALTER TABLE credential_vault
  ADD CONSTRAINT credential_vault_provider_check
  CHECK (provider IN (
    'openrouter', 'openai', 'anthropic', 'gemini', 'deepseek', 'glm',
    'kimi', 'minimax', 'xai', 'opencode_go', 'opencode_zen'
  ));

ALTER TABLE model_calls
  DROP CONSTRAINT IF EXISTS model_calls_provider_check;

ALTER TABLE model_calls
  ADD CONSTRAINT model_calls_provider_check
  CHECK (provider IN (
    'openrouter', 'openai', 'anthropic', 'gemini', 'deepseek', 'glm',
    'kimi', 'minimax', 'xai', 'opencode_go', 'opencode_zen'
  ));
