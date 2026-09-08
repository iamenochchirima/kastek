---
id: agent-memory-architecture-implementation-checklist
title: Agent memory architecture implementation checklist
sidebar_label: Memory architecture · checklist
slug: /memory-architecture-checklist
description: End-to-end execution checklist for the Agent Memory Architecture and Implementation Plan.
---

# Agent memory architecture implementation checklist

**Status:** Non-Studio backend M0-M6 implementation and integrity hardening complete locally; release/cutover gates remain

**Plan:** [`AGENT_MEMORY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`](../agents/AGENT_MEMORY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md)

**Owner:** Agent Platform

**Last updated:** 2026-09-08

**Risk:** High

**Checklist progress (2026-09-08):** 137 complete, 28 partial, 19 pending (184 tracked items); strict
completion 74.5%, weighted completion 81.8%. Partial and pending items are reviewer sign-off,
cutover/release evidence, provider/staging conformance, and the explicitly deferred P14 Studio UI. The
provider-aware agent deletion transition is implemented and covered by the v2 deletion fixture.
Excluding the eight explicitly deferred P14 Studio UI items, the memory/runtime implementation is
137 complete, 28 partial, and 11 pending out of 176 tracked items: 77.8% strict and 85.8% weighted.

Current implementation evidence is recorded in [`AGENT_MEMORY_ARCHITECTURE_PHASE_LOG.md`](./AGENT_MEMORY_ARCHITECTURE_PHASE_LOG.md).

This is the execution record for the M0-M6 memory architecture plan. Mark an item complete only
when the implementation, focused automated coverage, and required evidence exist. A checkbox is
not complete because code compiles or because a route responds once.

Status markers:

- `[x]` complete with evidence recorded;
- `[~]` implemented in part, with the remaining work named immediately after the item;
- `[ ]` pending.

## How to use this checklist

1. Start with the phase's reference refresh before reading or changing code.
2. Record the reference revision, files read, decisions made, and open questions in the phase log.
3. Implement one coherent chunk behind the contract for that phase.
4. Run the phase's deterministic tests and failure tests.
5. Run the manual proof against the real local stack where the phase requires it.
6. Record commit SHA, migrations, test commands, and evidence links before ticking the exit gate.
7. Do not begin the next dependent phase while its predecessor's exit gate is unchecked.

If an implementation decision diverges from Hermes, Waku, or this plan, stop and record the reason,
the alternative considered, the changed invariant, and the new test that protects the decision.

## Reference refresh protocol

The implementing agent must refresh the relevant primary sources at the start of every phase and
again when the phase changes a lifecycle, interface, failure mode, or scope rule. The references
are not decorative background reading. They are review checkpoints.

### Hermes references

Read the relevant sections directly from the checkout at
`/home/enoch/aworkspace/agents/hermes-agent`:

- `agent/memory_provider.py` — provider interface, prefetch, sync, session hooks, checkpoint API;
- `agent/memory_manager.py` — provider failure isolation, timeouts, serialized worker, fencing;
- `hermes_state_compression.py` and `agent/conversation_compression.py` — leases, atomic child
  publication, checkpoint and compaction failure behaviour;
- `tools/memory_tool_store.py` and `tools/memory_tool.py` — bounded curated memory, atomic writes,
  drift protection, threat scanning, consolidation failure cap;
- `website/docs/user-guide/features/memory.md` — frozen prompt snapshot, session search, capacity,
  write approval, and user-visible semantics;
- `plugins/memory/hindsight/__init__.py` — accepted versus searchable state, queued writes,
  provider visibility, session rotation, and bounded shutdown.

### Waku references

Read the relevant sections directly from the checkout at
`/home/enoch/aworkspace/agents/waku-agent`:

- `waku/memory/__init__.py` — four-pillar vocabulary, retrieval and consolidation wiring;
- `waku/runtime/session.py` — working-memory window and prompt assembly;
- `waku/memory/retrieval_gate.py` — cheap retrieval gate and fail-open rule;
- `waku/memory/consolidation.py` — batch threshold, exact source-row marking, failure preservation;
- `waku/memory/semantic/base.py` — backend interface and `settle` contract;
- `evals/deterministic/test_fact_store_conformance.py` — backend conformance testing;
- `waku/memory/semantic/zep_store.py` — temporal corrections and asynchronous visibility;
- `waku/tools/memory_admin.py` — explicit correction and deletion workflow.

### KasiTek references

Before touching the matching KasiTek module, read:

- `docs/plans/agents/HERMES_WAKU_MEMORY_RESEARCH.md` — consolidated findings and target architecture;
- [`AGENT_MEMORY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md`](../agents/AGENT_MEMORY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md)
  — authoritative M0-M6 contracts and exit gates;
- `agents/src/memory/lifecycle.ts` — current policy and write lifecycle;
- `agents/src/memory/retrieval.ts` — current retrieval decision and hybrid search;
- `agents/src/db/repositories/memory-repository.ts` — current scope, safety, conflict, and state
  enforcement;
- `agents/src/memory/consolidation-worker.ts` — current durable extraction worker;
- `agents/src/runtime/context-compaction.ts` and `agents/src/runtime/context-engine.ts` — current
  compaction and context seams;
- `agents/src/journal/` and `agents/src/runtime/runtime-telemetry.ts` — event and observability
  contracts used by Studio;
- `docs/internal/operations/release-process.md` — release evidence required for every phase that
  changes data, workers, APIs, or the Studio.

### Reference checkpoint template

