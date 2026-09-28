# Analytics deployment jobs

The Analytics image contains three independently deployed process commands:

| Process | Command | Startup migration behavior |
| --- | --- | --- |
| API | `/usr/local/bin/analytics-api` | Never migrates; serves health and API traffic |
| Worker | `/usr/local/bin/analytics-worker` | Never migrates; runs background work |
| Release job | `/usr/local/bin/analytics-migrate` | Connects eagerly, takes the PostgreSQL advisory lock, and applies migrations |

Build the image from the Labs repository root:

```bash
docker build -f services/analytics/Dockerfile -t kasitek-analytics:dev .
```

The release job must complete successfully before the API or worker rollout. Do not put migration
execution in an API or worker startup command. Production PostgreSQL and Redis should be managed
services with private networking, separate credentials, encrypted backups, and no public database
ports. The application receives only `ANALYTICS_DATABASE_URL` and `ANALYTICS_REDIS_URL`.

The service Compose file is a local and deployment-shape reference. It starts PostgreSQL, Redis,
the migration release job, API, and worker. API and worker startup is gated on PostgreSQL migration
completion; Redis remains non-authoritative and is not a startup readiness gate:

```bash
docker compose -f services/analytics/compose.yaml up --build
```

For scheduled operations, run `scripts/backup.sh` from a backup runner with a managed destination,
then copy the dump, checksum, and metadata together. Restore only into an isolated recovery target
or an explicitly stopped service environment:

```bash
ANALYTICS_RESTORE_CONFIRM=YES \
ANALYTICS_RESTORE_SERVICES_STOPPED=YES \
ANALYTICS_DATABASE_URL='postgres://...' \
ANALYTICS_BACKUP_FILE='/secure/backups/analytics-20260822T000000Z.dump' \
  scripts/restore.sh
```

The recovery procedure must reapply deletion and legal-hold records and reconcile source outboxes
before restored reporting is exposed. Those records are implemented in later analytics packages;
this A-02 package only establishes the guarded database restoration mechanism.

Runbooks preserved from Growth are under
[`runbooks/analytics/`](runbooks/analytics/README.md). They are historical drafts pending an
operations review and must not be treated as production instructions yet.
