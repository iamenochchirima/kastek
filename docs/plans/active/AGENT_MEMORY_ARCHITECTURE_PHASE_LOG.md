---
id: agent-memory-architecture-phase-log
title: Agent memory architecture phase log
sidebar_label: Memory architecture · phase log
slug: /memory-architecture-phase-log
description: Evidence and reference checkpoints for the active memory architecture implementation.
---

# Agent memory architecture phase log

This log is part of the active implementation record. It records the source refresh and evidence
for each implementation slice; it is not a second plan.

## Reference checkpoint — M0/M1/M2/M4/M5 initial slices

Date: 2026-09-07

Hermes files refreshed:

- `agent/memory_provider.py` — provider prefetch/sync hooks and checkpoint API versioning.
- `agent/memory_manager.py` — bounded provider timeouts, serialized sync worker, failure isolation,
  and shutdown draining.
- `hermes_state_compression.py` — leases, fences, watermarks, and atomic compression publication.
- `tools/memory_tool_store.py` — bounded consolidation attempts, drift protection, and redacted
  memory writes.

Waku files refreshed:

- `waku/memory/__init__.py` — working/semantic/episodic/procedural facade and lifecycle wiring.
- `waku/runtime/session.py` — bounded working-memory prompt assembly and post-turn consolidation.
- `waku/memory/retrieval_gate.py` — retrieval gate and its explicit failure behaviour.
- `waku/memory/consolidation.py` — thresholded extraction, exact source-row marking, and source
  preservation on failure.
- `waku/memory/semantic/base.py` — backend protocol, ID-bearing search, deletion, and `settle`.
- `waku/tools/memory_admin.py` — explicit search-before-correction/deletion workflow.

KasiTek files refreshed:

- `agents/src/memory/lifecycle.ts`, `retrieval.ts`, `revision-consolidation-worker.ts`, and
  `db/repositories/memory-repository.ts` — legacy lifecycle and migration inputs.
- `agents/src/runtime/context-compaction.ts`, `context-engine.ts`, `context-memory-boundary.ts`,
  `journal/`, and `runtime/runtime-telemetry.ts` — runtime seams and event envelope.
- `docs/plans/agents/HERMES_WAKU_MEMORY_RESEARCH.md` and the canonical memory plan.

Decisions carried forward:

- Hermes reliability is applied at the checkpoint/worker seam: idempotency, bounded work,
  provider isolation, and durable fences.
- Waku vocabulary is applied as canonical types: working, semantic, episodic, and procedural are
  not interchangeable; accepted/indexed/visible are distinct readiness states.
- KasiTek PostgreSQL revisions and journal events remain authoritative. Search and provider data
  are projections and are never the only evidence copy.
- The Studio visual surface remains P14; this phase only emits the events and lineage it will use.

Intentional divergences:

- Scope and authorization failures block the runtime retrieval path; only provider/search failures
  may produce an observable no-evidence result. This is stricter than Waku's generic gate fail-open
  rule because tenant isolation is a platform invariant.
- Inferred consolidation remains `review_pending`; “automatic” controls queue timing, not silent
  activation.
- The v2 retrieval adapter keeps lexical ranking authoritative when vector configuration is absent;
  the projection/index package records vector readiness separately and never labels lexical-only
  results as semantic embeddings.

Implementation evidence:

- M0: `agents/src/memory/contracts.ts`, `revisions.ts`, and contract tests.
- M1: migrations `130_memory_source_events_and_checkpoints.sql`,
  `134_memory_source_scope_validation.sql`, and `139_memory_source_event_capture.sql`, checkpoint
  repository/adapter, context compaction integration, strict installation/workspace/run scope
  triggers, journal observer capture, and idempotency tests.
- M2: migrations `131_memory_revision_foundation.sql`, `133_memory_revision_workspace_scope.sql`,
  `141_memory_revision_projection_readiness.sql`, and `142_memory_migration_receipts.sql`,
  immutable revision repository, relation storage, v2 explicit/correction/forget/review command
  service, and resumable legacy backfill.
- M3: `memory/revision-consolidation-worker.ts`, deterministic poisoning filters, evidence-window
  metadata, dead-letter/requeue recovery (`144_memory_consolidation_recovery.sql`), and worker
  tests; projection/outbox work is recorded below.
- M4: typed planner, revision retrieval repository, runtime adapter, lexical/vector readiness,
  embedding provider seam, and retrieval tests.
- M5: migrations `132_memory_deletion_worker.sql`, `137_memory_retention_quality.sql`,
  `138_memory_retention_scope_validation.sql`, `140_memory_deletion_scope_targets.sql`,
  `143_memory_provider_deletion_jobs.sql`, deletion/retention/provider-deletion workers,
  workspace-scoped revision reads, legal holds, and deletion tests.

Verification run for this checkpoint:

```text
pnpm --dir agents build
pnpm --dir agents exec vitest run \
  test/memory-contracts.test.ts \
  test/memory-runtime-adapter.test.ts \
  test/memory-runtime-retrieval-adapter.test.ts \
  test/memory-retrieval-planner.test.ts \
  test/memory-revisions.test.ts \
  test/memory-revision-consolidation-worker.test.ts \
  test/memory-deletion-worker.test.ts \
  test/context-memory-boundary.test.ts \
  test/context-compaction.test.ts \
  test/migration.test.ts
```

Result: build passed; the initial focused suite passed (including the added source-scope migration
assertion and checkpoint-only compaction case). Subsequent implementation checkpoints are listed
below. At the time of this checkpoint the local database/integration harness was unavailable;
local migration and integration evidence was added in the later checkpoints below.

## Phase 0 baseline checkpoint

Date: 2026-09-08

Evidence: [`AGENT_MEMORY_ARCHITECTURE_BASELINE.md`](./AGENT_MEMORY_ARCHITECTURE_BASELINE.md).
It records the exact KasiTek/Hermes/Waku revisions, local PostgreSQL counts, fixture inventory,
owners, rollout flags, release record, and rollback owner. The local database was empty for the
canonical memory tables before the random-tenant integration fixtures; one pre-existing
consolidation job was present.

Reviewer: Agent Platform automated review; external release approval remains a later gate.

## M5 retention and quality checkpoint

Date: 2026-09-07

Implemented evidence:

- `agents/migrations/137_memory_retention_quality.sql` defines organization/workspace/namespace/type/
  record retention rules, append-only quality events, stale revalidation jobs, conflict records, and
  leased maintenance scans.
- `agents/migrations/138_memory_retention_scope_validation.sql` enforces installation/workspace,
  fact/revision, tenant, and RLS boundaries for the new tables.
- `agents/src/memory/retention.ts` implements deterministic rule precedence, expiration/revalidation
  evaluation, bounded decay, validity overlap, entity/fact-key conflict detection, and explicit
  correction lineage classification.
- `agents/src/memory/retention-worker.ts` runs durable retention, revalidation, and conflict scans;
  expiration appends an immutable `expired` revision and never performs physical purge.
- `agents/src/db/repositories/memory-retention-repository.ts` persists idempotent quality events,
  revalidation jobs, conflict relations, maintenance leases, and bounded retry state.
- `agents/src/memory/quality-commands.ts` exposes explicit usage/confirmation/correction/rejection/
  helpfulness signals and revalidation without mutating a prior revision.
- `agents/src/db/repositories/memory-revision-retrieval-repository.ts` excludes open conflicts and
  returns usage counts for ranking.
- `agents/migrations/140_memory_deletion_scope_targets.sql` and the deletion worker route user,
  agent, workspace, conversation, memory, knowledge-source, and organization targets through the
  same leased, hold-aware deletion workflow.

Verification:

```text
pnpm --dir agents build
pnpm --dir agents exec vitest run \
  test/memory-retention.test.ts \
  test/memory-retention-worker.test.ts \
  test/memory-retention-migration.test.ts \
  test/memory-runtime-retrieval-adapter.test.ts \
  test/memory-retrieval-planner.test.ts \
  test/memory-revisions.test.ts \
  test/migration.test.ts
```

Result: build passed; 79 focused tests passed for the retention checkpoint. Live PostgreSQL execution of migrations, concurrent
expiration/correction races, and staging worker replay evidence remain release gates.

## M3/M4 projection and provider-readiness checkpoint

Date: 2026-09-07

Implemented evidence:

