CREATE TABLE agents_platform.conversation_retention_policies (
  organization_id uuid PRIMARY KEY REFERENCES agents_platform.organizations(id),
  inactivity_days integer CHECK(inactivity_days=90),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agents_platform.conversation_retention_policy_events (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
  inactivity_days integer CHECK(inactivity_days=90), operator text NOT NULL CHECK(length(operator) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER immutable_conversation_retention_policy_event BEFORE UPDATE OR DELETE
  ON agents_platform.conversation_retention_policy_events FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
ALTER TABLE agents_platform.conversations ADD COLUMN retention_hold boolean NOT NULL DEFAULT false;
-- Tombstones deliberately have no live-row foreign key: an older restore may lack the row.
CREATE TABLE agents_platform.conversation_retention_tombstones (
  conversation_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL
);
INSERT INTO agents_platform.conversation_retention_tombstones
  SELECT id,organization_id,deleted_at FROM agents_platform.conversations WHERE deleted_at IS NOT NULL;
CREATE FUNCTION agents_platform.record_conversation_deletion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND (NEW.deleted_at IS NULL OR NEW.deleted_at>OLD.deleted_at) THEN
    RAISE EXCEPTION 'Conversation deletion cannot be reversed' USING ERRCODE='23514';
  END IF;
  IF NEW.deleted_at IS NOT NULL THEN
    INSERT INTO agents_platform.conversation_retention_tombstones VALUES(NEW.id,NEW.organization_id,NEW.deleted_at)
      ON CONFLICT(conversation_id) DO UPDATE SET deleted_at=least(conversation_retention_tombstones.deleted_at,excluded.deleted_at);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER conversation_deletion_ledger BEFORE UPDATE OF deleted_at ON agents_platform.conversations
  FOR EACH ROW EXECUTE FUNCTION agents_platform.record_conversation_deletion();
CREATE FUNCTION agents_platform.fence_deleted_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM agents_platform.conversation_retention_tombstones WHERE conversation_id=NEW.id) THEN
    RAISE EXCEPTION 'Conversation was deleted' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER conversation_deletion_fence BEFORE INSERT ON agents_platform.conversations
  FOR EACH ROW EXECUTE FUNCTION agents_platform.fence_deleted_conversation();

CREATE FUNCTION agents_platform.export_conversation_deletion_ledger() RETURNS jsonb LANGUAGE sql AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('conversationId',conversation_id,'organizationId',organization_id,
    'deletedAt',deleted_at) ORDER BY conversation_id),'[]'::jsonb) FROM agents_platform.conversation_retention_tombstones;
$$;
CREATE FUNCTION agents_platform.replay_conversation_deletion_ledger(items jsonb) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item jsonb; conversation uuid; organization uuid; deleted timestamptz; task record; changed integer:=0;
BEGIN
  IF jsonb_typeof(items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid conversation deletion ledger'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(items) LOOP
    IF jsonb_typeof(item)<>'object' OR item-'conversationId'-'organizationId'-'deletedAt'<>'{}'::jsonb
      OR NOT item ?& ARRAY['conversationId','organizationId','deletedAt'] THEN RAISE EXCEPTION 'Invalid conversation tombstone'; END IF;
    conversation:=(item->>'conversationId')::uuid; organization:=(item->>'organizationId')::uuid; deleted:=(item->>'deletedAt')::timestamptz;
    IF conversation IS NULL OR organization IS NULL OR deleted IS NULL OR deleted>now()+interval '5 minutes' THEN RAISE EXCEPTION 'Invalid conversation tombstone'; END IF;
    PERFORM id FROM agents_platform.organizations WHERE id=organization FOR NO KEY UPDATE;
    IF EXISTS(SELECT 1 FROM agents_platform.conversations WHERE id=conversation AND organization_id<>organization) THEN RAISE EXCEPTION 'Conversation tombstone scope mismatch'; END IF;
    IF EXISTS(SELECT 1 FROM agents_platform.conversation_retention_tombstones WHERE conversation_id=conversation AND organization_id<>organization) THEN RAISE EXCEPTION 'Conversation tombstone scope mismatch'; END IF;
    INSERT INTO agents_platform.conversation_retention_tombstones VALUES(conversation,organization,deleted)
      ON CONFLICT(conversation_id) DO UPDATE SET deleted_at=least(conversation_retention_tombstones.deleted_at,excluded.deleted_at);
    PERFORM id FROM agents_platform.tasks WHERE conversation_id=conversation ORDER BY id FOR NO KEY UPDATE;
    PERFORM id FROM agents_platform.conversations WHERE id=conversation FOR UPDATE;
    UPDATE agents_platform.conversations SET deleted_at=least(coalesce(deleted_at,deleted),deleted) WHERE id=conversation;
    FOR task IN WITH RECURSIVE affected AS (
      SELECT id FROM agents_platform.tasks WHERE conversation_id=conversation
      UNION SELECT t.id FROM agents_platform.tasks t JOIN affected a ON t.parent_task_id=a.id
    ) UPDATE agents_platform.tasks SET state='cancel_requested',updated_at=now() WHERE id IN (SELECT id FROM affected)
      AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested') RETURNING id LOOP
      INSERT INTO agents_platform.task_events(task_id,event_key,kind) VALUES(task.id,'cancel-intent:'||task.id,'cancel_requested') ON CONFLICT DO NOTHING;
    END LOOP;
    PERFORM agents_platform.forget_conversation_memories(conversation);
    changed:=changed+1;
  END LOOP;
  RETURN changed;
END; $$;
