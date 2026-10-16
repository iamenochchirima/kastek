---
id: agent-memory-recovery
title: Agent memory database recovery
sidebar_position: 6
owner: platform-ops
last_reviewed: 2026-09-08
---

# Agent memory database recovery

This runbook covers the PostgreSQL database that owns Agent Platform runs, source events,
checkpoints, canonical memory revisions, projections, deletion jobs, and migration receipts.
It is also the required backup procedure before a memory backfill or destructive schema change.

## Create a pre-backfill backup

Stop memory workers before a cutover backup if the release record requires a quiescent snapshot.
Create and preserve the dump, checksum, metadata, and release identity:

```bash
AGENTS_DATABASE_URL="$AGENTS_DATABASE_URL" \
AGENTS_BACKUP_DIR="/secure/path/agents-backups" \
./agents/scripts/backup.sh
```

The command prints a backup ID in the form `agents-<UTC timestamp>`. The metadata records the
backup ID, UTC creation time, `pg_dump` client version, repository revision, and migration target.
The restore script uses that recorded PostgreSQL major version when the matching client is
installed; set `AGENTS_PG_RESTORE_BIN` explicitly when restoring with a separately managed client.
Record that ID in the memory checklist and release record before running backfill.

## Restore to a disposable target

Use a separate recovery database. Do not restore over a live Agents database. Stop the Agents API,
Temporal worker, gateway, and memory workers first, then verify the checksum and restore through
the guarded script:

```bash
AGENTS_DATABASE_URL="$RECOVERY_DATABASE_URL" \
AGENTS_BACKUP_FILE="/secure/path/agents-backups/agents-<UTC timestamp>.dump" \
AGENTS_RESTORE_CONFIRM=YES \
AGENTS_RESTORE_SERVICES_STOPPED=YES \
./agents/scripts/restore.sh
```

Apply forward migrations only after the restored schema is available. Do not remove additive memory
tables or use destructive schema rollback as an application rollback. Disable the new memory paths,
retain the migration receipts and compatibility readers, and restore the last tested application
artifact instead. The Agents runtime rollback switch is `MEMORY_V2_ENABLED=false`; this disables
v2 checkpoint, source-capture, revision-tool, and typed-retrieval wiring while leaving the additive
schema and worker code available for recovery. Disable the consolidation, projection, provider-
deletion, deletion, and retention workers separately when the incident requires a fully quiescent
memory subsystem.

## Verify and close

At minimum, record:

- backup ID, checksum, metadata, release/commit identity, and migration version;
- restore target and measured restore duration;
- migration runner result through the intended migration;
- source-event, checkpoint, canonical-revision, projection-readiness, deletion-job, and provider-
  receipt counts before and after restore;
- tenant-scope and retrieval parity checks;
- RPO/RTO and any unresolved provider or staging evidence.

The local automated fixture is `agents/test/memory-backfill.integration.test.ts`. It verifies
idempotent receipts, preserved provenance, rebuildable projections, readiness, and retrieval parity;
it does not replace a staging or production restore drill.
