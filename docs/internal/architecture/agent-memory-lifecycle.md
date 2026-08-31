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

The worker constructs `MemoryLifecycle` for hosted runs. Retrieval is decided before context
assembly and records an explainable reason (`always`, direct reference, preference reference,
contextual question, policy disabled, or not requested). A memory search is never issued when the
policy is disabled or its readable namespace allowlist is empty. Returned records are filtered for
sensitivity before prompt rendering.

The worker exposes two installation-scoped capabilities:

- `kasitek.agent.memory_search` — read-only, policy-bounded search;
- `kasitek.agent.memory_remember` — explicit, approval-gated write with bounded text, namespace,
  type, sensitivity, retention, and per-run limits.

Neither capability can widen repository scope. Memory tools are registered in the hosted worker,
not treated as unrestricted external business tools.

## Remaining work

Conversation extraction, review queues, contradiction and correction links, hybrid/vector ranking,
source-message/model/extraction provenance, derived-store deletion, lifecycle metrics, and
organization-level row-level security remain separate audit items. They must be implemented behind
the same lifecycle boundary rather than by adding direct writes to conversation handlers.