Copy this block into the phase log before implementation:

```text
Reference checkpoint:
- Phase:
- Hermes revision/files read:
- Waku revision/files read:
- KasiTek files/contracts read:
- Invariants carried forward:
- Behaviour intentionally not copied:
- New decision or divergence:
- Test added to protect it:
- Reviewer:
```

## Phase 0: preparation and ownership

- [x] Confirm the canonical plan and this checklist are the only active memory implementation
      authority; link older memory plans as references or mark them superseded.
- [x] Assign owners for runtime, database/migrations, Temporal workers, provider adapters, Studio,
      Security/Privacy, Operations, and release approval.
- [x] Create a phase log location for reference checkpoints, evidence, and unresolved decisions.
- [x] Record the baseline commit SHAs for KasiTek, Hermes, and Waku used for this implementation.
- [x] Record current memory counts, states, namespaces, embeddings, queued consolidation jobs,
      retention jobs, deletion jobs, and retrieval latency before migration.
- [x] Capture baseline fixtures for explicit memory, inferred memory, imported memory, knowledge,
      summaries, compaction, correction, deletion, and cross-tenant reads.
- [x] Confirm the rollout environments, agent-version flag strategy, operator kill switches, and
      rollback owner before writing migrations.
- [x] Complete the release record skeleton: owner, risk, affected services, migration, rollout,
      analytics, logs, docs, validation, rollback, and post-release review date.

**Reference refresh:** Read the full research note, the canonical memory plan, Hermes provider
manager, Hermes checkpoint contract, Waku memory facade, and current KasiTek lifecycle/repository.

**Exit evidence:** Baseline report, reference checkpoint, named owners, fixture inventory, and
release record skeleton committed with the first implementation change.

## M0: memory contract and scope freeze

### Domain vocabulary and types

- [x] Define `working`, `episodic`, `semantic`, `procedural`, and `knowledge` as distinct memory
      classes in the shared Agent Platform contract.
- [x] Define `observed`, `candidate`, `review_pending`, `quarantined`, `active`, `superseded`,
      `expired`, `rejected`, and `deleted` states.
- [x] Define every allowed state transition and the expected-version/concurrency rule.
- [x] Define the scope tuple: organization, workspace, agent definition, agent version, installation,
      conversation, end user, and namespace.
- [x] Define namespace semantics and default read/write policy for conversation, end-user-private,
      workspace-shared, agent-private, procedural, and knowledge data.
- [x] Define `fact_key` as stable scope + namespace + subject + predicate. Do not include value.
- [x] Define semantic validity fields: `valid_from`, `valid_to`, `observed_at`, `recorded_at`.
- [x] Define provenance fields: source event IDs, source run, actor, channel, extractor version,
      source trust, confidence, sensitivity, and redaction class.
- [x] Define relation types: `supports`, `contradicts`, `supersedes`, `derived_from`, and `about`.
- [x] Define readiness states and timestamps for accepted, committed, indexed, and visible.
- [x] Define the redacted evidence envelope used by model context and the journal.
- [x] Define the difference between a summary, episode, semantic claim, procedure, and knowledge
      chunk in code and documentation.

### Contract tests and enforcement

- [x] Add type-level contract tests for every domain record and transition.
- [x] Add invalid-scope tests for missing, mismatched, and cross-tenant identifiers.
- [x] Add tests proving pending, quarantined, rejected, superseded, expired, and deleted records
      cannot be returned by the retrieval repository.
- [x] Add tests proving procedural memory cannot be created through factual extraction.
- [x] Add tests proving a stale expected version cannot win a concurrent transition.
- [x] Add redaction tests proving credentials, tokens, and unnecessary message bodies never enter
      telemetry or deletion receipts.
- [x] Add provider contract fixtures for local, delayed, failed, and unavailable adapters.
- [x] Record the M0 reference checkpoint and reviewer approval in the phase log (automated Agent
      Platform review; external release approval remains a release gate).

**M0 exit gate:** A caller can determine ownership, scope, lifecycle, provenance, readiness, and
evidence without reading a storage implementation. Contract tests pass.

**M0 status:** `[~]` Contract vocabulary, scope validation, state transitions, stable fact keys,
evidence envelopes, redaction tests, provider failure fixtures, procedural separation, and stale
version tests are implemented. The recorded reviewer approval remains open.

## M1: durable capture and compaction checkpoint

### Journal and capture

- [x] Identify the single journal seam that receives inbound messages, assistant output, tool
      results, approvals, channel delivery, and memory commands.
- [x] Add memory event types without creating a second transcript source of truth.
- [x] Add source-run ID, evidence digest, extraction version, and idempotency key to each capture
      boundary.
- [x] Persist organization, workspace, agent, version, installation, conversation, end user,
      namespace, channel, and redaction decisions with every event.
- [x] Preserve tool/effect evidence separately from summaries so a replay cannot repeat an effect;
      direct checkpoints admit only user/assistant conversational evidence while journal and effect
      receipts remain the authoritative tool/effect record. Boundary and journal conformance tests
      prove the separation; end-to-end worker crash proof remains a release/integration gate.
- [x] Add event ordering and cursor replay tests.

### Compaction checkpoint

- [x] Define normalized direct evidence for a checkpoint: user/assistant evidence, source IDs,
      timestamps, and scope.
- [x] Exclude system scaffolding, tool payloads that are already durable, and previous summaries
      from the direct-evidence checkpoint.
