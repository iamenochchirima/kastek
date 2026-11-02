ALTER TABLE agents_platform.execution_grants ADD COLUMN source_revision_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE agents_platform.execution_grants ADD COLUMN connected_tool_binding_ids uuid[] NOT NULL DEFAULT '{}';
CREATE TABLE agents_platform.version_connected_tools (
 organization_id uuid NOT NULL, version_id uuid NOT NULL, binding_id uuid NOT NULL,
 PRIMARY KEY(version_id,binding_id),
 FOREIGN KEY(organization_id,version_id) REFERENCES agents_platform.agent_versions(organization_id,id),
 FOREIGN KEY(organization_id,binding_id) REFERENCES agents_platform.capability_bindings(organization_id,id)
);
CREATE TRIGGER immutable_version_connected_tools BEFORE UPDATE OR DELETE ON agents_platform.version_connected_tools FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
