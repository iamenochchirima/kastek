-- Canonical model-visible session context. The conversation/messages tables remain
-- display projections; this aggregate owns ordered model history and the active
-- compaction pointer.
CREATE TABLE IF NOT EXISTS agent_session_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  session_key TEXT NOT NULL CHECK (length(btrim(session_key)) BETWEEN 1 AND 240),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  head_sequence BIGINT NOT NULL DEFAULT 0 CHECK (head_sequence >= 0),
  head_digest TEXT NOT NULL DEFAULT repeat('0', 64) CHECK (length(head_digest) = 64),
  active_checkpoint_sequence BIGINT CHECK (active_checkpoint_sequence IS NULL OR active_checkpoint_sequence > 0),
  active_checkpoint_source_sequence BIGINT NOT NULL DEFAULT 0 CHECK (active_checkpoint_source_sequence >= 0),
  active_projection_digest TEXT NOT NULL DEFAULT repeat('0', 64) CHECK (length(active_projection_digest) = 64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, session_key),
  UNIQUE (organization_id, installation_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS agent_session_transcript_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_id UUID NOT NULL REFERENCES agent_session_contexts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  conversation_id UUID NOT NULL REFERENCES conversations(id),
  generation BIGINT NOT NULL CHECK (generation > 0),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  turn_id TEXT NOT NULL CHECK (length(btrim(turn_id)) BETWEEN 1 AND 240),
  run_id UUID REFERENCES agent_runs(id),
  entry_kind TEXT NOT NULL CHECK (entry_kind IN (
    'user', 'assistant_response', 'assistant_tool_call', 'tool_result',
    'waiting', 'interruption', 'error', 'compaction_checkpoint'
  )),
  model_message JSONB NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 300),
  payload_digest TEXT NOT NULL CHECK (length(payload_digest) = 64),
  previous_digest TEXT NOT NULL CHECK (length(previous_digest) = 64),
  entry_digest TEXT NOT NULL CHECK (length(entry_digest) = 64),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (context_id, generation, sequence),
  UNIQUE (context_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS agent_session_transcript_active_idx
  ON agent_session_transcript_entries (context_id, generation, is_active, sequence);

CREATE INDEX IF NOT EXISTS agent_session_transcript_turn_idx
  ON agent_session_transcript_entries (organization_id, conversation_id, turn_id, sequence);

CREATE INDEX IF NOT EXISTS agent_session_transcript_run_idx
  ON agent_session_transcript_entries (organization_id, run_id, sequence);

CREATE OR REPLACE FUNCTION kasitek_validate_session_context_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM conversations conversation
    WHERE conversation.id = NEW.conversation_id
      AND conversation.organization_id = NEW.organization_id
      AND conversation.installation_id = NEW.installation_id
  ) THEN
    RAISE EXCEPTION 'Session context does not belong to its organization and installation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_session_contexts_scope_trigger ON agent_session_contexts;
CREATE TRIGGER agent_session_contexts_scope_trigger
BEFORE INSERT OR UPDATE OF organization_id, installation_id, conversation_id ON agent_session_contexts
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_session_context_scope();

CREATE OR REPLACE FUNCTION kasitek_validate_session_transcript_entry_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM agent_session_contexts context
    WHERE context.id = NEW.context_id
      AND context.organization_id = NEW.organization_id
      AND context.installation_id = NEW.installation_id
      AND context.conversation_id = NEW.conversation_id
      AND context.generation = NEW.generation
  ) THEN
    RAISE EXCEPTION 'Session transcript entry is outside its context scope';
  END IF;
  IF NEW.run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM agent_runs run
    WHERE run.id = NEW.run_id
      AND run.organization_id = NEW.organization_id
      AND run.installation_id = NEW.installation_id
      AND run.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'Session transcript entry run is outside its context scope';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_session_transcript_entries_scope_trigger ON agent_session_transcript_entries;
CREATE TRIGGER agent_session_transcript_entries_scope_trigger
BEFORE INSERT OR UPDATE OF context_id, organization_id, installation_id, conversation_id, generation, run_id
ON agent_session_transcript_entries
FOR EACH ROW EXECUTE FUNCTION kasitek_validate_session_transcript_entry_scope();

GRANT SELECT, INSERT, UPDATE ON agent_session_contexts, agent_session_transcript_entries TO kasitek_agents_runtime;

ALTER TABLE agent_session_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_contexts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_session_contexts_agents_scope ON agent_session_contexts;
CREATE POLICY agent_session_contexts_agents_scope ON agent_session_contexts
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = agent_session_contexts.conversation_id
        AND conversation.organization_id = agent_session_contexts.organization_id
        AND conversation.installation_id = agent_session_contexts.installation_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = agent_session_contexts.conversation_id
        AND conversation.organization_id = agent_session_contexts.organization_id
        AND conversation.installation_id = agent_session_contexts.installation_id
    )
  );

ALTER TABLE agent_session_transcript_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_session_transcript_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_session_transcript_entries_agents_scope ON agent_session_transcript_entries;
CREATE POLICY agent_session_transcript_entries_agents_scope ON agent_session_transcript_entries
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_session_contexts context
      WHERE context.id = agent_session_transcript_entries.context_id
        AND context.organization_id = agent_session_transcript_entries.organization_id
        AND context.installation_id = agent_session_transcript_entries.installation_id
        AND context.conversation_id = agent_session_transcript_entries.conversation_id
        AND context.generation = agent_session_transcript_entries.generation
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_session_contexts context
      WHERE context.id = agent_session_transcript_entries.context_id
        AND context.organization_id = agent_session_transcript_entries.organization_id
        AND context.installation_id = agent_session_transcript_entries.installation_id
        AND context.conversation_id = agent_session_transcript_entries.conversation_id
        AND context.generation = agent_session_transcript_entries.generation
    )
  );
