CREATE TABLE agents_platform.automations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 owner_account_id uuid NOT NULL REFERENCES agents_platform.accounts(id), name text NOT NULL,
 revision integer NOT NULL DEFAULT 1, state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','revoked')),
 event_key_hash text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,id)
);
CREATE TABLE agents_platform.automation_revisions (
 automation_id uuid NOT NULL REFERENCES agents_platform.automations(id), revision integer NOT NULL,
 version_id uuid NOT NULL REFERENCES agents_platform.agent_versions(id), configuration jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(automation_id,revision)
);
CREATE TRIGGER immutable_automation_revision BEFORE UPDATE OR DELETE ON agents_platform.automation_revisions
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.automation_occurrences (
 id uuid PRIMARY KEY, automation_id uuid NOT NULL, revision integer NOT NULL, occurrence_key text NOT NULL,
 input_digest text NOT NULL, scheduled_at timestamptz NOT NULL, status text NOT NULL CHECK(status IN ('accepted','skipped_overlap','blocked','skipped_coalesced')),
 coalesced_count integer NOT NULL DEFAULT 0, task_id uuid UNIQUE REFERENCES agents_platform.tasks(id), error_code text, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(automation_id,revision) REFERENCES agents_platform.automation_revisions(automation_id,revision),
 UNIQUE(automation_id,occurrence_key)
);
CREATE INDEX automation_occurrence_daily ON agents_platform.automation_occurrences(automation_id,created_at);
CREATE TABLE agents_platform.automation_timer_outbox (
 automation_id uuid NOT NULL, revision integer NOT NULL, dispatched_at timestamptz,
 PRIMARY KEY(automation_id,revision), FOREIGN KEY(automation_id,revision) REFERENCES agents_platform.automation_revisions(automation_id,revision)
);
CREATE TABLE agents_platform.automation_mutations (
 automation_id uuid NOT NULL REFERENCES agents_platform.automations(id), operation_id uuid NOT NULL,
 digest text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(automation_id,operation_id)
);