- [x] Add a digest-keyed, idempotent checkpoint operation.
- [x] Add a configuration that fails compaction closed when a required checkpoint cannot commit.
- [x] Preserve the uncompressed transcript when the checkpoint fails.
- [x] Ensure new messages arriving during compaction are included in the correct evidence range;
      deterministic overlap coverage, live journal admission while summary runs, one-run-sequence
      admission fencing (migration 151), and a real child-process `SIGKILL` after journal commit
      but before the memory observer are proven by the PostgreSQL capture fixture.
- [x] Emit checkpoint completed, failed, blocked, and retried events.

### Verification

- [~] Worker-loss replay is proven after durable compaction commit, after a memory checkpoint and
      before context projection, and for leased consolidation work; source cursor conflicts are
      fenced and tested. The local Temporal worker-loss matrix (9 scenarios), PostgreSQL-backed
      compaction recovery (before/after persist), child-process journal admission kill proof, and
      child-process consolidation kill/reclaim proof now pass; reviewer sign-off remains open.
- [x] Retry capture with the same event and verify one canonical event.
- [x] Start compaction while a new message arrives and verify neither evidence range is lost.
      The local PostgreSQL capture fixture commits the pre-compaction range, injects a new message
      while summary generation is running, then commits the larger successor range without
      overwriting the first checkpoint.
- [x] Retry the same checkpoint digest and verify no duplicate archive or candidate source.
- [x] Verify tool/effect receipts remain available after context compaction.
- [~] Record the M1 reference checkpoint and reviewer approval. The checkpoint evidence is recorded
      in the phase log: migrations 130/139/151, journal source capture, compaction checkpoint
      fencing, concurrent-arrival coverage, and the child-process event-admission and consolidation
      kill/reclaim fixtures are verified; reviewer sign-off remains open.

**M1 exit gate:** Every memory-relevant source event is durable before extraction or compaction can
discard the working projection.

**M1 status:** `[~]` Source-event/checkpoint migrations, idempotent repository, redacted runtime
adapter, journal events, enforced pre-compaction capture, concurrent checkpoint/source-event
integration coverage, concurrent-arrival range coverage, and compaction worker-loss replay are
implemented and wired. Exact event-admission and consolidation kill/reclaim proofs pass; reviewer
approval remains open.

## M2: semantic and episodic revisions

### Canonical storage

- [x] Add canonical semantic revision storage with stable fact key, typed value, validity interval,
      status, confidence, sensitivity, provenance, version, and timestamps.
- [x] Add canonical episodic storage with event time, summary, participants, outcome, source refs,
      confidence, and historical query metadata.
- [x] Add relation storage and indexes for support, contradiction, supersession, derivation, and
      subject/entity links.
- [x] Add durable projection records for FTS, vector, temporal, and provider readiness.
- [x] Add tenant/workspace/agent/version/installation/namespace indexes and database policies.

### Commands and migration mapping

- [x] Route explicit remember through the canonical domain module.
- [x] Add explicit correct, forget, approve, reject, revalidate, and inspect commands.
- [x] Convert existing active records to immutable active revisions with legacy provenance.
- [x] Convert review-pending and quarantined records into candidates without activating them.
- [x] Preserve supersession lineage and original IDs during backfill.
- [x] Keep conversation summaries as context summaries; do not promote them automatically.
- [x] Keep procedural memory and knowledge grounding on separate interfaces.
- [x] Add migration checksums and a per-record migration receipt.

### Verification

- [x] Replace one preference with a new value and verify one stable fact key with two revisions in
      `memory-revisions.integration.test.ts`.
- [x] Ask for the current value and the historical value and verify different retrieval predicates
      through revision resolution and planner validity tests.
- [x] Run concurrent corrections and verify one conflict requires review. The command-service
      compare-and-set test proves one winner remains active and the losing correction is persisted
      as review-pending evidence linked to the observed winner.
- [x] Verify duplicate explicit writes/revision appends are idempotent in the revision integration
      fixture and command fingerprint tests.
- [x] Verify user-private, conversation, agent-private, and workspace-shared reads through the
      planner scope matrix and the runtime end-user-private adapter test; mismatched tenant,
      conversation, user, and installation scopes return no evidence.
- [x] Verify procedural extraction is rejected and explicit procedural publication is versioned.
      Consolidation rejects procedural candidates before writes, while the skill repository keeps
      immutable published skill versions and the integration fixture proves version increments.
- [~] Record the M2 reference checkpoint and reviewer approval. The phase log records immutable
      revisions, stable fact identity, correction/CAS conflict handling, scope enforcement, and
      migration 131/133/141/142/155/156/157/158 evidence; reviewer sign-off and live cutover evidence remain open.

**M2 exit gate:** Current truth, historical truth, correction lineage, and supporting evidence are
deterministic and scoped.

**M2 status:** `[~]` Additive revision schema, immutable repository, stable identity, explicit v2
command path, correction/forget/review/revalidation commands, relation storage, migration receipts,
semantic/episodic contract tests, current/history resolution, duplicate-write and stale-CAS
integration coverage, concurrent conflict review semantics, scope matrix, procedural extraction
rejection/publication versioning, and rebuildable FTS/vector/temporal projection records are
implemented. Scope mutation guards, immutable source evidence, atomic extractor-relation persistence,
and canonical projection enqueueing are now covered by the local integrity/revision fixtures. Live
migration evidence and reviewer approval remain open.

## M3: durable consolidation worker

### Job model

