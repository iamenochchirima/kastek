# Analytics producer crate

`analytics-producer` is the shared Rust library for Core and Tenant Platform analytics capture.

It builds the repository-owned CloudEvents-compatible envelope, canonical payload hash, event,
observation, and scope-definition records; rejects prohibited customer fields before the domain
transaction commits; and writes the same record shape to each service's local `analytics_outbox`.

The outbox helpers implement idempotent enqueue, conflicting-identity detection, bounded
`FOR UPDATE SKIP LOCKED` leasing, stale-lease recovery, and per-record accepted/duplicate/retryable/
quarantined state transitions. `AnalyticsIngestionClient` sends the records to the deployed
Analytics service over its authenticated HTTP ingestion and reconciliation endpoints. The crate
shares producer-side code; it does not contain or replace the Analytics service.
