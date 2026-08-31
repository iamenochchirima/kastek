# Agents PostgreSQL RLS rollout plan

**Status:** Active; first RLS tranche released

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
- [ ] Repair or quarantine ordinary legacy ownership violations and validate existing constraints.
- [x] Add RLS policies for memory and knowledge with a restricted-role integration suite
      ([091_memory_knowledge_rls.sql](../../../agents/migrations/091_memory_knowledge_rls.sql)).
- [ ] Extend RLS to conversations, messages, runs, credentials, approvals, effects, and worker
      tables in separate migrations.
- [ ] Document intentional cross-tenant operator and protected-system queries.
- [ ] Add isolation alerts, staged rollout, disable procedure, migration rollback, and post-release
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
operator-scope cases. The remaining 60 tables are not yet enabled.

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
