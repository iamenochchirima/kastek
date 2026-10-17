CREATE TABLE agents_platform.connections (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 account_id uuid NOT NULL REFERENCES agents_platform.accounts(id), name text NOT NULL,
 target_id text NOT NULL, resource text NOT NULL, revision integer NOT NULL DEFAULT 1,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days', created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id)
);
CREATE TABLE agents_platform.connection_credentials (
 connection_id uuid NOT NULL REFERENCES agents_platform.connections(id), revision integer NOT NULL,
 envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(connection_id,revision)
);
CREATE TABLE agents_platform.connection_mutations (
 organization_id uuid NOT NULL, account_id uuid NOT NULL, operation_id text NOT NULL,
 request_digest text NOT NULL, connection_id uuid NOT NULL REFERENCES agents_platform.connections(id), result jsonb NOT NULL,
 PRIMARY KEY(organization_id,account_id,operation_id)
);
CREATE TABLE agents_platform.actions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 reviewer_account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 task_id uuid NOT NULL, root_task_id uuid NOT NULL UNIQUE, operation_id text NOT NULL,
 connection_id uuid NOT NULL, connection_revision integer NOT NULL, target_id text NOT NULL,
 target_digest text NOT NULL, binding_digest text NOT NULL, artifact_id uuid NOT NULL REFERENCES agents_platform.artifacts(id), artifact_digest text NOT NULL,
 title text NOT NULL, request_digest text NOT NULL, payload jsonb NOT NULL, payload_digest text NOT NULL,
 review_digest text NOT NULL, state text NOT NULL CHECK(state IN ('pending_review','approved','rejected','expired','invalidated','claimed','delivered','failed','uncertain')),
 expires_at timestamptz NOT NULL, approved_at timestamptz, claimed_at timestamptz,
 receipt jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,connection_id) REFERENCES agents_platform.connections(organization_id,id),
 FOREIGN KEY(connection_id,connection_revision) REFERENCES agents_platform.connection_credentials(connection_id,revision),
 UNIQUE(task_id,operation_id)
);
CREATE INDEX actions_reconciliation ON agents_platform.actions(updated_at) WHERE state IN ('claimed','uncertain');
CREATE TABLE agents_platform.action_decisions (
 action_id uuid NOT NULL REFERENCES agents_platform.actions(id), operation_id text NOT NULL,
 request_digest text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(action_id,operation_id)
);