- `agents/migrations/135_memory_projection_outbox.sql` adds rebuildable FTS, vector, and temporal
  projections, per-projection readiness states, explicit workspace/install scope columns, database
  scope triggers, RLS, and an after-revision transactional projection outbox enqueue.
- `agents/migrations/136_memory_provider_projection_receipts.sql` records provider acceptance,
  indexing, visibility, failure, and deletion independently from canonical revision commit, with
  provider record and operation IDs, content digests, transition guards, scope validation, and RLS.
- `agents/src/db/repositories/memory-projection-repository.ts` provides idempotent enqueue,
  bounded canonical rebuild enqueue, SKIP-LOCKED leasing, scope-checked source reads, local
  FTS/temporal/vector upserts, readiness transitions, bounded retry/dead-letter handling, and
  provider receipts.
- `agents/src/memory/projection-worker.ts` provides the asynchronous worker seam, strict provider
  adapter contract, explicit blocked state for missing vector/provider configuration, no lexical
  fallback for failed vector projection, and bounded retry/lease recovery.

Verification:

```text
pnpm --dir agents build
pnpm --dir agents exec vitest run \
  test/memory-projection-migration.test.ts \
  test/memory-projection-worker.test.ts
git diff --check
```

Result: build passed; 6 projection migration/worker tests passed. Live PostgreSQL execution of the
135/136 migrations, vector extension/index creation, provider conformance, and worker crash/replay
evidence remain release gates.

## M3/M5 recovery and capture checkpoint

Date: 2026-09-07

Implemented evidence:

- `MemoryJournalSourceCapture` is attached as a durable observer to the main
  `PostgresExecutionJournal`; every persisted journal event is projected into the redacted,
  idempotent `memory_source_events` boundary without placing raw payloads in the memory event.
- `agents/migrations/144_memory_consolidation_recovery.sql` adds due-time scheduling, bounded error
  codes, evidence-window metadata, and explicit dead-letter status to consolidation jobs.
  `MemoryConsolidationJobRepository.requeueDeadLetter` provides a controlled operator retry.
- `agents/migrations/143_memory_provider_deletion_jobs.sql` adds a provider deletion queue that
  survives canonical revision purge. Deletion jobs remain `provider_pending` until every remote
  delete child is confirmed; dead-letter children remain visible and do not report completion.
- `MemoryProviderDeletionWorker` provides adapter-scoped remote deletion, lease/retry/dead-letter
  behaviour, and parent completion fencing. Operator retention projections expose provider queue
  counts and oldest pending time.

Verification:

```text
pnpm --dir agents build
pnpm --dir agents exec vitest run \
  test/memory-provider-deletion-worker.test.ts \
  test/memory-revision-consolidation-worker.test.ts \
  test/memory-deletion-worker.test.ts \
  test/migration.test.ts
```

Result: build passed; 64 tests passed. Live remote-provider adapter conformance, PostgreSQL queue
transitions, and crash/replay evidence remain release gates.

## M4 projection-backed retrieval and current-fact merge checkpoint

Date: 2026-09-08

Reference checkpoint:

- Hermes revision/files read: `agent/memory_provider.py`, `agent/memory_manager.py` — retrieval
  is gated before provider work, provider state is isolated, and provider output is treated as a
  bounded lifecycle rather than canonical truth.
- Waku revision/files read: `waku/memory/retrieval_gate.py`, `waku/memory/semantic/base.py`,
  `evals/deterministic/test_fact_store_conformance.py` — cheap retrieval gating and a complete,
  testable backend contract remain explicit seams.
- KasiTek files/contracts read: `memory/retrieval-planner.ts`,
  `memory/runtime-retrieval-adapter.ts`, `db/repositories/memory-revision-retrieval-repository.ts`,
  migration `135_memory_projection_outbox.sql`.
- Invariants carried forward: canonical revisions remain authoritative; scope and lifecycle checks
  precede ranking; only visible projections enter model evidence; current facts use stable identity.
- Behaviour intentionally not copied: no fail-open authorization path and no provider-backed write
  as the canonical memory source.
- New decision or divergence: lexical retrieval now requires the tenant-scoped FTS projection;
  canonical text `ILIKE` is not a retrieval fallback. Current-fact ranking merges by `fact_key`,
  while historical plans retain separate revisions.
- Test added to protect it: `memory-retrieval-planner.test.ts` current-fact merge/history test;
  repository SQL now uses `ts_rank_cd(plainto_tsquery(...))` against the FTS projection.
- Reviewer: pending.

Implemented evidence:

- `MemoryRevisionRetrievalRepository` now joins the FTS projection using the full organization,
  workspace, agent, installation, fact, and lifecycle scope and computes lexical rank from the
  durable `tsvector`. Vector similarity remains in the same scoped query plan.
- Retrieval candidates carry `factKey`, `subjectKey`, and `predicateKey` so the typed planner can
  merge current revisions without erasing historical revisions.
- `rankEvidencePack` deduplicates by stable fact identity for current plans and by revision ID for
  historical plans.

Verification:

```text
pnpm --dir agents exec vitest run test/memory-retrieval-planner.test.ts test/memory-runtime-retrieval-adapter.test.ts
pnpm --dir agents build
git diff --check
```

Result: 9 retrieval tests passed; TypeScript build passed. Live PostgreSQL FTS/vector query-plan
and projection-readiness evidence remains a release gate.

## M5 provider confirmation and residual purge checkpoint

Date: 2026-09-08

Implementation evidence:

- `MemoryDeletionJobRepository.markCompleted` now inspects every provider child before choosing
  `completed` versus `provider_pending`. A retry after canonical purge cannot leave a completed
  provider child stranded behind a permanently pending parent.
- `MemoryProviderDeletionWorker` advances the parent only when the current worker still owns and
  successfully completes the child lease. A stale worker that finishes after lease expiry cannot
  complete another worker's parent job.
- `purgeRevisionFacts` now handles organization-wide and source-only purges without accidentally
  deleting unrelated facts, and calls `assertNoResidualRevisionData` before the transaction can
  commit. The verifier checks canonical facts/revisions, local FTS/temporal/vector projections,
  outbox/readiness/provider receipts, revision sources, and relations using scope-safe IDs only.
- `agents/test/memory-v2-deletion.integration.test.ts` provides an opt-in real-PostgreSQL fixture
  with a fake provider adapter. It covers canonical/local projection purge, provider timeout and
  retry, stable operation IDs, parent confirmation, legal holds, resume after release, and an
  unrelated fact that must survive. The fixture is skipped unless
  `RUN_AGENTS_DB_INTEGRATION_TESTS=true` and `AGENTS_DATABASE_URL` are supplied.
- `agents/test/memory-deletion-worker.test.ts` covers residual detection, legal-hold routing, and
  retry-target isolation. `agents/test/memory-provider-deletion-worker.test.ts` covers fake-adapter
  timeout retries and stale-lease fencing.

Verification:

```text
pnpm --dir agents exec vitest run \
  test/memory-deletion-worker.test.ts \
  test/memory-provider-deletion-worker.test.ts \
  test/memory-v2-deletion.integration.test.ts
pnpm --dir agents build
git diff --check
```

Result: 11 focused unit tests passed; the 2 real-database integration cases were discovered but
skipped because this session has no active integration database. The executable fixture remains a
required live release gate.

## Release record status

Change: high-risk memory architecture upgrade, currently additive M0-M6 slices with staged rollout
controls.

Owner: Agent Platform.

Affected services and surfaces: Agents runtime, PostgreSQL migrations, Temporal worker, memory
commands/retrieval, deletion worker, and future Studio event projections. Studio UI is not changed.

Platform release version or release ID: pending commit/release identity.

API/schema/migration changes: migrations 130–153; runtime memory checkpoint/retrieval interfaces;
immutable revision, retention, quality, projection, consolidation recovery, provider deletion, and
deletion contracts.

Feature flag or rollout method: worker/config rollout is controlled by consolidation, projection,
retention, deletion, provider-deletion, and scoped memory v2 retrieval/write flags; production
cutover and legacy writer removal are pending migration evidence.

Analytics events and success metrics: structured memory checkpoint/retrieval/deletion telemetry and
versioned aggregate-safe analytics contracts are present; dashboards and quality metrics remain
pending.

Logs, metrics, dashboards, and alerts: bounded error codes and queue/retry/deletion telemetry are
present. The memory-specific dashboard and alert panel/threshold specification is recorded in
`docs/internal/operations/agent-memory-observability.md`; durable backend routing, notification
ownership, and staging evidence remain pending.

