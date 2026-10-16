-- A-12: current Analytics-owned rollout state. Every mutation is also appended to the existing
-- immutable analytics audit chain by the service transaction.
CREATE TABLE IF NOT EXISTS analytics.analytics_rollout_control (
    control_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    control_key TEXT NOT NULL CHECK (control_key IN (
        'publish', 'ingest', 'project', 'report', 'ui', 'agent_read', 'export', 'alerts',
        'scheduled_reports'
    )),
    control_kind TEXT NOT NULL CHECK (control_kind IN ('rollout', 'kill_switch')),
    target_kind TEXT NOT NULL CHECK (target_kind IN (
        'global', 'producer_service', 'domain', 'reporting_scope', 'percentage'
    )),
    target_key TEXT NOT NULL CHECK (length(trim(target_key)) BETWEEN 1 AND 512),
    enabled BOOLEAN NOT NULL,
    percentage_basis_points INTEGER CHECK (percentage_basis_points IS NULL OR
        percentage_basis_points BETWEEN 0 AND 10000),
    revision BIGINT NOT NULL CHECK (revision > 0),
    actor_type TEXT NOT NULL CHECK (length(trim(actor_type)) BETWEEN 1 AND 128),
    actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 512),
    reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 2000),
    issue_ref TEXT CHECK (issue_ref IS NULL OR length(trim(issue_ref)) BETWEEN 1 AND 512),
    expires_at TIMESTAMPTZ,
    removed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (control_key, control_kind, target_kind, target_key),
    CHECK ((target_kind = 'percentage') = (percentage_basis_points IS NOT NULL)),
    CHECK (control_kind <> 'kill_switch' OR target_kind <> 'percentage')
);

CREATE INDEX IF NOT EXISTS analytics_rollout_control_lookup_idx
    ON analytics.analytics_rollout_control (control_key, control_kind, target_kind, target_key);
CREATE INDEX IF NOT EXISTS analytics_rollout_control_expiry_idx
    ON analytics.analytics_rollout_control (expires_at)
    WHERE removed_at IS NULL AND expires_at IS NOT NULL;

CREATE TRIGGER analytics_rollout_control_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_rollout_control
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

COMMENT ON TABLE analytics.analytics_rollout_control IS
    'Current Analytics-owned rollout and kill-switch state; mutations are recorded in the immutable audit chain';
