ALTER TABLE agents_platform.skill_revisions
  ADD CONSTRAINT skill_revision_scope_unique UNIQUE(organization_id,agent_id,id);
ALTER TABLE agents_platform.skill_revisions DROP CONSTRAINT skill_revisions_body_check;
ALTER TABLE agents_platform.skill_revisions ADD CONSTRAINT skill_revisions_body_check CHECK(octet_length(body)<=65536);
ALTER TABLE agents_platform.skill_revisions DROP CONSTRAINT skill_revisions_description_check;
ALTER TABLE agents_platform.skill_revisions ADD CONSTRAINT skill_revisions_description_check CHECK(octet_length(description)<=4096);
CREATE TABLE agents_platform.skill_packages (
  skill_revision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  files jsonb NOT NULL CHECK(jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 1 AND 128),
  compatibility text CHECK(length(compatibility) BETWEEN 1 AND 500),
  source_kind text NOT NULL DEFAULT 'private' CHECK(source_kind IN ('private','curated')),
  source_slug text,
  total_bytes integer NOT NULL CHECK(total_bytes BETWEEN 0 AND 2097152),
  CHECK((source_kind='private' AND source_slug IS NULL) OR (source_kind='curated' AND source_slug IN ('grounded-answers','customer-handoff'))),
  FOREIGN KEY(organization_id,agent_id,skill_revision_id) REFERENCES agents_platform.skill_revisions(organization_id,agent_id,id)
);
CREATE TRIGGER immutable_skill_package BEFORE UPDATE OR DELETE ON agents_platform.skill_packages
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.skill_package_reviews (
  skill_revision_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  reviewed_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(skill_revision_id) REFERENCES agents_platform.skill_packages(skill_revision_id),
  FOREIGN KEY(organization_id,agent_id,skill_revision_id) REFERENCES agents_platform.skill_revisions(organization_id,agent_id,id)
);
CREATE TRIGGER immutable_skill_package_review BEFORE UPDATE OR DELETE ON agents_platform.skill_package_reviews
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
