CREATE SCHEMA agents_platform;

CREATE TABLE agents_platform.accounts (
  id uuid PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);

CREATE TABLE agents_platform.organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents_platform.memberships (
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  revoked_at timestamptz,
  PRIMARY KEY (organization_id, account_id)
);

CREATE TABLE agents_platform.sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  provider_session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_provider ON agents_platform.sessions(provider_session_id);

CREATE TABLE agents_platform.login_transactions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  state text NOT NULL,
  nonce text NOT NULL,
  verifier text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);

CREATE TABLE agents_platform.logout_tokens (
  jti text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);

CREATE TABLE agents_platform.agents (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  draft jsonb NOT NULL CHECK (jsonb_typeof(draft) = 'object'),
  draft_revision integer NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE TABLE agents_platform.agent_versions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  draft_revision integer NOT NULL CHECK (draft_revision > 0),
  execution_kind text NOT NULL CHECK (execution_kind IN ('business', 'workspace')),
  configuration jsonb NOT NULL CHECK (configuration->>'executionKind' = execution_kind),
  tool_bindings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents_platform.agents(organization_id, id),
  UNIQUE (agent_id, number),
  UNIQUE (agent_id, draft_revision),
  UNIQUE (organization_id, agent_id, id),
  UNIQUE (organization_id, id)
);

CREATE FUNCTION agents_platform.reject_snapshot_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published configuration and approved knowledge are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_agent_version BEFORE UPDATE OR DELETE ON agents_platform.agent_versions
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.execution_grants (
  id uuid PRIMARY KEY,
  product text NOT NULL CHECK (product IN ('agents', 'growth', 'agencies')),
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  resource_id text NOT NULL,
  caller_client_id text NOT NULL,
  principal jsonb NOT NULL CHECK (principal->>'kind' IN ('human', 'automation', 'visitor')),
  version_id uuid NOT NULL,
  operations jsonb NOT NULL CHECK (jsonb_typeof(operations) = 'array'),
  max_input_bytes integer NOT NULL CHECK (max_input_bytes BETWEEN 1 AND 16384),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 1024),
  max_context_tokens integer NOT NULL DEFAULT 8192 CHECK (max_context_tokens BETWEEN 2048 AND 8192),
  root_token_limit integer NOT NULL DEFAULT 32000 CHECK (root_token_limit BETWEEN 2048 AND 32000),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, version_id) REFERENCES agents_platform.agent_versions(organization_id, id),
  UNIQUE (organization_id, id),
  CHECK (expires_at > created_at)
);

CREATE TABLE agents_platform.website_deployments (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version_id uuid NOT NULL,
  allowed_origins jsonb NOT NULL CHECK (jsonb_typeof(allowed_origins) = 'array' AND jsonb_array_length(allowed_origins) BETWEEN 1 AND 10),
  published_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents_platform.agents(organization_id, id),
  FOREIGN KEY (organization_id, agent_id, version_id) REFERENCES agents_platform.agent_versions(organization_id, agent_id, id),
  UNIQUE (organization_id, id)
);

