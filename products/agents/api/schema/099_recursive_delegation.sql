ALTER TABLE agents_platform.tasks DROP CONSTRAINT tasks_depth_check;
ALTER TABLE agents_platform.tasks ADD CONSTRAINT tasks_depth_check CHECK(depth >= 0);

CREATE OR REPLACE FUNCTION agents_platform.task_lineage_default() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent agents_platform.tasks;
BEGIN
  IF NEW.root_task_id IS NULL THEN NEW.root_task_id=NEW.id; END IF;
  IF NEW.parent_task_id IS NULL THEN
    IF NEW.root_task_id<>NEW.id OR NEW.depth<>0 THEN RAISE EXCEPTION 'Invalid task lineage'; END IF;
  ELSE
    SELECT * INTO STRICT parent FROM agents_platform.tasks WHERE id=NEW.parent_task_id AND organization_id=NEW.organization_id;
    IF NEW.id=parent.id OR NEW.root_task_id<>parent.root_task_id OR NEW.depth<>parent.depth+1 OR
       NEW.product<>parent.product OR NEW.principal<>parent.principal THEN
      RAISE EXCEPTION 'Invalid child lineage';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE FUNCTION agents_platform.immutable_task_tree_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.root_task_id IS DISTINCT FROM OLD.root_task_id OR NEW.parent_task_id IS DISTINCT FROM OLD.parent_task_id OR NEW.depth IS DISTINCT FROM OLD.depth THEN
    RAISE EXCEPTION 'Task tree lineage is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER immutable_task_tree_lineage BEFORE UPDATE OF root_task_id,parent_task_id,depth ON agents_platform.tasks
FOR EACH ROW EXECUTE FUNCTION agents_platform.immutable_task_tree_lineage();
