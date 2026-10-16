# ADR 0003: Dedicated Agent Platform PostgreSQL

- Status: accepted
- Date: 2026-08-11

## Decision

The Agent Platform owns a separate PostgreSQL database and migration history. It stores
agent configuration, conversations, runs, events, audit records, memory, and knowledge
metadata. It does not share tables or foreign keys with `kasitek-core` or the tenant database.

Organization identifiers are carried as explicit fields and are part of every scope query.
The database is the source of truth for canonical agent and run records; search indexes are
rebuildable projections.

## Consequences

The service can be deployed and backed up independently. Cross-service consistency uses
typed APIs and durable events rather than cross-database SQL joins.
