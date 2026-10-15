-- Vector search is a rebuildable index. Canonical text, ownership, lifecycle,
-- and permissions remain authoritative in the relational columns.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE memory_records
  ADD COLUMN IF NOT EXISTS embedding_vector vector(1536);

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_vector vector(1536);

-- Preserve any legacy JSON embeddings that already have the selected dimension.
-- Invalid, partial, or differently-versioned values stay unembedded and are
-- rebuilt by the application when the record is next written.
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT id, embedding
    FROM memory_records
    WHERE embedding_vector IS NULL
      AND jsonb_typeof(embedding) = 'array'
      AND jsonb_array_length(embedding) = 1536
  LOOP
    BEGIN
      UPDATE memory_records
      SET embedding_vector = item.embedding::text::vector,
          embedding_model = COALESCE(embedding_model, 'openai/text-embedding-3-small')
      WHERE id = item.id;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'Skipping legacy memory embedding during vector backfill for record %', item.id;
    END;
  END LOOP;

  FOR item IN
    SELECT id, embedding
    FROM knowledge_chunks
    WHERE embedding_vector IS NULL
      AND jsonb_typeof(embedding) = 'array'
      AND jsonb_array_length(embedding) = 1536
  LOOP
    BEGIN
      UPDATE knowledge_chunks
      SET embedding_vector = item.embedding::text::vector,
          embedding_model = COALESCE(embedding_model, 'openai/text-embedding-3-small')
      WHERE id = item.id;
    EXCEPTION WHEN others THEN
      RAISE WARNING 'Skipping legacy knowledge embedding during vector backfill for record %', item.id;
    END;
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS memory_records_embedding_vector_hnsw_idx
  ON memory_records USING hnsw (embedding_vector vector_cosine_ops)
  WHERE embedding_vector IS NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_vector_hnsw_idx
  ON knowledge_chunks USING hnsw (embedding_vector vector_cosine_ops)
  WHERE embedding_vector IS NOT NULL;
