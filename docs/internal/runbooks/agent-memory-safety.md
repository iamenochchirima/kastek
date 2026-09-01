---
title: Agent memory safety response
owner: agent-platform
last_reviewed: 2026-08-31
---

# Agent memory safety response

## Normal review

1. Inspect the candidate from the agent installation's memory view. Candidates with status
   `review_pending` or `quarantined` are excluded from runtime retrieval.
2. Confirm the organization, agent, installation, conversation, namespace, source type, and
   provenance are the expected scope.
3. Approve only content that is a factual memory and does not contain instructions to change agent
   policy, reveal credentials, or bypass approvals. If it conflicts with an active fact, provide
   the active record ID as `supersedesMemoryId`; never approve a conflicting fact without an
   explicit replacement decision. Reject the candidate otherwise.
4. Verify the status transition and the `memory.reviewed` audit record. Review actions are scoped
   and cannot be repeated after the candidate leaves a review state.

## Incident response

When poisoning or credential exposure is suspected:

1. Treat all matching candidates as untrusted evidence and do not approve them.
2. Disable the affected installation's memory retrieval or use the agent kill switch if active
   runs are using the content.
3. Reject the affected candidates through the review API or the dual-approved `review_memory`
   operator command.
4. If content may have been exposed, create an export/audit record for the affected organization,
   rotate any credential that was persisted or referenced, and inspect delivery and model-call
   logs for redacted exposure indicators.
5. Record the incident, candidate IDs, scope, decisions, and verification in the incident system;
   do not copy secret values into tickets or logs.

## Consolidation queue recovery

The memory consolidation worker consumes run-bound jobs from `memory_consolidation_jobs`. It uses
leases and a unique source-run/extraction-version key, so a worker restart should leave work queued
or eligible for retry rather than require manual replay.

1. Check worker logs and queue counts by `status`, `attempt_count`, and lease expiry. Inspect the
   oldest queued and running jobs before changing data.
2. If extraction is producing unsafe candidates, disable `MEMORY_CONSOLIDATION_ENABLED` or change
   the affected installation policy to `explicit`. Existing review-pending candidates remain
   unavailable to retrieval until reviewed; do not delete them without a scoped decision.
3. If leases are stale, restart or replace the worker and allow the lease timeout to elapse. The
   next worker claims expired jobs. Do not insert duplicate jobs or extend leases by hand unless an
   incident owner has recorded the reason.
4. Review repeated failures by bounded error code and job scope. Jobs become permanently failed
   after the configured attempt limit; repair the cause before a scoped operator retry. Never log
   message text, memory text, tokens, or credentials while diagnosing a job.
5. After recovery, verify queue age, completed/failed counts, candidate review states, and the
   `kasitek.memory.consolidation.count` metric. Record the worker release identity and the scope of
   any manual action.

## Bulk quarantine or deletion

Bulk changes require a reviewed query identifying one organization and an explicit scope. Run the
query in a transaction or bounded batches, record the count and operator identity, and verify that
active retrieval returns no affected records. Use the existing deletion path for canonical memory
deletion so deletion jobs and audit records are created. Do not issue an unscoped delete against
`memory_records`.

The memory and knowledge deletion paths are permanent. A memory delete removes the canonical row,
its embedding and full-text search vector, and any conversation summary associated with the row.
Deleting a knowledge source removes its source row and all chunks. Conversation deletion uses the
same memory purge helper. An active organization, installation, or conversation legal hold blocks
the purge with `MEMORY_LEGAL_HOLD_ACTIVE`; release the hold through the approved operator flow
before retrying. The deletion ledger retains bounded target and completion metadata only, not the
deleted content.

The safety migration is additive. Application rollback must leave migration 085 applied because
the additional status values are needed to preserve review decisions; old statuses remain valid.
Migration 087 is also additive. If its application code is rolled back, retain the columns and
lineage trigger; old memory records remain valid and the new fields are nullable.

Migration 089 is additive. If the consolidation worker is rolled back, leave the job table and
enqueue trigger in place, disable the worker, and resume it only after the replacement understands
the stored extraction version. Do not remove review-pending records as part of an application
rollback.
