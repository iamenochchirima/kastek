CREATE TABLE agents_platform.mcp_configuration_reviews (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  connection_id uuid NOT NULL REFERENCES agents_platform.mcp_oauth_connections(id),
  agent_id uuid NOT NULL REFERENCES agents_platform.agents(id),
  expected_revision integer NOT NULL CHECK(expected_revision > 0),
  request_digest text NOT NULL,
  configuration jsonb NOT NULL,
  setup jsonb,
  setup_step text,
  changes jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','cancelled')),
  resulting_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  UNIQUE(organization_id,account_id,request_id)
);
