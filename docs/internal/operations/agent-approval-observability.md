---
id: agent-approval-observability
title: Agent approval-group observability
sidebar_position: 8
owner: platform-ops
last_reviewed: 2026-09-11
---

# Agent approval-group observability

This document defines the provider-neutral telemetry contract for durable approval groups. The
Agents runtime emits the metrics below through OpenTelemetry. A durable metrics backend, deployed
dashboards, alert rules, and notification ownership are still release-environment responsibilities.

## Metrics

Scope dashboards by `service.name`, `deployment.environment.name`, and `kasitek.release_id`. The
runtime does not emit organization, installation, run, conversation, group, provider request, or
resource identifiers as metric labels.

| Metric | Type | Bounded dimensions | Meaning |
| --- | --- | --- | --- |
| `kasitek.approval.group.lifecycle.count` | counter | `action`, `error_code` | Requested, displayed, decided, resumed, cancelled, invalidated, expired, or consumed groups |
| `kasitek.approval.group.decision.count` | counter | `outcome`, `error_code` | Accepted decisions and stale, duplicate, conflict, or expired attempts |
| `kasitek.approval.group.size` | histogram | `action` or `outcome` | Number of proposed operations |
| `kasitek.approval.group.selected_size` | histogram | `action` or `outcome` | Number of operations selected by a decision |
| `kasitek.approval.group.wait_duration` | histogram | `action` or `outcome` | Milliseconds from group creation to a terminal decision or consumption |
| `kasitek.approval.group.decision_latency` | histogram | `outcome` | Milliseconds spent accepting a decision request |
| `kasitek.approval.group.provider_failure.count` | counter | `outcome`, `error_code` | Failed or unknown provider outcomes after approval crossed the barrier |

Error codes are truncated to a bounded length and must remain from a reviewed, finite vocabulary.
Arguments, resource snapshots, credentials, tokens, and raw provider payloads do not belong in
metrics or labels.

## Dashboard panels and alerts

Use five-minute counter rates and histogram percentiles. The release owner should provision and
link equivalent panels in the selected telemetry backend:

- decision outcomes, with stale, duplicate, conflict, expiry, rejection, partial, and approval
  rates;
- approval wait duration p50/p95 and decision latency p50/p95;
- group and selected-operation size p50/p95;
- lifecycle terminal-state counts and provider failed/unknown outcomes;
- approval groups waiting near expiry and groups not resumed after a durable decision.

Initial alert candidates are a rise in stale decisions, duplicate/conflict attempts, expired
groups, post-approval provider failures, or p95 wait duration. Thresholds, notification ownership,
retention, and paging severity must be set per environment in the release record; this document
does not invent production thresholds.

## Investigation and release evidence

An investigation records the release ID, commit/artifact digest, migration version, Temporal
Workflow compatibility version, bounded error codes, and the matching run-event history. Run-event
payloads are the audit source of truth; telemetry is an operational projection and must not grant,
revoke, or replay an effect.

The approval migration is additive. Fresh and legacy-state checks must prove that migration 173
creates the group table and nullable child link without creating groups for legacy per-operation
rows. Rollback follows
[`agent-approval-group-migration-rollback`](../runbooks/agent-approval-group-migration-rollback.md)
and never reopens a consumed group.

The local release evidence currently includes the metric instruments and deterministic runtime
coverage. Provisioning a durable backend, dashboards, alerts, and hosted staging signal delivery
remains an environment release gate.
