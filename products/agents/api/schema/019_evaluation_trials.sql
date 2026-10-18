CREATE TABLE agents_platform.evaluation_trials (
  id uuid PRIMARY KEY,
  trial_id text NOT NULL CHECK(length(trial_id) BETWEEN 1 AND 128),
  organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
  agent_id uuid NOT NULL UNIQUE REFERENCES agents_platform.agents(id),
  version_id uuid NOT NULL REFERENCES agents_platform.agent_versions(id),
  composition_digest text NOT NULL CHECK(composition_digest ~ '^[a-f0-9]{64}$'),
  max_tokens integer NOT NULL CHECK(max_tokens BETWEEN 2048 AND 32000),
  allocated_tokens integer NOT NULL DEFAULT 0 CHECK(allocated_tokens>=0 AND allocated_tokens<=max_tokens),
  request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(organization_id,account_id,trial_id),
  UNIQUE(id,organization_id),
  FOREIGN KEY(organization_id,version_id) REFERENCES agents_platform.agent_versions(organization_id,id)
);
ALTER TABLE agents_platform.tasks ADD COLUMN evaluation_trial_id uuid;
ALTER TABLE agents_platform.tasks ADD CONSTRAINT task_evaluation_scope
  FOREIGN KEY(evaluation_trial_id,organization_id) REFERENCES agents_platform.evaluation_trials(id,organization_id);
CREATE INDEX evaluation_tasks ON agents_platform.tasks(evaluation_trial_id,id) WHERE evaluation_trial_id IS NOT NULL;
CREATE FUNCTION agents_platform.protect_trial_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.evaluation_trial_id IS DISTINCT FROM OLD.evaluation_trial_id
  THEN RAISE EXCEPTION 'Evaluation trial binding is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_task_trial BEFORE UPDATE ON agents_platform.tasks
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_trial_binding();
