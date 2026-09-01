# Agents PostgreSQL RLS rollout plan

**Status:** Active; all runtime policy tranches released, evidence closure pending

**Owner:** Agent Platform

**Last updated:** 2026-09-01

## Objective

Move the Agents runtime off the PostgreSQL superuser, establish transaction-scoped tenant
context, and enable row-level security as defense in depth for tenant-owned state without breaking
protected system-agent or operator workflows.

## Scope

- Inventory all Agents tables and parent ownership paths.
- Provision a restricted runtime group/login role and verify grants.
- Add a connection-safe context mechanism for organization and actor scope.
- Repair or explicitly classify legacy ownership exceptions.
- Enable RLS in small, reversible migration steps with restricted-role negative tests.

## Non-goals

- Replacing application authorization or repository predicates.
- Making platform operator projections tenant-local.
- Allowing the runtime role to run migrations or bypass RLS.

## Implementation checklist

- [x] Inventory the 64 public Agents tables and ownership paths
      ([agents-tenant-isolation-inventory.md](../../internal/architecture/agents-tenant-isolation-inventory.md)).
- [x] Audit production legacy ownership results and classify protected system-agent exceptions.
- [x] Add the non-login runtime group role and default grants
      ([090_agents_runtime_role.sql](../../../agents/migrations/090_agents_runtime_role.sql)).
- [x] Provision a restricted login role, update API/worker database URLs, and verify no
      application process uses `SUPERUSER` or `BYPASSRLS`.
- [x] Add transaction-scoped organization and actor context without pool leakage. API routes,
      background workers, publishers, Discord refresh, and Temporal activities now set transaction
      context; legacy activities recover it from their durable run ID
      ([context.ts](../../../agents/src/db/context.ts), [pool.ts](../../../agents/src/db/pool.ts)).
- [x] Audit ordinary legacy ownership violations and validate the existing memory/knowledge
      ownership-presence constraints. Production has zero invalid rows; migration 095 records the
      validation. Local legacy fixture rows remain outside production validation and must be
      recreated or explicitly quarantined before any local database is used as production data.
- [x] Add RLS policies for memory and knowledge with a restricted-role integration suite
      ([091_memory_knowledge_rls.sql](../../../agents/migrations/091_memory_knowledge_rls.sql)).
- [x] Extend RLS to conversations, messages, runs, and their direct projections in a separate
      migration with parent ownership checks and restricted-role coverage
      ([092_conversation_run_rls.sql](../../../agents/migrations/092_conversation_run_rls.sql)).
- [x] Document the released protected-system and explicit platform-operator query scope;
      migrations 093 and 094 now cover the remaining runtime table groups; `schema_migrations` is
      deliberately administrative and privilege-revoked from runtime roles.
- [x] Extend RLS to credentials, approvals, effects, channels, lifecycle sidecars, analytics, and
      remaining worker/control-plane tables in separate migrations
      ([093_identity_credentials_effects_rls.sql](../../../agents/migrations/093_identity_credentials_effects_rls.sql),
      [094_control_plane_and_lifecycle_rls.sql](../../../agents/migrations/094_control_plane_and_lifecycle_rls.sql)).
- [x] Extend RLS to parallel branch budget leases with run-parent validation
      ([097_parallel_branch_budget_leases.sql](../../../agents/migrations/097_parallel_branch_budget_leases.sql)).
- [x] Keep every policy table represented in the seeded restricted-role fixture source matrix
      ([rls-matrix.test.ts](../../../agents/test/rls-matrix.test.ts)).
- [ ] Execute the complete opt-in restricted-role matrix against an isolated
      production-equivalent database and exercise every background process type.
- [x] Make background database scope failures fail closed and add a source-level process matrix
      covering every long-running and one-shot Agents entrypoint
      ([background-database-context.test.ts](../../../agents/test/background-database-context.test.ts)).
- [x] Emit bounded database authorization and missing-context metrics, with an operator response
      documented in the database-isolation runbook.
- [x] Check in stable database-isolation events and the staged rollout, disable, rollback, and
      alert-routing contract ([agent-database-isolation.md](../../internal/runbooks/agent-database-isolation.md)).
- [ ] Execute and record the production rollback drill, durable alert notification, and post-release
      review evidence.

## Release record

Change: Restricted Agents runtime database role and staged PostgreSQL RLS rollout.

Owner: Agent Platform.

Risk: high. A database authorization policy can deny valid platform operations or expose tenant
data if context is wrong. The first release only provisions grants; it does not enable RLS.

Affected services and user surfaces: agents-api, agents-worker, Agents PostgreSQL, memory,
knowledge, conversations, model/tool execution, credentials, effects, approvals, and operator
recovery.

