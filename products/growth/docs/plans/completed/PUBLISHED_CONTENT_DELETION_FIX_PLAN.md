# Published Content Deletion Fix

**Status:** Completed
**Owner:** Agent Platform and KasiTek Core
**Last updated:** 2026-08-31

## Objective

Ensure an approved published-post deletion is only reported as completed after the provider
confirms deletion. A provider rejection must fail the run, preserve the local post state, and
remain retryable.

## Checklist

- [x] Reproduce the production run and confirm the persisted provider result.
- [x] Trace approval resume, Core response, tool result, and completion message.
- [x] Make domain deletion failures fail the Core and Agent execution boundaries.
- [x] Add regression coverage for HTTP-200 domain failure and approved-action messaging.
- [x] Verify provider targeting for legacy and current Instagram connection metadata.
- [x] Run builds/tests, deploy the exact commit, and verify production state and health.
- [x] Record rollout, observability, documentation, and rollback evidence.

## Release record

Change: truthful approved published-content deletion results.
Owner: Agent Platform and KasiTek Core.
Risk: standard; affects approved external deletion flows across social providers.
Affected services and user surfaces: Agents API/worker, Core internal agent route, and
conversational approval responses.
Platform release version or release ID: commit `c341df9e`; Railway deployments Core
`4bda6c2b-9c19-4c2c-9d75-fcc5b9936c12`, Agents API `a4555574-772b-4c63-a263-3df2c9894047`, and
Agents worker `1505c7f8-7110-425d-82c9-6ebf750dc6a9`, all `SUCCESS`.
API/schema/migration changes: no schema or migration change; failed domain results become non-2xx
at the internal deletion boundary and are also rejected defensively by the Agent client.
Feature flag or rollout method: existing effect-execution and approval controls; the exact
committed tree was archived and uploaded to each affected Railway service.
Analytics events and success metrics: existing run, tool, approval, and effect lifecycle events;
success requires provider deletion confirmation, and failed provider attempts remain failures.
Logs, metrics, dashboards, and alerts: existing Core/Agent request and effect telemetry; Core now
emits a bounded `provider.call.failed` deletion event with provider, operation, scoped IDs, and
stable error code. No tokens or provider response bodies are logged, and no new dashboard is
required.
User, API, internal, and operational documentation: updated the internal action-platform design
and retained this completed release record; the public capability shape remains unchanged.
Validation evidence: red regression test failed before the fix, then the targeted Core-client and
runtime tests passed; the full Agents suite passed (80 files, 474 passed, 45 skipped), Agents build
passed, Core formatting/check passed, and Core suite passed (214 passed, 3 ignored). Production
Core health and Agents readiness both returned HTTP 200 after deployment, and Railway logs showed
the Agents worker in `RUNNING` state with no error-level results in the post-deploy sweep.
The affected post remains unchanged and published until the user starts a new approved deletion;
the provider delete itself was not reissued automatically during deployment verification.
Rollback or disable plan: disable external effects if needed, or redeploy the prior successful
artifacts. No data migration is required.
Post-release review date: 2026-09-01.
