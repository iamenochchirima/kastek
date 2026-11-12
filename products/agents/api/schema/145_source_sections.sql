CREATE TABLE agents_platform.source_sections (
 id uuid PRIMARY KEY, organization_id uuid NOT NULL, revision_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 4095),
 parent_ordinal integer CHECK(parent_ordinal BETWEEN 0 AND 4095),
 level integer NOT NULL CHECK(level BETWEEN 0 AND 6),
 heading text NOT NULL CHECK(octet_length(heading) BETWEEN 1 AND 512),
 heading_path text NOT NULL CHECK(octet_length(heading_path) BETWEEN 1 AND 4096),
 part integer NOT NULL DEFAULT 1 CHECK(part BETWEEN 1 AND 64),
 start_offset integer NOT NULL CHECK(start_offset>=0), end_offset integer NOT NULL,
 chars integer NOT NULL CHECK(chars BETWEEN 1 AND 1048576),
 content text NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 1048576),
 content_digest text NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
 FOREIGN KEY(organization_id,revision_id) REFERENCES agents_platform.source_revisions(organization_id,id),
 UNIQUE(revision_id,ordinal,part), UNIQUE(organization_id,id), CHECK(end_offset>start_offset)
);
CREATE INDEX source_sections_revision ON agents_platform.source_sections(organization_id,revision_id);
CREATE INDEX source_sections_parent ON agents_platform.source_sections(revision_id,parent_ordinal,ordinal);

ALTER TABLE agents_platform.source_chunks ADD COLUMN section_id uuid;
ALTER TABLE agents_platform.source_chunks ADD COLUMN section_ordinal integer;
ALTER TABLE agents_platform.source_chunks ADD CONSTRAINT source_chunks_section
 FOREIGN KEY(organization_id,section_id) REFERENCES agents_platform.source_sections(organization_id,id);
CREATE INDEX source_chunks_section ON agents_platform.source_chunks(organization_id,section_id,ordinal);

CREATE TRIGGER immutable_source_section BEFORE UPDATE OR DELETE ON agents_platform.source_sections FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_snapshot_update();
