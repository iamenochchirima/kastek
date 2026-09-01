---
title: Agent memory lifecycle
owner: agent-platform
last_reviewed: 2026-08-31
---

# Agent memory lifecycle

Agent memory is owned by an agent installation at runtime. The memory repository requires the
organization and agent identity and applies additional installation, conversation, user, and
namespace predicates before returning records. `organization_shared` is the deliberate exception:
it may be visible to multiple installations in one organization only when the installation policy
allows that namespace.

## Runtime policy

An installation policy can select `disabled`, `explicit`, `reviewed`, or `automatic` memory mode.
The current runtime slice implements policy normalization, bounded retrieval, namespace and
sensitivity filtering, explicit writes, source-run provenance, retention, and per-run write caps.
For `reviewed` and `automatic` installations, the memory worker also consumes run-bound inbound
evidence after a minimum message threshold. The first extractor is deterministic and conservative:
it proposes only explicit preference and decision patterns, never procedural memory. Candidates are
written through the lifecycle as inferred records and remain `review_pending` (or `quarantined`)
until review; they are not silently activated.

## Runtime boundary

The worker constructs `MemoryLifecycle` and `RetrievalService` for hosted runs. Retrieval is
decided before context assembly by one deterministic, bounded classifier and records an
explainable reason (`always`, direct reference, preference reference, contextual question,
semantic reference, knowledge reference, policy disabled, or not requested). The general profile
may retrieve knowledge even when memory is disabled; memory searches still require an enabled mode,
readable namespaces, and a positive memory limit. Returned records are filtered for sensitivity
before prompt rendering.

`RetrievalService` runs the policy-bounded memory and knowledge searches concurrently, then returns
structured evidence with source type, stable record identity, lexical score, rank, and provenance.
It deduplicates identical text, limits the candidate set, keeps source diversity when both sources
are available, and applies the installation's bounded `maxRetrievedTokens` budget before passing
selected evidence into the untrusted context section. Oversized candidates are truncated only when
needed to fit an otherwise empty budget; later candidates are skipped when they would exceed the
remaining budget. Run-step evidence records counts and ranked IDs/scores without recording the
retrieved text there.

The worker exposes two installation-scoped capabilities:

- `kasitek.agent.memory_search` — read-only, policy-bounded search;
- `kasitek.agent.memory_remember` — explicit, approval-gated write with bounded text, namespace,
  type, sensitivity, retention, and per-run limits.

Neither capability can widen repository scope. Memory tools are registered in the hosted worker,
not treated as unrestricted external business tools.

## Safety and review

Memory writes are classified at the repository boundary. Explicit user-authored content is trusted
for authorship, while imported content is `external_untrusted` and inferred content is
`model_inferred`. Platform and organization curation can be represented as separate trust values
when those ingestion adapters are added.

The boundary detects instruction-injection and secret/personal-data signals before persistence. A
poisoning or sensitive signal produces `quarantined`; clean imported or inferred content produces
`review_pending`; explicit clean content remains `active`. Review metadata and bounded signal names
are stored in provenance, never the secret value itself. Sensitive content is classified as
`sensitive` or `restricted` and remains excluded from retrieval unless the installation policy
allows it.

Procedural memory is rejected unless its source is explicit. Memory content cannot update agent
instructions or policy: retrieved records are passed to the model only as untrusted evidence.
Users can review scoped candidates with `POST /v1/memory/{memoryId}/review`; platform operators
can use the dual-approval `review_memory` command. Both paths enforce organization, agent,
installation, conversation, and user scope and append an audit record. Rejection moves the record
to `rejected`, which is never searchable.

Semantic facts may provide a stable `factKey`. If a new fact conflicts with an active fact using
the same key and scope, the new record is held in `review_pending`; it never silently overwrites
the old value. Approval must name the active conflicting record as `supersedesMemoryId`. The new
record then becomes active and the old record becomes `superseded`, with immutable lineage retained
in `memory_records.supersedes_memory_id` and provenance. A supersession target must match the
organization, agent, installation, conversation, user, namespace, and fact key of the candidate.

The current detector is a bounded first-pass classifier, not a complete adversarial defense. The
consolidation worker records source message IDs, source run ID, extraction version, confidence, and
the extractor identity in bounded provenance. Job claims are leased and idempotent per source run
and extraction version, so worker replacement can retry a job without creating a second candidate.
Explicit and disabled policies are safe no-op paths for inferred extraction.

Deletion is a permanent, scoped purge. Memory deletion removes the canonical row, its embedded
vector and PostgreSQL full-text search vector, then invalidates any conversation summary associated
with the deleted record. Knowledge-source deletion removes the source and all revision chunks.
Conversation deletion uses the same purge helper. An active organization, installation, or
conversation legal hold blocks these paths with a conflict. Deletion records remain in
`memory_deletion_jobs` without retaining the deleted content. There is no independent vector or
cache store in the current deployment; adding one requires an adapter behind this boundary and a
deletion test for that adapter.

Multi-turn poisoning analysis, model-backed extraction, and automatic activation remain open.

## Remaining work

Model-backed extraction quality, vector ranking, scope-rejection metrics, and organization-level
row-level security remain separate audit items. They must be implemented
behind the same lifecycle boundary rather than by adding direct writes to conversation handlers.
