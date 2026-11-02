ALTER TABLE agents_platform.tasks ADD COLUMN work_id uuid;
ALTER TABLE agents_platform.tasks ADD COLUMN prior_task_id uuid;
ALTER TABLE agents_platform.tasks ADD COLUMN execution_policy_version integer NOT NULL DEFAULT 1 CHECK(execution_policy_version>=1);
UPDATE agents_platform.tasks SET work_id=root_task_id;
ALTER TABLE agents_platform.tasks ALTER COLUMN work_id SET NOT NULL;
ALTER TABLE agents_platform.tasks ADD FOREIGN KEY(organization_id,work_id) REFERENCES agents_platform.tasks(organization_id,id);
ALTER TABLE agents_platform.tasks ADD FOREIGN KEY(organization_id,prior_task_id) REFERENCES agents_platform.tasks(organization_id,id);
CREATE UNIQUE INDEX tasks_one_continuation ON agents_platform.tasks(prior_task_id) WHERE prior_task_id IS NOT NULL;
CREATE INDEX tasks_logical_work ON agents_platform.tasks(work_id,created_at,id);

CREATE FUNCTION agents_platform.task_work_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior agents_platform.tasks; parent agents_platform.tasks;
BEGIN
  IF NEW.parent_task_id IS NOT NULL THEN
    SELECT * INTO STRICT parent FROM agents_platform.tasks WHERE id=NEW.parent_task_id AND organization_id=NEW.organization_id;
    IF NEW.prior_task_id IS NOT NULL OR (NEW.work_id IS NOT NULL AND NEW.work_id<>parent.work_id) THEN RAISE EXCEPTION 'Invalid child work lineage'; END IF;
    NEW.work_id=parent.work_id;
  ELSIF NEW.prior_task_id IS NOT NULL THEN
    SELECT * INTO STRICT prior FROM agents_platform.tasks WHERE id=NEW.prior_task_id AND organization_id=NEW.organization_id;
    IF prior.parent_task_id IS NOT NULL OR prior.state NOT IN ('incomplete','failed') OR
      prior.conversation_id<>NEW.conversation_id OR prior.version_id<>NEW.version_id OR prior.product<>NEW.product OR
      prior.principal<>NEW.principal OR prior.resource_id<>NEW.resource_id OR prior.caller_client_id<>NEW.caller_client_id OR
      (NEW.work_id IS NOT NULL AND NEW.work_id<>prior.work_id) THEN RAISE EXCEPTION 'Invalid continuation work lineage'; END IF;
    NEW.work_id=prior.work_id;
  ELSE
    IF NEW.work_id IS NOT NULL AND NEW.work_id<>NEW.id THEN RAISE EXCEPTION 'Invalid root work lineage'; END IF;
    NEW.work_id=NEW.id;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER task_work_lineage BEFORE INSERT ON agents_platform.tasks FOR EACH ROW EXECUTE FUNCTION agents_platform.task_work_lineage();

CREATE FUNCTION agents_platform.immutable_task_work_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_id IS DISTINCT FROM OLD.work_id OR NEW.prior_task_id IS DISTINCT FROM OLD.prior_task_id THEN
    RAISE EXCEPTION 'Task work lineage is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_task_work_lineage BEFORE UPDATE OF work_id,prior_task_id ON agents_platform.tasks
FOR EACH ROW EXECUTE FUNCTION agents_platform.immutable_task_work_lineage();