User, API, internal, and operational documentation: canonical plan, checklist, and this phase log
updated; public memory behaviour is not documented because the v2 path is not released.

Validation evidence: focused build/tests above; live DB, provider, and staging validation pending.

Rollback or disable plan: stop new v2 worker/retrieval flags and preserve additive schemas; no
destructive rollback migration is permitted.

Post-release review date: pending release owner and staging approval.

## M3/M4 runtime boundary checkpoint

Date: 2026-09-08

Implementation evidence:

- `directEvidenceEnvelopeFromMessages` now normalizes checkpoints to user/assistant conversational
  evidence and excludes system scaffolding, prior summaries, tool payloads, and assistant tool-call
  envelopes. Tool/effect receipts continue through the journal/effect lifecycle tables.
- Migration `149_memory_consolidation_flush_reasons.sql` adds explicit `threshold`,
  `pre_compaction`, `session_end`, and `operator` flush reasons. The job repository can reopen a
  run idempotently for a forced flush, and the v2 worker bypasses the message threshold only for an
  explicit flush. The runtime requests a pre-compaction flush before lossy context work.
- M4 retrieval now has a deterministic self-contained-message prefilter and a bounded small-model
  classifier for ambiguous prompts. Gate timeout/failure is recorded as bounded fallback metadata.
- M4 migration `147_memory_retrieval_decisions.sql` plus `148_memory_retrieval_gate_metadata.sql`
  persist content-free planner decisions, selected revision IDs, rejection reasons, measured tokens,
  latency, and gate provenance. Raw query text is hashed and never stored.

Verification:

```text
set -a; source agents/.env; set +a; pnpm --dir agents migrate
pnpm --dir agents build
pnpm --dir agents exec vitest run test/context-memory-boundary.test.ts test/memory-retrieval-gate.test.ts test/memory-runtime-retrieval-adapter.test.ts
set -a; source agents/.env; set +a; RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents exec vitest run test/memory-consolidation.integration.test.ts test/operator-projections.integration.test.ts test/memory-deletion-worker.integration.test.ts test/retention.integration.test.ts test/memory.integration.test.ts test/memory-consolidation.integration.test.ts
git diff --check
```

Result: migrations through 149 applied to the local PostgreSQL database; build passed; focused
runtime tests passed (14 assertions across the boundary/gate/adapter files); local integration
 subset passed (14 tests), including the replay-safe retrieval-decision integration assertion.
 Provider conformance, crash/replay, staging, and external release gates
remain open.

## Direct capability completion checkpoint

Date: 2026-09-08

The local durable REST/MCP smoke exposed a boundary bug: direct capability runs returned an empty
`AgentLoopResult`, so the workflow incorrectly entered assistant-response delivery and failed with
`EMPTY_ASSISTANT_RESPONSE`/`A response requires text or media`. Direct capability execution is not a
conversation turn and must expose its own durable result.

Implementation evidence:

- `AgentLoopResult.directToolResult` is now an explicit typed result for direct MCP/REST runs.
- `executeMcpToolRun` returns the already redacted capability output with the tool name.
- `agentRunWorkflow` persists that result under `output.tool`, completes the run without creating
  a conversation message or generating a title, and keeps the existing assistant-response path
  unchanged for model-backed runs.
- The public REST guide documents the terminal direct-tool output shape.

Verification:

```text
pnpm --dir agents build
pnpm --dir agents build:mcp
pnpm --dir agents exec vitest run \
  test/mcp-2026-transport.test.ts test/http.test.ts test/run.integration.test.ts --reporter=dot
AGENTS_E2E_API_URL=http://127.0.0.1:4110 \
AGENTS_E2E_GATEWAY_URL=http://127.0.0.1:4210 \
AGENTS_E2E_KEEP_FIXTURES=false \
pnpm --dir agents test:e2e:local
```

Result: both builds passed; focused transport/API/run tests passed (107 tests, 6 skipped); the
Temporal-enabled local REST/MCP smoke passed credential exchange, discovery, idempotency, durable
execution, gateway authentication, and protocol initialization. The temporary services were
stopped after the run. Staging/provider conformance and release-owner approval remain open.

Post-fix database verification:

```text
RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents test -- --reporter=dot
```

Result: 210 test files passed and 1,153 tests passed. Eight external-fixture files (31 tests) were
explicitly skipped by their existing gates. The worker was paused during the database run and
resumed by the command trap; no temporary smoke service remains running. The full suite now covers
the direct-tool completion change alongside the memory capture, revision, retrieval, consolidation,
retention, deletion, provider-confirmation, and tenant-boundary paths.

## M3 consolidation recovery checkpoint

Date: 2026-09-08

Implementation evidence:

- Migration `150_memory_consolidation_shutdown_recovery.sql` records abandonment count, last
  abandoning worker, bounded reason, and the extractor provider independently from the model.
- `MemoryConsolidationJobRepository.abandonLeases` requeues only leases still owned by the
  shutting-down worker, clears the lease, makes the job immediately due for a successor, and
  records `MEMORY_CONSOLIDATION_ABANDONED` without changing source evidence.
- `MemoryRevisionConsolidationWorker.shutdown(timeoutMs)` stops polling, waits for active claim and
  processing operations, and requeues owned leases after the bound. The Temporal worker uses the
  bounded result during shutdown and does not wait indefinitely for a timed-out consolidation run.
- Extractor execution has a bounded deadline and validates the complete structured candidate
  envelope before writing. Timeout and malformed output are retryable bounded errors.
- Revision idempotency is keyed by evidence digest rather than trigger run, preventing duplicate
  revisions when multiple threshold jobs cover the same bounded evidence window.

Verification:

```text
pnpm --dir agents build
pnpm --dir agents exec vitest run test/memory-revision-consolidation-worker.test.ts test/migration.test.ts
set -a; source agents/.env; set +a; RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents exec vitest run \
  test/memory-consolidation.integration.test.ts \
  test/memory-revision-consolidation.integration.test.ts
git diff --check
```

Result: migration 150 applied locally; build passed; focused unit/migration tests passed (68 tests
in the combined focused run); local PostgreSQL recovery/replay tests passed, covering expired-lease
successor fencing, bounded shutdown abandonment, digest replay, and messages arriving during
extraction. Production throughput/load evidence, staging approval, and the M3 reviewer checkpoint
remain release gates.

## M1 concurrent-arrival and M3 partition checkpoint

Date: 2026-09-08

Implementation evidence:

- `agents/test/memory-capture.integration.test.ts` runs the real compaction path through
  `createRuntimeMemoryCheckpointPort` and `MemoryCheckpointRepository`. The summary provider
  appends a new inbound message after the first checkpoint commits, then a successor compaction
  commits the larger source-event range. The assertions prove the first checkpoint retains its
  original three event IDs and the second retains those IDs plus the concurrent arrival.
- `agents/test/memory-consolidation-partition.integration.test.ts` exercises two concurrent
  workers against two conversation partitions. It proves one worker claims the first trigger run
  per conversation, while the next bounded pass claims the next trigger run per conversation;
  retryable claims preserve the ordered sequence without duplicate claims.
- `agents/test/context-memory-boundary.test.ts` simulates worker loss after the memory checkpoint
  commits but before the context projection persists. The retry replays the same checkpoint
  idempotently and creates one durable context record.

Verification:

```text
set -a; source agents/.env; set +a; RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents exec vitest run test/memory-capture.integration.test.ts
set -a; source agents/.env; set +a; RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents exec vitest run test/memory-consolidation-partition.integration.test.ts
pnpm --dir agents exec vitest run test/context-memory-boundary.test.ts
```

Result: both local PostgreSQL integration files passed (3 capture tests and 1 partition/order
test), and the context boundary unit file passed (8 tests). The unit simulates the post-checkpoint
worker-loss retry; exact event-admission process-kill proof and production throughput/load evidence
remain open. No reviewer or release gate is claimed by these tests.

## M6 backend observatory contract checkpoint

Date: 2026-09-08

Reference checkpoint:

- Hermes revision/files read: provider and compression lifecycle contracts; failure and visibility
  states remain explicit and content is not copied into operator telemetry.
- Waku revision/files read: retrieval/consolidation event boundaries and replay-oriented memory
  lifecycle states.
