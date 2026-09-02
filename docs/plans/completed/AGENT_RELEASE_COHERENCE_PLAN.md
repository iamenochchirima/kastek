---
id: agent-release-coherence
title: Agent release coherence
owner: platform-ops
status: completed
---

# Agent release coherence

## Outcome

When a production Agents artifact changes the protected KasiAi definition, the active system
installations must move to the matching published version before the Agents API reports ready.
A green deployment must not hide a stale database-backed agent version.

Customer-owned agent versions remain governed by their installation release mode: `follow_published`,
`staged`, or `pinned`. This change does not silently move pinned customer installations.

## Plan

- [completed] Make the source-defined protected-agent release operation shared, gated, idempotent,
  and verified after rollout.
- [completed] Run that reconciliation during production Agents API startup before the listener opens;
  fail startup and readiness when release or rollout cannot complete.
- [completed] Add a worker-side version-coherence check so a newly deployed worker cannot process new
  work against a stale protected-agent definition while the API release is pending.
- [completed] Add regression coverage for stale-version promotion, no-op restarts, incomplete rollout,
  and deployment descriptor contracts.
- [completed] Update deployment/runbook documentation with the new automatic gate, release identity,
  logs, validation, and rollback procedure.
- [completed] Run verification, record production evidence, commit, push, and deploy the coherent change.

## Release record

Change: Tie the protected KasiAi database version to the deployed Agents artifact at startup.

Owner: platform-ops / Agent Platform.

Risk: standard. Startup becomes fail-closed if the protected release cannot be published or rolled
out; this prevents mixed versions but requires the Agents migration to be complete before API start.

Affected services and user surfaces: Agents API startup/readiness, Agents Worker startup, KasiAi
conversations and all protected system installations. No customer-owned pinned installation is
changed by this release.

Platform release version or release ID: record the production commit SHA and platform release ID
after deployment.

API/schema/migration changes: no schema migration planned; existing agent version and installation
tables remain the source of truth.

Feature flag or rollout method: automatic, idempotent reconciliation in the migrated Agents API
process before it listens; the existing one-shot release command remains available for recovery.

Analytics events and success metrics: no new product analytics event. Success is a zero stale active
protected-installation count after startup; release and startup outcomes are structured operational
events.

Logs, metrics, dashboards, and alerts: emit bounded release start, completion, gate failure, rollout
verification failure, and worker coherence failure events with release/commit metadata; no secrets or
message content. Existing deployment health checks become the release gate.

User, API, internal, and operational documentation: update the Railway topology and release process
references; add the operator recovery and rollback procedure.

Validation evidence: targeted release tests, full Agents tests, Agents build, deployment descriptor
test, and production `/health/ready` plus protected-version verification after deployment.

Rollback or disable plan: redeploy the previous coherent Agents artifact. Its startup reconciliation
will restore the matching prior protected agent definition; if database recovery is required, run the
compiled release command from that artifact with `--rollout` after migrations are confirmed.

Post-release review date: 2026-09-09.

## Production evidence

- Source commit: `05e1e6904f2a` (`fix(agents): make system release idempotency canonical`).
- Agents API deployment: Railway `0836645c-1555-4a51-8ea2-80380ac69755`, `SUCCESS`.
- Agents Worker deployment: Railway `42efc8ee-e671-4c59-9519-773526272997`, `SUCCESS`.
- API startup release event: published version `9`, active installations `2`, stale installations `0`,
  rollout changes `0` (already coherent).
- Worker startup release event: published version `9`, active installations `2`, stale installations `0`.
- Runtime checks: the Agents API's internal `/health/ready` returned HTTP 200 with
  `{"status":"ready","temporalEnabled":true}` through Railway SSH. The public
  `https://agents.kasitek.co.za/health/ready` gateway check and
  `https://api.kasitek.co.za/health` Core check also returned HTTP 200.

## Design boundary

The platform runtime loads the exact `agent_version_id` captured on each run. Existing runs remain
bound to their captured version; new runs use the installation's current version. Therefore release
coherence is enforced at installation promotion and process startup, not by mutating in-flight runs.
