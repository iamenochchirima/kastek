# Analytics runbooks

These procedures were preserved from Growth when source ownership moved to Labs. They have not been
reviewed against the current Analytics implementation or deployment as part of the source move.
Treat them as historical drafts, not production instructions, until a separate operations review
updates them. This source move does not change the existing hosted deployment.

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
