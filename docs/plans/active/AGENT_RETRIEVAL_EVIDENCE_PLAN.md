# Agent retrieval evidence plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Replace the duplicated retrieval gate and concatenated prompt payload with one bounded retrieval
decision and structured evidence pipeline. Preserve the existing organization, agent,
installation, conversation, user, namespace, expiry, and sensitivity boundaries while making
retrieval behavior explainable and testable.

## Scope

- A deterministic, cheap retrieval-intent classifier with normalized queries and bounded reason
  codes.
- One retrieval service that queries memory and knowledge concurrently, deduplicates results, and
  returns source, rank, score, and provenance evidence separately from prompt rendering.
- Full-text relevance metadata and bounded candidate limits. Vector storage remains deferred until
  the embedding model, dimension, index, and migration policy are selected.
- Retrieval metrics and run-step evidence that do not record prompt or document contents.
- Evaluation fixtures for direct references, paraphrases, unrelated requests, and restricted
  policies.

## Non-goals

- Automatic memory extraction or consolidation; that remains P1.1.
- PostgreSQL RLS; that remains P1.2.
- Enabling pgvector without measured embedding settings.

## Implementation checklist

- [x] Define the retrieval decision and structured evidence interfaces.
- [x] Replace the duplicate regex gates with one deterministic classifier.
- [x] Add bounded full-text candidate scoring, deduplication, source diversity, and token limits.
- [x] Apply repository ownership and policy filtering before ranking.
- [x] Record retrieval reason, source counts, empty results, and scope-safe evidence metadata.
- [x] Add paraphrase and restricted-scope evaluation fixtures.
- [x] Update memory architecture and audit evidence.
- [ ] Run unit, integration, type, build, and production smoke checks.

## Release record

Change: Structured, policy-bounded retrieval decisions and evidence ranking.

Risk: standard. The change affects context assembly and retrieval behavior but does not add a new
data store or widen ownership scope.

Affected services and user surfaces: agents-api, agents-worker, hosted agent context, memory and
knowledge retrieval, run evidence, and agent operations diagnostics.

Platform release version or release ID: pending implementation release.

API/schema/migration changes: additive relevance aliases in repository projections only; no
database migration and no public API contract change.

Feature flag or rollout method: pending implementation; default behavior remains policy-disabled
or no-retrieval when the classifier does not request retrieval.

Analytics events and success metrics: retrieval decision reason, retrieval rate, source counts, and
empty-result rate; no prompt or document content. Scope-rejection and latency-specific metrics
remain open because repository filtering currently fails closed without a separate rejection signal.

Logs, metrics, dashboards, and alerts: bounded retrieval counters and operation spans; a durable
destination and alert policy remain governed by the observability plan.

User, API, internal, and operational documentation: update the memory architecture document and
the audit checklist in the same change.

Validation evidence: pending implementation.

Rollback or disable plan: revert the retrieval service/context wiring; repository search remains
backward-compatible.

Post-release review date: pending staged rollout evidence.
