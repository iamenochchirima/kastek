# Analytics migrations

This directory is the migration boundary for the dedicated Analytics PostgreSQL database.

A-01 does not create business tables. A-02 owns the first schema migrations, migration locking,
backup/restoration integration, and migration verification.
