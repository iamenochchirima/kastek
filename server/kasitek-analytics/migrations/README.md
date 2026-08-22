# Analytics migrations

This directory is the migration boundary for the dedicated Analytics PostgreSQL database. The
release job runs these migrations independently from API and worker startup.

A-02 creates only the `analytics` schema namespace and verifies the migration-release path. A-05
adds the versioned scope-kind registry, reporting scopes, hierarchy closure, service identities,
producer permissions, assignment read model, short-lived grant metadata, and RLS authorization
context. A-06 adds immutable events and provider observations, source state and cursors, safe
quarantine, historical manifests and coverage, reconciliation evidence, quality issues, backfill
jobs, projection checkpoints/generations, and hash-chained audit records. A-09 adds immutable
scope-definition receipts and the shared authenticated ingestion/reconciliation write boundary.
Source services remain authoritative for users, roles, assignments, and outbox delivery state;
these tables are the Analytics-side fact and control read model. Domain projections and reporting
APIs belong to later migrations. The release job takes a stable PostgreSQL advisory lock and
records checksums in SQLx's dedicated migration history.
