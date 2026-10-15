# Analytics Redis degraded

**Version:** A-03 foundation
**Severity:** P2 unless PostgreSQL or reporting availability is also affected

Redis is a non-authoritative analytics cache. Redis failure must not make the Analytics API
unready when PostgreSQL can safely answer a bounded request.

## Procedure

1. Confirm the Redis endpoint and capture connection-failure, latency, memory, and eviction metrics.
2. Check PostgreSQL-backed service health independently; do not restart the database for a Redis-only
   alert.
3. Disable or bypass cache reads only through the approved Analytics control once that control exists.
4. Restore Redis capacity or connectivity, then warm keys through normal report requests. Do not
   copy authoritative facts into Redis manually.

## Verify and close

- PostgreSQL readiness remains truthful.
- Reports are either served from PostgreSQL or carry the approved degraded-cache metadata.
- Cache keys include the authorization, scope, metric version, generation, and epoch identity once
  reporting is implemented.
- Record evictions, duration, affected workload, and whether any rate limits were applied.
