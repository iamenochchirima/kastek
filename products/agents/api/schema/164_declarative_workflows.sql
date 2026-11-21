CREATE TABLE agents_platform.workflow_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  workflow_id text NOT NULL CHECK (workflow_id ~ '^[a-z][a-z0-9-]{0,79}$'),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  prerequisites jsonb NOT NULL,
  waits jsonb NOT NULL,
  completion_evidence jsonb NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  published_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, workflow_id, version)
);

CREATE INDEX workflow_revisions_scope ON agents_platform.workflow_revisions(organization_id, published_at DESC);
