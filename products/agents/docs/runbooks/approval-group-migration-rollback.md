---
title: Agent approval-group migration and rollback
owner: agent-platform
last_reviewed: 2026-09-11
---

# Agent approval-group migration and rollback

This runbook covers the additive durable approval-group schema and the Temporal rollout gate.
It applies to Agent Platform deployments that include migrations `173_durable_approval_groups.sql`
and `177_bounded_approval_session_grants.sql`.

## Migration

Migration 173 adds `agent_approval_groups`, links existing approval rows through the nullable
`approval_group_id`, and adds indexes, row-level security, and the one-active-group constraint.
Migration 177 adds exact resource selectors to child approval records and the bounded
`agent_approval_session_grants` table. Session grants are scoped to one conversation, installation,
actor, capability/version, policy revision, and resource selector, and expire within 30 minutes.
The migration runner applies files in lexical version order and records each applied file in
`schema_migrations`.

Before rollout:

1. Confirm the release artifact contains migrations 173 and 177 and the matching approval repository,
   API, Activity, and Workflow code.
2. Take the normal database backup and record the backup identifier in the release record.
3. Check for existing rows in `agent_approval_records` and open Temporal runs that are waiting on
   the legacy per-operation approval path. Do not regroup those rows in place.
4. Apply the migration with the restricted migration database URL in the deployment environment.
5. Verify both migration entries, the group table, the nullable child link, the session-grant table,
   the partial unique active index, and the row-level-security policies before admitting new
   group-version runs.

The migration is additive. Existing approval rows remain valid child evidence and continue through
the compatibility Workflow path. New decomposed runs create one group for the current model-turn
barrier.

## Rollout and rollback gate

The decomposed approval behavior is admitted only behind the Temporal patch/version gate
`agent-parallel-tool-activities-v1`. Roll back application binaries only at a compatible Workflow
boundary:

- stop admitting new group-version runs;
- allow already-approved effects to finish or reconcile from their effect receipts;
- leave pending groups pending or expire them through the normal recovery sweep;
- keep migration 173 and group rows in place while open histories drain; and
- restore the previous binary only when it can replay the recorded history under the same patch
  decision.

Never delete `agent_approval_groups`, drop `approval_group_id`, reopen a consumed group, or convert
a consumed child approval back to `approved`. A database rollback must not cause an already-approved
external effect to be sent again. Effect receipts and their idempotency keys remain authoritative
for replay prevention.

## Post-rollback checks

Confirm that:

- no new group-version run is waiting without a compatible worker;
- pending legacy approvals are still visible through the compatibility projection;
- session grants remain bounded and are not extended or recreated by rollback;
- consumed, cancelled, expired, and invalidated groups retain their terminal evidence;
- stale or duplicate decisions fail closed; and
- the recovery sweep reports no unexplained executing or unknown effect receipts.

Record the migration version, Workflow patch state, deployment identity, backup identifier, open-run
count, and any reconciled effect IDs in the release record. Remove the compatibility path only
after the open-history drain has been explicitly reviewed and documented.
