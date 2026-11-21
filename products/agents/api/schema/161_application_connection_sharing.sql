-- Sharing is pinned to the selected connection policy, and defaults to private.
ALTER TABLE agents_platform.connections ADD COLUMN application_shared_policy_revision integer
  CHECK (application_shared_policy_revision IS NULL OR application_shared_policy_revision > 0);
