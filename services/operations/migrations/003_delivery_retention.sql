ALTER TABLE ops_rule_versions ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE ops_outbox ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'pending' CHECK(disposition IN ('pending','delivered','suppressed'));
CREATE INDEX IF NOT EXISTS ops_transitions_retention ON ops_transitions(created_at);
