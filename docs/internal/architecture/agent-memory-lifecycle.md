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

`reviewed` and `automatic` are policy values for the planned extraction and review adapters; they do
not currently cause inferred writes. Inferred or procedural memory must continue through an explicit
creation policy and the repository's poisoning controls.

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
are available, and passes only the selected evidence text into the untrusted context section.
Run-step evidence records counts and ranked IDs/scores without recording the retrieved text there.

The worker exposes two installation-scoped capabilities:

- `kasitek.agent.memory_search` — read-only, policy-bounded search;
- `kasitek.agent.memory_remember` — explicit, approval-gated write with bounded text, namespace,
  type, sensitivity, retention, and per-run limits.

Neither capability can widen repository scope. Memory tools are registered in the hosted worker,
not treated as unrestricted external business tools.

## Remaining work

Conversation extraction, review queues, contradiction and correction links, vector ranking,
source-message/model/extraction provenance, derived-store deletion, scope-rejection metrics, and
organization-level row-level security remain separate audit items. They must be implemented behind
the same lifecycle boundary rather than by adding direct writes to conversation handlers.
