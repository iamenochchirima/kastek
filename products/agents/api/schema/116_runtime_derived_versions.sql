-- Runtime releases can replace a published version without consuming or editing
-- an author's draft revision. The source always belongs to the same agent.
CREATE UNIQUE INDEX agent_versions_runtime_source_identity
  ON agents_platform.agent_versions (organization_id, agent_id, id, draft_revision);

ALTER TABLE agents_platform.agent_versions
  ADD COLUMN runtime_derived_from uuid,
  ADD CONSTRAINT agent_versions_runtime_source_fk
    FOREIGN KEY (organization_id, agent_id, runtime_derived_from, draft_revision)
    REFERENCES agents_platform.agent_versions (organization_id, agent_id, id, draft_revision),
  ADD CONSTRAINT agent_versions_runtime_source_not_self
    CHECK (runtime_derived_from IS NULL OR runtime_derived_from <> id);

ALTER TABLE agents_platform.agent_versions DROP CONSTRAINT agent_versions_agent_id_draft_revision_key;
CREATE UNIQUE INDEX agent_versions_authored_draft_revision_key
  ON agents_platform.agent_versions (agent_id, draft_revision)
  WHERE runtime_derived_from IS NULL;
