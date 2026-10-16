---
title: Agent memory safety response
owner: agent-platform
last_reviewed: 2026-09-08
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

### Forced flush and retrieval-gate checks

The runtime requests a `pre_compaction` flush for reviewed or automatic memory policy before a
lossy context compaction. Inspect `flush_reason` with the job status; an explicit flush is allowed
to run below the normal inbound-message threshold, while ordinary threshold jobs are not. A
session-end or operator flush uses the same idempotent source-run/extraction-version key.

Retrieval runs a deterministic self-contained-message prefilter before the optional small-model
gate. Gate timeouts and provider failures use bounded deterministic behaviour and are persisted as
`bounded_fallback` metadata; they must not bypass tenant scope, lifecycle, or authorization checks.
Retrieval decision rows store only query digests, selected revision IDs, rejection reasons, bounded
timing/token fields, and gate provenance. Never copy the raw query or memory text into logs or an
incident ticket.

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

### Agent deletion with v2 memory

An agent with source events, checkpoints, canonical revisions, or provider projection receipts is
not removed synchronously. `AgentRepository.deleteAgent` archives the definition, disables its
installations, and creates an agent-targeted `memory_deletion_jobs` record. The memory worker purges
local evidence and projections; the provider worker must acknowledge every remote deletion before
the finalizer removes installations, versions, and the definition.

If a deletion remains queued or `provider_pending`, inspect the job and bounded error code rather
than deleting rows manually. Legal holds and active runs block the request. A completed parent job
is safe to retry through the finalizer; provider child rows are retained until confirmation and are
removed only immediately before installation deletion. The combined integration fixture is
`agents/test/agent-deletion-v2.integration.test.ts`.

The historical migrations 085 (review states), 087 (legacy fact lineage), and 089 (the original
consolidation queue) are additive compatibility layers. They remain applied during any application
rollback; do not delete their columns, triggers, or queued rows. The current v2 source evidence,
revision, projection, retention, and deletion contracts are defined by migrations 130 onward.

The operator retention projection reports `agent_memory_facts` as the canonical memory dataset and
groups its immutable revisions by lifecycle state. The legacy `memory_records` count remains in the
same projection only as an explicitly marked compatibility diagnostic until the production cutover
removes the rollback dependency; it must not be used as the v2 readiness signal.

If the v2 consolidation worker is rolled back, leave the queue and its extraction-version records
in place, disable the scoped worker flag, and resume only after the replacement understands the
stored version. Source evidence and checkpoint identity are guarded by migrations 155/156/158;
relation scope and immutability are guarded by migration 157. Only the
`system:memory-deletion` transaction actor may purge source evidence. Never repair evidence with
an UPDATE or a direct unscoped DELETE.
