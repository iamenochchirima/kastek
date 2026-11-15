-- One Growth assistant per workspace, and replay-safe Growth product requests.
CREATE UNIQUE INDEX agents_one_growth_assistant_per_organization
  ON agents_platform.agents(organization_id)
  WHERE offering = 'growth-assistant' AND deleted_at IS NULL;

CREATE TABLE agents_platform.product_request_results (
  product text NOT NULL,
  request_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  operation text NOT NULL,
  request_digest text NOT NULL,
  response jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (product, request_id)
);

CREATE INDEX product_request_results_created_at_idx
  ON agents_platform.product_request_results(created_at);
