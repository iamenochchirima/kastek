# ADR 0006: PostgreSQL and pgvector as the initial memory store

- Status: accepted
- Date: 2026-08-11

## Decision

Canonical memory and knowledge text, provenance, ownership, permissions, and retention live
in PostgreSQL. PostgreSQL full-text search and pgvector provide the initial hybrid retrieval
implementation. Namespace predicates are applied before ranking, and vectors are rebuildable
indexes rather than authoritative data.

The memory contract preserves working, semantic, episodic, and procedural separation from the
Waku blueprint. A provider-neutral retrieval interface keeps a future Qdrant migration local
to the storage adapter.

## Consequences

The first deployment has one durable data system and straightforward backups. A dedicated
vector engine is introduced only after measured retrieval or scale limits justify the added
operational system. Embeddings are rebuildable indexes: ingestion records indexing readiness and
the runtime repairs missing or stale knowledge vectors before a scoped search, while PostgreSQL
full-text search remains the availability fallback. Customer-facing factual requests are not
allowed to fall through to unsupported model knowledge when retrieval returns no evidence.
