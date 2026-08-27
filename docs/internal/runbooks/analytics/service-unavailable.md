# Analytics service unavailable

**Version:** A-03 foundation
**Severity:** P1 unless a scoped dependency or provider issue is confirmed

## Detect

- `/health/live` does not return `200`.
- `/health/ready` returns `503`.
- The authenticated metrics scrape reports readiness failures or process absence.

## Impact

Customer analytics may be unavailable or stale. Core, Agent Platform, and Tenant Platform must keep
serving their operational APIs; their future outbox backlog is the recovery path.

## Procedure

1. Record UTC start time, service revision, environment, and correlation ID.
2. Check process status and logs. Do not print the environment file or process environment.
3. Check liveness first, then readiness:

   ```bash
   curl -fsS http://127.0.0.1:4300/health/live
   curl -i http://127.0.0.1:4300/health/ready
   ```

4. If readiness reports PostgreSQL unavailable, verify the dedicated Analytics database endpoint,
   connection capacity, and network path. Do not point Analytics at a Core or Tenant database.
5. If migrations are pending, run the release job once through the deployment system or:

   ```bash
   ./server/kasitek-analytics/scripts/local-migrate.sh
   ```

6. Restart only the affected Analytics process after the dependency or migration issue is fixed.
   API and worker startup must not be changed to apply migrations.

## Verify and close

- Liveness and readiness both return `200`.
- The authenticated metrics endpoint is scrapeable without exposing customer identifiers.
- The source backlog, once implemented, is draining and no acknowledged records were discarded.
- Record the cause, duration, revision, operator, and evidence.

Escalate to the Analytics owner when readiness remains unavailable for five minutes, or immediately
for any evidence of data loss or an authorization failure.