Platform release version or release ID: commit `ae97c7e5`; role-switch rollout completed in
Railway redeployments `5c41fb52-396f-449a-b77f-f09d42701c78` (API) and
`d4bcbb4a-5923-498b-9488-e700e55e8472` (worker).

API/schema/migration changes: additive migration 090 creates the `kasitek_agents_runtime` NOLOGIN
group role, grants current-table access, and sets default privileges. Login credentials are
provisioned outside source control.

Feature flag or rollout method: migrate role first with RLS disabled; switch API and worker URLs;
verify restricted-role smoke tests; enable RLS table groups only after context tests pass.

Analytics events and success metrics: restricted-role connection checks, RLS policy denials,
cross-tenant negative-test results, and scoped query failures. Do not log tenant data or secrets.

Logs, metrics, dashboards, and alerts: database authorization failures, context-missing failures,
cross-tenant test results, and migration status. Add alerts before enabling production policies.

User, API, internal, and operational documentation: update the tenant isolation inventory,
deployment topology, database recovery runbook, and audit checklist.

Validation evidence: inventory queries completed locally and in production; migration 090 applied
in production; API and worker were redeployed with the restricted login; the API connection reports
`kasitek_agents_app` with `rolsuper = false` and `rolbypassrls = false`; API live/ready checks
returned 200 and the worker reached `RUNNING`. This role-only release was followed by commit
`2031a0ca`, with API deployment `ba5855ff-be8a-43a5-b613-6433766a1421`, worker deployment
`e06cc572-bf76-4eca-b114-9b526183e085`, and Gateway deployment
`1b25b0c9-5284-40a9-94fb-53907b44ff79`, all successful. Migration 091 is recorded in production
and enables `FORCE ROW LEVEL SECURITY` on the four first-tranche tables. The scoped context test
passed; the restricted-role RLS suite passed its cross-tenant read, write-denial, and explicit
operator-scope cases. The remaining 39 tables are not yet enabled.

Rollback or disable plan: do not enable RLS until a restricted role and context mechanism are
verified. For a role-only rollout, restore the previous runtime URL while retaining the additive
group role. Never grant `BYPASSRLS` to the runtime role as a rollback shortcut.

Post-release review date: pending staged rollout evidence.

## Release record: first RLS tranche

Change: Add transaction-local tenant context and enable the first PostgreSQL RLS tranche for
memory and knowledge.

Owner: Agent Platform.

Risk: high. Policies can deny valid memory/knowledge operations when context is missing or can
misclassify protected system-agent rows if parent checks are incomplete.

Affected services and user surfaces: agents-api, agents-worker, MCP Gateway, Temporal activities,
memory retrieval/consolidation, knowledge ingestion, and Agents PostgreSQL.

Platform release version or release ID: commits `2031a0ca` and `b831e1c3`; the successful
compatibility deployments are API `0b66fd2a-0b73-4de9-ab68-86e0291e9d38`, worker
`de1d80af-bf6b-45d9-9a85-f6aee2e027bf`, and Gateway
`e730de6f-6571-4b04-9637-20b6ef034764`. The first attempted b831 deployments failed after clean
startup and were superseded by these successful redeployments.

API/schema/migration changes: migration 091 adds an operator-scope function and policies for
`memory_records`, `knowledge_sources`, `knowledge_chunks`, and `memory_deletion_jobs`, then
enables and forces RLS. Production records migration version `091`. Production migration
execution used the Railway database administrative container; no migration credential remains on
the API service.

Feature flag or rollout method: code deployed first; RLS enabled only after local context and
restricted-role checks passed. The remaining table groups stay disabled for staged rollout.

Analytics events and success metrics: not applicable for user analytics. Existing structured
database error telemetry and RLS negative-test evidence are the operational signals; no tenant data
is logged.

Logs, metrics, dashboards, and alerts: existing structured database and worker logs; targeted
checks covered context leakage and policy denials. Dedicated production RLS-denial alerting and a
database authorization dashboard remain open.

User, API, internal, and operational documentation: updated the tenant isolation inventory,
deployment topology, and this rollout plan. Public API behavior is unchanged.

Validation evidence: `pnpm exec tsc --noEmit`, full Agents suite (542 passed, 57 skipped), build,
the local transaction context integration test, and the local restricted-role RLS suite (3 passed).
Production API live/ready checks returned 200, Gateway ready returned 200, worker logs reported
`RUNNING`, and production inspection reported all four first-tranche tables with RLS and FORCE RLS.