- KasiTek files/contracts read: `agents/src/journal/contracts.ts`,
  `agents/src/db/repositories/run-repository.ts`, memory revision/source/projection schemas, and
  the canonical M0-M6 plan.
- Invariants carried forward: the journal is the durable cursor source; canonical revisions are
  authoritative; provider readiness is distinct from commit; scope is checked before projection;
  graph metadata is bounded and content-free.
- Behaviour intentionally not copied: no browser polling, inferred placeholder nodes, raw prompts,
  canonical text, or provider payloads in the graph projection.
- New decision or divergence: expose run and revision views from one typed content-free projection
  module; a node exists only for a durable journal/revision/source row.
- Test added to protect it: `agents/test/memory-observatory.test.ts` and fixture streams under
  `agents/test/fixtures/memory-observatory-event-streams.ts`.
- Reviewer: automated Agent Platform review; external release approval remains open.

Implementation evidence:

- `agents/src/memory/observatory.ts` maps durable journal events into typed run graph nodes and
  causal edges, and maps canonical revision/source/relation rows into scoped memory lineage. It
  preserves sequence cursors for reconnect and only carries bounded IDs, statuses, readiness,
  retries, and error codes.
- `MemoryObservatoryRepository.listRun` reads the PostgreSQL execution journal with organization,
  run, and cursor predicates. `listRevision` reads only the requested tenant's canonical lineage.
- Fixture streams cover worker failure/retry, projection lag, and legal-hold deletion without
  browser-derived state or raw message content.

Verification:

```text
pnpm --dir agents exec vitest run test/memory-observatory.test.ts
pnpm --dir agents build
git diff --check
```

Result: five observatory projection/lineage assertions passed; build and diff checks passed. P14
visual Studio implementation remains explicitly deferred; staging, production, and reviewer gates
remain release work.

M4 retrieval fan-out follow-up:

- `MemoryRevisionRetrievalRepository.search` now runs the lexical/vector and structured
  fact-key/entity/temporal branches concurrently under the same organization, workspace,
  installation, namespace, lifecycle, validity, conflict, and readiness predicates. Results merge
  by revision ID before planner ranking; no branch can widen authorization.
- `memory-retrieval-fanout.test.ts` verifies both branches execute and merge deterministic scores;
  planner tests cover no-evidence responses, poisoned/pending exclusion, current-versus-history,
  scope fencing, source diversity, and token caps.

M4 lineage follow-up:

- Retrieval candidates now hydrate scoped, content-free relation summaries after the lexical,
  vector, fact-key, entity, and temporal fan-out. Historical results preserve related revision
  IDs and relation types instead of flattening the history into one text match.
- The runtime evidence contract carries those relation summaries through to diagnostics without
  copying canonical text, provider payloads, or hidden cross-scope records. Contradiction-linked
  evidence is therefore explainable by revision ID and relation type while open conflict rows
  remain excluded from current-fact retrieval.
- `memory-retrieval-fanout.test.ts` and the planner lineage assertion cover relation hydration and
  explicit contradiction explanation; build and diff checks passed after the change.

M2 verification follow-up:

- `memory-revision-command-service.test.ts` simulates two compare-and-set corrections reading the
  same predecessor. One correction wins; the loser is appended as review-pending with the observed
  winner in its bounded conflict metadata.
- `memory-retrieval-planner.test.ts` covers conversation, end-user-private, agent-private, and
  workspace-shared reads plus mismatched tenant, user, conversation, and installation scopes. The
  runtime adapter now admits an end-user-private scope without manufacturing a conversation scope.
- `memory-revision-consolidation-worker.test.ts` rejects procedural extractor output before any
  canonical write, and the versioned skill integration fixture covers explicit procedural
  publication with incrementing immutable versions.

Migration backfill follow-up:

- `memory-backfill.integration.test.ts` runs the real `MemoryBackfillService` against PostgreSQL.
  It proves dry-run receipts do not create canonical revisions, supported scoped semantic and
  episodic records preserve legacy IDs/checksums in provenance, working/procedural/unscoped rows
  are recorded as explicit skips, and a live rerun does not append duplicate revisions.

- The same fixture now enqueues and drains the real FTS, vector, and temporal projection rebuild
  worker, verifies six readiness rows reach `visible`, and compares legacy search with v2 retrieval
  output for the migrated semantic fact. The local run also caught and fixed untyped PostgreSQL
  parameters in projection completion and structured retrieval ordering; these are now covered by
  the integration path rather than being hidden behind mocks.

Projection/retrieval SQL correctness checkpoint (2026-09-08):

- Reference refresh: `memory-projection-repository.ts`, `projection-worker.ts`, and
  `memory-revision-retrieval-repository.ts` were reread alongside the Waku/Hermes memory notes.
- Decision: every projection completion parameter is explicitly typed and every retrieval query
  parameter is either consumed or removed; ranking expressions are repeated in `ORDER BY` rather
  than relying on aliases inside an expression. This keeps PostgreSQL planning deterministic and
  prevents a successful worker claim from being recorded as a failed projection.
- Evidence: `memory-backfill.integration.test.ts` now passes the real projection rebuild and
  retrieval parity path; full build and suite remain green.

Agent deletion cutover audit (2026-09-08):

- `AgentRepository.deleteAgent` still performs synchronous resource deletion and only removes
  legacy `memory_records`. It does not enqueue the v2 memory deletion job or provider-deletion
  children. v2 source/checkpoint rows use restrictive foreign keys, and provider deletion jobs
  must survive local purge until the remote adapter confirms deletion.
- Decision: keep this as an explicit cutover gate. Do not add cascading foreign keys or silently
  delete v2/provider rows. The safe sequence is archive or disable, enqueue an agent-targeted
  deletion job, drain canonical and provider deletion workers, then remove installations,
  versions, and the definition. A combined agent-delete/v2-fixture test is still required before
  legacy deletion is routed to the new workflow.

Agent deletion cutover implementation (2026-09-08):

- `AgentRepository.deleteAgent` now detects v2 facts, source events, checkpoints, and provider
  deletion children before destructive work. When present, it archives the definition, disables
  installations, and enqueues an `agent`-targeted durable memory deletion job instead of removing
  the installation boundary.
- `MemoryDeletionWorker` runs a restart-safe finalizer scan after each batch. It only invokes the
  final resource deletion after the parent memory job is `completed` and every provider child is
  `completed`; completed provider child rows are removed immediately before installation removal.
- `conversationIdsForTarget` now selects the actual `conversations.id` column for agent/workspace
  deletion scopes. This path is covered by `agent-deletion-v2.integration.test.ts`, which creates
  a source event, checkpoint, canonical fact, revision provenance, and visible provider receipt,
  then proves archive -> local purge -> provider confirmation -> final resource deletion.
- A normal agent with no v2 memory remains compatible with the existing synchronous delete path;
  the v2 path is now durable and provider-safe rather than relying on restrictive foreign keys.

Latest agents verification on 2026-09-08:

```text
pnpm --dir agents build
pnpm --dir agents build:mcp
pnpm --dir agents test -- --reporter=dot
```

Result: TypeScript and MCP package builds passed. 179 test files passed, 37 integration files skipped without their external fixtures;
1,052 tests passed and 108 skipped. The skipped tests remain environment/release gates rather than
silent success claims. The focused local PostgreSQL memory matrix passed 28 tests across capture,
revisions, retrieval decisions, consolidation, recovery, retention, deletion/provider, skill,
and migration backfill confirmation. The standalone backfill integration file adds 2 passed tests
when the local database gate is enabled.

Full database-enabled verification (2026-09-08, final local run):

```text
RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents test -- --reporter=dot
```

Result: 209 test files passed and 1,142 tests passed. Eight integration files (31 tests) were
explicitly skipped by their existing external-fixture gates. The previously failing hosted-agent,
durable-run, and template integration paths are now green: template installation targets the
environment-aware uniqueness index, and durable-run fixtures declare `playground` explicitly at
the installation boundary. `pnpm --dir agents build`, `pnpm --dir agents build:mcp`, the migration
runner through migration 152, and `git diff --check` also pass. This verifies the local backend
implementation; staging/production rollout, provider conformance, reviewer approval, and the
explicitly deferred Studio visual surface remain open release gates. The agent-delete/provider-
confirmation cutover is now covered by `agent-deletion-v2.integration.test.ts`. Because the local
development Temporal worker shares this database and can claim queued fixtures, the suite was run
with that worker paused for isolation and the worker was resumed immediately afterward.

