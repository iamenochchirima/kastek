CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
DO $$ BEGIN
 IF (SELECT extversion FROM pg_extension WHERE extname='vector') <> '0.8.7' THEN
  RAISE EXCEPTION 'Agents requires pgvector 0.8.7';
 END IF;
END $$;
CREATE TABLE agents_platform.chunk_embeddings (
 organization_id uuid NOT NULL, chunk_id uuid PRIMARY KEY, embedding_release text NOT NULL,
 embedding public.vector(384) NOT NULL,
 FOREIGN KEY(organization_id,chunk_id) REFERENCES agents_platform.source_chunks(organization_id,id)
);
CREATE INDEX chunk_embeddings_scope ON agents_platform.chunk_embeddings(organization_id,embedding_release);
CREATE TRIGGER immutable_chunk_embedding BEFORE UPDATE OR DELETE ON agents_platform.chunk_embeddings FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