Rollback or disable plan: stop new policy migrations, restore the prior application deployment if
needed, and disable only the affected table policies through a reviewed administrative migration.
Do not grant `BYPASSRLS` to the runtime role. A full rollback drill remains open before broader
table groups are enabled.

Post-release review date: 2026-09-08.

## Release record: fail-closed background database scope

Change: Reject long-running and one-shot Agents background work when the organization or actor
database context is absent, and emit bounded signals for PostgreSQL authorization failures and
missing context.

Owner: Agent Platform.

Risk: high. A missing scope must stop work rather than run against an ambient or cross-tenant
connection; an overly strict boundary can interrupt legitimate maintenance or recovery work.

Affected services and user surfaces: agents-api, agents-worker, Temporal activities, analytics
publisher and readiness sweep, memory consolidation, transcription, Discord refresh, KasiAi
maintenance, Agents PostgreSQL, and operator observability.

Platform release version or release ID: commit `d7ec1eb9`; Railway production redeployments API
`9fd17db5-3b3f-481d-b7d4-6c4b3e811650` and worker `acd88818-b92b-4a02-9aec-7720aef3df9f` both
reached `SUCCESS` on 2026-09-01. The immutable Railway artifact digests are API
`sha256:e9377a7e18ea9f60222f3d0104e647e13eb03ce797e372a80de8638661de5960` and worker
`sha256:f0f6c0d0b71d906130b6c18e3ee71334a0b3c528c0cb0a7001287365cfb3755a`.

API/schema/migration changes: no API or database schema changes. Runtime behavior and two
OpenTelemetry metric contracts changed; migrations 091-095 remain unchanged.

Feature flag or rollout method: deployed through the existing Railway production approval gate,
then redeployed after setting non-secret release metadata. `KASITEK_VERSION=0.1.0`,
`KASITEK_RELEASE_ID=d7ec1eb9`, `KASITEK_COMMIT_SHA=d7ec1eb9`, explicit production environment,
and distinct API/worker service names are now set on both services. The guard is active at the
listed background boundaries; no RLS bypass or runtime privilege was added. Rollout is limited
to the API and worker artifacts in this release.

Analytics events and success metrics: not applicable for user analytics. Operational success is
API and worker readiness, worker `RUNNING` state, zero unexpected context-missing failures, and
investigable authorization-failure counts partitioned by context presence. A real production
RLS-denial alert drill remains open and is not inferred from deployment success.

Logs, metrics, dashboards, and alerts: `kasitek.database.authorization_failure.count` and
`kasitek.database.context_missing.count` are documented in the observability guide and database
isolation runbook. Production durable dashboards and alert routing remain open; the debug exporter
is verification-only.

User, API, internal, and operational documentation: updated the tenant-isolation inventory,
observability guide, database-isolation runbook, architecture audit, and this rollout plan. Public
API behavior is unchanged.

Validation evidence: the targeted boundary and migration tests passed (`38/38`), affected worker
tests passed (`46/46`), the full Agents suite passed (`607 passed, 78 skipped`), typecheck and
build passed, and the migration matrix covers 64 protected runtime tables with
`schema_migrations` excluded. Both Railway redeployments report `SUCCESS` with one running
replica; worker logs show `state: 'RUNNING'`; the Gateway readiness endpoint returned `200`; and
the new API startup logs identify `kasitek-agents-api`, version `0.1.0`, release `d7ec1eb9`, and
commit `d7ec1eb9` instead of `unknown`. The API public health path is not exposed on the Core
domain, so its `404` there is not used as Agents API readiness evidence.

Rollback or disable plan: restore the previous compatible API and worker deployments if a valid
background path is rejected unexpectedly. Investigate and repair the missing scope at its caller;
do not grant `BYPASSRLS` or weaken the database role. Disable only the affected guard through a
reviewed code release, then rerun the restricted-role and worker recovery suites.

Post-release review date: 2026-09-08.

## Release record: legacy ownership constraint validation

Change: Validate the three memory and knowledge agent-definition ownership-presence constraints
after the production legacy-row audit.

Owner: Agent Platform.

Risk: standard. Validation is read-only with respect to valid rows, but migration failure must stop
the release if an unclassified legacy row is found.

Affected services and user surfaces: Agents PostgreSQL, agents-api, agents-worker, memory retrieval,
knowledge ingestion, and operator database diagnostics.

Platform release version or release ID: implementation commit `8fea9fae`; production migration
`095` is recorded in the Agents database.

API/schema/migration changes: additive migration 095 validates existing constraints from migration
057; it does not change the ownership rules or delete rows.

