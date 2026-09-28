-- Extension snapshots remain immutable while their owning agent aggregate
-- exists. An authorized agent deletion may remove the aggregate and its
-- snapshots, but active runs must be removed or reconciled first.

CREATE OR REPLACE FUNCTION prevent_agent_extension_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Agent extension snapshots are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$;

ALTER TABLE agent_extension_snapshots
  DROP CONSTRAINT IF EXISTS agent_extension_snapshots_agent_version_id_fkey;

ALTER TABLE agent_extension_snapshots
  ADD CONSTRAINT agent_extension_snapshots_agent_version_id_fkey
  FOREIGN KEY (agent_version_id) REFERENCES agent_versions(id) ON DELETE CASCADE;

ALTER TABLE agent_versions
  DROP CONSTRAINT IF EXISTS agent_versions_extension_snapshot_fk;

ALTER TABLE agent_versions
  ADD CONSTRAINT agent_versions_extension_snapshot_fk
  FOREIGN KEY (extension_snapshot_id) REFERENCES agent_extension_snapshots(id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE agent_runs
  DROP CONSTRAINT IF EXISTS agent_runs_extension_snapshot_fk;

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_extension_snapshot_fk
  FOREIGN KEY (extension_snapshot_id) REFERENCES agent_extension_snapshots(id)
  ON DELETE RESTRICT
  NOT VALID;
