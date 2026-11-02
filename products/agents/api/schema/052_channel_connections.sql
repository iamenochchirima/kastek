CREATE TABLE agents_platform.channel_connections (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  kind text NOT NULL CHECK (kind IN ('website','whatsapp','telegram','facebook','instagram')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  asset_id text CHECK (length(asset_id) BETWEEN 1 AND 512),
  mode text NOT NULL CHECK (mode IN ('website','bot','cloud_api','meta','instagram_login')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','needs_attention','disconnected','removed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  credential_revision integer NOT NULL DEFAULT 0 CHECK (credential_revision >= 0),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(organization_id,id),
  CHECK ((kind='website' AND mode='website') OR (kind='telegram' AND mode='bot') OR
    (kind='whatsapp' AND mode='cloud_api') OR (kind='facebook' AND mode='meta') OR
    (kind='instagram' AND mode IN ('meta','instagram_login'))),
  CHECK (state<>'active' OR asset_id IS NOT NULL)
);
-- A bot, number or account must never route ambiguously, including across Instagram login modes.
CREATE UNIQUE INDEX channel_connection_asset_owner ON agents_platform.channel_connections(kind,asset_id)
  WHERE asset_id IS NOT NULL AND state NOT IN ('disconnected','removed');
CREATE INDEX channel_connections_organization ON agents_platform.channel_connections(organization_id,created_at,id);
CREATE TABLE agents_platform.channel_credentials (
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  kind text NOT NULL,
  mode text NOT NULL,
  asset_id text,
  envelope jsonb,
  state text NOT NULL CHECK(state IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY(organization_id,connection_id,revision),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  CHECK((state='active' AND envelope IS NOT NULL) OR (state='revoked' AND envelope IS NULL))
);
CREATE TABLE agents_platform.channel_assets (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  provider_asset_id text NOT NULL CHECK(length(provider_asset_id) BETWEEN 1 AND 512),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 256),
  eligible boolean NOT NULL,
  reason_code text,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(metadata)='object'),
  observed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  UNIQUE(organization_id,connection_id,provider_asset_id),
  UNIQUE(organization_id,id)
);
CREATE TABLE agents_platform.channel_deployments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.channel_connections(organization_id,id),
  FOREIGN KEY(organization_id,agent_id,version_id) REFERENCES agents_platform.agent_versions(organization_id,agent_id,id),
  UNIQUE(organization_id,id)
);
CREATE UNIQUE INDEX channel_deployment_active_connection ON agents_platform.channel_deployments(connection_id) WHERE state='active';
CREATE INDEX channel_deployments_agent ON agents_platform.channel_deployments(organization_id,agent_id,id);
