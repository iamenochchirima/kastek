ALTER TABLE agents_platform.sources DROP CONSTRAINT sources_state_check;
ALTER TABLE agents_platform.sources ADD CONSTRAINT sources_state_check CHECK(state IN ('active','withdrawn','deleted'));
UPDATE agents_platform.sources SET visibility='public' WHERE visibility<>'public';

CREATE TABLE agents_platform.source_deletions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, source_id uuid NOT NULL,
 title text NOT NULL, content_digest text, actor_account_id uuid,
 state text NOT NULL CHECK(state IN ('soft','purged')),
 deleted_at timestamptz NOT NULL DEFAULT now(), purge_after timestamptz NOT NULL, purged_at timestamptz,
 UNIQUE(organization_id,source_id)
);
CREATE INDEX source_deletions_purge ON agents_platform.source_deletions(purge_after) WHERE state='soft';

-- Content stays immutable while a source is live; only a deleted source may be purged.
CREATE OR REPLACE FUNCTION agents_platform.reject_source_revision_mutation() RETURNS trigger AS $$
DECLARE source_state text;
BEGIN
  SELECT s.state INTO source_state FROM agents_platform.sources s WHERE s.id=OLD.source_id;
  IF source_state='deleted' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable source revision' USING ERRCODE='23514';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agents_platform.reject_source_chunk_mutation() RETURNS trigger AS $$
DECLARE source_state text;
BEGIN
  SELECT s.state INTO source_state FROM agents_platform.source_revisions r
    JOIN agents_platform.sources s ON s.id=r.source_id WHERE r.id=OLD.revision_id;
  IF source_state='deleted' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable source chunk' USING ERRCODE='23514';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agents_platform.reject_source_section_mutation() RETURNS trigger AS $$
DECLARE source_state text;
BEGIN
  SELECT s.state INTO source_state FROM agents_platform.source_revisions r
    JOIN agents_platform.sources s ON s.id=r.source_id WHERE r.id=OLD.revision_id;
  IF source_state='deleted' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'immutable source section' USING ERRCODE='23514';
END $$ LANGUAGE plpgsql;

DROP TRIGGER immutable_source_revision ON agents_platform.source_revisions;
CREATE TRIGGER immutable_source_revision BEFORE UPDATE OR DELETE ON agents_platform.source_revisions
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_source_revision_mutation();
DROP TRIGGER immutable_source_chunk ON agents_platform.source_chunks;
CREATE TRIGGER immutable_source_chunk BEFORE UPDATE OR DELETE ON agents_platform.source_chunks
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_source_chunk_mutation();
DROP TRIGGER immutable_source_section ON agents_platform.source_sections;
CREATE TRIGGER immutable_source_section BEFORE UPDATE OR DELETE ON agents_platform.source_sections
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_source_section_mutation();
