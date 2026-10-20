CREATE TABLE agents_platform.tool_invocation_reviews (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL,
 task_id uuid NOT NULL,
 root_task_id uuid NOT NULL,
 operation_id text NOT NULL,
 binding_id uuid NOT NULL,
 binding_digest text NOT NULL CHECK(length(binding_digest)=64),
 request_digest text NOT NULL CHECK(length(request_digest)=64),
 arguments jsonb NOT NULL,
 connection_id uuid NOT NULL,
 connection_policy_revision integer NOT NULL,
 reviewer_account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 state text NOT NULL CHECK(state IN ('pending','approved','rejected','claimed','completed','uncertain','invalidated','expired')),
 expires_at timestamptz NOT NULL,
 approved_at timestamptz,
 claimed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,binding_id) REFERENCES agents_platform.capability_bindings(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.connections(organization_id,id),
 UNIQUE(task_id,operation_id)
);
CREATE INDEX tool_reviews_actor ON agents_platform.tool_invocation_reviews(organization_id,reviewer_account_id,state,created_at,id);
ALTER TABLE agents_platform.connected_attempts DROP CONSTRAINT connected_attempts_ordinal_check;
ALTER TABLE agents_platform.connected_attempts ADD CONSTRAINT connected_attempts_ordinal_check CHECK(ordinal BETWEEN 1 AND 128);
