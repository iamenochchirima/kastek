-- Keep conflicting semantic facts visible until a user or operator explicitly
-- chooses which fact supersedes the other. A fact_key is supplied by a future
-- extractor or an explicit memory writer; free-form text is never treated as a
-- reliable contradiction key by itself.
ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS fact_key TEXT,
  ADD COLUMN IF NOT EXISTS supersedes_memory_id UUID REFERENCES memory_records(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;

ALTER TABLE memory_records
  DROP CONSTRAINT IF EXISTS memory_records_fact_key_length;

ALTER TABLE memory_records
  ADD CONSTRAINT memory_records_fact_key_length
  CHECK (fact_key IS NULL OR length(trim(fact_key)) BETWEEN 1 AND 240);

CREATE INDEX IF NOT EXISTS memory_records_fact_lineage_idx
  ON memory_records (organization_id, agent_definition_id, fact_key, status, updated_at DESC)
  WHERE fact_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_records_supersedes_idx
  ON memory_records (supersedes_memory_id)
  WHERE supersedes_memory_id IS NOT NULL;

CREATE OR REPLACE FUNCTION kasitek_validate_memory_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent memory_records%ROWTYPE;
BEGIN
  IF NEW.supersedes_memory_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.id = NEW.supersedes_memory_id THEN
    RAISE EXCEPTION 'Memory cannot supersede itself';
  END IF;

  SELECT * INTO parent
  FROM memory_records
  WHERE id = NEW.supersedes_memory_id;

  IF NOT FOUND
    OR parent.organization_id <> NEW.organization_id
    OR parent.agent_definition_id IS DISTINCT FROM NEW.agent_definition_id
    OR parent.installation_id IS DISTINCT FROM NEW.installation_id
    OR parent.conversation_id IS DISTINCT FROM NEW.conversation_id
    OR parent.owner_user_id IS DISTINCT FROM NEW.owner_user_id
    OR parent.namespace <> NEW.namespace
    OR parent.fact_key IS DISTINCT FROM NEW.fact_key
  THEN
    RAISE EXCEPTION 'Memory supersession target is outside the memory scope';
  END IF;

  IF parent.status <> 'active' THEN
    RAISE EXCEPTION 'Only active memory can be superseded';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_records_lineage_trigger ON memory_records;
CREATE TRIGGER memory_records_lineage_trigger
BEFORE INSERT OR UPDATE OF organization_id, agent_definition_id, installation_id,
  conversation_id, owner_user_id, namespace, fact_key, supersedes_memory_id
ON memory_records
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_memory_lineage();

COMMENT ON COLUMN memory_records.fact_key IS
  'Stable identity for one semantic claim within its memory scope; it is not derived from free-form text.';
COMMENT ON COLUMN memory_records.supersedes_memory_id IS
  'Explicit replacement lineage. The parent remains auditable with status superseded.';
