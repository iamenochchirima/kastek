CREATE TABLE agents_platform.sandbox_allocations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  root_task_id uuid NOT NULL,
  task_id uuid NOT NULL,
  operation_id text NOT NULL,
  request_digest text NOT NULL,
  profile_id text NOT NULL CHECK(profile_id='python-analysis-v1'),
  state text NOT NULL CHECK(state IN ('provisioning','running','awaiting_export','destroying','destroyed','uncertain')),
  unit_name text NOT NULL UNIQUE CHECK(unit_name='kasitek-sandbox-'||id::text||'.service'),
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id),
  FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
  UNIQUE(task_id,operation_id)
);
CREATE INDEX sandbox_expiry ON agents_platform.sandbox_allocations(lease_expires_at) WHERE state<>'destroyed';
CREATE TABLE agents_platform.sandbox_commands (
  id uuid PRIMARY KEY,
  allocation_id uuid NOT NULL UNIQUE REFERENCES agents_platform.sandbox_allocations(id),
  operation_id text NOT NULL,
  state text NOT NULL CHECK(state IN ('prepared','running','completed','failed','uncertain')),
  exit_code integer,
  error_code text,
  export_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
