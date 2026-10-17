CREATE TABLE agents_platform.sources (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id),
 importer_account_id uuid NOT NULL REFERENCES agents_platform.accounts(id), title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 kind text NOT NULL CHECK(kind IN ('upload','public_url','provider_snapshot')),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','withdrawn')),
 visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','public')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,id)
);

CREATE TABLE agents_platform.ingestion_jobs (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, source_id uuid NOT NULL,
 importer_account_id uuid NOT NULL REFERENCES agents_platform.accounts(id), operation_id text NOT NULL,
 request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 revision_id uuid NOT NULL UNIQUE, revision integer NOT NULL CHECK(revision>0),
 accepted_generation integer NOT NULL CHECK(accepted_generation>0),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','acquiring','extracting','indexing','ready','failed','cancelled')),
 content_type text NOT NULL, authorized_url text, raw_key text NOT NULL UNIQUE, raw_digest text,
 raw_state text NOT NULL DEFAULT 'pending' CHECK(raw_state IN ('pending','available','deleted')),
 raw_bytes integer NOT NULL DEFAULT 0 CHECK(raw_bytes BETWEEN 0 AND 10485760),
 parser_release text NOT NULL, embedding_release text, deadline timestamptz NOT NULL,
 error_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,source_id) REFERENCES agents_platform.sources(organization_id,id),
 UNIQUE(organization_id,importer_account_id,operation_id), UNIQUE(source_id,revision)
);
CREATE INDEX ingestion_jobs_pending ON agents_platform.ingestion_jobs(organization_id,state) WHERE state NOT IN ('ready','failed','cancelled');

CREATE TABLE agents_platform.ingestion_outbox (
 job_id uuid PRIMARY KEY REFERENCES agents_platform.ingestion_jobs(id),
 invocation_id text, dispatch_attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz
);

CREATE TABLE agents_platform.source_revisions (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, source_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 raw_key text NOT NULL UNIQUE, text_key text NOT NULL UNIQUE,
 raw_digest text NOT NULL CHECK(raw_digest ~ '^[a-f0-9]{64}$'),
 text_digest text NOT NULL CHECK(text_digest ~ '^[a-f0-9]{64}$'),
 chunk_set_digest text NOT NULL CHECK(chunk_set_digest ~ '^[a-f0-9]{64}$'),
 raw_bytes integer NOT NULL CHECK(raw_bytes BETWEEN 1 AND 10485760),
 text_bytes integer NOT NULL CHECK(text_bytes BETWEEN 1 AND 1048576),
 chunk_count integer NOT NULL CHECK(chunk_count BETWEEN 1 AND 1000),
 parser_release text NOT NULL, normalizer_release text NOT NULL, embedding_release text,
 acquired_at timestamptz NOT NULL, sealed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,source_id) REFERENCES agents_platform.sources(organization_id,id),
 UNIQUE(source_id,revision), UNIQUE(organization_id,id), UNIQUE(organization_id,source_id,id)
);
CREATE TABLE agents_platform.source_revision_policy (
 organization_id uuid NOT NULL, source_id uuid NOT NULL, revision_id uuid PRIMARY KEY,
 state text NOT NULL DEFAULT 'candidate' CHECK(state IN ('candidate','approved','withdrawn')),
 approved_by uuid REFERENCES agents_platform.accounts(id), approved_at timestamptz,
 FOREIGN KEY(organization_id,source_id,revision_id) REFERENCES agents_platform.source_revisions(organization_id,source_id,id),
 CHECK((approved_by IS NULL)=(approved_at IS NULL))
);
CREATE TABLE agents_platform.source_chunks (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, revision_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 999),
 start_offset integer NOT NULL CHECK(start_offset>=0), end_offset integer NOT NULL,
 page integer CHECK(page BETWEEN 1 AND 200), section text,
 content text NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 1048576),
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 token_count integer NOT NULL CHECK(token_count BETWEEN 1 AND 512),
 search_document tsvector GENERATED ALWAYS AS (to_tsvector('english',content)) STORED,
 FOREIGN KEY(organization_id,revision_id) REFERENCES agents_platform.source_revisions(organization_id,id),
 UNIQUE(revision_id,ordinal), UNIQUE(organization_id,id), CHECK(end_offset>start_offset)
);
CREATE INDEX source_chunks_revision ON agents_platform.source_chunks(organization_id,revision_id);
CREATE INDEX source_chunks_lexical ON agents_platform.source_chunks USING GIN(search_document);
CREATE TABLE agents_platform.version_sources (
 organization_id uuid NOT NULL, version_id uuid NOT NULL, source_id uuid NOT NULL, revision_id uuid NOT NULL,
 PRIMARY KEY(version_id,source_id),
 FOREIGN KEY(organization_id,version_id) REFERENCES agents_platform.agent_versions(organization_id,id),
 FOREIGN KEY(organization_id,source_id,revision_id) REFERENCES agents_platform.source_revisions(organization_id,source_id,id)
);

CREATE TRIGGER immutable_source_revision BEFORE UPDATE OR DELETE ON agents_platform.source_revisions FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TRIGGER immutable_source_chunk BEFORE UPDATE OR DELETE ON agents_platform.source_chunks FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
CREATE TRIGGER immutable_version_source BEFORE UPDATE OR DELETE ON agents_platform.version_sources FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

CREATE TABLE agents_platform.source_mutations (
 organization_id uuid NOT NULL REFERENCES agents_platform.organizations(id), account_id uuid NOT NULL REFERENCES agents_platform.accounts(id),
 operation_id text NOT NULL, request_digest text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(organization_id,account_id,operation_id)
);

CREATE TABLE agents_platform.evidence_references (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, root_task_id uuid NOT NULL, operation_id uuid NOT NULL,
 source_id uuid, revision_id uuid, chunk_id uuid,
 start_offset integer NOT NULL CHECK(start_offset>=0), end_offset integer NOT NULL CHECK(end_offset>start_offset),
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 acquired_at timestamptz NOT NULL, manifest jsonb NOT NULL,
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,source_id,revision_id) REFERENCES agents_platform.source_revisions(organization_id,source_id,id),
 FOREIGN KEY(organization_id,chunk_id) REFERENCES agents_platform.source_chunks(organization_id,id),
 CHECK((source_id IS NULL)=(revision_id IS NULL)), CHECK(chunk_id IS NULL OR revision_id IS NOT NULL),
 UNIQUE(organization_id,id)
);
CREATE INDEX evidence_references_root ON agents_platform.evidence_references(root_task_id);
CREATE TRIGGER immutable_evidence_reference BEFORE UPDATE OR DELETE ON agents_platform.evidence_references FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
