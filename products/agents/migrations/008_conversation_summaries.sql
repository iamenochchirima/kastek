CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id UUID PRIMARY KEY REFERENCES conversations(id),
  organization_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  summary_version INTEGER NOT NULL DEFAULT 1 CHECK (summary_version > 0),
  last_message_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_message_sequence >= 0),
  generated_by TEXT NOT NULL DEFAULT 'deterministic-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_summaries_scope_idx
  ON conversation_summaries (organization_id, updated_at DESC);