Post-fence memory verification (2026-09-08):

```text
pnpm --dir agents build
pnpm --dir agents build:mcp
pnpm --dir agents migrate
RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents exec vitest run \
  test/memory*.test.ts test/context-compaction.test.ts \
  test/context-runtime-postgres.integration.test.ts --reporter=dot
```

Result: 35 memory/context files were collected; 24 passed and 11 were intentionally skipped, with
121 tests passed and 33 skipped. Migration 151 adds a unique
`(organization_id, run_id, event_sequence)` fence for journal-admitted source events; the
PostgreSQL capture fixture proves a conflicting cursor returns
`MEMORY_SOURCE_EVENT_SEQUENCE_CONFLICT` instead of silently creating a replay gap. The workflow
execution journal now uses the same memory source observer as linear runs, so graph tool/waiting
facts share the canonical evidence boundary. The isolated audio integration file and the full
database-enabled suite also pass with the local development worker paused for fixture isolation.
Migration 152 adds the organization/install/conversation partition index used by the consolidation
claim fence, and the partition integration fixture verifies concurrent workers do not merge tenant
partitions.

Agents backup and restore drill (2026-09-08):

- Added guarded custom-format backup and restore scripts at `agents/scripts/backup.sh` and
  `agents/scripts/restore.sh`. The backup records a stable backup ID, UTC timestamp, repository
  revision, intended migration target, and SHA-256 checksum; restore requires an explicit
  confirmation, stopped-service confirmation, and verifies the checksum before invoking
  `pg_restore`.
- Local backup evidence: `agents-20260908T033234Z`, created from the local Agents PostgreSQL 18
  database and checksum-verified. The dump was restored into disposable database
  `kasitek_agents_recovery_20260908`; the restored schema contained 3 canonical revisions and no
  migration receipts, source events, or checkpoints, matching the source database counts at the
  time of the snapshot. The disposable database was removed after verification.
- The backup ID and disposable restore prove the local recovery mechanism, but do not satisfy the
  staging/production pre-backfill backup, restore-duration, RPO/RTO, or release-owner approval
  gates.
- The backup script now records the highest migration filename present in the repository instead
  of a hard-coded target, so future cutover snapshots cannot silently report an older schema level.
- Follow-up hardening: backup publication now uses a temporary custom-format file and refuses to
  publish an empty archive after a failed `pg_dump`. Metadata records the `pg_dump` client version,
  and restore selects a matching installed major-version `pg_restore` when no explicit binary is
  supplied; restore also validates archive readability before invoking `pg_restore`. The existing
  local archive was checksum-verified and listed successfully with PostgreSQL 18 clients; the
  staging/production RPO, RTO, and restore-owner gates remain open.
- Fresh disposable drill: `agents-20260908T055006Z` was created with PostgreSQL 18 `pg_dump`,
  restored through `agents/scripts/restore.sh` without an explicit restore binary, and validated at
  146 restored `schema_migrations` rows before the disposable database and dump were removed.

Runtime rollback gate (2026-09-08):

- Added `MEMORY_V2_ENABLED` to the Agents configuration, enabled by default. Setting it to
  `false` prevents v2 checkpoint, source-event capture, typed retrieval, and revision-tool wiring
  from being constructed; the existing compatibility memory path and additive schema remain
  available. Memory workers retain independent switches so an operator can quiesce them as part of
  the same rollback.
- `test/config.test.ts` proves the default-enabled and explicit-disabled configuration states;
  `pnpm build` and `pnpm build:mcp` pass. A staging drill must still prove disablement during live
  traffic, checkpoint-free recovery, and exact artifact rollback before this gate can be closed.

M4 direct memory-search policy follow-up (2026-09-08):

- The v2 `memory_search` command now normalizes the agent memory policy before building its typed
  retrieval plan. Disabled policies, zero-result budgets, and empty readable-namespace sets return
  no memories without querying the revision index; requested result and token limits are capped by
  the policy budget and sensitive reads require both the tool request and policy permission.
- Search responses preserve the canonical revision sensitivity (`normal`, `sensitive`, or
  `restricted`) instead of flattening it to `normal`. The focused command-service test verifies
  the planner inputs, policy limits, sensitivity gate, disabled-policy short circuit, and response
  metadata.
- This closes the direct command policy/metadata gap only. The M4 reviewer approval, provider
  conformance, Studio preview, staging rollout, and full legacy-path removal remain release gates.

Verification refresh (2026-09-08):

- Added the durable compaction `projectionDigest` contract field used to validate replayed message
  projections against the exact persisted projection. This keeps the context-runtime change typed
  and makes replay divergence a bounded `replay_conflict` instead of an untyped payload.
- `pnpm --dir agents build` and `pnpm --dir agents build:mcp` pass, followed by `git diff --check`.
- The focused memory/context matrix now passes 24 of 35 collected files (121 tests passed, 33
  skipped by external-fixture gates). The full database-enabled suite passes 209 files and 1,142
  tests, with 8 files and 31 tests skipped by existing external-fixture gates.

Scoped rollout controls (2026-09-08):

- Migration `153_memory_rollout_flags.sql` extends the operator flag contract with
  `memory_v2_writes_enabled`, `memory_v2_retrieval_enabled`, and
  `memory_consolidation_enabled`. Existing global, organization, and installation precedence
  applies; absent rows remain enabled by the repository default.
- Runtime automatic retrieval, direct memory tools, and direct MCP memory calls now check the
  corresponding scoped flag. `MEMORY_V2_ENABLED=false` remains the global rollback switch.
- Consolidation workers release a claimed job when the scoped worker flag is disabled, preserving
  the queue for a later enablement. The worker-loss/replay suite covers lease fencing and no-write
  behaviour after a lost evidence-window lease.
- Focused migration/operator/worker verification: 4 files passed, 81 tests passed. Local
  migration runner applied through `153`; staging enablement, queue monitoring, and release-owner
  approval remain open.

Analytics contract refresh (2026-09-08):

- Added versioned aggregate-safe contracts for memory lifecycle, retrieval, projection, and
  deletion outcomes (`agent.memory.lifecycle@1`, `agent.memory.retrieval@1`,
  `agent.memory.projection@1`, and `agent.memory.deletion@2`). Registry bindings now include 52
  contracts; deletion v2 adds explicit `knowledge_source`/`user` targets and an
  `organization_aggregate` scope resolution so cross-installation jobs never use synthetic
  identifiers. The validated registry checksum is
  `732a46944532031fe28e6141e7e8ab938f91e9a01d54f26a3e5559d8735a0fb1`.
- Added typed Agent producer builders/enqueue helpers and privacy/content-redaction coverage.
  Registry validation, Rust registry tests (5), TypeScript producer tests (19), and diff checks
  pass. Runtime dashboard and alert validation remain a release gate.

Runtime analytics wiring (2026-09-08):

- Reference refresh: reread the memory lifecycle repository, typed retrieval adapter, projection
  worker, analytics contracts, and the Hermes/Waku memory research note before wiring producers.
- Decision: lifecycle events for canonical revision capture/correction/conflict, retrieval outcomes,
  and projection readiness/failure are emitted as aggregate-safe outbox records. Retrieval and
  projection analytics are best-effort operational projections; the canonical decision, revision,
  and projection state remain authoritative when an analytics enqueue is unavailable.
- Scope safety: revision lifecycle events are enqueued in the same transaction as the canonical
  revision. Retrieval events are emitted only after the scoped decision row is recorded. Projection
  events are emitted only after the lease-owner state transition succeeds, so stale workers cannot
  report a successful projection.
- Privacy: the retrieval producer stores a query digest and length, never query text; projection
  and lifecycle producers store bounded IDs, states, readiness, and error codes only. Producer and
  redaction tests cover the contract boundary.
- Evidence: focused runtime analytics/recovery matrix passed 7 files and 108 tests; the checkpoint
  adapter and analytics contract follow-up passed 2 files and 21 tests. The DB-enabled full suite
  passed 212 files and 1,176 tests, with 8 external-fixture files and 31 tests skipped.
- Checkpoint completion: `MemoryCheckpointRepository` now emits the scoped `checkpoint` lifecycle
  event in the same transaction as a committed or replayed checkpoint. This preserves the
  checkpoint/source-of-truth boundary while making compaction outcomes observable without exposing
  evidence content.
