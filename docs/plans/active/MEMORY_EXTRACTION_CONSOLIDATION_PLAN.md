# Conversation memory extraction and consolidation plan

**Status:** Released; monitoring

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Create a conservative, durable path from completed conversation evidence to scoped memory
candidates. The first adapter is deterministic and review-first: it may propose semantic or
episodic records, but it cannot write procedural policy or silently activate inferred facts.

## Scope

- Enqueue one idempotent consolidation job for each run-bound inbound message.
- Claim jobs with a lease so worker replacement does not lose work or create concurrent extraction.
- Select bounded, deduplicated conversation evidence after a minimum message threshold.
- Extract only explicit preference and decision patterns in the first adapter.
- Persist inferred candidates through `MemoryLifecycle`, with source messages, run, extractor
  version, and review state in provenance.
- Make the adapter replaceable by a model-backed extractor after evaluation and cost controls exist.

## Non-goals

- Automatic activation of inferred memory.
- Procedural-memory creation from conversation text.
- Vector indexing or PostgreSQL RLS.
- Treating model or user content as trusted platform policy.

## Implementation checklist

- [x] Add the consolidation job table, lease indexes, and inbound-message enqueue trigger
      ([089_memory_consolidation_jobs.sql](../../../agents/migrations/089_memory_consolidation_jobs.sql)).
- [x] Add scoped job claim, completion, retry, and idempotency repository methods
      ([memory-consolidation-job-repository.ts](../../../agents/src/db/repositories/memory-consolidation-job-repository.ts)).
- [x] Add bounded evidence selection and a conservative candidate extractor
      ([consolidation.ts](../../../agents/src/memory/consolidation.ts)).
- [x] Add lifecycle support for reviewed/automatic inferred candidates
      ([lifecycle.ts](../../../agents/src/memory/lifecycle.ts)).
- [x] Run consolidation only after the evidence threshold and through the worker lease
      ([consolidation-worker.ts](../../../agents/src/memory/consolidation-worker.ts)).
- [x] Add unit, migration, and integration coverage for scope, replay, threshold, review, and
      poisoning behavior ([memory-consolidation.integration.test.ts](../../../agents/test/memory-consolidation.integration.test.ts)).
- [x] Update memory architecture, runbook, audit, analytics, and release evidence.

## Release record

Change: Durable, review-first conversation memory extraction and consolidation.

Owner: Agent Platform.

Risk: high. The change writes derived memory from user conversations and introduces a background
queue; inferred records remain review-pending and are never used as policy.

Affected services and user surfaces: agents-worker, Agents PostgreSQL, hosted conversation runs,
memory review, retention, and operator recovery.

Platform release version or release ID: commit `52b0fc8e`.

API/schema/migration changes: additive migration 089 adds consolidation jobs and an inbound-message
enqueue trigger. No public API contract changes.

Feature flag or rollout method: enabled only for installations whose normalized memory policy is
`reviewed` or `automatic`; existing `explicit` and `disabled` installations enqueue no writes.

Analytics events and success metrics: jobs claimed/completed/failed, candidates proposed, review
outcomes, and extraction threshold skips. Do not record message or memory text.

Logs, metrics, dashboards, and alerts: bounded queue age, lease recovery, candidate counts, and
failure codes; alert on repeated failures or lease churn. Collector revision and durable retention
remain governed by the observability release plan.

User, API, internal, and operational documentation: update the memory lifecycle architecture,
memory safety runbook, and audit checklist.

Validation evidence: focused unit, migration, worker, and guarded PostgreSQL integration tests
passed (37/37); full Agents verification passed with 87 test files and 539 tests passing, with 19
database-integration files skipped when the full suite ran without the integration flag; the
TypeScript build passed. Migration 089 applied in production through `node dist/db/migrate.js`.
Agents API deployment `be45b7f6-1855-4cf3-831b-1775eaa26877`, Agents Worker deployment
`81656054-450b-4985-b81d-19814e061a4f`, and MCP Gateway deployment
`5bdc4e31-5888-49b7-9852-550386aae7f2` reached `SUCCESS`. API live/ready and gateway health
smoke checks returned HTTP 200; worker logs showed the Temporal worker `RUNNING` with the memory
bundle loaded.

Rollback or disable plan: disable the consolidation worker or set memory policy to `explicit`;
retain review-pending records for review or deletion. Migration 089 is additive.

Post-release review date: 2026-09-07.
