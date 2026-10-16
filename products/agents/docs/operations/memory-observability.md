---
id: agent-memory-observability
title: Agent memory observability
sidebar_position: 7
owner: platform-ops
last_reviewed: 2026-09-08
---

# Agent memory observability

This document defines the dashboard panels, alert conditions, and investigation queries for the
memory v2 rollout. It is a provider-neutral specification until a durable telemetry backend is
selected. The local and staging Collector debug exporters are verification-only and do not satisfy
the production retention or alerting gate.

## Dashboard panels

Use a five-minute rate for counters and a five-minute histogram window unless a panel says
otherwise. Scope panels by `service.name`, `deployment.environment.name`, and `kasitek.release_id`;
do not use organization, installation, run, conversation, memory, or provider request IDs as metric
labels.

| Panel | Signal | Question |
| --- | --- | --- |
| Capture and checkpoint failures | `kasitek.operation.error.count` filtered to `memory.source.capture` and `context.compaction`; `kasitek.operation.duration` | Are source events admitted before compaction, and are checkpoints failing closed? |
| Consolidation queue age | `kasitek.queue.age{queue.name="memory_consolidation"}` | Is extraction waiting behind a growing queue? |
| Consolidation outcomes | `kasitek.memory.consolidation.count` by bounded `outcome` | Are jobs producing candidates, retrying, dead-lettering, or being rollout-paused? |
| Projection queue age and failures | `kasitek.queue.age{queue.name="memory_projection"}` and `kasitek.operation.error.count` filtered to `memory.projection.job` | Are FTS/vector/temporal projections becoming visible? |
| Retrieval quality | `kasitek.memory.retrieval.decision.count`, `kasitek.memory.retrieval.evidence.count`, and `kasitek.memory.retrieval.scope_rejection.count` | Are retrieval decisions returning scoped evidence without authorization failures? |
| Retrieval latency | `kasitek.memory.retrieval.duration` and `kasitek.operation.duration` filtered to retrieval operations | Is retrieval within its configured budget? |
| Deletion backlog | `kasitek.queue.age{queue.name="memory_deletion"}` and `kasitek.memory.deletion.count` by outcome | Are canonical, projection, and provider deletions converging? |
| Provider deletion backlog | `kasitek.queue.age{queue.name="memory_provider_deletion"}` and `kasitek.operation.error.count` filtered to `memory.provider.deletion.job` | Is a provider preventing deletion completion? |
| Embedding fallback | `kasitek.memory.embedding.request.count` by bounded provider/outcome | Are vector providers failing and forcing lexical fallback? |
| Tenant-safety signals | `kasitek.database.authorization_failure.count`, `kasitek.memory.retrieval.scope_rejection.count` | Are isolation or scope checks rejecting requests? |

## Alert rules

Thresholds are initial release defaults. The release owner must approve the final values for each
environment and link the deployed rules in the release record.

| Alert | Initial condition | Severity | First response |
| --- | --- | --- | --- |
| MemoryConsolidationQueueGrowing | `max_over_time(kasitek.queue.age{queue.name="memory_consolidation"}[15m]) > 900` for 15m | warning | Check worker health, rollout flag, lease expiry, and dead-letter count. |
| MemoryConsolidationDeadLetters | increase of failed/dead-letter outcomes for 5m | critical | Stop promotion, inspect bounded error codes and source evidence, then replay only leased jobs. |
| MemoryProjectionStalled | projection queue age > 900s or no visible transition for 15m while work is queued | critical | Check projection worker/provider readiness and preserve canonical revisions. |
| MemoryRetrievalScopeRejections | scope-rejection rate > 1% of requested retrievals for 10m | critical | Treat as an isolation incident; inspect authorization context before changing flags. |
| MemoryCheckpointFailures | checkpoint/compaction error rate > 0.5% for 10m | critical | Keep compaction fail-closed, inspect source-event admission, and use the rollback switch only with an owner. |
| MemoryDeletionBacklog | deletion queue age > 900s for 15m | warning | Check legal holds, projection purge, provider receipts, and retryable error codes. |
| MemoryProviderDeletionFailures | provider deletion error rate > 1% for 10m | critical | Preserve canonical deletion state, pause promotion, and follow provider deletion runbook. |
| MemoryEmbeddingFallback | lexical fallback > 10% of embedding requests for 15m | warning | Check provider health; retrieval remains lexical and must not label results as semantic. |

## Investigation requirements

Every alert investigation must capture the release ID, commit/artifact digest, migration version,
active memory rollout flags, and bounded error codes. Logs may include scope-safe opaque IDs for
correlation, but must not include credentials, authorization headers, full message bodies, prompts,
raw vectors, or deleted content.

The canonical evidence path is PostgreSQL memory source events, checkpoints, revisions, readiness
rows, provider receipts, and deletion jobs. Telemetry is an operational projection and must never
be used as the authorization or memory source of truth.

The Agents runtime currently emits lifecycle events for canonical revision writes and compaction
checkpoints, retrieval events for automatic and direct-tool searches, projection events after a
lease-owner state transition, and deletion events for canonical/provider worker outcomes. Deletion
analytics resolve a unique target to a real workspace/agent/installation scope; when a target spans
installations, the event uses the explicit `organization_aggregate` resolution with all installation
identifiers set to null. Synthetic scope IDs are never emitted. Analytics enqueue is best effort;
the deletion job and provider receipt state remain authoritative.

## Rollout gate

The dashboard and alert specification is complete when the metrics are emitted and the queries are
reviewed. The memory release remains operationally incomplete until the rules are installed in a
durable backend, notification ownership is assigned, and staging smoke evidence proves delivery
and rollback behaviour.
