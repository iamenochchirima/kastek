ALTER TABLE agents_platform.memory_revisions ADD COLUMN superseded_at timestamptz;
ALTER TABLE agents_platform.memory_revisions ADD COLUMN content_purged_at timestamptz;
ALTER TABLE agents_platform.memories ADD CONSTRAINT forgotten_memory_has_no_content CHECK(status<>'forgotten' OR content='');
UPDATE agents_platform.memory_revisions r SET superseded_at=(SELECT min(n.created_at) FROM agents_platform.memory_revisions n WHERE n.memory_id=r.memory_id AND n.revision>r.revision);
CREATE TABLE agents_platform.memory_revision_fingerprints (
 memory_id uuid NOT NULL, revision integer NOT NULL, content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 PRIMARY KEY(memory_id,revision)
);
INSERT INTO agents_platform.memory_revision_fingerprints SELECT memory_id,revision,content_digest FROM agents_platform.memory_revisions;
CREATE TABLE agents_platform.memory_deletion_tombstones (
 memory_id uuid PRIMARY KEY, scope_id uuid NOT NULL, forgotten_at timestamptz NOT NULL,
 purge_after timestamptz NOT NULL, purged_at timestamptz
);
INSERT INTO agents_platform.memory_deletion_tombstones SELECT id,scope_id,updated_at,updated_at,NULL FROM agents_platform.memories WHERE status='forgotten';
CREATE FUNCTION agents_platform.retain_memory_fingerprint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM agents_platform.memory_revision_fingerprints WHERE memory_id=NEW.memory_id AND revision=NEW.revision AND content_digest<>NEW.content_digest) THEN RAISE EXCEPTION 'Memory fingerprint mismatch'; END IF;
 INSERT INTO agents_platform.memory_revision_fingerprints VALUES(NEW.memory_id,NEW.revision,NEW.content_digest) ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TRIGGER memory_revision_fingerprint AFTER INSERT ON agents_platform.memory_revisions FOR EACH ROW EXECUTE FUNCTION agents_platform.retain_memory_fingerprint();
CREATE TRIGGER immutable_memory_revision_fingerprint BEFORE UPDATE OR DELETE ON agents_platform.memory_revision_fingerprints FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE FUNCTION agents_platform.record_memory_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.revision>OLD.revision THEN
  UPDATE agents_platform.memory_revisions SET superseded_at=coalesce(superseded_at,now()) WHERE memory_id=OLD.id AND revision=OLD.revision;
 END IF;
 IF NEW.status='forgotten' AND OLD.status<>'forgotten' THEN
  INSERT INTO agents_platform.memory_suppressions(scope_id,content_digest)
   SELECT NEW.scope_id,content_digest FROM agents_platform.memory_revision_fingerprints WHERE memory_id=NEW.id ON CONFLICT DO NOTHING;
  INSERT INTO agents_platform.memory_deletion_tombstones VALUES(NEW.id,NEW.scope_id,now(),now(),NULL) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER memory_retention AFTER UPDATE ON agents_platform.memories FOR EACH ROW EXECUTE FUNCTION agents_platform.record_memory_retention();
CREATE FUNCTION agents_platform.purge_memory_revision_content(batch_size integer DEFAULT 100) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE changed integer;
BEGIN
 IF batch_size<1 OR batch_size>1000 THEN RAISE EXCEPTION 'Invalid retention batch'; END IF;
 WITH due AS (
  SELECT r.memory_id,r.revision FROM agents_platform.memory_revisions r JOIN agents_platform.memories m ON m.id=r.memory_id
  LEFT JOIN agents_platform.memory_deletion_tombstones d ON d.memory_id=m.id
  WHERE r.content_purged_at IS NULL AND r.content<>'' AND
   ((m.status='forgotten' AND d.purge_after<=now()) OR (r.revision<m.revision AND r.superseded_at<=now()-interval '30 days'))
  ORDER BY coalesce(d.purge_after,r.superseded_at),r.memory_id,r.revision LIMIT batch_size FOR UPDATE OF r SKIP LOCKED
 ) UPDATE agents_platform.memory_revisions r SET content='',content_purged_at=now() FROM due
 WHERE r.memory_id=due.memory_id AND r.revision=due.revision;
 GET DIAGNOSTICS changed=ROW_COUNT;
 UPDATE agents_platform.memory_deletion_tombstones d SET purged_at=now() WHERE d.purged_at IS NULL AND d.purge_after<=now()
  AND NOT EXISTS(SELECT 1 FROM agents_platform.memory_revisions r WHERE r.memory_id=d.memory_id AND r.content<>'');
 RETURN changed;