CREATE TABLE agents_platform.website_sessions (
  id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES agents_platform.website_deployments(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day'
);

CREATE TABLE agents_platform.website_rate_limits (
  deployment_id uuid NOT NULL REFERENCES agents_platform.website_deployments(id),
  minute timestamptz NOT NULL,
  requests integer NOT NULL CHECK (requests > 0),
  PRIMARY KEY (deployment_id, minute)
);

CREATE TABLE agents_platform.conversations (
  id uuid PRIMARY KEY,
  next_sequence bigint NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  principal jsonb NOT NULL,
  deployment_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents_platform.agents(organization_id, id),
  FOREIGN KEY (organization_id, deployment_id) REFERENCES agents_platform.website_deployments(organization_id, id),
  UNIQUE (organization_id, id)
);

CREATE TABLE agents_platform.tasks (
  id uuid PRIMARY KEY,
  product text NOT NULL CHECK (product IN ('agents', 'growth', 'agencies')),
  organization_id uuid NOT NULL,
  resource_id text NOT NULL,
  caller_client_id text NOT NULL,
  principal jsonb NOT NULL,
  version_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 128),
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  input text NOT NULL CHECK (octet_length(input) BETWEEN 1 AND 16384),
  state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted', 'running', 'waiting_children', 'waiting_authority', 'waiting_review', 'reconciling', 'cancel_requested', 'completed', 'incomplete', 'refused', 'failed', 'cancelled', 'uncertain')),
  turn_sequence bigint NOT NULL DEFAULT 1,
  harness_release text NOT NULL DEFAULT 'connected-research-v3',
  root_task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  parent_task_id uuid REFERENCES agents_platform.tasks(id),
  depth integer NOT NULL DEFAULT 0 CHECK(depth BETWEEN 0 AND 1),
  delegation_operation_id text,
  effective_configuration jsonb,
  allocation_released boolean NOT NULL DEFAULT false,
  pending_outcome jsonb,
  disposition text NOT NULL DEFAULT 'settled' CHECK(disposition IN ('settled','pending_children','pending_resources')),
  allocation_active_ms integer NOT NULL DEFAULT 900000 CHECK(allocation_active_ms BETWEEN 1000 AND 900000),
  root_token_limit integer NOT NULL DEFAULT 32000 CHECK (root_token_limit BETWEEN 2048 AND 32000),
  tokens_used integer NOT NULL DEFAULT 0 CHECK (tokens_used>=0),
  tokens_reserved integer NOT NULL DEFAULT 0 CHECK (tokens_reserved>=0),
  model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls BETWEEN 0 AND 12),
  tool_calls integer NOT NULL DEFAULT 0 CHECK (tool_calls BETWEEN 0 AND 24),
  active_ms integer NOT NULL DEFAULT 0 CHECK(active_ms>=0),
  active_reserved_ms integer NOT NULL DEFAULT 0 CHECK(active_reserved_ms>=0),
  deadline_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  history_cutoff bigint,
  control_generation bigint NOT NULL DEFAULT 0,
  runtime_invocation_id text,
  output text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, version_id) REFERENCES agents_platform.agent_versions(organization_id, id),
  FOREIGN KEY (organization_id, grant_id) REFERENCES agents_platform.execution_grants(organization_id, id),
  FOREIGN KEY (organization_id, conversation_id) REFERENCES agents_platform.conversations(organization_id, id),
  UNIQUE (product, organization_id, caller_client_id, resource_id, request_key),
  UNIQUE (organization_id, id)
);

CREATE FUNCTION agents_platform.task_lineage_default() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.root_task_id IS NULL THEN NEW.root_task_id=NEW.id; END IF;
  IF (NEW.parent_task_id IS NULL AND (NEW.root_task_id<>NEW.id OR NEW.depth<>0)) OR
     (NEW.parent_task_id IS NOT NULL AND (NEW.root_task_id=NEW.id OR NEW.depth<>1)) THEN
    RAISE EXCEPTION 'Invalid task lineage';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER task_lineage BEFORE INSERT ON agents_platform.tasks FOR EACH ROW EXECUTE FUNCTION agents_platform.task_lineage_default();
CREATE INDEX tasks_root ON agents_platform.tasks(root_task_id,parent_task_id);
CREATE TABLE agents_platform.execution_roots (
  root_task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  tokens_used integer NOT NULL DEFAULT 0 CHECK(tokens_used>=0),
  tokens_reserved integer NOT NULL DEFAULT 0 CHECK(tokens_reserved>=0),
  child_reserved_tokens integer NOT NULL DEFAULT 0 CHECK(child_reserved_tokens>=0),
  model_calls integer NOT NULL DEFAULT 0 CHECK(model_calls BETWEEN 0 AND 12),
  tool_calls integer NOT NULL DEFAULT 0 CHECK(tool_calls BETWEEN 0 AND 24),
  active_ms integer NOT NULL DEFAULT 0 CHECK(active_ms>=0),
  active_reserved_ms integer NOT NULL DEFAULT 0 CHECK(active_reserved_ms>=0),
  child_reserved_ms integer NOT NULL DEFAULT 0 CHECK(child_reserved_ms>=0),
  settled_at timestamptz
);
CREATE TABLE agents_platform.delegations (
  parent_task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  operation_id text NOT NULL,
  slot integer NOT NULL CHECK(slot BETWEEN 0 AND 1),
  child_task_id uuid NOT NULL UNIQUE REFERENCES agents_platform.tasks(id),
  binding_id text NOT NULL,
  input_manifest jsonb NOT NULL CHECK(jsonb_typeof(input_manifest)='object'),
  request_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(parent_task_id,operation_id,slot)
);

