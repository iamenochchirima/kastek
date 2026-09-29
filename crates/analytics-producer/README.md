# Analytics producer crate

`analytics-producer` is the shared Rust boundary for Core and Tenant Platform analytics capture.

It builds the repository-owned CloudEvents-compatible envelope, canonical payload hash, event,
observation, and scope-definition records; rejects prohibited customer fields before the domain
transaction commits; and writes the same record shape to each service's local `analytics_outbox`.

The outbox helpers implement idempotent enqueue, conflicting-identity detection, bounded
`FOR UPDATE SKIP LOCKED` leasing, stale-lease recovery, and per-record accepted/duplicate/retryable/
quarantined state transitions. The crate does not make network calls. Authenticated batch transport
is attached at the Analytics ingestion boundary in a later slice.
