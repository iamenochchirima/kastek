CREATE TABLE agents_platform.memory_scopes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  generation bigint NOT NULL DEFAULT 0,
  next_expiry_at timestamptz,
  UNIQUE(organization_id,agent_id,account_id),
  FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id)
);
CREATE TABLE agents_platform.memories (
  id uuid PRIMARY KEY,
  scope_id uuid NOT NULL REFERENCES agents_platform.memory_scopes(id),
  kind text NOT NULL CHECK(kind IN ('semantic','episodic')),
  status text NOT NULL CHECK(status IN ('candidate','accepted','forgotten')),
  content text NOT NULL CHECK(octet_length(content)<=8192),
  content_digest text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  source_task_id uuid REFERENCES agents_platform.tasks(id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_search ON agents_platform.memories USING gin(to_tsvector('simple',content));
CREATE TABLE agents_platform.memory_revisions (
  memory_id uuid NOT NULL REFERENCES agents_platform.memories(id),
  revision integer NOT NULL,
  content text NOT NULL,
  content_digest text NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(memory_id,revision)
);
CREATE TABLE agents_platform.memory_suppressions (
  scope_id uuid NOT NULL REFERENCES agents_platform.memory_scopes(id),
  content_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scope_id,content_digest)
);
CREATE TABLE agents_platform.memory_mutations (
  scope_id uuid NOT NULL REFERENCES agents_platform.memory_scopes(id),
  operation_id text NOT NULL,
  request_digest text NOT NULL,
  memory_id uuid NOT NULL REFERENCES agents_platform.memories(id),
  PRIMARY KEY(scope_id,operation_id)
);
CREATE TABLE agents_platform.skill_revisions (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES agents_platform.accounts(id),
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  description text NOT NULL CHECK(octet_length(description)<=1024),
  body text NOT NULL CHECK(octet_length(body)<=16384),
  revision integer NOT NULL CHECK(revision>0),
  content_digest text NOT NULL,
  operation_id text NOT NULL,
  request_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
  UNIQUE(organization_id,agent_id,name,revision),
  UNIQUE(organization_id,agent_id,operation_id)
);
CREATE TRIGGER immutable_skill_revision BEFORE UPDATE OR DELETE ON agents_platform.skill_revisions
FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TABLE agents_platform.artifacts (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  operation_id text NOT NULL,
  request_digest text NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  bytes integer NOT NULL CHECK(bytes BETWEEN 0 AND 1048576),
  content_digest text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','available','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(organization_id,agent_id) REFERENCES agents_platform.agents(organization_id,id),
  UNIQUE(organization_id,agent_id,account_id,operation_id)
);
