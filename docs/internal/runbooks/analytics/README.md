# Analytics runbooks

Versioned operational procedures for the standalone customer-analytics service.

Current release: `A-03 foundation`

The service currently exposes process health, migration-gated readiness, an authenticated internal
metrics endpoint, a migration release job, and guarded PostgreSQL backup/restore scripts. Ingestion,
projections, reporting, exports, and customer-scope authorization are not implemented yet; their
runbook steps remain explicitly marked as pending rather than inventing commands.

## Runbook index

| Runbook | Use when |
| --- | --- |
| [Service unavailable](service-unavailable.md) | API or worker is down, restarting, or not ready |
| [Database recovery](database-recovery.md) | Analytics PostgreSQL must be restored or rebuilt |
| [Pipeline backlog](pipeline-backlog.md) | Outbox, ingestion, quarantine, or projection lag is reported |
| [Redis degraded](redis-degraded.md) | The non-authoritative cache is unavailable or evicting |
| [Isolation incident](isolation-incident.md) | A scope authorization or customer-data boundary may be violated |

Every incident record should include the service revision, environment, UTC timestamps, correlation
ID, affected scope at the minimum permitted level, operator, commands run, and verification output.
Never put database URLs, bearer tokens, provider credentials, raw customer payloads, or message
content into tickets or logs.
