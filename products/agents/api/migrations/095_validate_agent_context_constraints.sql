-- Production audit found no legacy rows that violate these ownership-presence
-- constraints. Validate them now so the database records that the existing
-- data has been checked, rather than leaving the protection only NOT VALID.
ALTER TABLE memory_records
  VALIDATE CONSTRAINT memory_records_agent_scope_required;

ALTER TABLE knowledge_sources
  VALIDATE CONSTRAINT knowledge_sources_agent_scope_required;

ALTER TABLE knowledge_chunks
  VALIDATE CONSTRAINT knowledge_chunks_agent_scope_required;
