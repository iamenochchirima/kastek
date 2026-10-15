---
id: agent-database-isolation
title: Agents database isolation
sidebar_position: 8
owner: platform-ops
last_reviewed: 2026-09-01
---

# Agents database isolation

This runbook covers PostgreSQL authorization and row-level security (RLS) incidents in the
Agents API, workers, and maintenance processes. The runtime role is deliberately unable to
bypass RLS. Do not grant `SUPERUSER` or `BYPASSRLS` to recover an application path.

## Signals and routing

The application emits both an OpenTelemetry metric and a structured log for each signal:

| Signal | Event | Severity | Initial route |
| --- | --- | --- | --- |
| PostgreSQL `42501`, including an RLS denial | `database.authorization.failed` | critical in production | platform-ops on-call |
| Required organization or actor scope missing | `database.context.missing` | critical in production | platform-ops on-call and owning worker team |

Metrics are low-cardinality:

- `kasitek.database.authorization_failure.count` with `sqlstate=42501` and
  `context=present|missing`;
- `kasitek.database.context_missing.count` with a bounded background `process` value.

Logs include the service/release identity, correlation ID when available, bounded process or
context status, and the error code. They do not include SQL text, query parameters, tenant
payloads, prompts, tokens, or credentials.

The repository Collector currently provides transport and debug verification only. A production
deployment is not considered alert-routed until its durable telemetry backend has alert rules for
the two metric names above, sends both routes to the stated owner, and records a test notification.
That provider-specific routing evidence remains an external release gate.

Expected RLS negative-test denials must run only in the isolated test environment and must be
identified by the test release/environment. They must not be silently filtered from production
alerts.

## First response

1. Confirm the service, release ID, commit SHA, environment, process, and time window.
2. Check both metrics and search the stable events `database.authorization.failed` and
   `database.context.missing`.
3. Treat any `database.context.missing` event as a caller defect. Pause the affected worker or
   maintenance loop before retrying it.
4. For an unexpected authorization failure, check the migration version, runtime role flags,
   transaction context, and the affected policy tranche. Do not copy tenant data or SQL values
   into the incident record.
5. If the failure is isolated to an expected test release, attach the test result and close the
   notification. Otherwise escalate to the Agent Platform owner.

## Staged rollout and disable procedure

RLS changes are released in this order:

1. Apply additive grants and ownership/constraint checks with RLS unchanged.
2. Deploy the compatible API and worker artifact with the fail-closed context boundary.
3. Run the restricted-role matrix against an isolated database containing two organizations,
   including cross-organization reads, writes, parent-owned rows, and system-agent rows.
4. Enable one migration tranche through the administrative migration connection.
5. Verify `relrowsecurity=true`, `relforcerowsecurity=true`, the runtime role has
   `rolsuper=false` and `rolbypassrls=false`, readiness is healthy, and the process matrix is
   clean.
6. Observe authorization and context-missing signals for the release review window before the
   next tranche.

To disable a bad tranche, stop the rollout and restore the last compatible API/worker artifact.
Then use a reviewed administrative migration to disable only the affected tranche's policies.
Record the migration version and policy names. Never make a broad privilege change and never use
the runtime role for policy changes.

## Rollback drill

The drill is complete only when the operator records all of the following in the release record:

- the exact prior API and worker deployment IDs;
- the affected migration and policy tranche;
- the administrative command or migration used to disable that tranche;
- readiness and restricted-role isolation checks after the rollback;
- confirmation that `BYPASSRLS` and superuser privileges were not added;
- the time, owner, alert notification, and post-rollback review result.

If the prior artifact is unavailable, stop and restore the last known compatible artifact before
changing database policy. A source-level rollback procedure is checked in here; the production
rollback drill and durable alert notification are still pending evidence.