- [x] Add or replace consolidation jobs with source run, extraction version, evidence digest,
      lease owner, lease expiry, attempt count, next attempt, terminal reason, and dead-letter state.
- [x] Add an idempotent, leased outbox for projection work. Canonical revision commits now enqueue
      internal projections atomically and accept an explicit policy-owned provider projection without
      competing with rebuild idempotency keys.
- [~] Partition work by installation or memory key so ordering is preserved without one global
      worker bottleneck; leasing now fences by organization + installation + conversation, with
      migration 152 indexing that ownership tuple. The bounded PostgreSQL fixture claims 32
      conversations across four workers and 256 conversations across eight workers in two ordered
      waves with no duplicate conversation claim; the obsolete legacy consolidation worker was
      removed, leaving the revision-backed worker as the only production consolidation path;
      production-scale throughput/load proof remains open.
- [x] Add thresholded batch extraction and forced session-end/pre-compaction flushes.
- [x] Select a bounded evidence window with exact source event IDs.
- [x] Run deterministic filtering and poisoning checks before model extraction.
- [x] Require structured extraction output for type, fact key, value, evidence, confidence,
      sensitivity, retention suggestion, and relations.
- [x] Keep inferred and imported candidates review pending by default.
- [x] Persist parser, extraction-version, and bounded extractor metadata, including the selected
      provider/model route when available.
- [x] Make retries upsert by source run + extraction version + digest.

### Verification

- [x] Model timeout preserves source events and makes the job retryable. The canonical worker
      bounds extractor execution and records `MEMORY_CONSOLIDATION_EXTRACTOR_TIMEOUT` before
      requeueing the leased job.
- [x] Malformed output creates a bounded `MEMORY_CONSOLIDATION_EXTRACTOR_OUTPUT_INVALID` retry,
      never silent success or a partial candidate write.
- [x] Worker lease expiry allows one successor and prevents duplicate candidates. The queue
      uses an expired-lease successor claim, fences the old owner, and the integration test
      verifies replayed evidence yields one canonical revision per evidence digest.
- [x] Messages arriving during extraction remain eligible for a later job. Journal/message insertion
      enqueues the later trigger run independently; the integration test appends during extraction
      and verifies the successor job remains queued for the next worker pass.
- [x] Replaying the same evidence digest creates no duplicate candidate or revision. Revision
      idempotency is keyed by the digest rather than the triggering run, so repeated threshold
      jobs over one evidence window remain deduplicated.
- [x] Dead-letter jobs can be inspected and safely reprocessed.
- [x] Shutdown drains within a bound and records abandoned work. The canonical worker exposes a
      bounded shutdown; timed-out consolidation leases are requeued with abandonment count, owner,
      reason, and retry metadata, while projection, deletion, provider-deletion, and retention
      workers now return a bounded `drained` result and leave unfinished leases fenced for expiry.
- [x] Represent external provider acceptance, indexing, visibility, and deletion separately from canonical commit.
- [~] Record the M3 reference checkpoint and reviewer approval. The phase log records leased
      consolidation, evidence digests, projection/provider receipts, partition fencing, worker
      recovery, and migration 143/144/152 evidence; reviewer sign-off and production load proof
      remain open.

**M3 exit gate:** Extraction failure, retry, worker loss, and provider lag never lose evidence or
create duplicate durable memory.

**M3 status:** `[~]` The v2 consolidation worker now uses bounded evidence, deterministic poisoning
      checks, structured candidate output, review-pending immutable revisions, stable value-independent
      facts, idempotent revision writes, evidence-window metadata, forced pre-compaction flushes,
      provider/model metadata, and dead-letter requeue semantics. Projection outbox/readiness records,
      provider receipts, policy-driven provider enqueueing, and bounded shutdown seams are implemented. Production throughput/
      load proof and the M3 reviewer checkpoint remain open; lease-expiry,
      replay, extractor-timeout, and bounded-shutdown recovery now have unit and local Postgres
      evidence. Studio observability remains intentionally excluded from this implementation pass.

## M4: typed retrieval planner and evidence pack

### Planner and retrieval seam

- [x] Define the typed retrieval plan: decision, query, scopes, memory types, freshness, result
      limit, token budget, reason, and planner revision.
- [x] Add deterministic no-memory prefilter for obvious self-contained prompts.
- [x] Add a measured small-model gate for ambiguous prompts.
- [x] Define the safe fallback when the gate or search provider fails.
- [x] Fail closed on scope, authorization, and policy errors.
- [x] Route automatic retrieval and `memory_search` through one typed planner interface, including
      explicit namespace allow-lists. Automatic runtime retrieval uses the v2 runtime port and
      `memory_search` uses the same `buildRetrievalPlan`/`rankEvidencePack` contract; both paths
      pass the scoped namespace allow-list before repository search. Studio previews will consume
      the same seam when their P14 surfaces are implemented.
- [x] Apply scope and lifecycle filters before ranking or prompt rendering.
- [x] Run lexical and vector search through the same scoped repository plan; lexical search reads
      the tenant-scoped FTS projection and vector search shares the same scope filters. A second
      scoped branch now fans out fact-key/entity/temporal candidates in parallel and merges by
      revision ID with measured branch coverage in `memory-retrieval-fanout.test.ts`.
- [x] Merge by revision ID and resolve supersession, validity, and contradictions; current-fact
      ranking merges by stable `fact_key`, while scoped SQL excludes superseded and open-conflict
      revisions. Historical relation fan-out and explicit contradiction explanation are carried as
      content-free related revision IDs and relation types in the evidence contract.
