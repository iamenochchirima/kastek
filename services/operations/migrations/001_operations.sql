CREATE TABLE IF NOT EXISTS ops_monitors (
 id text PRIMARY KEY, source text NOT NULL CHECK(source IN ('growth','agents','agency','analytics')),
 origin text NOT NULL, enabled boolean NOT NULL, interval_seconds integer NOT NULL CHECK(interval_seconds BETWEEN 10 AND 3600),
 next_poll_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, fence bigint NOT NULL DEFAULT 0,
 last_observed_at timestamptz, last_error text, last_completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ops_monitor_due ON ops_monitors(next_poll_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS ops_observations (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, monitor_id text NOT NULL REFERENCES ops_monitors(id),
 observed_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), snapshot jsonb NOT NULL, error_code text,
 UNIQUE(monitor_id, observed_at)
);
CREATE INDEX IF NOT EXISTS ops_observation_retention ON ops_observations(received_at);
CREATE TABLE IF NOT EXISTS ops_rules (
 id text PRIMARY KEY, source text NOT NULL, signal_key text NOT NULL, enabled boolean NOT NULL,
 threshold text NOT NULL CHECK(threshold ~ '^[0-9]{1,18}$'), minimum_samples integer NOT NULL CHECK(minimum_samples>=0),
 breach_count integer NOT NULL CHECK(breach_count BETWEEN 1 AND 20), recovery_count integer NOT NULL CHECK(recovery_count BETWEEN 1 AND 20),
 severity text NOT NULL CHECK(severity IN('warning','critical')), revision integer NOT NULL DEFAULT 1,
 UNIQUE(source, signal_key)
);
CREATE TABLE IF NOT EXISTS ops_rule_versions (rule_id text NOT NULL, revision integer NOT NULL, value jsonb NOT NULL, actor_id text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(rule_id,revision));
CREATE TABLE IF NOT EXISTS ops_conditions (
 fingerprint text PRIMARY KEY, rule_id text NOT NULL REFERENCES ops_rules(id), group_key text NOT NULL,
 last_observed_at timestamptz NOT NULL, breach_count integer NOT NULL DEFAULT 0, recovery_count integer NOT NULL DEFAULT 0,
 condition text NOT NULL, rule_revision integer NOT NULL
);
CREATE TABLE IF NOT EXISTS ops_incidents (
 id uuid PRIMARY KEY, fingerprint text NOT NULL, environment text NOT NULL, source text NOT NULL, signal_key text NOT NULL, group_key text NOT NULL,
 severity text NOT NULL CHECK(severity IN('warning','critical')), status text NOT NULL CHECK(status IN('open','acknowledged','resolved')),
 condition text NOT NULL CHECK(condition IN('breached','healthy','unknown')), assigned_to text,
 revision integer NOT NULL DEFAULT 1, opened_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, resolved_at timestamptz,
 previous_incident_id uuid REFERENCES ops_incidents(id), evidence jsonb NOT NULL, value text, rule_revision integer NOT NULL,
 observed_at timestamptz, observation_id bigint REFERENCES ops_observations(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_incident_active ON ops_incidents(fingerprint) WHERE status <> 'resolved';
CREATE INDEX IF NOT EXISTS ops_incident_list ON ops_incidents(opened_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS ops_transitions (
 id uuid PRIMARY KEY, incident_id uuid NOT NULL REFERENCES ops_incidents(id), action text NOT NULL, actor_id text,
 reason text, created_at timestamptz NOT NULL DEFAULT now(), revision integer NOT NULL,
 UNIQUE(incident_id,revision)
);
CREATE TABLE IF NOT EXISTS ops_maintenance (
 id uuid PRIMARY KEY, source text, rule_id text REFERENCES ops_rules(id), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
 reason text NOT NULL, actor_id text NOT NULL, expired_at timestamptz, CHECK(ends_at>starts_at)
);
CREATE TABLE IF NOT EXISTS ops_outbox (
 id uuid PRIMARY KEY, incident_id uuid NOT NULL REFERENCES ops_incidents(id), transition_id uuid NOT NULL REFERENCES ops_transitions(id),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0, delivered_at timestamptz, lease_until timestamptz, fence bigint NOT NULL DEFAULT 0,
 UNIQUE(transition_id)
);
CREATE INDEX IF NOT EXISTS ops_outbox_pending ON ops_outbox(next_attempt_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS ops_audit (
 id uuid PRIMARY KEY, environment text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), actor_id text,
 action text NOT NULL, status text NOT NULL, customer_id text, resource_type text NOT NULL, resource_id text NOT NULL,
 operation_id text, code text
);
CREATE INDEX IF NOT EXISTS ops_audit_list ON ops_audit(occurred_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS ops_commands (
 operation_id uuid PRIMARY KEY, actor_id text NOT NULL, body_digest text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ops_worker_progress (id text PRIMARY KEY, updated_at timestamptz NOT NULL);
