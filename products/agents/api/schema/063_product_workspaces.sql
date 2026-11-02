-- Product principals have service provenance, never fabricated customer accounts.
ALTER TABLE agents_platform.agents ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE agents_platform.agents ADD COLUMN created_by_service jsonb;
ALTER TABLE agents_platform.agents ADD CONSTRAINT agent_creation_owner CHECK
  ((created_by IS NOT NULL AND created_by_service IS NULL) OR
   (created_by IS NULL AND created_by_service IS NOT NULL AND COALESCE(created_by_service->>'product' IN ('growth','agencies'),false) AND created_by_service->>'clientId' IS NOT NULL));
ALTER TABLE agents_platform.agent_versions ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE agents_platform.agent_versions ADD COLUMN created_by_service jsonb;
ALTER TABLE agents_platform.agent_versions ADD CONSTRAINT version_creation_owner CHECK
  ((created_by IS NOT NULL AND created_by_service IS NULL) OR
   (created_by IS NULL AND created_by_service IS NOT NULL AND COALESCE(created_by_service->>'product' IN ('growth','agencies'),false) AND created_by_service->>'clientId' IS NOT NULL));
ALTER TABLE agents_platform.model_provider_connections ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE agents_platform.model_provider_connections ADD COLUMN created_by_service jsonb;
ALTER TABLE agents_platform.model_provider_connections ADD CONSTRAINT model_creation_owner CHECK
  ((created_by IS NOT NULL AND created_by_service IS NULL) OR
   (created_by IS NULL AND created_by_service IS NOT NULL AND COALESCE(created_by_service->>'product' IN ('growth','agencies'),false) AND created_by_service->>'clientId' IS NOT NULL));

CREATE TABLE agents_platform.product_execution_features (
  product text NOT NULL, tenant_id text NOT NULL, feature_id text NOT NULL,
  organization_id uuid NOT NULL, agent_id uuid NOT NULL, version_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(product,tenant_id,feature_id),
  FOREIGN KEY(product,tenant_id) REFERENCES agents_platform.product_execution_tenants(product,tenant_id),
  FOREIGN KEY(organization_id,agent_id,version_id) REFERENCES agents_platform.agent_versions(organization_id,agent_id,id)
);
CREATE TABLE agents_platform.product_conversations (
  conversation_id uuid PRIMARY KEY REFERENCES agents_platform.conversations(id),
  product text NOT NULL, tenant_id text NOT NULL, feature_id text NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  context jsonb,
  context_revision text,
  context_display jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(product,tenant_id,feature_id) REFERENCES agents_platform.product_execution_features(product,tenant_id,feature_id)
);
CREATE INDEX product_conversation_scope ON agents_platform.product_conversations(product,tenant_id,updated_at DESC,conversation_id);
CREATE TABLE agents_platform.product_task_contexts (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  product text NOT NULL, tenant_id text NOT NULL, feature_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES agents_platform.product_conversations(conversation_id),
  context jsonb, context_revision text, sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  command_digest text NOT NULL CHECK(command_digest ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY(product,tenant_id,feature_id) REFERENCES agents_platform.product_execution_features(product,tenant_id,feature_id)
);
CREATE TABLE agents_platform.product_command_receipts (
  product text NOT NULL,tenant_id text NOT NULL,request_id text NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(product,tenant_id,request_id),
  FOREIGN KEY(product,tenant_id) REFERENCES agents_platform.product_execution_tenants(product,tenant_id)
);
CREATE TABLE agents_platform.product_service_assertions (
  product text NOT NULL,client_id text NOT NULL,jti uuid NOT NULL,
  request_digest text NOT NULL,expires_at timestamptz NOT NULL,
  PRIMARY KEY(product,client_id,jti)
);
CREATE INDEX product_service_assertion_expiry ON agents_platform.product_service_assertions(expires_at);
CREATE TABLE agents_platform.product_model_defaults (
  product text NOT NULL, organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,model_id text NOT NULL,use_grant_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(product,organization_id),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id),
  FOREIGN KEY(organization_id,use_grant_id) REFERENCES agents_platform.model_provider_use_grants(organization_id,id)
);
CREATE TABLE agents_platform.product_review_projections (
  review_id uuid PRIMARY KEY,task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN ('proposed','approved','rejected','executing','saved','failed','uncertain','expired')),
  projection jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Product artifacts belong to their actual task, without a standalone customer account.
ALTER TABLE agents_platform.artifacts ALTER COLUMN account_id DROP NOT NULL;
ALTER TABLE agents_platform.artifacts ADD COLUMN product_owner text;
ALTER TABLE agents_platform.artifacts ADD CONSTRAINT artifact_creation_owner CHECK
  ((account_id IS NOT NULL AND product_owner IS NULL) OR
   (account_id IS NULL AND product_owner IS NOT NULL AND product_owner IN ('growth','agencies') AND task_id IS NOT NULL));

ALTER TABLE agents_platform.tasks ALTER COLUMN harness_release SET DEFAULT 'growth-products-v10';
