CREATE TABLE agents_platform.mcp_website_reviews (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  connection_id uuid NOT NULL REFERENCES agents_platform.mcp_oauth_connections(id),
  agent_id uuid NOT NULL REFERENCES agents_platform.agents(id),
  version_id uuid NOT NULL REFERENCES agents_platform.agent_versions(id),
  appearance_revision integer NOT NULL,
  allowed_origins jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','cancelled')),
  deployment_id uuid REFERENCES agents_platform.website_deployments(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  UNIQUE (organization_id, account_id, request_id)
);
