ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'fallback',
  ADD COLUMN IF NOT EXISTS title_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS title_locked BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS model_provider TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_title_source_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_title_source_check
  CHECK (title_source IN ('fallback', 'ai', 'manual'));

UPDATE conversations
SET title = COALESCE(NULLIF(BTRIM(title), ''), 'New chat'),
    title_source = CASE WHEN title IS NULL OR BTRIM(title) = '' THEN 'fallback' ELSE title_source END,
    last_opened_at = COALESCE(last_opened_at, updated_at)
WHERE title IS NULL OR BTRIM(title) = '' OR last_opened_at IS NULL;

CREATE INDEX IF NOT EXISTS conversations_workspace_owner_idx
  ON conversations (organization_id, installation_id, owner_actor_id, pinned DESC, updated_at DESC)
  WHERE status = 'active' AND owner_actor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversations_workspace_search_idx
  ON conversations (organization_id, installation_id, owner_actor_id, lower(title))
  WHERE status = 'active' AND owner_actor_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kasiai_user_preferences (
  organization_id TEXT NOT NULL,
  installation_id UUID NOT NULL REFERENCES agent_installations(id),
  owner_actor_id TEXT NOT NULL,
  language TEXT,
  tone TEXT CHECK (tone IS NULL OR tone IN ('concise', 'balanced', 'detailed')),
  response_detail TEXT CHECK (response_detail IS NULL OR response_detail IN ('concise', 'standard', 'detailed')),
  notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  use_saved_preferences BOOLEAN NOT NULL DEFAULT TRUE,
  reference_previous_chats BOOLEAN NOT NULL DEFAULT FALSE,
  default_model_provider TEXT,
  default_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, installation_id, owner_actor_id)
);

CREATE INDEX IF NOT EXISTS kasiai_user_preferences_owner_idx
  ON kasiai_user_preferences (organization_id, owner_actor_id, updated_at DESC);

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS resolved_model_provider TEXT,
  ADD COLUMN IF NOT EXISTS resolved_model TEXT;

CREATE INDEX IF NOT EXISTS agent_runs_resolved_model_idx
  ON agent_runs (organization_id, resolved_model_provider, resolved_model, created_at DESC)
  WHERE resolved_model IS NOT NULL;
