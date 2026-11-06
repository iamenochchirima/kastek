CREATE TABLE agents_platform.website_appearance_drafts (
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  appearance jsonb NOT NULL CHECK (jsonb_typeof(appearance) = 'object'),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, agent_id),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents_platform.agents(organization_id, id)
);
