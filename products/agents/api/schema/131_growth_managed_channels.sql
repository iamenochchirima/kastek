ALTER TABLE agents_platform.channel_connections DROP CONSTRAINT channel_connections_mode_check;
ALTER TABLE agents_platform.channel_connections ADD CONSTRAINT channel_connections_mode_check
  CHECK (mode IN ('website','bot','cloud_api','meta','instagram_login','growth_managed'));
ALTER TABLE agents_platform.channel_connections DROP CONSTRAINT channel_connections_check;
ALTER TABLE agents_platform.channel_connections ADD CONSTRAINT channel_connections_kind_mode_check CHECK (
  (kind='website' AND mode='website') OR (kind='telegram' AND mode='bot') OR
  (kind='whatsapp' AND mode IN ('cloud_api','growth_managed')) OR
  (kind='facebook' AND mode IN ('meta','growth_managed')) OR
  (kind='instagram' AND mode IN ('meta','instagram_login','growth_managed'))
);

CREATE TABLE agents_platform.growth_channel_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  provider text NOT NULL CHECK(provider IN ('facebook','instagram','whatsapp')),
  growth_organization_id text NOT NULL CHECK(length(growth_organization_id) BETWEEN 1 AND 128),
  growth_connection_id text NOT NULL CHECK(length(growth_connection_id) BETWEEN 1 AND 128),
  provider_asset_id text NOT NULL CHECK(length(provider_asset_id) BETWEEN 1 AND 512),
  permission_revision text NOT NULL CHECK(length(permission_revision) BETWEEN 1 AND 128),
  state text NOT NULL CHECK(state IN ('active','needs_attention','revoked')),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
  UNIQUE(organization_id,connection_id),
  UNIQUE(organization_id,id)
);
CREATE UNIQUE INDEX growth_channel_grant_active_asset ON agents_platform.growth_channel_grants(provider,provider_asset_id)
  WHERE state IN ('active','needs_attention');
CREATE INDEX growth_channel_grant_agent ON agents_platform.growth_channel_grants(organization_id,agent_id,state);
