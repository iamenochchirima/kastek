CREATE TABLE agents_platform.organization_assistants (
  organization_id uuid PRIMARY KEY REFERENCES agents_platform.organizations(id),
  agent_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id)
);