- Direct-tool parity: the v2 `memory_search` command now emits the same typed retrieval analytics
  contract as automatic retrieval after it applies the shared planner and ranking rules. It stores
  only bounded scope, decision, digest, count, token, and latency dimensions.
- Blocked retrievals with a valid scope now emit a bounded `blocked` retrieval event with a scope-
  rejection marker; invalid or incomplete scopes intentionally produce no analytics record because
  there is no authorized tenant scope to attach to the event.
- Deletion parity: canonical and provider deletion workers now resolve a real installation scope
  when one target maps uniquely, otherwise an explicit organization aggregate, and emit bounded
  requested, canonical-purged, projection-purged, held, retrying, provider-confirmed, completed,
  and failed outcomes. No synthetic workspace, agent, or installation identifiers are generated.
- Deletion analytics enqueue is best effort and never blocks canonical purge or provider confirmation;
  the deletion job/provider state remains authoritative. Dashboard deployment, alert routing,
  staging exporter inspection, and release approval remain open operational gates.

Pre-direct-tool verification refresh (2026-09-08):

- `pnpm --dir agents build`, `pnpm --dir agents build:mcp`, and `git diff --check` pass after
  adding rollout checks, runtime analytics, and checkpoint lifecycle events.
- The DB-enabled full suite completed with 210 test files passed and 1,152 tests passed; 8 files
  and 31 tests were skipped by their existing external-fixture gates. The focused memory/context
  matrix completed with 25 files passed, 11 intentionally skipped, 127 tests passed, and 33
  skipped. The local migration runner is applied through `153`.
- Public and internal Docusaurus builds pass after documenting the versioned memory lifecycle and
  observability contract. The public guide describes rollout-controlled behavior without claiming
  production enablement.
- Deletion-focused verification passed: 2 unit files (11 tests) passed and the DB-backed deletion
  and agent-delete/provider-confirmation paths passed in the 210-file/1,152-test suite. The local
  Temporal worker was resumed after the isolated run.
- Pre-release record: `docs/plans/active/AGENT_MEMORY_ARCHITECTURE_RELEASE_RECORD.md` now captures
  the base commit, migrations through `153`, agent package version, scoped rollout flags, analytics
  registry checksum, validation evidence, rollback switch, and explicit gaps for a clean tagged
  artifact, staging provider configuration, and release-owner approval.
- Checklist reconciliation: 135 items are complete, 28 are partial, and 20 remain pending. Excluding
  the eight deferred P14 Studio items, weighted implementation evidence is 85.1%; the remaining
  non-Studio pending items are reviewer approval, controlled cutover, staging/production, soak,
  rollback, and post-release gates.
- Release manifest evidence: `MEMORY_RELEASE_ID=memory-v2-pre-release-local pnpm --dir agents
  release:memory:manifest` passed and wrote the ignored local manifest at
  `agents/.artifacts/memory-release-manifest.json`. It records the base commit, stable worktree
  fingerprint recorded at that checkpoint, migration range,
  rollout flags, registry checksum, and built Agents/MCP artifact digests. It intentionally leaves
  staging and production gates pending.

Final verification after direct capability completion fix (2026-09-08):

- The direct MCP/REST completion boundary now persists a redacted `output.tool` result instead of
  attempting assistant-message delivery for a run with no model response.
- `pnpm --dir agents build`, `pnpm --dir agents build:mcp`, `pnpm --dir agents migrate`, the
  analytics registry check, both Docusaurus builds, and `git diff --check` pass.
- The focused MCP/HTTP/run suite passes 107 tests with 6 existing skips.
- The Temporal-enabled local REST/MCP smoke passes credential exchange, discovery, idempotency,
  gateway authentication, protocol initialization, durable execution for both transports, and
  asserts that the completed REST operation contains the redacted `output.tool` result.
- The database-enabled full suite passes 212 files and 1,176 tests; eight external-fixture files
  (31 tests) remain explicitly skipped. The local worker was resumed after the isolated database
  run.
- The refreshed local release manifest records base commit `65a507580e23d56e62c9c341e18ef7802402f765`;
  the current worktree fingerprint and Agents/MCP artifact digests are recorded in the release
  record. Staging deployment, provider conformance, production
  promotion, rollback drill, reviewer approval, and the deferred P14 Studio UI remain open.

RLS verification refresh (2026-09-08):

- A temporary local login was granted the existing `kasitek_agents_runtime` role so the restricted
  RLS path could be exercised without the development superuser bypassing policies.
- `memory-knowledge-rls.integration.test.ts`, `conversation-run-rls.integration.test.ts`,
  `identity-credentials-effects-rls.integration.test.ts`, and
  `control-plane-lifecycle-rls.integration.test.ts` passed all 14 assertions.
- The temporary login was disabled and removed after the run; the runtime role is again `NOLOGIN`,
  and the fixture organizations were cleaned up. This closes the local tenant-policy evidence gap;
  production role provisioning and staging isolation remain release work.

Provider acknowledgement and artifact verification follow-up (2026-09-08):

- Reference refresh: reread `agents/src/memory/projection-worker.ts`,
  `agents/src/memory/provider.ts`, the projection repository readiness contract, and the provider
  deletion worker before closing the local provider boundary.
- Decision: provider projection adapters must return matching `readiness` and `providerState`
  values (`accepted`, `indexed`, or `visible`) with a non-empty remote record ID for upserts;
  deletes must return `deleted` for both fields. A malformed acknowledgement is a non-retryable
  contract failure and is dead-lettered before it can advance local readiness or provider receipt
  state. This keeps canonical commits independent from provider availability while preventing a
  provider from falsely making a record visible or deleted.
- Evidence: `assertMemoryProviderProjectionResult` is covered by memory contract tests, and the
  projection-worker test proves a mismatched acknowledgement is blocked rather than completed or
  retried. Provider-specific API conformance and staging credentials remain external gates.
- Added `pnpm --dir agents release:memory:verify`, which validates a generated local manifest's
  schema, source identity, migration range, analytics registry checksum, and built artifact
  digests. Dirty worktrees are accepted only when `MEMORY_RELEASE_ALLOW_DIRTY=true` is explicitly
  set for local pre-release verification; staging candidates must pass without that override.
- Verification: provider/deletion/projection focused tests (19 tests), Agents build, manifest
  generation and verification, and `git diff --check` pass. The release record now points at the
  latest local manifest and verifier. Clean tagged artifact, provider configuration, staging,
  production, rollback, and review-owner gates remain open.

Journal source replay recovery (2026-09-08):

- Added bounded, ordered replay from the durable execution journal into the memory source-event
  boundary. The replay cursor advances only after an idempotent source write succeeds, resumes
  from the last admitted sequence in-process, and safely restarts from sequence zero after a
  worker restart because source-event identity is idempotent.
- Replay rejects crossed tenant/run scopes and non-monotonic journal pages. It is reconciled before
  context construction, while the journal observer remains non-blocking so a capture outage cannot
  turn a committed user turn into a second execution.
- Added coverage for ordered paging, cursor resume, idempotent replay accounting, scope conflict,
  and cursor validation. The journal-capture, projection, and provider-deletion focused matrix
  passes 14 tests; the Agents build and `git diff --check` pass. A process-kill Temporal matrix is
  still a staging/release evidence gate.

Current database matrix refresh (2026-09-08):

- The full database-enabled suite was rerun with the current journal replay wiring and the live
  worker fenced from claiming test fixtures. It passed 210 files and 1,158 tests; eight external-
  fixture files (31 tests) remain intentionally skipped.
- The run exposed and fixed a real environment-selection bug in `getSystemInstallation`: when a
  live and playground protected installation shared a scope, an unordered query could return the
  playground record. The lookup now defaults to the live environment and accepts an explicit
  environment when needed. The isolated system-agent integration test and the complete database
  matrix pass after the fix.
- The remote-MCP rate-limit integration test also passed repeatedly in isolation and in the final
  complete matrix. The worker was resumed after the isolated verification.

Typed retrieval seam closure (2026-09-08):

- Rechecked the automatic runtime path and the direct `kasitek.agent.memory_search` path against
  the same typed planner (`buildRetrievalPlan` + `rankEvidencePack`). Automatic retrieval enters
  through `createRuntimeMemoryRetrievalPort`; direct search applies the identical planner contract
  and maps legacy policy names into the v2 namespace allow-list before repository search.
