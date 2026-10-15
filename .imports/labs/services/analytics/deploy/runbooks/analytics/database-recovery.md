# Analytics database recovery

**Version:** A-03 foundation
**Severity:** P0 for failed restoration; P1 for production unavailability

## Preconditions

- An approved incident or restoration change exists.
- Analytics API and worker are stopped.
- The target is a dedicated Analytics database, never a source operational database.
- The backup checksum and metadata are available.

## Procedure

1. Preserve the backup, checksum, metadata, service revision, and incident correlation ID.
2. Provision or select a disposable recovery target and apply forward migrations.
3. Verify the backup before restore:

   ```bash
   sha256sum --check "${ANALYTICS_BACKUP_FILE}.sha256"
   ```

4. Restore only through the guarded script:

   ```bash
   ANALYTICS_DATABASE_URL="$RECOVERY_DATABASE_URL" \
   ANALYTICS_BACKUP_FILE="/secure/path/analytics.dump" \
   ANALYTICS_RESTORE_CONFIRM=YES \
   ANALYTICS_RESTORE_SERVICES_STOPPED=YES \
   ./services/analytics/scripts/restore.sh
   ```

5. Start the migration release job if the recovery target needs forward migrations, then start the
   API and worker with the recovery URL.

## Verify and close

The foundation verification is:

```bash
curl -fsS http://127.0.0.1:4300/health/live
curl -fsS http://127.0.0.1:4300/health/ready
```

Once facts and projections exist, this runbook must also verify manifests, deletion and legal-hold
records, scope isolation, projection rebuild, and source reconciliation before production cutover.
Do not declare recovery successful because PostgreSQL merely starts. Record measured RPO/RTO and
the remaining validation evidence.
