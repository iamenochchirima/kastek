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
  evidence token budget. Vector storage remains deferred until the embedding model, dimension,
  index, and migration policy are selected.
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
- [x] Add bounded full-text candidate scoring, deduplication, source diversity, and policy token
      limits.
- [x] Apply repository ownership and policy filtering before ranking.
- [x] Record retrieval reason, source counts, empty results, and scope-safe evidence metadata.
- [x] Add paraphrase and restricted-scope evaluation fixtures.
- [x] Record missing-scope outcomes and retrieval latency without emitting memory or document
      contents.
- [x] Update memory architecture and audit evidence.
- [ ] Run unit, integration, type, build, and production smoke checks.

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
