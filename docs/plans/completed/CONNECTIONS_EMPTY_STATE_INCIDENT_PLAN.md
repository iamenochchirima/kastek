# Connections Empty-State Incident Plan

**Status:** Completed — Core deployed; Client artifact pushed for Vercel automation
**Owner:** Core and Client platform
**Last updated:** 2026-08-31

## Objective

Restore the Connections page for the active workspace and make backend load failures visible as
errors instead of presenting an empty workspace. Existing connection records must remain intact.

## Checklist

- [x] Confirm production records exist for the `KasiTek` workspace.
- [x] Reproduce the capability-sync SQL failure without mutating production data.
- [x] Correct the invalid SQL alias and add regression coverage.
- [x] Preserve a distinct client error state when `/api/connections` fails.
- [x] Deploy the corrected Core and Client artifacts and verify the live page/API.
- [x] Record final release evidence and archive this plan.

## Findings

Production has 14 `ExternalConnection` records for `KasiTek` and zero for `TestOrg`. The new
`SOCIAL_POST_DELETE` capability condition referenced `capability.key` inside the lateral
subquery that defines the `capability` alias, causing PostgreSQL to return `missing FROM-clause
entry for table "capability"`. The server-rendered Connections page caught that error and replaced
the response with `{ connections: [] }`, producing a false empty state.

## Release record

Change: Fix Connections capability-sync SQL and expose connection-load failures in the UI.
Owner: Core and Client platform.
Risk: standard; read-path recovery and error-state presentation, with no data deletion or migration.
Affected services and user surfaces: Core `/api/connections`; Client `/connections`; workspace
connection management and all surfaces that refresh the shared connection projection.
Platform release version or release ID: Core Railway deployment `bfd174d5-e850-4d98-986f-9464236370bd`;
Client commit pushed to the Vercel-connected repository branch as `d7560b24`.
API/schema/migration changes: none; the response contract is unchanged.
Feature flag or rollout method: deploy the corrected Core artifact, then the Client artifact; no flag.
Analytics events and success metrics: not applicable; no new user outcome or event contract.
Logs, metrics, dashboards, and alerts: existing Core request/error logs remain the signal; no new
instrumentation is needed because the SQL failure is eliminated and the Client no longer masks it.
User, API, internal, and operational documentation: update the connection failure runbook with the
false-empty-state diagnostic and the production validation result.
Validation evidence: the corrected capability-sync statement was prepared successfully against the
production PostgreSQL schema without executing it; the `KasiTek` workspace still has 14 connection
records and `TestOrg` has zero. Core formatting, check, and 223 library tests passed (220 passed,
3 ignored). Client build passed and lint passed with two pre-existing warnings. Core deployment
`bfd174d5-e850-4d98-986f-9464236370bd` reports `SUCCESS`, `/health` returns HTTP 200, and an
unauthenticated `/api/connections` probe correctly returns 401. The client artifact is pushed for
the connected Vercel automation; Vercel CLI inspection is unavailable in this environment.
Rollback or disable plan: redeploy the previous known-good Core and Client artifacts; no migration
rollback is required.
Post-release review date: one business day after deployment.
