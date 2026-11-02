CREATE TABLE agents_platform.query_embedding_allocations (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 task_id uuid NOT NULL REFERENCES agents_platform.tasks(id), operation_id text NOT NULL REFERENCES agents_platform.operations(id),
 profile_release text NOT NULL, input_digest text NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('admitted','running','completed','destroyed')),
 lease_expires_at timestamptz NOT NULL, receipt jsonb, result_key text, result_digest text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,operation_id)
);
CREATE INDEX query_embedding_allocations_reap ON agents_platform.query_embedding_allocations(lease_expires_at) WHERE state<>'destroyed';
