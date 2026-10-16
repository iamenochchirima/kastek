-- Hosted agent lifecycle is explicit: every installation points at one
-- immutable version until Deploy or Rollback moves that pointer.
UPDATE agent_installations
SET release_mode = 'pinned', updated_at = now()
WHERE release_mode <> 'pinned';

UPDATE agent_installation_deployments
SET release_mode = 'pinned'
WHERE release_mode <> 'pinned';

ALTER TABLE agent_installations
  DROP CONSTRAINT IF EXISTS agent_installations_release_mode_check;

ALTER TABLE agent_installations
  ADD CONSTRAINT agent_installations_release_mode_check
  CHECK (release_mode = 'pinned');

ALTER TABLE agent_installation_deployments
  DROP CONSTRAINT IF EXISTS agent_installation_deployments_release_mode_check;

ALTER TABLE agent_installation_deployments
  ADD CONSTRAINT agent_installation_deployments_release_mode_check
  CHECK (release_mode = 'pinned');