Feature flag or rollout method: run the production ownership audit first, then apply migration 095
through the administrative migration connection. Do not bypass validation or grant runtime roles
DDL privileges.

Analytics events and success metrics: not applicable for user analytics. Operational success is
zero invalid legacy rows and all three constraints reporting `convalidated = true`.

Logs, metrics, dashboards, and alerts: migration status and database authorization logs; a
dedicated alert for future ownership-audit failures remains open.

User, API, internal, and operational documentation: update the tenant isolation inventory and
architecture audit with the final migration evidence.

Validation evidence: migration test passed (`31 tests`); production migration 095 applied
successfully; production reported zero `NOT VALID` constraints and latest migration `095`; Agents
API live/readiness and MCP Gateway readiness checks returned `200`.

Rollback or disable plan: stop before applying migration 095 if the audit finds invalid rows;
quarantine or repair those rows through a reviewed administrative procedure. Constraint validation
does not require a destructive rollback.

Post-release review date: 2026-09-08.

## Release record: identity, credentials, channels, effects, and approvals tranche

Change: Extend tenant isolation to agent identity, version, installation, credential, channel,
usage, integration, effect, approval, schedule, kill-switch, and client-assertion replay records.

Owner: Agent Platform.

Risk: high. These tables contain credentials, external-channel bindings, and effect state. A
policy mistake could deny valid agent operation or expose a tenant's integration state.

Affected services and user surfaces: agents-api, agents-worker, MCP Gateway, channel adapters,
credential resolution, integration connections, schedules, effect reconciliation, approvals, and
Agents PostgreSQL.

Platform release version or release ID: migration `093`, implementation commit `41c8fc97`.

API/schema/migration changes: migration 093 adds parent-validated policies and `FORCE ROW LEVEL
SECURITY` for 23 identity, credential, channel, integration, effect, approval, schedule, and
replay tables. Protected system definitions and system tool grants remain readable where required;
mutations remain operator-only. No application service receives migration privileges.

Feature flag or rollout method: ownership audit first; apply the additive policy migration through
the Railway Agents database administrative container; verify restricted tenant and operator scopes
before allowing the application deployment to use the new boundary.

Analytics events and success metrics: not applicable for user analytics. Operational success is
zero production ownership mismatches, tenant read/write denials for cross-scope rows, and successful
credential/channel/effect smoke paths.

Logs, metrics, dashboards, and alerts: existing structured database authorization and runtime
error logs; restricted-role policy denials are expected in negative tests and must remain free of
credential values. Dedicated RLS-denial alerting remains open.

User, API, internal, and operational documentation: updated the tenant isolation inventory,
architecture audit, and this rollout plan. Public API behavior is unchanged.

Validation evidence: local restricted-role identity/credential/effect suite passed (`4 tests`);
the migration suite passed its 093 policy assertions. Production ownership audit returned zero
mismatches for the covered parent paths. Migration 093 is recorded in production, all 23 tables
report both RLS and FORCE RLS, the runtime role remains `rolsuper = false` and `rolbypassrls =
false`, and the production restricted-role probe hid cross-tenant rows while explicit operator
scope retained visibility. The compatible API, worker, and Gateway deployments from commit
`41c8fc97` reached `SUCCESS`: `b21843e1-66fe-4e8c-a684-e4718021fa79`,
`d190fd68-2bcc-4be6-8d04-c595ca1d16d3`, and
`d5092568-8f7e-48a5-ae42-cb6b271b090b`.

Rollback or disable plan: stop further policy migrations, restore the prior compatible application
deployment if needed, and use a reviewed administrative migration to disable only the affected
policy set. Never grant `BYPASSRLS` to the runtime role.

Post-release review date: 2026-09-08.

## Release record: lifecycle and control-plane tranche

Change: Extend tenant isolation to readiness, memory-consolidation, transcription, calendar,
preferences, audit, analytics outbox, retention, legal holds, feature flags, holds, and operator
control-plane records; revoke runtime access to `schema_migrations`.

Owner: Agent Platform.

Risk: high. These tables are used by background workers and operators. Incorrect lifecycle scope
could stall recovery; incorrect operator scope could expose cross-tenant operational data.

Affected services and user surfaces: agents-api, agents-worker, analytics publisher, Temporal and
recovery paths, memory/transcription workers, operator projections, retention/export workflows, and
Agents PostgreSQL.

Platform release version or release ID: migration `094`, implementation commit `41c8fc97`.

API/schema/migration changes: migration 094 adds parent-validated policies and `FORCE ROW LEVEL
SECURITY` for 15 remaining runtime tables. Tenant reads/writes are limited to the owning
organization or actor namespace; operator commands, exports, notifications, and projections are
operator-only. `schema_migrations` is not runtime data and has all privileges revoked from the
runtime group.