- [x] Add source diversity, confidence, trust, freshness, and token-budget ranking.
- [x] Return evidence IDs, scores, provenance, validity, confidence, and exclusion reasons.
- [x] Fence factual memory as untrusted evidence; load procedural instructions separately.
- [x] Record planner, selected evidence, rejected reasons, latency, gate metadata, and token
      metrics without raw sensitive text.

### Verification

- [x] Implicit “what do you know?” and historical questions retrieve correctly through the typed
      gate/planner and historical validity tests.
- [x] No-evidence requests do not fabricate grounding.
- [x] Direct tool retrieval matches automatic retrieval scope and lifecycle semantics through the
      shared runtime retrieval port and planner contract tests.
- [x] Current and superseded revisions resolve correctly.
- [x] Cross-tenant, cross-installation, and cross-user retrieval attacks return no evidence through
      scope filtering tests and repository predicates.
- [x] Poisoned evidence is excluded and observable through lifecycle filtering and diagnostics.
- [x] Gate failure uses bounded fallback; authorization failure blocks.
- [x] Token and result caps are enforced before model context assembly.
- [~] Record the M4 reference checkpoint and reviewer approval. The phase log records typed
      retrieval planning, policy gates, direct-tool parity, evidence IDs, projection readiness,
      and retrieval analytics evidence; reviewer sign-off and provider/staging conformance remain
      open.

**M4 exit gate:** Every model-facing memory item has a stable ID, scope, provenance, validity, score,
and reason for selection.

**M4 status:** `[~]` Typed planner, deterministic ranking/token budget, deterministic self-contained
      prefilter, bounded small-model gate, v2 revision repository, runtime adapter, preflight-plus-loop
      retrieval seam, direct memory command search, scope/lifecycle/version filtering, evidence IDs,
      diagnostics, source-diversity ranking, structured/entity/temporal fan-out, scoped historical
      relation hydration, content-free contradiction explanations, and safe provider-failure handling
      are implemented. Rebuildable FTS/vector/temporal projection workers and readiness state are
      implemented; Studio preview and full legacy-path removal remain open.

## M5: retention, decay, conflict, and deletion

### Retention and quality

- [x] Add organization, workspace, namespace, type, and record-level retention evaluation.
- [x] Mark records expired without pretending they have been physically purged.
- [x] Add usage, confirmation, correction, rejection, and helpfulness events.
- [x] Use decay only for ranking and revalidation priority unless an explicit retention policy acts.
- [x] Add stale-memory and revalidation queues.
- [x] Add fact-key, entity-overlap, validity-overlap, and explicit-correction conflict detection.

### Deletion workflow

- [x] Route user, conversation, agent, workspace, and organization deletion through one workflow.
- [x] Add deletion job lease, retries, legal-hold state, target selector, and redacted receipt.
- [x] Purge canonical revisions and candidates according to the deletion request.
- [x] Purge FTS, vector, temporal, graph, cache, and provider projections.
- [x] Distinguish requested, held, canonical-purged, projections-purged, provider-confirmed, and
      completed.
- [x] Prevent deleted content from entering logs, metrics, dead-letter payloads, or receipts.
- [x] Add an operator query for deletion lag and residual projection failures.

### Verification

- [x] Expired records are excluded from retrieval immediately.
- [x] Deletion completes across all projections and provider adapters; the canonical purge now
      verifies that no local revision, FTS, temporal, vector, outbox, readiness, provider-receipt,
      relation, or source row remains, and the local PostgreSQL fake-provider run verifies timeout,
      retry, confirmation, and completion fencing.
- [x] Provider deletion timeout is retryable and visible; fake-adapter coverage preserves the
      operation ID across retries and keeps the parent in `provider_pending` until confirmation.
- [x] Legal hold blocks physical purge while respecting retrieval policy; unit and PostgreSQL
      integration coverage verify release-and-resume behavior.
- [x] Partial purge resumes safely without deleting unrelated records; retry-target isolation and
      the end-to-end deletion fixture cover this path.
- [x] No supported read path returns deleted content after completion; residual verification checks
      canonical, local projection, relation, source, and provider-receipt tables before completion.
      Source evidence updates are rejected at the database boundary and only the deletion actor may
      purge it; fact scope validation now runs on every update.
- [~] Record the M5 reference checkpoint and reviewer approval. The phase log records retention,
      conflict, legal-hold, canonical purge, residual checks, provider confirmation, and deletion
      analytics evidence; provider acknowledgement conformance is now enforced locally by the
      projection worker, while reviewer sign-off and provider-specific/staging conformance remain
      open.

**M5 exit gate:** Forgetting has a durable, observable completion state and no residual searchable
copy remains after completion.

**M5 status:** `[~]` Retention rules, immutable expiration revisions, append-only quality events,
decay/revalidation prioritisation, durable stale queues, conflict detection, canonical purge, and
provider deletion queuing are implemented by `137`-`143` migrations plus the retention, deletion,
      projection, and provider-deletion workers. Canonical purge now verifies residual local projection
      absence transactionally; parent deletion completion is fenced on every provider child, and the
      provider worker preserves idempotency across timeout retries. Executable unit and PostgreSQL
      coverage is in `memory-v2-deletion.integration.test.ts`; local provider acknowledgement
      conformance is covered by the projection worker and contract tests, while provider-specific,
      staging, and reviewer approval remain release gates.

## M6: Studio event contract and handoff to the runtime observatory

Visual implementation plan: [`Studio runtime observatory and promotion update`](./AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md).

