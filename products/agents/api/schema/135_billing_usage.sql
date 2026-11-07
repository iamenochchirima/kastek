CREATE TABLE agents_platform.billing_usage_forwarded (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  accounted_tokens double precision NOT NULL CHECK (accounted_tokens >= 0),
  outcome text NOT NULL,
  forwarded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_usage_forwarded_org ON agents_platform.billing_usage_forwarded(organization_id, forwarded_at);
