---
title: Growth agent access release record
owner: engineering
last_reviewed: 2026-11-01
---

# Growth agent access release record

Change: restore Growth OAuth MCP and canonical REST with equivalent direct internal execution,
exact action reviews, delegated credential lifecycle and bounded media/results.

Owner: Growth engineering; deployment and provider acceptance remain with the owner.

Risk: high. Delegated access can read customer data and perform explicitly reviewed effects.

Affected services and user surfaces: Growth API, web, database, shared Growth operation/review
contracts, signed embedded Agents integration; Developers MCP, OAuth consent and action reviews.
Standalone Agents identity, data and deployment remain separate.

Platform release version or release ID: candidate `growth-agent-access-2026-11-01`, not a deployed
platform release or tag. `VERSION` remains unchanged. Deployment commit SHA, immutable artifact
IDs, final SemVer and configuration revision must be recorded before promotion. Typed draft
writes now return an approval workflow and typed reads share canonical data visibility; consumers
must review this behavior change before rollout.

API/schema/migration changes: OAuth discovery/authorize/register/token/revoke and consent APIs;
canonical `/mcp`, `/v1/operations`, operation receipts and browser review APIs; typed aliases share
authority and dispatch. Additive migrations `20261101130000_growth_oauth`,
`20261101140000_growth_operation_reviews` and `20261101150000_growth_media_transfers`.
Analytics additionally requires `services/analytics/migrations/20261101160000_growth_agent_access.sql`
for the existing producer's Growth namespace, independently of Growth migrations. The three additive Growth migrations were applied to the current local API database on port `5433`
for local restoration, without destructive changes. Production and the separate Analytics database
were not migrated by this local step.

Feature flag or rollout method: production requires explicit agent-access/effects flags. Enable
reads and reviewed drafts in an owned workspace first; enable external effects separately after
provider acceptance. See [operations](./growth-agent-access.md). Production is not deployed by
this record, and no hosted OAuth client connection is claimed.

Analytics events and success metrics: registered `growth.agent.access@1`, registry version
`20261101.1`, records OAuth granted/revoked and operation review/execution outcomes. Review state
and outbox events share a transaction; the existing publisher recovers OAuth events from durable
connection timestamps. Only bounded kind/action/operation/outcome attributes are sent. Queued
publication reports admitted, never published. Reuse `public_api_requests` usage separately.
Growth engineering owns connection/revocation success, approved-to-succeeded review rate,
uncertain outcomes and operation latency. Hosted dashboards/thresholds remain deployment work;
the existing ingestion-token worker configuration is required.

Logs, metrics, dashboards, and alerts: bounded OAuth lifecycle logs, MCP operation duration/outcome,
canonical audit/usage rows, review states and webhook enqueue failures. Credentials and customer
message bodies are excluded from these log payloads. Existing Collector revision, OTLP endpoint
and service/release identity are reused, with no exporter/configuration change; new hosted
retention/alerts are not applicable to local validation and must be recorded on deployment.
Exporter rollback is unchanged from the existing observability runbook.

User, API, internal, and operational documentation: public MCP, Agent REST, connection guide and
Public API v1; internal Growth agent execution, agent-access operations, this release record;
feature map includes consent and generic operation review entry points. No strategy/roadmap was
added to live navigation.

Validation evidence: final full Growth API run passed 165 tests with zero failures; 52 optional
integration checks requiring other service fixtures were skipped. The official SDK's actual OAuth
state machine passed discovery, DCR, PKCE, consent, code redemption, token persistence, refresh
and revocation. Its content fixture covers all 44 schemas, media upload/finalization, reviewed
create/update, scheduling/rescheduling/unscheduling/cancellation and publication/status/replay.
The real provider adapter used an intercepted deterministic response, persisted the confirmed
fixture external ID and made one provider call. Nonempty customer, contact, Inbox, booking,
campaign, template and connection reads match REST/internal/MCP results; connection sync-owned
timestamps are excluded from comparison. Reporting uses its separate gateway fixture.

The shared worker/provisioning suite passed 28 tests with zero skips, including signed child
review routing, current canonical prepare/approval/commit and lost acknowledgement recovery.
Growth managed setup revision/queue checks passed seven tests with zero skips. The browser
suite passed eight tests: three widths, both themes, keyboard/focus/loading/error retention,
API-key scopes, exact previews, revocation, expiry/rejection and approval-to-completion polling.
Screenshots were inspected. Local runtime health and same-origin discovery/MCP challenge passed;
all four agents in the selected local test workspace reported ready on revision6 during the initial restoration.

Shared contracts, Growth API/web and affected Agents builds/types, web lint, Prisma validation,
OpenAPI/routes, Analytics registry and import-boundary checks passed. Both public and internal
documentation sites built with their pinned Node22 isolated dependencies and unchanged lockfiles.
The local audit uses source diffs, test output and saved artifacts; independent peer safety
reviews ran, without a claim of a full transcript or cross-model audit. Evidence pointers are
`.audit/growth-restoration-checkpoint.txt` and `.audit/growth-mcp-rest-parity.tsv`.

Managed defaults, publication and policy now use revision8; the signed adapter uses release5. Retained
revisions2–7 map to their exact publications. New setup and explicit upgrades derive the current
revision from the publication; retries keep their queued target. The initial local workspace was explicitly upgraded
through signed provisioning; customized selections and existing tasks remain pinned. No production
artifact has been promoted or merged. Hosted client acceptance, live provider formats/permissions
and paid model evaluations remain separate. Small local direct/SDK latency samples are a baseline,
not a latency guarantee. Some list handlers still fetch workspace collections before slicing.

Rollback or disable plan: disable external effects, then agent access if required; revoke affected
connections/keys. Existing effects cannot be undone by a flag. Roll back matching API/web artifacts
without dropping additive schema, review receipts, analytics outbox/event receipts or queued-work authority. Reconcile uncertain
outcomes before enabling retries. No destructive down migration is part of this change.

Post-release review date: not applicable until an owner schedules a deployment; deployment
owner must set a dated review before promotion.