CREATE TRIGGER immutable_delegation BEFORE UPDATE OR DELETE ON agents_platform.delegations
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

CREATE TABLE agents_platform.task_events (
  sequence bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  event_key text NOT NULL,
  kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 100),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, event_key)
);

CREATE TABLE agents_platform.task_outbox (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_owner uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  dispatched_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_outbox_due ON agents_platform.task_outbox(available_at) WHERE dispatched_at IS NULL;
CREATE TABLE agents_platform.task_controls (
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  generation bigint NOT NULL,
  kind text NOT NULL DEFAULT 'authority' CHECK(kind IN ('authority','review')),
  dispatched_at timestamptz,
  PRIMARY KEY(task_id,generation)
);

CREATE UNIQUE INDEX conversation_turn_order ON agents_platform.tasks(conversation_id,turn_sequence);
CREATE TABLE agents_platform.operations (
  id text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  kind text NOT NULL CHECK(kind IN ('model','compaction','tool','delegation','resource')),
  name text NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('started','completed','failed','uncertain')),
  output jsonb,
  error_code text,
  reserved_tokens integer NOT NULL DEFAULT 0 CHECK(reserved_tokens>=0),
  accounted_tokens integer NOT NULL DEFAULT 0 CHECK(accounted_tokens>=0),
  reserved_ms integer NOT NULL CHECK(reserved_ms>=0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  attempt_id uuid NOT NULL,
  adapter_version text NOT NULL DEFAULT '1',
  UNIQUE(task_id,id)
);
CREATE INDEX operation_task ON agents_platform.operations(task_id,started_at,id);
CREATE TABLE agents_platform.context_snapshots (
  id text PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  step integer NOT NULL,
  digest text NOT NULL,
  payload jsonb NOT NULL,
  source_references jsonb NOT NULL DEFAULT '[]'::jsonb,
  memory_scope_id uuid,
  memory_generation bigint,
  history_cutoff bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,step)
);
CREATE TRIGGER immutable_context_snapshot BEFORE UPDATE ON agents_platform.context_snapshots
  FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.operation_usage (
  operation_id text PRIMARY KEY REFERENCES agents_platform.operations(id),
  task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
  accounted_tokens integer NOT NULL CHECK(accounted_tokens>=0),
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents_platform.usage_accounts (
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  day date NOT NULL,
  token_allowance integer NOT NULL DEFAULT 100000 CHECK (token_allowance > 0),
  reserved_tokens integer NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  consumed_tokens integer NOT NULL DEFAULT 0 CHECK (consumed_tokens >= 0),
  PRIMARY KEY (organization_id, day),
  CHECK (reserved_tokens + consumed_tokens <= token_allowance)
);

CREATE TABLE agents_platform.usage_reservations (
  task_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  day date NOT NULL,
  tokens integer NOT NULL CHECK (tokens > 0),
  settled_at timestamptz,
  FOREIGN KEY (organization_id, task_id) REFERENCES agents_platform.tasks(organization_id, id),
  FOREIGN KEY (organization_id, day) REFERENCES agents_platform.usage_accounts(organization_id, day)
);

CREATE TABLE agents_platform.usage_ledger (
  task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id),
  operation_id text NOT NULL UNIQUE,
  accounted_tokens integer NOT NULL CHECK (accounted_tokens >= 0),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'incomplete', 'refused', 'failed', 'cancelled', 'uncertain')),
  created_at timestamptz NOT NULL DEFAULT now()
);