### Event-backed graph

- [x] Define memory graph node and edge projections from journal events and revision relations.
- [x] Add run view nodes for capture, working context, checkpoint, extraction, policy, revision,
      projection, retrieval, evidence, retention, and deletion.
- [x] Add memory view lineage from source event through candidate, approval, revision, retrieval,
      supersession, retention, and purge.
- [x] Do not render stages that did not occur.
- [x] Represent accepted, committed, indexing, visible, blocked, failed, and retrying states from
      durable data.
- [x] Add cursor replay and reconnect from the journal, not browser polling inference.
- [x] Add fixture event streams for capture, compaction, extraction, review, conflict, projection
      lag, retrieval, retry, retention, and deletion.
- [x] Verify the event stream contains enough information to render the current Studio shell later
      without introducing browser-derived state.

### Studio implementation, not part of this memory rollout

- [ ] **Studio plan:** Render the two-pane Studio Playground layout from the memory and runtime projections.
- [ ] **Studio plan:** Keep the graph primary, with collapsed timeline and selected-node
      inspector.
- [ ] **Studio plan:** Show scope, state, timestamps, retries, evidence IDs, policy decisions,
      readiness, and bounded error codes.
- [ ] **Studio plan:** Redact raw content and secrets according to operator permissions.
- [ ] **Studio plan:** Add run and revision selectors without changing runtime state.
- [ ] **Studio plan:** Expose review, correction, retry, revalidate, and delete controls only
      for tested backend transitions.
- [ ] **Studio plan:** Show provider accepted/indexed/visible status separately.
- [ ] **Studio plan:** Verify desktop, tablet, and keyboard-only behaviour.

### Verification

- [x] Reconnect during extraction and recover the same event cursor from the backend.
- [x] Replay worker failure, retry, projection lag, conflict, compaction, and deletion hold from
      fixture events without a browser-generated state.
- [x] Confirm the future inspector projection cannot cross tenant, workspace, installation, or user
      scope.
- [x] Confirm the event contract does not require browser-generated counts, statuses, latency, or
      readiness values.
- [~] Record the M6 reference checkpoint and reviewer approval; automated contract review is recorded,
      external release approval remains a gate.

**M6 exit gate:** The backend exposes a complete, scoped, replayable memory event stream and
revision lineage. The visual Studio expansion is explicitly tracked under P14 and does not block
the memory rollout.

**M6 status:** `[~]` The content-free run and revision lineage projections, cursor-backed PostgreSQL
read model, scoped readiness/status mapping, and failure/retry fixture streams are implemented in
`agents/src/memory/observatory.ts` and `agents/test/memory-observatory.test.ts`. The visual Studio
canvas, timeline, inspector, and responsive checks remain explicitly deferred to P14; reviewer and
external release approval remain open.

## Migration and cutover checklist

- [~] Create and checksum a guarded Agents database backup before the cutover backfill, and record
      its ID. Local evidence: `agents-20260908T033234Z` was created with PostgreSQL 18 client
      support and restored into a disposable database; the production/staging pre-backfill backup
      remains a release gate. A fresh disposable drill (`agents-20260908T055006Z`) also passed
      through the hardened scripts, selected the matching PostgreSQL 18 restore client, and
      restored 146 migration rows before cleanup.
- [~] Apply additive schema migrations in an isolated environment. Local PostgreSQL has applied
      migrations through `158`; staging isolation and release evidence remain open.
- [~] Run backfill in dry-run mode and compare counts by organization, workspace, agent, namespace,
      state, type, and sensitivity. The backfill report now emits source and canonical target
      dimension counts, and the local fixture verifies all seven dimensions plus receipts; the full
      legacy dataset comparison remains a cutover gate.
- [~] Verify every legacy record has a migration receipt and preserved provenance. The scoped
      backfill fixture proves receipts/checksums/provenance and explicit skip reasons; production
      backfill evidence remains open.
- [~] Rebuild FTS/vector/temporal projections from canonical revisions. Projection workers and
      rebuildable schemas are tested locally; `memory-backfill.integration.test.ts` drains a real
      six-task rebuild and verifies all readiness rows become visible. The complete backfill
      rebuild remains a cutover gate.
- [~] Compare old and new retrieval results for the approved fixture set. The local backfill
      fixture proves parity for a migrated semantic fact; the approved full fixture set remains
      open.
- [x] Add a combined agent-delete fixture with v2 source events, checkpoints, canonical facts,
      and provider receipts before routing `AgentRepository.deleteAgent` through the deletion job.
      `agent-deletion-v2.integration.test.ts` proves archive/disable, v2 purge, provider confirmation,
      and final agent resource removal.
- [~] Enable new explicit writes for one non-production organization. The scoped
      `memory_v2_writes_enabled` operator flag and runtime/MCP enforcement are implemented; the
      local rollout fixture proves organization isolation and installation precedence, and the
      PostgreSQL durable-activity fixture now proves disabled rejection, approval, and a real v2
      revision write after enablement. Staging evidence remains open.
- [~] Enable new retrieval for one agent version with automatic promotion disabled. The scoped
      `memory_v2_retrieval_enabled` operator flag gates automatic and direct retrieval; the local
      rollout fixture proves installation canary precedence, and the PostgreSQL durable-activity
      fixture now proves disabled rejection and a real empty evidence response after enablement.
      Staging evidence remains open.
