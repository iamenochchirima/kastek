ALTER TABLE agents_platform.sources
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_by uuid REFERENCES agents_platform.accounts(id),
  ADD COLUMN IF NOT EXISTS review_due_at timestamptz NOT NULL DEFAULT now() + interval '180 days';

CREATE INDEX IF NOT EXISTS sources_review_due
  ON agents_platform.sources(organization_id, review_due_at)
  WHERE state = 'active';
