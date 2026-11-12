CREATE OR REPLACE FUNCTION agents_platform.reject_source_revision_mutation() RETURNS trigger AS $$
DECLARE source_state text;
BEGIN
  SELECT s.state INTO source_state FROM agents_platform.sources s WHERE s.id=OLD.source_id;
  IF source_state='deleted' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'immutable source revision' USING ERRCODE='23514';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agents_platform.reject_source_chunk_mutation() RETURNS trigger AS $$
DECLARE source_state text;
BEGIN
  SELECT s.state INTO source_state FROM agents_platform.source_revisions r
    JOIN agents_platform.sources s ON s.id=r.source_id WHERE r.id=OLD.revision_id;
  IF source_state='deleted' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'immutable source chunk' USING ERRCODE='23514';
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION agents_platform.reject_source_section_mutation() RETURNS trigger AS $$
DECLARE source_state text;
BEGIN
  SELECT s.state INTO source_state FROM agents_platform.source_revisions r
    JOIN agents_platform.sources s ON s.id=r.source_id WHERE r.id=OLD.revision_id;
  IF source_state='deleted' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'immutable source section' USING ERRCODE='23514';
END $$ LANGUAGE plpgsql;
