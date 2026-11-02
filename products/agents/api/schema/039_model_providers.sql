CREATE TABLE agents_platform.model_provider_connections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  provider_id text NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  endpoint text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('openai_chat_completions','openai_responses','anthropic_messages','google_generate_content')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  credential_revision integer NOT NULL DEFAULT 1 CHECK (credential_revision > 0),
  custody text NOT NULL DEFAULT 'user_supplied' CHECK (custody IN ('user_supplied','platform_managed')),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked','removed')),
  verification text NOT NULL DEFAULT 'saved' CHECK (verification IN ('saved','discovered','inference_verified','tools_verified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id,id)
);
CREATE INDEX model_provider_connections_tenant ON agents_platform.model_provider_connections(organization_id,created_at,id);

CREATE TABLE agents_platform.model_provider_credentials (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  endpoint text NOT NULL,
  protocol text NOT NULL,
  envelope jsonb,
  state text NOT NULL CHECK (state IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id,connection_id,revision),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id),
  CHECK ((state='active' AND envelope IS NOT NULL AND jsonb_typeof(envelope)='object') OR (state='revoked' AND envelope IS NULL))
);

CREATE TABLE agents_platform.model_provider_use_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  consumer jsonb NOT NULL CHECK (jsonb_typeof(consumer)='object'),
  roles jsonb NOT NULL CHECK (jsonb_typeof(roles)='array' AND jsonb_array_length(roles)>0),
  model_ids jsonb NOT NULL CHECK (jsonb_typeof(model_ids)='array' AND jsonb_array_length(model_ids)>0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,connection_id) REFERENCES agents_platform.model_provider_connections(organization_id,id),
  UNIQUE (organization_id,id)
);
CREATE INDEX model_provider_grants_connection ON agents_platform.model_provider_use_grants(organization_id,connection_id,state);