- The runtime adapter and command-service tests cover typed intent, current/semantic memory kinds,
  scope filtering, and explicit namespace allow-lists. Studio preview consumption remains a P14
  surface, not a second retrieval implementation.
- Hardened the runtime scope boundary so a missing allow-list defaults to the requested namespace
  instead of becoming an unrestricted repository query; normalized persisted policies now always
  contribute an explicit bounded allow-list. Added a regression test for that fail-closed default.
- The checklist item is now complete; the remaining M4 partial status is limited to reviewer and
  external provider/staging conformance gates.

Temporal recovery verification (2026-09-08):

- Started an ephemeral local Temporal dev server on `localhost:7233` and ran the real workflow
  worker replacement matrix. All nine model/tool/approval/effect/completion before/after scenarios
  passed, including exactly-once terminal completion assertions.
- Ran the PostgreSQL-backed context-compaction recovery workflow for both `before_persist` and
  `after_persist`; both scenarios passed with one durable revision and a replayed projection digest.
- Ran the four workflow recovery cases (approval wait, batch feedback, bounded loop continuation,
  and handoff cancellation); all passed. The local Temporal process is test-only and is not a
  staging or production release gate.
- Re-ran the PostgreSQL memory capture and worker-loss fixtures against the current database; both
  files passed all nine tests, including concurrent-arrival evidence ranges, journal admission
  during compaction, cursor fencing, replay idempotency, lease loss, and successor recovery.
- Re-ran the PostgreSQL partition-fencing, revision-consolidation, backfill, and agent-deletion
  fixtures; four files passed all six tests. This confirms local installation/conversation lease
  ordering, canonical revision extraction, dry-run migration receipts, and provider-confirmed
  agent deletion. Production-scale load and cutover comparisons remain release gates.
- After the scope-boundary hardening, the complete non-database Agents suite passed 180 files and
  1,078 tests; 38 external-fixture files (111 tests) remain intentionally skipped.

Scoped rollout fixture refresh (2026-09-08):

- Added `memory-rollout-flags.integration.test.ts` as an executable non-production rollout proof.
  It verifies the four memory flags default to enabled when no scoped override exists, isolate
  organization overrides, allow an installation canary to override its organization, and keep
  consolidation disabled without consuming a lease attempt or dropping the queued job.
- The PostgreSQL fixture passed with `AGENTS_DATABASE_URL=... RUN_AGENTS_DB_INTEGRATION_TESTS=true`.
  This closes the local flag/lease evidence gap; end-to-end explicit-write and retrieval enablement,
  bounded queue monitoring, staging configuration, and release-owner approval remain open.

Independent projection rollout control (2026-09-08):

- Added migration `154_memory_projection_rollout_flag.sql` and the scoped
  `memory_projection_enabled` operator flag. Projection now has the same global, organization, and
  installation precedence as writes, retrieval, and consolidation.
- `MemoryProjectionWorker` checks the flag after claiming a task. A disabled scope returns the
  lease to `queued`, refunds the claim attempt, restores readiness to `accepted`, and records a
  bounded rollout code; canonical revisions remain untouched. The worker is wired to the existing
  operator controls in the Temporal worker.
- The backfill integration fixture passed with projection paused for all six tasks, then resumed
  after the flag was enabled and reached visible readiness. Unit coverage also proves the worker
  does not read or project a task while paused.

Latest database verification refresh (2026-09-08):

- Reran the complete PostgreSQL-backed Agents matrix against migrations through `156` with the
  development Temporal worker fenced from claiming fixtures. The current tree passed 212 test files
  and 1,176 tests; eight external-fixture files (31 tests) remain intentionally skipped. The worker
  was resumed by the command trap after the run.
- Regenerated the local release manifest; its current release ID, fingerprint, migration range, five
  rollout flags, registry digest, and built artifact digests are recorded in the release record.
  Staging, provider, production, rollback, and release-owner gates remain open.

Process-kill journal admission proof (2026-09-08):

- Added `test/fixtures/memory-journal-kill-child.ts`, which uses the real PostgreSQL execution
  journal store and reports only after the journal transaction commits. Its observer is held open so
  the parent can terminate the child with `SIGKILL` before memory observation runs.
- The PostgreSQL capture integration test then replays the durable journal through
  `MemoryJournalSourceCapture`, captures one source event, replays from sequence zero, and verifies
  the second pass is idempotent. The fixture passed 6/6 tests. This closes the exact event-admission
  crash boundary; release-owner approval remains open.

Process-kill consolidation recovery proof (2026-09-08):

- Added `test/fixtures/memory-consolidation-kill-child.ts`, which runs the real revision
  consolidation worker and pauses after the first canonical revision commit but before the leased
  job completion mutation. The parent terminates it with `SIGKILL`, expires the persisted lease, and
  runs a successor worker.
- The successor reclaims the job, replays the committed revision by evidence digest, completes the
  job, and leaves one idempotency key per revision. The PostgreSQL consolidation integration file
  passed 3/3 tests, including the new process-loss case. Production-scale load remains a release
  gate; the local live consolidation kill boundary is now covered.

Consolidation partition/load fixture refresh (2026-09-08):

- Expanded `memory-consolidation-partition.integration.test.ts` from two conversations to 32
  conversations and four concurrent claimers. Two ordered claim waves each return exactly one job
  per conversation, preserve the trigger-run order, and produce no duplicate ownership.
- The PostgreSQL fixture passed with all 32 partitions and 64 jobs. This is bounded local evidence
  for partitioning and queue contention; production-scale throughput, latency, and capacity results
  still require the staging load gate.

End-to-end scoped rollout activity proof (2026-09-08):

- Extended `run.integration.test.ts` to exercise the actual Temporal activity construction and
  v2 memory tools, not only the operator repository or worker seams. With organization flags off,
  `memory_search` and `memory_remember` fail closed with their bounded rollout codes; after the
  same organization is enabled, retrieval completes with an empty evidence pack and an approved
  explicit remember call commits a v2 semantic revision.
- The durable run integration file passed 7/7 tests. This closes the local explicit-write and
  retrieval enablement gap; staged agent-version rollout and production evidence remain open.

Backfill dimension evidence (2026-09-08):

- `MemoryBackfillService` now returns bounded source and canonical target counts for organization,
  workspace, agent, namespace, lifecycle state, memory type, and sensitivity. Missing scope is
  represented explicitly as `__missing__`; no content or secrets are included in the report.
- The legacy backfill integration fixture verifies all seven source dimensions on dry-run and all
  migrated target dimensions after projection, while preserving the idempotent rerun assertion.
  The local file passed 2/2 tests; complete production-dataset comparison remains a cutover gate.

Integrity and worker hardening refresh (2026-09-08):

- Migrations `155_memory_integrity_guards.sql`, `156_memory_integrity_guard_nullsafe.sql`, and
  `158_memory_checkpoint_integrity.sql` now validate every canonical fact update against its
  installation scope, freeze source evidence against UPDATE and ordinary DELETE, make checkpoint
  identity immutable, and reject impossible checkpoint status/timestamp transitions. Migration
  `157_memory_relation_scope_and_immutability.sql` constrains relation endpoints to one canonical
  scope and rejects relation updates. Source purge remains available only to the scoped
  `system:memory-deletion` actor; the null-safe guard prevents an unset transaction actor from
  passing the check.
- `MemoryCheckpointRepository` no longer mutates an existing source event on an idempotent replay;
  it verifies the full identity tuple and treats stale failure/block reports as no-ops once a
  checkpoint is committed. The capture and integrity fixtures pass against the live PostgreSQL
  schema.
- `MemorySourceEventRepository` now applies the same full-identity rule to replayed source events;
  a reused idempotency key, digest boundary, or run cursor cannot silently return an event whose
  scope, turn, type, channel, or sequence changed. The live capture fixture includes this
  regression case.
- Revision appends persist extractor relations in the same transaction as the revision. Relation
  targets resolve through source-event lineage, missing targets roll back the revision, and the
  revision fixture proves both persistence and atomic rollback. Canonical revision commits now
  enqueue FTS/vector/temporal projections atomically; an explicit memory policy can additionally
  enqueue a provider projection without colliding with rebuild keys.
- Projection, deletion, provider-deletion, and retention workers now expose bounded shutdown
  results. In-flight external calls can report `drained: false` without falsely completing work;
  lease expiry remains the successor-recovery fence. The projection worker test exercises the
  timeout path. The final database-enabled matrix passed 212 files / 1,174 tests with 31
  external-fixture tests intentionally skipped; the affected-memory hardening rerun passed
  6 files / 29 tests, including the full-identity replay regression and bounded worker shutdown.

