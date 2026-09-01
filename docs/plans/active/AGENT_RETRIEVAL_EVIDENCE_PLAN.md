# Agent retrieval evidence plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-09-01

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
- Full-text relevance metadata, bounded candidate limits, source diversity, and a policy-controlled
  evidence token budget. The released semantic path uses one pinned 1536-dimensional embedding
  model, PostgreSQL pgvector HNSW indexes, and lexical fallback.
- Retrieval metrics and run-step evidence that do not record prompt or document contents.
- Evaluation fixtures for direct references, paraphrases, unrelated requests, and restricted
  policies.

## Non-goals

- Automatic memory extraction or consolidation; that remains P1.1.
- PostgreSQL RLS; that remains P1.2.
- Changing the embedding model, vector dimension, or ranking weights without a separate evaluation.

## Implementation checklist

- [x] Define the retrieval decision and structured evidence interfaces.
- [x] Replace the duplicate regex gates with one deterministic classifier.
- [x] Add bounded full-text candidate scoring, deduplication, source diversity, and policy token
      limits.
- [x] Apply repository ownership and policy filtering before ranking.
- [x] Record retrieval reason, source counts, empty results, and scope-safe evidence metadata.
- [x] Add paraphrase and restricted-scope evaluation fixtures.
- [x] Record missing-scope outcomes and retrieval latency without emitting memory or document
      contents.
- [x] Update memory architecture and audit evidence.
- [x] Select and smoke-test the active embedding provider, model, and dimension.
- [x] Add additive vector columns, legacy JSON conversion, and partial HNSW indexes.
- [x] Generate vectors for new memory and knowledge writes with bounded batching and lexical
      fallback on provider failure.
- [x] Merge scoped lexical and vector candidates with model matching before ranking.
- [ ] Measure recall, relevance, latency, provider cost, and backfill completeness before changing
      the released model or score weights.
- [x] Run focused unit, migration, type, build, and deployed-service smoke checks.

## Release record

Change: Structured, policy-bounded retrieval decisions and evidence ranking.

Risk: standard. The change affects context assembly and retrieval behavior but does not add a new
data store or widen ownership scope.

Affected services and user surfaces: agents-api, agents-worker, hosted agent context, memory and
knowledge retrieval, run evidence, and agent operations diagnostics.

Platform release version or release ID: `6215196e`; Railway deployments
`34590ad9-f75c-4545-a984-648f6a8ea7ec` (agents-worker),
`e52624a1-11b8-4f27-a75b-a5bec994032a` (agents-api), and
`c97f83d4-e0e7-419b-8e16-b4e4302f16f9` (MCP-Gateway).

API/schema/migration changes: additive relevance aliases in repository projections only; no
database migration and no public API contract change.

Feature flag or rollout method: pending implementation; default behavior remains policy-disabled
or no-retrieval when the classifier does not request retrieval.

Analytics events and success metrics: retrieval decision reason, retrieval rate, source counts,
empty-result rate, missing-scope outcomes, and retrieval latency; no prompt or document content.
Repository filtering still fails closed when required scope is absent. Vector ranking remains
deferred until an embedding provider and dimension are selected.

Logs, metrics, dashboards, and alerts: bounded retrieval counters and operation spans; a durable
destination and alert policy remain governed by the observability plan.

User, API, internal, and operational documentation: update the memory architecture document and
the audit checklist in the same change.

Validation evidence: targeted retrieval and memory-policy tests passed (`11/11`); Agents
typecheck and build passed; full non-database suite passed (`85 passed, 18 skipped`; `533 passed,
52 skipped`). All three watched services reached `SUCCESS`. Agents-api live/readiness and
MCP-Gateway health smoke checks returned `200`.

Rollback or disable plan: revert the retrieval service/context wiring; repository search remains
backward-compatible.

Post-release review date: 2026-09-07; monitor evidence size, context-limit failures, retrieval
empty-result rate, and model latency before changing the default token budget.

## Follow-up release record: pgvector hybrid retrieval baseline

Change: Add optional semantic embeddings and bounded hybrid ranking to memory and knowledge
retrieval while preserving PostgreSQL full-text fallback.

Owner: Agent Platform.

Risk: standard. The database change is additive. Embedding calls add provider latency and cost, so
the feature remains disabled by default until the deployed code and migration are verified.

Affected services and user surfaces: agents-api, agents-worker, Agent Platform PostgreSQL, memory
writes, knowledge ingestion, hosted-agent context assembly, and retrieval diagnostics.

