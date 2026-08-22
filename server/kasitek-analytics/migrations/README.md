# Analytics migrations

This directory is the migration boundary for the dedicated Analytics PostgreSQL database. The
release job runs these migrations independently from API and worker startup.

A-02 creates only the `analytics` schema namespace and verifies the migration-release path. It does
not create business tables. Later packages own registry, scope, fact, projection, and reporting
migrations. The release job takes a stable PostgreSQL advisory lock and records checksums in SQLx's
dedicated migration history.
