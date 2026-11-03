ALTER TABLE workspace_agents ADD COLUMN tenant_client_id text REFERENCES tenant_clients(id);
CREATE INDEX workspace_agent_client_scope ON workspace_agents(workspace_id,tenant_client_id,id);
ALTER TABLE product_capability_mappings ADD COLUMN tenant_client_id text REFERENCES tenant_clients(id);
ALTER TABLE product_capability_mappings ADD COLUMN origin_client_id text;
CREATE INDEX capability_mapping_client_scope ON product_capability_mappings(workspace_id,tenant_client_id,tenant_user_id);
ALTER TABLE product_capability_grants DROP CONSTRAINT product_capability_grants_agent_ids_check;
ALTER TABLE product_capability_grants ADD CONSTRAINT product_capability_grants_agent_ids_check
  CHECK (jsonb_typeof(agent_ids) = 'array');

CREATE TABLE shared_agent_client_setups (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  tenant_client_id text NOT NULL REFERENCES tenant_clients(id),
  tenant_user_id text NOT NULL REFERENCES tenant_users(id),
  mapping_id text NOT NULL REFERENCES product_capability_mappings(id),
  binding jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,tenant_client_id,tenant_user_id)
);
