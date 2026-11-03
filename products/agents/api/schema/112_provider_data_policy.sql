-- Operator-reviewed evidence is scoped to the exact credential, endpoint and model.
CREATE TABLE agents_platform.model_provider_data_policies (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 connection_id uuid NOT NULL REFERENCES agents_platform.model_provider_connections(id),
 model_id text NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 policy jsonb NOT NULL,
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,connection_id,model_id,revision)
);
CREATE TRIGGER immutable_model_provider_data_policy BEFORE UPDATE OR DELETE
 ON agents_platform.model_provider_data_policies FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

-- A restored snapshot must not reactivate evidence revoked after that snapshot was taken.
CREATE TABLE agents_platform.model_provider_data_policy_restore_fences (
 id uuid PRIMARY KEY,
 fenced_at timestamptz NOT NULL
);
CREATE TRIGGER immutable_model_provider_data_policy_restore_fence BEFORE UPDATE OR DELETE
 ON agents_platform.model_provider_data_policy_restore_fences FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE FUNCTION agents_platform.fence_restored_provider_data_policies() RETURNS timestamptz
 LANGUAGE plpgsql AS $$
DECLARE restored_at timestamptz := clock_timestamp();
BEGIN
 INSERT INTO agents_platform.model_provider_data_policy_restore_fences(id,fenced_at)
 VALUES(gen_random_uuid(),restored_at);
 RETURN restored_at;
END;
$$;