Platform release version or release ID: commit `74e51799`; migration `099` is applied in
production. The production agents-api deployment is `79ce23a4-bdbc-49b7-a6fa-4f04c5f4b34f` and
the agents-worker deployment is `0953ffb4-0ee9-4731-be24-199f9b60d4ce`.

API/schema/migration changes: migration `099_pgvector_hybrid_retrieval.sql` enables the available
pgvector `0.8.6` extension, adds `vector(1536)` columns and `embedding_model`-aware partial HNSW
indexes, converts valid legacy 1536-value JSON embeddings, and leaves canonical text untouched.

Feature flag or rollout method: `EMBEDDINGS_ENABLED=false` remains the default. The production
rollout sets it to `true` on agents-api and agents-worker only after the compatible release is
deployed. `EMBEDDING_PROVIDER=openrouter`, `EMBEDDING_MODEL=openai/text-embedding-3-small`, and
`EMBEDDING_DIMENSIONS=1536` are the released settings.

Analytics events and success metrics: not applicable for user analytics. Operational success is
embedding success/fallback count, retrieval latency, empty-result rate, relevance, recall, and
provider cost. The metric contract is `kasitek.memory.embedding.request.count`.

Logs, metrics, dashboards, and alerts: `memory.embedding.failed` records only provider, model,
bounded error code, and `fallback=lexical`; the embedding metric has bounded provider and outcome
attributes. Durable retention, dashboards, and alert routing remain governed by the observability
plan.

User, API, internal, and operational documentation: updated the memory lifecycle architecture,
observability guide, root architecture audit, and this plan. No public API contract changed.

Validation evidence: OpenRouter returned 1536-dimensional vectors for the released model. The
production migration reported pgvector `0.8.6`. A production database smoke path stored a real
vector, ranked the matching memory, and verified the restricted role saw only its organization.
Focused tests passed: 53 tests across embeddings, retrieval, memory policy, and migration checks;
the Agents production build and `git diff --check` passed. Both services reached `SUCCESS`, the
rollout variables and release metadata were verified on both services, and readiness returned
`200`.

Rollback or disable plan: set `EMBEDDINGS_ENABLED=false` on agents-api and agents-worker and
redeploy if provider latency, cost, or errors exceed the release threshold. Lexical retrieval
continues to work. Do not drop the vector columns or indexes in the rollback release.

Post-release review date: 2026-09-08; review provider spend, fallback rate, latency, result
quality, and the count of rows still missing vectors.

## Follow-up release record: memory and retrieval observability

Change: Add bounded memory lifecycle outcome metrics, missing retrieval-scope metrics, and
retrieval-duration metrics.

Owner: Agent Platform.

Risk: low. The change is observational and does not widen retrieval, change stored memory content,
or add a database migration.

Affected services and user surfaces: agents-api, agents-worker, MCP-Gateway, memory lifecycle,
knowledge and memory retrieval diagnostics, and operator telemetry.

Platform release version or release ID: `b10ad3f8`.

API/schema/migration changes: not applicable.

Feature flag or rollout method: not applicable; metrics are emitted only from existing lifecycle
and retrieval paths.

Analytics events and success metrics: `kasitek.memory.lifecycle.decision.count`,
`kasitek.memory.retrieval.scope_rejection.count`, and `kasitek.memory.retrieval.duration`; metric
attributes contain bounded outcome, source type, scope-rejection reason, or duration only.

Logs, metrics, dashboards, and alerts: OpenTelemetry metrics are emitted by the affected services;
durable retention, dashboards, and alerts remain governed by the observability plan. No memory text,
document text, or record identifiers are emitted.

User, API, internal, and operational documentation: memory architecture and the root architecture
audit were updated in the same release record.

Validation evidence: targeted memory-policy and retrieval tests passed (`13/13`), Agents
typecheck passed, production build passed, and `git diff --check` passed. Railway deployments
`e25edcbe-35e9-4637-8926-61fff218e49a` (agents-worker),
`445c72f3-74b9-4f42-8cab-e817d8a16352` (agents-api), and
`d1a51746-a52b-4006-b8a1-029f5270553d` (MCP-Gateway) reached `SUCCESS` for commit `b10ad3f8`.
Agents-api live/readiness checks returned `200`; the public gateway readiness check returned
`200`; and a worker SSH smoke command succeeded.

Rollback or disable plan: revert commit `b10ad3f8`; the existing retrieval fail-closed behavior
remains unchanged.

Post-release review date: 2026-09-08; confirm metric delivery and check for unexpected scope
rejection or retrieval-latency regressions before the next retrieval tranche.
