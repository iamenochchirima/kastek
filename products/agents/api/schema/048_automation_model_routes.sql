CREATE TABLE agents_platform.automation_model_routes (
 automation_id uuid NOT NULL,
 revision integer NOT NULL,
 organization_id uuid NOT NULL,
 version_id uuid NOT NULL,
 routes jsonb NOT NULL CHECK(jsonb_typeof(routes)='object'),
 snapshot_digest text NOT NULL CHECK(snapshot_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(automation_id,revision),
 FOREIGN KEY(automation_id,revision) REFERENCES agents_platform.automation_revisions(automation_id,revision),
 FOREIGN KEY(organization_id,automation_id) REFERENCES agents_platform.automations(organization_id,id),
 FOREIGN KEY(organization_id,version_id) REFERENCES agents_platform.agent_versions(organization_id,id)
);
CREATE TRIGGER immutable_automation_model_routes BEFORE UPDATE OR DELETE ON agents_platform.automation_model_routes
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
