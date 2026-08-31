# Agent memory safety plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Make memory ingestion fail closed for untrusted instructions and secrets, preserve explicit
provenance, and provide a durable review state for imported or inferred candidates. Retrieved
memory remains evidence, never platform policy.

## Scope

- Source trust and deterministic safety assessment at the memory repository boundary.
- Quarantine for poisoning or secret signals and review-pending status for untrusted candidates.
- Explicit rejection of inferred procedural memory.
- User and operator review actions for review-pending or quarantined records.
- Adversarial tests for direct, indirect, encoded, and translated instruction injection.

## Non-goals

- Automatic extraction and consolidation from conversations; that remains a separate P1.1 tranche.
- Full contradiction/supersession modeling; this tranche records the missing seam and leaves fact
  graph semantics open.
- Database RLS; that remains P1.2.

## Implementation checklist

- [x] Define source trust, sensitivity, review, and quarantine states; contradiction and supersession remain open.
- [x] Prevent untrusted content from creating procedural memory or changing agent policy.
- [x] Add secret and personal-data classification before memory persistence.
- [x] Add review-pending/rejected state and scoped review actions.
- [x] Add adversarial poisoning tests and bounded safety metrics.
- [x] Update memory architecture, API, operator, and audit documentation.
- [ ] Run unit, integration, type, build, and production migration/smoke checks.

## Release record

Change: Fail-closed memory safety assessment, review state, and scoped review actions.

Risk: standard. The change makes some imported or inferred records non-retrievable until review;
explicit user-requested memory remains subject to the same secret and poisoning checks.

Affected services and user surfaces: agents-api, agents-worker, Agents PostgreSQL, memory tools,
memory inspection, and operator controls.

Platform release version or release ID: pending implementation release.

API/schema/migration changes: additive migrations 085 and 086 extend memory status values and the
operator command constraint. Review routes
are scoped to the authenticated organization, agent, installation, conversation, and user.

Feature flag or rollout method: pending implementation; quarantine and review-pending behavior is
fail-closed by default.

Analytics events and success metrics: bounded safety assessment and review outcome counters; no
memory text or secrets.

Logs, metrics, dashboards, and alerts: safety signal counts and review outcomes; durable alerting
remains governed by the observability plan.

User, API, internal, and operational documentation: update memory lifecycle and review behavior
documentation in the same change.

Validation evidence: pending implementation.

Rollback or disable plan: roll back application code only after reviewing pending records; retain
migration 085 because its status constraint is additive and old statuses remain valid.

Post-release review date: pending staged rollout evidence.
