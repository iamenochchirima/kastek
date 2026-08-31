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
- Automatic extraction and consolidation; this tranche only provides the durable fact-lineage seam
  that an extractor can use.
- Database RLS; that remains P1.2.

## Implementation checklist

- [x] Define source trust, sensitivity, review, quarantine, contradiction, and supersession states.
- [x] Prevent untrusted content from creating procedural memory or changing agent policy.
- [x] Add secret and personal-data classification before memory persistence.
- [x] Add review-pending/rejected state and scoped review actions.
- [x] Add adversarial poisoning tests and bounded safety metrics.
- [x] Update memory architecture, API, operator, and audit documentation.
- [x] Run unit, integration, type, build, and production migration/smoke checks.

## Release record

Change: Fail-closed memory safety assessment, review state, and scoped review actions.

Risk: standard. The change makes some imported or inferred records non-retrievable until review;
explicit user-requested memory remains subject to the same secret and poisoning checks.

Affected services and user surfaces: agents-api, agents-worker, Agents PostgreSQL, memory tools,
memory inspection, and operator controls.

Platform release version or release ID: `20526aff` (agents-api, agents-worker, and MCP-Gateway).

API/schema/migration changes: additive migrations 085, 086, and 087 extend memory status values,
the operator command constraint, and memory fact lineage. Review routes
are scoped to the authenticated organization, agent, installation, conversation, and user.

Feature flag or rollout method: pending implementation; quarantine and review-pending behavior is
fail-closed by default.

Analytics events and success metrics: bounded safety assessment and review outcome counters; no
memory text or secrets.

Logs, metrics, dashboards, and alerts: safety signal counts and review outcomes; durable alerting
remains governed by the observability plan.

User, API, internal, and operational documentation: update memory lifecycle and review behavior
documentation in the same change.

Validation evidence: agents full suite `85 passed, 18 skipped`; `525 passed, 49 skipped`; agents
typecheck and build passed; frontend lint passed with two pre-existing warnings; frontend Webpack
build passed; local PostgreSQL migrations through 086 and 11 integration tests passed. Production
migrations 085 and 086 were applied through the agents-db tunnel. The deployed agents-api returned
live/readiness 200 on its internal 4100 port and the public MCP-Gateway `/health` and
`/health/ready` endpoints returned 200. Migration 087 and its integration test remain to be run
before this plan is closed.

Rollback or disable plan: roll back application code only after reviewing pending records; retain
migrations 085-087 because their status and lineage changes are additive and old records remain
valid.

Post-release review date: 2026-09-07 for review/quarantine rates and false-positive reports.
