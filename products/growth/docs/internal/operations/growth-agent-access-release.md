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

## Read-result access references

Owner: iamenochchirima. Risk: standard. The Growth capability endpoint supports negotiated private
`access-v1` references for canonical reads. Growth keeps the returned value and existing published
operation descriptors unchanged. The additive Growth Prisma migration
`20261103100000_growth_read_access_handles` widens the existing `GrowthAgentSourceHandle` ID
constraint for two private reference namespaces and preserves existing source handles. A retry with the same operation identity and changed
result or source scope is rejected. Resource checks cover the stored read scope and current
entitlements, with reporting-scope checks that do not rerun reports.

The focused signed HTTP/PostgreSQL checks cover pre-chunk post references, old-worker response
compatibility, receipt replay, stable scope reuse, user and binding isolation, entitlement and
resource withdrawal, and an Inbox preview whose original message is deleted. They do not establish
live-provider, production, or hosted behavior. API typecheck and product boundary checks are recorded
in the local audit. New analytics events, logs, metrics, Collector settings and alerts: not applicable.

Apply the Growth migration, then roll out the Growth endpoint before workers that request `access-v1`.
Stop new negotiated reads
before rolling back the endpoint, and retain compatible Growth and Agents workers until accepted
references have settled. Keep the widened constraint and reference rows during rollback; existing
action reviews and receipts are preserved. Production release ID,
rollout, rollback demonstration and review date are not applicable until separately authorized.

## Reviewed-effect status scope

Owner: iamenochchirima. Risk: standard. The Growth endpoint accepts a separate
`effect-status-v1` observation on canonical or retained draft review/commit calls. It stores the
saved review identity in the existing private handle namespaces. The matching Agents worker keeps
the exact native receipt, gives models only a saved status and opaque review reference, and checks
the retained recipient/provider audience. The observation does not authorize the private review
body or the current content of a business record. Embedded staging-transfer responses use
`access-v1` with current owner, state and expiry checks. Direct Growth REST behavior is unchanged.

The controlled worker fixture covers a saved draft after a lost commit acknowledgement, the model
projection, private native receipt, retained history and current entitlement/provider denial. A
separate owned Growth database check covers staging owner, inactive state and expiry. There is no
live-provider or hosted deployment claim. New analytics, logging, metrics, dashboards and alerts:
not applicable; existing operation and review receipts remain. Apply the existing Growth handle
migration and Agents schema107 first, then deploy the matching Growth endpoint before the worker.
Stop new negotiated actions and retain a compatible worker until accepted work settles before
rollback; do not delete receipts or replay an unknown effect. Production release identity, rollout,
rollback demonstration and post-release review date remain unassigned.

## Reviewed resource revisions

Owner: iamenochchirima. Risk: standard. The additive
`20261103120000_agent_review_row_versions` migration adds private bigint revisions and update
triggers to Conversation, ExternalConnection, SocialPost, SocialChannelConnection, WhatsappContact
and WhatsappContactListMembership. Prisma records the fields; existing `updatedAt` timestamps keep
their audit meaning. Every writer advances the relevant revision, and overflow rejects the update.
Review snapshots hold revisions as exact decimal strings or bind them into account digests, including
the older draft-review path. Existing unstarted reviews without the new snapshot contract require a new review; started and
uncertain effects keep their original identity and receipt-only reconciliation. A remotely accepted
published edit that cannot be finalized locally remains uncertain and cannot be resent under a new
identity by reconciliation. Ordinary product clients that use only `expectedUpdatedAt` retain that timestamp check;
they do not gain a revision-based compare-and-swap precondition from this change.

Controlled PostgreSQL fixtures cover two simultaneous reviewed conversation writes with the same
millisecond timestamp, an ordinary writer changing a reviewed post, exact values above JavaScript's
safe integer range, overflow, stale old reviews and recovery of a prior draft receipt. The provider
fixture confirms a changed post after remote acceptance remains uncertain without a second send.
The existing older draft-review fixture checks an unchanged-timestamp account edit, stale legacy
approval and lost-reply receipt recovery. A signed worker fixture checks one saved draft after a lost
acknowledgement.
These checks do not establish live-provider or hosted behavior. New analytics, logs, metrics,
Collector settings, dashboards and alerts: not applicable; existing review events remain.

Pause new reviewed admissions and commits, settle or preserve existing effects, and apply the
additive migration before the matching Growth API. Resume only with the revision-aware API. Keep
the columns, triggers and receipts on rollback, and keep reviewed writes paused if the former API is
restored because it uses timestamp-only preconditions. Never replay an uncertain effect to recover
it. Hosted release ID, deployment, rollback demonstration and post-release review remain unassigned.
