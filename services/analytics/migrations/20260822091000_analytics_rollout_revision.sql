-- A-12 slice 2: one monotonic revision invalidates every cached rollout decision after a
-- committed registry mutation. The registry row is authoritative; Redis remains optional.
CREATE TABLE IF NOT EXISTS analytics.analytics_rollout_registry (
    registry_name TEXT PRIMARY KEY CHECK (registry_name = 'default'),
    revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO analytics.analytics_rollout_registry (registry_name, revision)
VALUES ('default', 0)
ON CONFLICT (registry_name) DO NOTHING;

CREATE TRIGGER analytics_rollout_registry_updated_at_trigger
BEFORE UPDATE ON analytics.analytics_rollout_registry
FOR EACH ROW EXECUTE FUNCTION analytics.set_updated_at();

COMMENT ON TABLE analytics.analytics_rollout_registry IS
    'Monotonic revision for invalidating bounded rollout-decision caches';
