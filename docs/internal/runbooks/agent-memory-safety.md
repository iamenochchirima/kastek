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
   policy, reveal credentials, or bypass approvals. Reject the candidate otherwise.
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

## Bulk quarantine or deletion

Bulk changes require a reviewed query identifying one organization and an explicit scope. Run the
query in a transaction or bounded batches, record the count and operator identity, and verify that
active retrieval returns no affected records. Use the existing deletion path for canonical memory
deletion so deletion jobs and audit records are created. Do not issue an unscoped delete against
`memory_records`.

The safety migration is additive. Application rollback must leave migration 085 applied because
the additional status values are needed to preserve review decisions; old statuses remain valid.
