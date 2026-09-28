CREATE TABLE IF NOT EXISTS memory_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  agent_definition_id UUID REFERENCES agent_definitions(id),
  installation_id UUID REFERENCES agent_installations(id),
  conversation_id UUID REFERENCES conversations(id),
  owner_user_id TEXT,
  namespace TEXT NOT NULL CHECK (namespace IN ('conversation', 'user_private', 'organization_shared', 'agent_private')),
  memory_type TEXT NOT NULL CHECK (memory_type IN ('working', 'semantic', 'episodic', 'procedural')),
  canonical_text TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type TEXT NOT NULL CHECK (source_type IN ('explicit', 'imported', 'inferred')),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal', 'sensitive', 'restricted')),
  confidence NUMERIC(5, 4) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  embedding JSONB,
  embedding_model TEXT,
  search_vector TSVECTOR NOT NULL DEFAULT to_tsvector('simple', ''),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted', 'expired')),
  expires_at TIMESTAMPTZ,
  last_revalidated_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS memory_records_scope_idx
  ON memory_records (organization_id, installation_id, namespace, memory_type, status, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_records_search_idx ON memory_records USING GIN (search_vector);

CREATE OR REPLACE FUNCTION kasitek_memory_search_vector_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', COALESCE(NEW.canonical_text, ''));
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_records_search_vector_trigger ON memory_records;
CREATE TRIGGER memory_records_search_vector_trigger
BEFORE INSERT OR UPDATE OF canonical_text ON memory_records
FOR EACH ROW EXECUTE FUNCTION kasitek_memory_search_vector_update();

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  agent_definition_id UUID REFERENCES agent_definitions(id),
  installation_id UUID REFERENCES agent_installations(id),
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('upload', 'url', 'platform', 'manual')),
  source_uri TEXT,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'processing', 'deleted', 'failed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES knowledge_sources(id),
  organization_id TEXT NOT NULL,
  agent_definition_id UUID REFERENCES agent_definitions(id),
  installation_id UUID REFERENCES agent_installations(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  canonical_text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding JSONB,
  embedding_model TEXT,
  search_vector TSVECTOR NOT NULL DEFAULT to_tsvector('simple', ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, revision, chunk_index)
);

CREATE INDEX IF NOT EXISTS knowledge_chunks_scope_idx
  ON knowledge_chunks (organization_id, installation_id, revision);
CREATE INDEX IF NOT EXISTS knowledge_chunks_search_idx ON knowledge_chunks USING GIN (search_vector);

CREATE OR REPLACE FUNCTION kasitek_knowledge_search_vector_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector := to_tsvector('simple', COALESCE(NEW.canonical_text, ''));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS knowledge_chunks_search_vector_trigger ON knowledge_chunks;
CREATE TRIGGER knowledge_chunks_search_vector_trigger
BEFORE INSERT OR UPDATE OF canonical_text ON knowledge_chunks
FOR EACH ROW EXECUTE FUNCTION kasitek_knowledge_search_vector_update();

CREATE TABLE IF NOT EXISTS memory_deletion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('memory', 'knowledge_source', 'conversation', 'organization')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