Feature flag or rollout method: apply after production ownership and role preflight; verify tenant,
second-tenant, and explicit operator transactions before service rollout. The migration is
additive and does not change public API contracts.

Analytics events and success metrics: no new user analytics event. Success is 63 of 64 public base
tables reporting RLS and FORCE RLS, no runtime access to `schema_migrations`, tenant filtering of
sidecars/outbox rows, and operator-only visibility for control-plane projections.

Logs, metrics, dashboards, and alerts: production health/readiness checks, database authorization
logs, worker state, outbox scope checks, and migration status. Dedicated RLS-denial dashboards and
alerts remain open; no tenant payloads are logged.

User, API, internal, and operational documentation: updated the tenant isolation inventory,
architecture audit, and this rollout plan. Public API behavior is unchanged.

Validation evidence: local lifecycle/control-plane restricted-role suite passed (`3 tests`), and
the migration suite includes 094 table/policy assertions. Production migration 094 is recorded.
Production inspection reports 64 public base tables, 63 with both RLS and FORCE RLS, and only
`schema_migrations` unprotected because both runtime and application roles lack table privilege.
The production restricted-role probe returned tenant-specific definitions/channels/effects/outbox,
no cross-tenant rows for an empty second organization, and full cross-tenant visibility only under
explicit operator scope. API and worker services were online during verification. The compatible
API, worker, and Gateway deployments from commit `41c8fc97` reached `SUCCESS`:
`b21843e1-66fe-4e8c-a684-e4718021fa79`, `d190fd68-2bcc-4be6-8d04-c595ca1d16d3`, and
`d5092568-8f7e-48a5-ae42-cb6b271b090b`.

Rollback or disable plan: stop new policy migrations, restore the prior compatible service
deployment if needed, and use a reviewed administrative migration to disable only the affected
policies or restore the prior privilege boundary. Do not grant `BYPASSRLS` to the runtime role.

Post-release review date: 2026-09-08.

## Release record: conversation and durable-run tranche

Change: Extend transaction-local tenant enforcement to conversations, messages, durable runs, and
their direct workflow, model, tool, delivery, attachment, handoff, assignment, and evaluation
projections.

Owner: Agent Platform.

Risk: high. Parent-scope policy mistakes can hide valid workflow state or permit a child record to
cross an installation, conversation, or run boundary.

Affected services and user surfaces: agents-api, agents-worker, MCP Gateway, Temporal activities,
conversation inboxes, model/tool execution, delivery, handoff, evaluation, and Agents PostgreSQL.

Platform release version or release ID: migration `092`; the compatible runtime is deployed from
`b831e1c3` on API `0b66fd2a-0b73-4de9-ab68-86e0291e9d38`, worker
`de1d80af-bf6b-45d9-9a85-f6aee2e027bf`, and Gateway
`e730de6f-6571-4b04-9637-20b6ef034764`.

API/schema/migration changes: migration 092 adds a transaction-local organization-scope helper,
parent ownership policies, and `FORCE ROW LEVEL SECURITY` for 21 conversation/run tables. It is
recorded in production as `092`; no migration credential remains on an application service.

Feature flag or rollout method: ownership audits and restricted-role tests ran before the additive
policy migration. Existing four-table RLS from 091 remained active; the remaining 39 tables stay
disabled for staged rollout.

Analytics events and success metrics: not applicable for user analytics. Operational success is
measured by zero ownership mismatches, restricted-role isolation tests, and absence of unexpected
authorization errors in service logs.

Logs, metrics, dashboards, and alerts: production API live/ready checks returned 200, Gateway
ready returned 200, worker state was `RUNNING`, and a production restricted-role probe verified
tenant filtering, wrong-context write denial, and operator scope. Dedicated RLS-denial alerting
and a database authorization dashboard remain open.

User, API, internal, and operational documentation: updated the architecture audit, tenant
isolation inventory, and this rollout plan. Public API behavior is unchanged.

Validation evidence: full Agents suite (`543 passed, 61 skipped`), typecheck, build, local
restricted-role suites (`7 passed` across both RLS suites), production ownership audit with zero
mismatches, production migration inspection, and the transactional production RLS probe. Probe
rows were rolled back and no `rls-prod-*` rows remain.

Rollback or disable plan: stop new policy migrations, restore the prior application deployment if
needed, and disable only the affected policy set through a reviewed administrative migration. Do
not grant `BYPASSRLS` to the runtime role. A complete rollback drill remains open before broader
table groups are enabled.

Post-release review date: 2026-09-08.