- [~] Enable consolidation workers with a bounded queue and dead-letter monitoring. The scoped
      `memory_consolidation_enabled` flag, lease release path, and worker recovery tests are in
      place; the local rollout fixture proves a disabled organization releases a claimed job
      without consuming an attempt. The global worker discovers due organizations and fans claims
      out through organization-scoped transactions, while bounded-queue monitoring evidence
      remains open.
- [~] Enable projections independently during cutover. The scoped `memory_projection_enabled`
      flag and lease release path are implemented; the local backfill fixture pauses all six
      projection tasks, preserves accepted readiness, resumes them after the flag is enabled, and
      reaches visible state. Canonical writes also enqueue provider work only when an explicit memory
      policy names a provider. Staging provider/queue monitoring evidence remains open.
- [~] Run the full isolation, retry, deletion, and compaction checkpoint matrix. The local
      PostgreSQL memory/context matrix collected 36 files in the latest targeted run (25 passed,
      11 intentionally skipped; 127 tests passed and 33 skipped), and the DB-enabled repository
      baseline DB-enabled suite passes 213 files and 1,181 tests; the final hardening rerun passes
      six affected memory integration files (29 tests); the Temporal-enabled local REST/MCP smoke also
      passes credential exchange, discovery, idempotency, gateway auth, and durable execution. A
      temporary restricted runtime login also passed the four RLS integration files (14 assertions)
      before being removed. Provider, staging, and production evidence remain open.
- [x] Keep controlled autonomous promotion disabled for inferred and imported memory until review
      and quality gates exist. `automatic` mode changes proposal timing only; consolidation and
      lifecycle tests prove it never silently activates an inferred or imported revision.
- [ ] Freeze all legacy writers before production cutover.
- [~] Route all runtime, tool, retention, and deletion paths to the new domain. Runtime tools,
      automatic retrieval, operator review/delete, retention workers, and canonical deletion use
      v2; the operator retention writer now only requests a v2 maintenance scan. The public
      `/v1/memory` compatibility surface, retention policy/legal-hold administration, and
      migration/backfill inputs remain explicit cleanup/cutover surfaces.
- [~] Verify rollback can disable the new paths without destructive schema rollback. The runtime
      now has `MEMORY_V2_ENABLED=false`, which removes v2 checkpoint/source-capture/retrieval/tool
      wiring and prevents v2 consolidation, projection, deletion, provider-deletion, and
      retention workers from starting while retaining additive tables and compatibility readers;
      a staging rollback drill and release-owner approval remain open.
- [ ] Soak the new path for the agreed review window.
- [ ] Remove legacy writers and compatibility adapters only after rollback no longer depends on them.
- [ ] Retain migration evidence until the release owner approves old-schema removal.

## Release and operational closure checklist

- [~] Record platform release ID, commit SHA, migration versions, worker artifact, agent version,
      feature-flag configuration, and provider configuration revision. The pre-release record is
      captured in `docs/plans/active/AGENT_MEMORY_ARCHITECTURE_RELEASE_RECORD.md`, including the
      current base SHA, migrations through 158, registry checksum, flags, validation evidence, and
      explicit `not assigned`/`not applicable` decisions. The local manifest is verified with
      `pnpm --dir agents release:memory:verify`; a clean tagged artifact and staging provider
      configuration remain open.
- [~] Register and validate analytics events for capture, candidate, review, retrieval, projection,
      conflict, deletion, and checkpoint outcomes. Versioned aggregate-safe contracts, registry
      bindings (including deletion v2), producer builders, enqueue helpers, and redaction tests are implemented. Runtime
      lifecycle, retrieval, projection, and checkpoint enqueue paths are wired behind scoped
      transactions, including direct-tool retrieval parity. Canonical and provider deletion workers
      now emit requested, purge, hold, retry, provider-confirmed, completion, and failure outcomes
      after resolving an installation scope or an explicit organization aggregate; dashboard/alert
      validation, exporter inspection, and release evidence remain open.
- [~] Add structured logs with service, environment, release, correlation ID, scope-safe IDs, and
      bounded error codes. Existing worker/provider/runtime boundaries use the shared structured
      logger and bounded error vocabulary; durable backend routing and release-identity evidence
      remain open.
- [~] Confirm logs and analytics contain no credentials, tokens, full message bodies, or deleted
      content. Telemetry redaction and memory analytics privacy tests pass; staging/exporter
      inspection remains open.
- [~] Add dashboards for capture-to-visible latency, queue age, dead letters, projection lag,
      retrieval quality, wrong-scope blocks, checkpoint failures, and deletion lag. The provider-
      neutral panel specification is recorded in `docs/internal/operations/agent-memory-observability.md`;
      durable dashboard deployment remains open.
- [~] Add alerts for queue growth, repeated provider failure, projection stalls, checkpoint blocks,
      deletion backlog, and cross-tenant access violations. Initial thresholds and response actions
      are specified in the memory observability runbook; notification routing and staging proof
      remain open.
- [x] Update internal architecture documentation and operator runbooks. Updated
      `docs/internal/architecture/agent-workflow-execution.md` and
      `docs/internal/runbooks/agent-memory-safety.md` for the v2 contracts and recovery rules.
- [x] Update API and public documentation only for behaviour enabled in the release. The public
      Agent REST guide now documents the versioned lifecycle, scope/readiness filtering,
      checkpoint, legal-hold, provider-confirmation, and rollout semantics; release-specific
      enablement remains controlled by the release record.
