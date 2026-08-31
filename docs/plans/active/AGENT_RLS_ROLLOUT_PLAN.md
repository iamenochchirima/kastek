# Agents PostgreSQL RLS rollout plan

**Status:** Active; runtime role separated

**Owner:** Agent Platform

**Last updated:** 2026-08-31

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
- [ ] Add transaction-scoped organization and actor context without pool leakage.
- [ ] Repair or quarantine ordinary legacy ownership violations and validate existing constraints.
- [ ] Add RLS policies for memory and knowledge with a restricted-role integration suite.
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
returned 200 and the worker reached `RUNNING`. All tables still report RLS disabled, as intended
until transaction context and policies are released.

Rollback or disable plan: do not enable RLS until a restricted role and context mechanism are
verified. For a role-only rollout, restore the previous runtime URL while retaining the additive
group role. Never grant `BYPASSRLS` to the runtime role as a rollback shortcut.

Post-release review date: pending staged rollout evidence.