END; $$;
CREATE FUNCTION agents_platform.restore_memory_forget(target_memory uuid,target_scope uuid,forgotten timestamptz,fingerprints jsonb,minimum_generation bigint DEFAULT 0) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item jsonb; found_scope uuid; current_digest text; restored record;
BEGIN
 IF forgotten IS NULL OR minimum_generation IS NULL OR minimum_generation<0 OR jsonb_typeof(fingerprints) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid deletion tombstone'; END IF;
 IF EXISTS(SELECT 1 FROM agents_platform.memory_deletion_tombstones WHERE memory_id=target_memory AND scope_id<>target_scope) THEN RAISE EXCEPTION 'Deletion scope mismatch'; END IF;
 SELECT scope_id,content_digest INTO found_scope,current_digest FROM agents_platform.memories WHERE id=target_memory FOR UPDATE;
 IF found_scope IS NOT NULL AND found_scope<>target_scope THEN RAISE EXCEPTION 'Deletion scope mismatch'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(fingerprints) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT (item ?& ARRAY['revision','content_digest']) OR
   EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN ('revision','content_digest')) OR
   jsonb_typeof(item->'revision') IS DISTINCT FROM 'number' OR item->>'revision' !~ '^[1-9][0-9]*$' OR
   jsonb_typeof(item->'content_digest') IS DISTINCT FROM 'string' OR item->>'content_digest' !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid deletion fingerprint'; END IF;
  IF EXISTS(SELECT 1 FROM agents_platform.memory_revision_fingerprints WHERE memory_id=target_memory AND revision=(item->>'revision')::integer AND content_digest<>item->>'content_digest') THEN RAISE EXCEPTION 'Deletion fingerprint mismatch'; END IF;
  INSERT INTO agents_platform.memory_revision_fingerprints VALUES(target_memory,(item->>'revision')::integer,item->>'content_digest') ON CONFLICT DO NOTHING;
  INSERT INTO agents_platform.memory_suppressions(scope_id,content_digest) SELECT target_scope,item->>'content_digest' WHERE EXISTS(SELECT 1 FROM agents_platform.memory_scopes WHERE id=target_scope) ON CONFLICT DO NOTHING;
 END LOOP;
 INSERT INTO agents_platform.memory_deletion_tombstones VALUES(target_memory,target_scope,forgotten,forgotten,NULL)
  ON CONFLICT(memory_id) DO UPDATE SET forgotten_at=least(memory_deletion_tombstones.forgotten_at,excluded.forgotten_at),purge_after=least(memory_deletion_tombstones.purge_after,excluded.purge_after);
 IF found_scope IS NOT NULL THEN
  INSERT INTO agents_platform.memory_suppressions VALUES(target_scope,current_digest,now()) ON CONFLICT DO NOTHING;
  UPDATE agents_platform.memories SET content='',content_digest=encode(sha256(''::bytea),'hex'),status='forgotten',
   revision=greatest(revision,coalesce((SELECT max(f.revision) FROM agents_platform.memory_revision_fingerprints f WHERE f.memory_id=target_memory),0))+1,updated_at=now()
   WHERE id=target_memory AND status<>'forgotten' RETURNING * INTO restored;
  IF restored.id IS NOT NULL THEN
   INSERT INTO agents_platform.memory_revisions(memory_id,revision,content,content_digest,status,actor,assertion_context,assertion_conflict,assertion_origin)
    VALUES(restored.id,restored.revision,'',restored.content_digest,'forgotten','{"kind":"system","reason":"restore_tombstone"}',restored.assertion_context,restored.assertion_conflict,restored.assertion_origin);
   UPDATE agents_platform.memory_scopes SET generation=greatest(generation+1,minimum_generation) WHERE id=target_scope;
  ELSE
   UPDATE agents_platform.memory_scopes SET generation=greatest(generation,minimum_generation) WHERE id=target_scope;
  END IF;
 END IF;
