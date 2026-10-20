ALTER TABLE agents_platform.tasks ALTER COLUMN harness_release SET DEFAULT 'modular-programs-v5';
CREATE TABLE agents_platform.skill_script_executions (
 operation_id text PRIMARY KEY,
 task_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 agent_id uuid NOT NULL,
 skill_revision_id uuid NOT NULL,
 package_digest text NOT NULL CHECK(package_digest ~ '^[a-f0-9]{64}$'),
 script_path text NOT NULL CHECK(octet_length(script_path) BETWEEN 1 AND 256),
 script_digest text NOT NULL CHECK(script_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(task_id,operation_id) REFERENCES agents_platform.operations(task_id,id),
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,agent_id,skill_revision_id) REFERENCES agents_platform.skill_revisions(organization_id,agent_id,id)
);
CREATE TRIGGER immutable_skill_script_execution BEFORE UPDATE OR DELETE ON agents_platform.skill_script_executions
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
