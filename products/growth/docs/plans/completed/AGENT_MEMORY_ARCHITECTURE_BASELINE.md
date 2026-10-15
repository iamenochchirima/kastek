---
id: agent-memory-architecture-baseline
title: Agent memory architecture baseline
sidebar_label: Memory architecture · baseline
slug: /memory-architecture-baseline
description: Baseline evidence and fixture inventory for the active memory architecture rollout.
---

# Agent memory architecture baseline

This baseline is captured for the additive memory rollout. It is evidence for the active plan, not
another implementation authority. The Studio visual rollout is intentionally excluded.

## Source revisions

Captured 2026-09-08:

| Source | Revision |
| --- | --- |
| KasiTek | `57554d8c57fa7d831505f5bde2b3af3fe3814a91` |
| Hermes | `9a84bee265daad14340a80d7585928cd8ea1f9eb` |
| Waku | `21486b39ca2b59cf3a616159139712f4bef0914c` |

The Hermes and Waku revisions are the exact checkouts refreshed in the research note and phase
log. Any later lifecycle or provider decision must record a new checkpoint rather than silently
using a moving checkout.

## Local database baseline

Environment: local PostgreSQL configured by `agents/.env`, captured before the new integration
fixtures ran.

| Dataset | Rows |
| --- | ---: |
| `memory_records` (legacy) | 0 |
| `agent_memory_facts` | 0 |
| `agent_memory_revisions` | 0 |
| `memory_source_events` | 0 |
| `memory_checkpoints` | 0 |
| `memory_consolidation_jobs` | 1 |
| `memory_deletion_jobs` | 0 |
| `agent_memory_provider_deletion_jobs` | 0 |
| `agent_memory_retrieval_decisions` | 0 |

The integration tests create organization-scoped fixtures with random identifiers and clean them
up in `afterAll`; the zero counts are therefore not a claim that a production tenant is empty.

## Fixture inventory

| Fixture | Authoritative coverage |
| --- | --- |
| Explicit semantic memory | `memory-revisions.test.ts`, `memory.integration.test.ts` |
| Inferred candidate and poisoning | `memory-revision-consolidation-worker.test.ts`, `memory-poisoning.test.ts` |
| Imported pending/quarantined memory | `memory.integration.test.ts` |
| Knowledge source/chunks | `memory.integration.test.ts`, `retrieval.test.ts` |
| Context summary and compaction | `context-memory-boundary.test.ts`, `context-compaction.test.ts` |
| Correction, supersession, conflict | `memory-revisions.test.ts`, `memory-retention.test.ts` |
| Source capture/checkpoint replay | `memory-journal-source-capture.test.ts`, `context-memory-boundary.test.ts` |
| Projection readiness and provider states | `memory-projection-worker.test.ts`, `memory-projection-migration.test.ts` |
| Retention/expiration/revalidation | `memory-retention-worker.test.ts`, `retention.integration.test.ts` |
| Canonical/provider deletion and legal hold | `memory-deletion-worker.test.ts`, `memory-provider-deletion-worker.test.ts`, `memory-deletion-worker.integration.test.ts` |
| Typed retrieval/gate/diagnostics | `memory-retrieval-planner.test.ts`, `memory-retrieval-gate.test.ts`, `memory-runtime-retrieval-adapter.test.ts`, `memory.integration.test.ts` |
| Observatory run/revision lineage | `memory-observatory.test.ts`, `fixtures/memory-observatory-event-streams.ts` |

## Ownership and rollout record

| Area | Owner | Evidence/decision |
| --- | --- | --- |
| Runtime capture and context boundary | Agent Platform · Runtime | M1 checkpoint and context boundary tests |
| PostgreSQL contracts and migrations | Agent Platform · Data | migrations 130–150 and migration tests |
| Temporal consolidation/projection workers | Agent Platform · Workers | worker tests, local integration fixtures |
| Provider adapters and deletion | Agent Platform · Integrations | provider contracts and deletion queue; live adapter gate remains external |
| Security/privacy and tenant scope | Agent Platform · Security | RLS/scope triggers, poisoning/redaction tests |
| Studio visual surface | Agent Platform · Studio | Deferred to P14; no UI work blocks this rollout |
| Release approval | Platform Operations | Staging/production approval remains an external release gate |

## Baseline release record

Change: high-risk additive Agent Memory Architecture upgrade.

Owner: Agent Platform.

Affected services: Agents runtime, PostgreSQL migrations, Temporal workers, memory command/retrieval
paths, provider deletion workers, and internal operational documentation. Studio UI: not applicable
for this rollout; its backend event contract remains a separate non-visual gate.

Rollout: additive migrations first; feature flags for consolidation, retrieval gate, projection,
retention, and deletion workers; non-production organization/agent-version canary before any
production cutover.

Rollback: disable new runtime/worker flags and preserve additive tables; no destructive schema
rollback. Canonical source events remain authoritative during rollback.

Analytics/logging: bounded lifecycle telemetry and structured logs are implemented; dashboards,
alerts, and release identity are still required before staging/production promotion.

Validation: build, full unit suite, migration application, and local PostgreSQL integration subsets
are recorded in the phase log. External provider conformance, crash/replay soak, staging, and
production evidence are not claimed here.