END; $$;
CREATE FUNCTION agents_platform.export_memory_deletion_ledger() RETURNS jsonb LANGUAGE sql AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('memoryId',d.memory_id,'scopeId',d.scope_id,'forgottenAt',d.forgotten_at,
  'generation',coalesce(s.generation,0),'fingerprints',coalesce((SELECT jsonb_agg(jsonb_build_object('revision',f.revision,'content_digest',f.content_digest) ORDER BY f.revision)
   FROM agents_platform.memory_revision_fingerprints f WHERE f.memory_id=d.memory_id),'[]'::jsonb)) ORDER BY d.memory_id),'[]'::jsonb)
 FROM agents_platform.memory_deletion_tombstones d LEFT JOIN agents_platform.memory_scopes s ON s.id=d.scope_id;
$$;
CREATE FUNCTION agents_platform.replay_memory_deletion_ledger(ledger jsonb) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item jsonb; processed integer:=0;
BEGIN
 IF jsonb_typeof(ledger) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid memory deletion ledger'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(ledger) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR NOT (item ?& ARRAY['memoryId','scopeId','forgottenAt','generation','fingerprints']) OR
   EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN ('memoryId','scopeId','forgottenAt','generation','fingerprints')) OR
   jsonb_typeof(item->'memoryId') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'scopeId') IS DISTINCT FROM 'string' OR
   jsonb_typeof(item->'forgottenAt') IS DISTINCT FROM 'string' OR jsonb_typeof(item->'generation') IS DISTINCT FROM 'number' OR item->>'generation' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Invalid memory deletion entry'; END IF;
  PERFORM agents_platform.restore_memory_forget((item->>'memoryId')::uuid,(item->>'scopeId')::uuid,(item->>'forgottenAt')::timestamptz,item->'fingerprints',(item->>'generation')::bigint);
  processed:=processed+1;
 END LOOP;
 RETURN processed;
END; $$;
CREATE FUNCTION agents_platform.forget_conversation_memories(target_conversation uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE scope_row record; memory_row record; changed integer:=0; blank_digest text:=encode(sha256(''::bytea),'hex');
BEGIN
 FOR scope_row IN SELECT s.id FROM agents_platform.memory_scopes s WHERE EXISTS(
  SELECT 1 FROM agents_platform.memories m JOIN agents_platform.tasks t ON t.id=m.source_task_id
   WHERE m.scope_id=s.id AND t.conversation_id=target_conversation AND m.status<>'forgotten') ORDER BY s.id FOR UPDATE OF s LOOP
  FOR memory_row IN UPDATE agents_platform.memories m SET content='',content_digest=blank_digest,status='forgotten',revision=revision+1,updated_at=now()
   WHERE m.scope_id=scope_row.id AND m.status<>'forgotten' AND EXISTS(SELECT 1 FROM agents_platform.tasks t WHERE t.id=m.source_task_id AND t.conversation_id=target_conversation)
   RETURNING m.* LOOP
   INSERT INTO agents_platform.memory_revisions(memory_id,revision,content,content_digest,status,actor,assertion_context,assertion_conflict,assertion_origin)
    VALUES(memory_row.id,memory_row.revision,'',blank_digest,'forgotten','{"kind":"system","reason":"conversation_retention"}',memory_row.assertion_context,memory_row.assertion_conflict,memory_row.assertion_origin);
   changed:=changed+1;
  END LOOP;
  UPDATE agents_platform.memory_scopes SET generation=generation+1,next_expiry_at=(SELECT min(expires_at) FROM agents_platform.memories WHERE scope_id=scope_row.id AND status='accepted' AND expires_at>now()) WHERE id=scope_row.id;
 END LOOP;
 RETURN changed;
END; $$;
