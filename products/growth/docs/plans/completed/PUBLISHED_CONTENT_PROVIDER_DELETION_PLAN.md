# Published Content Provider Deletion Plan

**Status:** Completed — deployment follow-up is Meta reauthorization for existing connections
**Owner:** Core integrations
**Last updated:** 2026-08-31

## Objective

Make published Instagram deletion truthful and usable across the supported Instagram connection
types. A provider rejection must remain an unknown external state, while a connection whose OAuth
mode cannot delete media must be rejected before an invalid provider call is made.

## Checklist

- [x] Reproduce the production retry against the affected post and connection.
- [x] Confirm the saved post/job remains published after provider rejection.
- [x] Compare the legacy Meta OAuth scopes and Instagram deletion requirements.
- [x] Add regression coverage for required Meta deletion scope and direct Instagram Login limits.
- [x] Implement provider-aware deletion behavior and actionable connection requirements.
- [x] Verify local tests, build, production deployment, and post-deploy health.
- [x] Record release, observability, rollout, and rollback evidence, then archive this plan.

## Findings

Production retry at 2026-08-31 13:32 UTC reached the current Core deployment and returned HTTP 409
from the internal delete action. The Core trace recorded `provider.call.failed` for Instagram and
the post/job remained `PUBLISHED`. The affected connection uses the older Meta/Facebook Login path
and its OAuth scope builder currently requests `instagram_content_publish` but not
`instagram_manage_contents`, which the provider requires for Instagram media deletion. Direct
Instagram Login uses a different Graph host and the provider documentation does not support media
deletion through that login mode.

## Release record

Change: Provider-aware published Instagram deletion and required Meta deletion permission.
Owner: Core integrations.
Risk: standard; provider authorization and destructive-action behavior, with local state retained
on any unconfirmed provider result.
Affected services and user surfaces: Core social OAuth and provider deletion; Agents receives the
existing failure/success contract; published-content deletion through hosted agents and APIs.
Platform release version or release ID: no SemVer platform tag exists; record exact Railway
deployment IDs after promotion.
API/schema/migration changes: none.
Feature flag or rollout method: OAuth scope and provider adapter behavior roll out with the Core
artifact; existing connections require reauthorization to receive the new Meta permission.
Analytics events and success metrics: reuse existing provider/content deletion lifecycle events;
success means the provider confirms deletion, and failure means the local published state remains.
Logs, metrics, dashboards, and alerts: retain the existing bounded provider failure event and add
provider status/error classification without tokens, URLs containing credentials, or post bodies.
User, API, internal, and operational documentation: update the internal provider capability and
release documentation; user-facing errors will direct users to reconnect through Meta when needed.
Validation evidence: Rust formatting, check, and 222 Core library tests passed; all 475 runnable
Agents tests passed; Agents TypeScript build passed. Railway deployments succeeded for Core
(`e920a182-8c8a-4e8b-9fa9-2834b3a3b6e4`), Agents API
(`c4d051c7-5fe4-489c-9592-8ace3c63e640`), and Agents worker
(`c3309d09-8c5d-42f3-bee4-b46b920ad404`). Live Core and Agents readiness endpoints both returned
HTTP 200, and the worker reported `RUNNING`. A destructive provider smoke test was not performed;
the affected legacy token must first be reauthorized through Meta to receive the new scope.
Rollback or disable plan: revert the Core artifact; no migration rollback is required. Existing
connections and local published records remain intact because local mutation is gated on provider
confirmation.
Post-release review date: one business day after deployment and after a real Instagram deletion
smoke test.
