# Analytics pipeline backlog

**Version:** A-03 foundation
**Severity:** P1 for continuous data older than the approved threshold; P2 for isolated lag

## Current state

The source outbox, ingestion, quarantine, reconciliation, and projection tables are not present in
the foundation release. This runbook is a controlled placeholder for A-06 through A-10 and must not
be used to claim that a current Analytics worker is processing product facts.

## When implemented

1. Identify the producer, domain, reporting scope, oldest item, sequence gap, and correlation ID.
2. Compare source outbox depth with accepted manifests and Analytics checkpoints.
3. Determine whether the cause is publisher retry, schema rejection, quarantine growth, worker lease
   failure, database capacity, or a provider observation delay.
4. Prioritize live windows without deleting or rewriting immutable facts.
5. Replay only with the original idempotency identity and an audited reason.
6. Reconcile the bounded source interval after the queue drains.

## Required verification

- Duplicate delivery does not change accepted facts.
- Conflicting identities remain quarantined.
- Sequence gaps are either resolved or explicitly marked unavailable.
- Projection checkpoints advance and report their completeness boundary.
- No customer report presents unavailable data as zero.

The final procedure must include safe commands, ownership, alert links, escalation, and evidence
locations before A-09 is accepted.