- [~] Run lint, type checks, unit tests, integration tests, migration tests, worker recovery tests,
      provider conformance tests, and memory event/projection contract checks. TypeScript build,
      MCP package build, full unit suite, baseline DB-enabled repository suite (213 files/1,181 tests),
      final affected-memory hardening suite (6 files/29 tests), local
      PostgreSQL matrix, migration runner, contract checks, and the Temporal-enabled local REST/MCP
      smoke pass (the harness now waits for both REST and MCP runs to complete before cleanup).
      The DB-backed suite was run
      with the local development worker paused so it could not claim integration fixtures; the
      worker was restored after verification. The
      repository has no lint script. Operator retention projection coverage now verifies canonical
      v2 fact/revision counts plus an explicit legacy compatibility marker. Local provider
      acknowledgement conformance now covers readiness/state matching and remote identity;
      provider-specific/staging conformance remains open. Studio UI build checks are `not applicable`
      unless P14 UI files change in this release.
- [ ] Deploy the exact tested artifacts to staging.
- [ ] Run staging smoke tests with non-sensitive test resources.
- [ ] Promote the exact tested artifact to production using the staged rollout.
- [ ] Run production smoke tests and record canonical, projection, provider, and Studio evidence.
- [ ] Record rollback drill or the reason it is not applicable.
- [ ] Schedule and complete the post-release review.
- [ ] Move this checklist to `docs/plans/completed/agents/` only after every M0-M6 exit gate and
      release item has evidence.

## Evidence log

| Phase | Commit or release | Tests and commands | Manual proof / dashboard | Reviewer | Date |
| --- | --- | --- | --- | --- | --- |
| Preparation | local pre-release manifest; dirty worktree on base `1d44cec9` | Builds, migration checks, docs builds, and `git diff --check` pass | Scope, ownership, rollback, and release record captured in the phase log | release owner pending | 2026-09-08 |
| M0 | local pre-release manifest | Contract, scope, lifecycle, redaction, provider, and stale-version tests pass in full matrix | M0 reference checkpoint recorded; reviewer approval remains open | reviewer pending | 2026-09-08 |
| M1 | local pre-release manifest | Journal capture, checkpoint, compaction recovery, journal-admission `SIGKILL`, and consolidation kill/reclaim fixtures pass | Durable journal admission and replay evidence recorded; reviewer approval remains open | reviewer pending | 2026-09-08 |
| M2 | local pre-release manifest | Revision, correction, conflict, scope, migration, and backfill dimension fixtures pass | Seven-dimensional source/target counts and provenance evidence recorded; live cutover remains open | reviewer pending | 2026-09-08 |
| M3 | local pre-release manifest | Consolidation retry, lease fencing, organization-partitioned worker scheduling, partition contention, provider acknowledgement, and recovery tests pass | Bounded 32-conversation and repeated 256-conversation/8-worker fixtures pass; production-scale load remains open | reviewer pending | 2026-09-08 |
| M4 | local pre-release manifest | Typed planner, policy gate, direct-tool parity, retrieval, scope, and analytics tests pass | Evidence IDs and retrieval decisions are observable; provider/staging conformance remains open | reviewer pending | 2026-09-08 |
| M5 | local pre-release manifest | Retention, legal hold, deletion, provider deletion, residual purge, and privacy tests pass | Local provider confirmation and residual checks pass; provider/staging approval remains open | reviewer pending | 2026-09-08 |
| M6 event contract | local pre-release manifest | Event-stream, cursor replay, scope, failure fixture, and observatory projection tests pass | Backend event contract is ready; visual Studio work is deferred to P14 | reviewer pending | 2026-09-08 |
| P14 Studio visualization | deferred | deferred | deferred | deferred | deferred |
| Cutover | local pre-release manifest | Full PostgreSQL matrix: 213 files / 1,181 tests passed; 8 external-fixture files / 31 tests skipped; final affected-memory hardening suite: 6 files / 29 tests passed; canonical retention/legal-hold fixture verifies worker-side hold fencing and immutable expiration | Staging backup, migration, parity, queue, rollback, and smoke evidence remain open | release owner pending | 2026-09-08 |
| Release closure | local pre-release manifest | Agents/MCP builds, manifest generation/verification, docs builds, and diff check pass | Clean tagged artifact, staging/provider inspection, production promotion, rollback drill, and review remain open | release owner pending | 2026-09-08 |

## Unresolved decisions and blockers

| Topic | Decision needed | Owner | Status |
| --- | --- | --- | --- |
| Workspace scope | Confirm mandatory workspace scope for all new records | Agent Platform + Tenant Platform | Decided: mandatory; scope validation and PostgreSQL policies enforce it |
| Agent-version visibility | Confirm whether revisions can be promoted across versions by policy | Agent Platform | Decided: creating version by default; explicit null-version sharing only |
| Autonomous promotion | Confirm threshold and memory types eligible for automatic activation | Product + Security | Decided: inference/import stays review-pending; explicit review activates |
| Embedding/index implementation | Select initial internal projection adapter and capacity limits | Agent Platform | Decided: existing 1,536-dimension projection behind rebuildable interface |
| Sensitive memory | Confirm encryption, redaction, and embedding policy | Security + Privacy | Decided: policy-gated, redacted before provider projection, no raw secrets |
| Retention defaults | Confirm policy source and legal-hold precedence | Tenant Platform + Privacy | Decided: organization policy authority; legal hold blocks purge |
| Studio graph expansion | Consume M6 event projections in P14 after memory rollout; preserve the existing shell | Agent Platform + Design | Deferred to P14 |
