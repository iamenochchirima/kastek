ALTER TABLE agents_platform.evidence_references
 ADD COLUMN task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
 ADD COLUMN citation_label text NOT NULL CHECK(citation_label ~ '^E[a-f0-9]{32}$'),
 ADD COLUMN request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 ADD CONSTRAINT evidence_actual_operation FOREIGN KEY(operation_id) REFERENCES agents_platform.operations(id),
 ADD CONSTRAINT evidence_root_label UNIQUE(citation_label),
 ADD CONSTRAINT evidence_operation_receipt UNIQUE(task_id,operation_id,request_digest);

CREATE TABLE agents_platform.evidence_contents (
 reference_id uuid PRIMARY KEY REFERENCES agents_platform.evidence_references(id),
 object_key text UNIQUE, title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
 content_bytes integer NOT NULL CHECK(content_bytes BETWEEN 1 AND 1048576),
 page integer, section text, binding_id uuid REFERENCES agents_platform.capability_bindings(id),
 resource jsonb, receipt_digest text CHECK(receipt_digest ~ '^[a-f0-9]{64}$')
);
CREATE TRIGGER immutable_evidence_content BEFORE UPDATE OR DELETE ON agents_platform.evidence_contents
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

CREATE TABLE agents_platform.evidence_nodes (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, root_task_id uuid NOT NULL, task_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('context','summary','memory','artifact','child_result','input')),
 owner_id text NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
 evidence_ids uuid[] NOT NULL DEFAULT '{}', parents uuid[] NOT NULL DEFAULT '{}',
 manifest jsonb NOT NULL, request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(organization_id,task_id) REFERENCES agents_platform.tasks(organization_id,id),
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id),
 UNIQUE(task_id,kind,owner_id), CHECK(cardinality(evidence_ids)<=1024), CHECK(cardinality(parents)<=1024)
);
CREATE INDEX evidence_nodes_root ON agents_platform.evidence_nodes(root_task_id,task_id);
CREATE TRIGGER immutable_evidence_node BEFORE UPDATE OR DELETE ON agents_platform.evidence_nodes
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

CREATE TABLE agents_platform.artifact_citations (
 artifact_id uuid NOT NULL REFERENCES agents_platform.artifacts(id),
 reference_id uuid NOT NULL REFERENCES agents_platform.evidence_references(id),
 PRIMARY KEY(artifact_id,reference_id)
);
CREATE TRIGGER immutable_artifact_citation BEFORE UPDATE OR DELETE ON agents_platform.artifact_citations
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();

CREATE TABLE agents_platform.evidence_history_links (
 node_id uuid NOT NULL REFERENCES agents_platform.evidence_nodes(id),
 origin_task_id uuid NOT NULL REFERENCES agents_platform.tasks(id),
 origin_node_ids uuid[] NOT NULL, PRIMARY KEY(node_id,origin_task_id)
);
CREATE TRIGGER immutable_evidence_history BEFORE UPDATE OR DELETE ON agents_platform.evidence_history_links
 FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
