# Analytics migrations

This directory is the migration boundary for the dedicated Analytics PostgreSQL database. The
release job runs these migrations independently from API and worker startup.

A-02 creates only the `analytics` schema namespace and verifies the migration-release path. A-05
adds the versioned scope-kind registry, reporting scopes, hierarchy closure, service identities,
producer permissions, assignment read model, short-lived grant metadata, and RLS authorization
context. Source services remain authoritative for users, roles, and assignments; these tables are
the Analytics-side control read model. Facts, outboxes, projections, and reporting tables belong to
later migrations. The release job takes a stable PostgreSQL advisory lock and records checksums in
SQLx's dedicated migration history.
