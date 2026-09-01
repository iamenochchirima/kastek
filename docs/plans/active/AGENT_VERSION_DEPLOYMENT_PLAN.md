# Agent version deployment plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Make the version shown as published match the version used by new runs for user-created hosted
agents. Existing installations must have an explicit release mode, and publishing must update only
installations configured to follow the published version. Historical and in-flight runs must keep
their original version.

## Scope

### Included

- An explicit installation release mode.
- Backfill behavior for existing installations.
- Automatic deployment for `follow_published` installations.
- Repository and database ownership checks.
- Deployment audit records and lifecycle evidence.
- Accurate API and dashboard deployment state.
- Regression and integration tests.

### Excluded

- Percentage-based canaries.
- Staged deployment UI.
- Changing system-agent rollout behavior.
- Rewriting historical runs or changing the agent version attached to an existing run.

## Context and constraints

- `agent_versions.status = 'published'` currently identifies the published version, but it does
  not move existing user installations.
- `agent_installations.agent_version_id` is the runtime version selected when a run starts.
- System installations retain explicit rollout behavior through `rolloutSystemVersion`.
- External-connected installations must remain pinned until their own release contract exists.
- The migration must be safe for existing rows and must not weaken organization ownership checks.
- Runtime and product version identifiers remain separate from customer-created agent versions.

## Implementation plan

1. [x] Confirm the current publication, installation, and run-version seams.
2. [x] Add an installation release-mode migration and backfill existing rows.
3. [x] Update the repository interface and publication path to deploy follow-published installations.
4. [x] Add explicit deployment API state and correct dashboard copy and display.
5. [x] Add an organization-scoped manual deployment operation for hosted installations with an
      optimistic version check.
6. [x] Add regression, integration, ownership, rollback, and historical-run tests.
7. [x] Update internal and user documentation, observability, and release evidence.
8. [x] Verify the tested artifact, apply the production migration, and record rollout results.

## Verification

- [x] `pnpm --dir agents exec tsc --noEmit` or the repository's equivalent type check.
- [x] `pnpm --dir agents run build`.
- [x] `pnpm --dir agents test` (database-backed integration files are skipped without
      `AGENTS_DATABASE_URL`).
- [x] `pnpm --dir client/apps/client exec tsc --noEmit`.
- [x] `pnpm --dir client/apps/client run lint` (existing warnings remain; no lint errors).
- [x] Repository tests for release modes and ownership failures.
- [x] Database integration tests for backfill, publish, deployment, and rollback.
- [x] Run snapshot tests proving historical and in-flight runs retain their version.
- [x] API and dashboard checks for published versus deployed state.
- [x] Migration check against the production precondition audit and administrative migration path.
- [ ] Production release smoke test using a non-sensitive hosted agent.

## Release record

Change: Separate agent version publication from installation deployment.

Owner: Agent Platform.

Risk: High. This changes which instructions, tools, limits, and workflows new hosted runs use.

Affected services and user surfaces: agents-api, agents-worker, Agent Platform PostgreSQL, agent
creation flow, agent detail dashboard, and hosted conversations.

Platform release version or release ID: implementation commit `01d25b01`.

API/schema/migration changes: Add installation release mode and deployment state. Preserve existing
run version references.

Feature flag or rollout method: `agent_version_deployment_enabled` is an explicit dual-controlled
global, organization, or installation flag. When absent it defaults to enabled for backward
compatibility; disabling it blocks only automatic follow-published movement and leaves the current
deployed version runnable. System and external installations keep their existing behavior.

Analytics events and success metrics: Publication, manual deployment, automatic deployment, and
rollback remain in the existing audit trail. `kasitek.agent.version.deployment.count` records
matched, mismatch, blocked, and deployed counts with bounded release-mode labels. Production
currently reports one matched and zero mismatched active follow-published installations; no
dedicated dashboard or deployment-lag alert exists yet. Historical-run version changes remain
zero by the existing snapshot contract.

Logs, metrics, dashboards, and alerts: Structured audit records exist for deployment outcomes;
`kasitek.agent.version.deployment.count` records matched, mismatch, blocked, and deployed counts
with bounded release-mode labels. Deployment lag and a durable dashboard/alert remain open.
Collector configuration: not applicable.

User, API, internal, and operational documentation: Update the agent lifecycle contract, API
reference, dashboard copy, migration notes, and deployment runbook.

Validation evidence: targeted rollout/migration/operator tests passed (`38 tests`), the full
non-database Agents suite passed (`549 tests`, `68 skips`), Agents type-check and build passed,
and the exact commit reached `SUCCESS` on Railway: API `b37e9de4-a42a-4f5b-bd05-8bdf39801429`,
worker `008ef973-9952-483f-b45e-5f71024ee135`, and MCP Gateway
`2d6c6eab-e408-4af2-b598-d5d7fa91055b`. Migration 096 is recorded in Production; the flag
constraint is validated. Production API live/readiness and Gateway readiness returned `200`.

Rollback or disable plan: Disable automatic deployment for user installations, preserve pinned
version IDs, and run the explicit rollback operation. The migration is additive and its backfill
must be reversible before the column becomes non-null.

Post-release review date: Set at release time.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Existing hosted installations | Backfill to `follow_published` so current user-created agents receive the behavior they were shown in the editor. | Agent Platform | Decided |
| System installations | Keep explicit system rollout behavior and do not change it in this slice. | Agent Platform | Decided |
| External-connected installations | Keep pinned until external-agent version negotiation is designed. | Agent Platform | Decided |
| New installation default | Use `follow_published` for organization-owned hosted installations and `pinned` for system or external installations. | Agent Platform | Decided |
| Canary release | Add as a later tranche after the basic deployment contract is correct. | Platform | Open for later tranche |

## Notes and blockers

The local PostgreSQL integration database is available on the isolated test port and the lifecycle
tests have been exercised against it. The release still needs the current tranche's production
migrations, deployment approval, and post-release published-versus-deployed mismatch measurement.
The existing working tree contains unrelated changes in `.github/workflows/observability.yml` and
`docs/plans/active/AGENT_MEDIA_HARNESS_PLAN.md`; those files are outside this implementation slice
and must remain untouched.
