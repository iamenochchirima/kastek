ALTER TABLE agents_platform.memory_scopes ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE agents_platform.memory_scopes ADD COLUMN namespace text NOT NULL DEFAULT 'personal';
ALTER TABLE agents_platform.memory_scopes ADD COLUMN product text;
ALTER TABLE agents_platform.memory_scopes ADD COLUMN tenant_id text;
ALTER TABLE agents_platform.memory_scopes ADD COLUMN actor_issuer text;
ALTER TABLE agents_platform.memory_scopes ADD COLUMN actor_subject text;
ALTER TABLE agents_platform.memory_scopes ADD COLUMN client_id text;
ALTER TABLE agents_platform.memory_scopes ADD CONSTRAINT memory_namespace_shape CHECK (
  (namespace='personal' AND account_id IS NOT NULL AND product IS NULL AND tenant_id IS NULL
    AND actor_issuer IS NULL AND actor_subject IS NULL AND client_id IS NULL)
  OR (namespace='product_actor' AND account_id IS NULL AND product IS NOT NULL AND product IN ('growth','agencies')
    AND tenant_id IS NOT NULL AND actor_issuer IS NOT NULL AND actor_subject IS NOT NULL
    AND length(tenant_id) BETWEEN 1 AND 256 AND length(actor_issuer) BETWEEN 1 AND 2048
    AND length(actor_subject) BETWEEN 1 AND 512
    AND ((product='growth' AND client_id IS NULL) OR (product='agencies' AND client_id IS NOT NULL AND length(client_id) BETWEEN 1 AND 256)))
);
CREATE UNIQUE INDEX product_actor_memory_namespace ON agents_platform.memory_scopes
  (product,tenant_id,agent_id,actor_issuer,actor_subject,client_id) NULLS NOT DISTINCT WHERE namespace='product_actor';
ALTER TABLE agents_platform.memories ADD COLUMN assertion_origin text NOT NULL DEFAULT 'user_supplied'
  CHECK (assertion_origin IN ('user_supplied','model_candidate'));
ALTER TABLE agents_platform.memory_revisions ADD COLUMN actor jsonb;