Temporal shutdown hardening (2026-09-08):

- The Temporal worker now starts bounded shutdown for consolidation, projection, provider deletion,
  canonical deletion, and retention workers before awaiting audio shutdown. A provider or database
  call that does not return cannot hold process termination indefinitely; unfinished leases remain
  fenced for expiry and successor recovery.
- A single configured shutdown bound is applied consistently to every memory worker, and timeout
  events are logged with worker-specific bounded event names. The build passes and the six-file
  affected-memory matrix passes 29/29 tests.
- The full PostgreSQL-backed Agents matrix passes 212 files and 1,180 tests, with eight
  external-fixture files and 31 tests intentionally skipped. Staging, provider, production,
  rollback, and release-owner gates remain external release work.

Operator projection cutover hardening (2026-09-08):

- The retention projection no longer presents the legacy `memory_records` table as the memory
  readiness signal. It now reports canonical `agent_memory_facts` totals and revision lifecycle
  counts, while retaining the legacy count as an explicitly marked compatibility diagnostic for
  rollback investigation.
- The integration projection fixture verifies both the canonical dataset and the compatibility
  marker. The full PostgreSQL-backed matrix remains green at 212 files / 1,180 tests, and the
  release manifest was regenerated with the resulting artifact digests.

Runtime compatibility cleanup (2026-09-08):

- Operator `review_memory` and `delete_memory` now resolve canonical facts/revisions only. Review
  appends an immutable operator revalidation revision; delete enqueues the canonical fact into the
  durable deletion workflow. The old operator `memory_records` fallback and dependency were removed.
- The legacy v1 memory tool registrations were removed from the default activity tool registry;
  the revision-backed tool surface is now the only runtime memory tool surface. Knowledge-only
  preflight retrieval no longer constructs a legacy `MemoryRepository` in the activity path.
- The canonical revision compare-and-set guard now accepts `review_pending` and `quarantined`
  predecessors for operator revalidation while preserving active-only correction semantics.
- The operator integration fixture now creates, reviews, and queues deletion for canonical facts;
  the focused file passes 3/3 tests. The public `/v1/memory` compatibility API, legacy retention
  repository, migration/backfill reader, and historical schema remain explicit cleanup/cutover
  work rather than hidden runtime fallbacks.

Legacy retention writer removal (2026-09-08):

- The operator `apply_retention_policy` command no longer calls the legacy
  `RetentionRepository.applyMemoryRetention` writer. It now requests a scoped v2 maintenance
  scan through `MemoryRetentionRepository`, leaving expiration transitions to the leased retention
  worker and preserving legal-hold/retry semantics.
- Audio retention remains an immediate provider cleanup because it is not a memory-record
  transition. The legacy retention repository remains for policy and legal-hold administration,
  preview, and compatibility reads; its memory-record mutation path is no longer reachable from
  the operator command.

Broad deletion evidence fencing (2026-09-08):

- User, agent, workspace, and organization deletion now removes checkpoint rows before deleting
  their source events. This covers queued source evidence that has not produced a fact yet, so a
  checkpoint cannot retain a deleted event after the source row is purged.
- The organization deletion integration fixture now creates both a direct source event and a
  checkpoint-backed event, then verifies that both rows are removed. The focused deletion,
  agent-deletion, and integrity suite passes 7/7 tests.
- The implementation keeps the source-event immutability guard intact. Only the system deletion
  actor can perform this purge; ordinary source updates remain rejected.

Final local matrix refresh (2026-09-08):

- Applied migrations through `158_memory_checkpoint_integrity.sql` to the local Agents database.
- The complete DB-enabled Vitest matrix passed 213 files and 1,181 tests; 8 external-fixture files
  and 31 tests remain intentionally skipped because they require provider/staging resources. The
  migrated retention/legal-hold fixture now exercises canonical facts, immutable expiration, and
  the worker-side legal-hold fence; the operator result exposes the queued workspace count.
- `git diff --check` passes and the development Temporal worker was resumed after the isolated test
  run. No active disposable `operator-test-*` rows remain; append-only audit history is retained.

Local API/gateway/Temporal smoke refresh (2026-09-08):

- The E2E smoke harness now waits for both the REST and MCP durable runs to reach a terminal
  `completed` state before deleting the disposable installation. This prevents cleanup from
  racing a still-running MCP workflow and leaves no orphaned test runs.
- With the local signing key supplied on an isolated API/gateway pair, the smoke passed REST
  credential exchange, discovery, idempotency, durable execution, MCP gateway authentication,
  protocol initialization, and terminal completion for both runs. All disposable E2E definitions,
  installations, runs, facts, maintenance jobs, and deletion jobs were then removed through the
  authenticated agent-delete path.

Controlled full-matrix rerun (2026-09-08):

- A first verification attempt was invalid because the development Temporal worker was still
  polling the same PostgreSQL fixtures; two tests consequently raced stale `received` runs. The
  worker was stopped, the matrix was rerun with the worker quiesced, and both affected fixtures
  passed.
- The controlled DB-enabled matrix passed 213 files and 1,181 tests, with the same eight external
  fixture files and 31 tests intentionally skipped. The worker was restarted afterward for local
  manual testing. Disposable operator/lifecycle fixture resources were removed; completed
  deletion-job audit rows remain append-only evidence.

Consolidation ordering hardening (2026-09-08):

- Partition representatives and due-job selection now order by the source run's durable creation
  time and ID before job timestamps. Concurrent claimers therefore preserve trigger-run order even
  when PostgreSQL assigns identical job timestamps.
- The partition integration fixture passes 1/1 after the ordering change, and the full DB-enabled
  matrix passes 213 files / 1,181 tests with 31 external-fixture tests intentionally skipped.

Consolidation partition high-load refresh (2026-09-08):

- The partition fixture is parameterized for bounded contention runs. With
  `MEMORY_PARTITION_CONVERSATIONS=256` and `MEMORY_PARTITION_WORKERS=8`, three repeated runs
  completed two ordered claim waves with exactly one claim per conversation and no duplicate
  ownership.
- The claim transaction now uses a transaction-scoped advisory fence for the organization (or
  the global queue when no organization filter is supplied). This keeps the claim boundary
  deterministic while leaving claimed-job extraction concurrent after commit.
- This strengthens local contention evidence only; production-scale throughput, latency,
  capacity, and staging monitoring remain release gates.

Latest local verification refresh (2026-09-08):

- After the broad deletion fencing and legacy retention-writer removal, the controlled
  DB-enabled Vitest matrix passed 212 files and 1,179 tests. Eight external-fixture files with
  31 tests remain intentionally skipped because they require provider or staging resources.
- The focused deletion, agent-deletion, integrity, and retention repository run passed 8/8.
  Agents and MCP builds, release-manifest verification, and `git diff --check` also pass.
- The worker was restarted after the matrix for manual testing and both Temporal and gateway
  health services report ready. The local memory tables remain empty apart from one append-only
  deletion audit row.

Organization-partitioned worker scheduling (2026-09-08):

- The global consolidation worker now discovers due organizations and fans claims out through
  organization-scoped transactions. Production scheduling therefore avoids a single global
  claim fence while retaining a defensive global path for injected/test repositories that do not
  expose organization discovery.
- Worker and partition tests pass after the change; staging capacity, queue-age, and dead-letter
  monitoring remain release gates.

Legacy consolidation worker retirement (2026-09-08):

- Removed the unused `MemoryConsolidationWorker` implementation and its legacy candidate-writing
  tests. The production worker and integration coverage now use
  `MemoryRevisionConsolidationWorker`, which writes only immutable v2 facts/revisions and never
  targets `memory_records`.
- The v2 worker-loss, lease-fencing, partition, retry, and PostgreSQL consolidation fixtures pass;
  legacy API/migration readers remain separate cutover work and are not used by the worker.

Organization deletion evidence purge (2026-09-08):

- Organization-scoped memory deletion now purges immutable `memory_source_events` inside the
  system-owned deletion transaction, preventing queued extraction from resurrecting deleted
  evidence after canonical facts are removed.
- The PostgreSQL deletion fixture now creates source evidence and verifies the organization target
  removes it; the focused deletion and integrity suite passes 6/6 tests.
