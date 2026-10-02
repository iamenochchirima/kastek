---
title: Agents tenant isolation inventory
owner: agent-platform
last_reviewed: 2026-09-01
---

# Agents tenant isolation inventory

Historical inventory. Counts and production checks below describe the recorded September baseline; recheck the current schema and runtime roles during Phase 0 before treating them as present verification.

This inventory covers the public schema of the Agents PostgreSQL database. It was checked against
the local migrated database on 2026-08-31 and the production database through the Agents API
container. The schema contains 72 base tables. Migrations 091 through 094, 097, and 100 through 103
now enable `FORCE ROW LEVEL SECURITY` on 71 runtime tables covering memory, knowledge,
conversations, messages, runs,
credentials, channels, effects, approvals, lifecycle sidecars, analytics, control-plane data. The
composition release also includes migration 104, which adds durable health columns to the already
RLS-protected remote MCP provider table.
`schema_migrations` is the only table without RLS because runtime and application roles have no
privilege to read or write it; migrations use a separate administrative database connection.
The three memory/knowledge ownership-presence constraints introduced in migration 057 were
validated by migration 095 after the production legacy-row audit found zero invalid rows.

## Ownership roots

| Root | Ownership rule | RLS consequence |
| --- | --- | --- |
| `agent_definitions` | Organization, except protected system definitions owned by `kasitek-system` | Organization context must allow an installation to use a protected system definition without exposing another organization's data. |
| `agent_installations` | Organization plus agent definition and version | Policy must validate all three relationships, not only `organization_id`. |
| `conversations` | Installation and organization | Conversation access is installation-local; child rows inherit conversation scope. |
| `agent_runs` | Installation, agent definition/version, conversation, and organization | Run context is the root for model, tool, budget, workflow, and event records. |
| `memory_records` | Agent plus installation/conversation/user namespace | Namespace policy remains an application concern; RLS supplies organization and installation defense in depth. |
| `knowledge_sources` | Agent plus optional installation | Platform knowledge may intentionally use a protected system definition; tenant knowledge must not. |
| `credential_vault`, `channel_credentials`, `integration_credentials` | Organization | These tables require strict runtime access and separate operator/migration ownership. |
| `agent_operator_*`, `audit_records`, `memory_deletion_jobs` | Organization or platform operator scope | Operator queries are intentional cross-tenant operations and need a separate controlled role/context. |

## Table classification

### Direct organization-owned tables

These tables carry `organization_id` and are covered by direct or parent-validated organization
policies:

`agent_definitions`, `agent_approval_records`, `agent_attachment_references`, `agent_effect_receipts`,
`agent_events`, `agent_export_requests`, `agent_handoff_offers`, `agent_handoff_requests`,
`agent_installation_connector_grants`, `agent_installation_credentials`, `agent_installation_deployments`,
`agent_installation_resource_grants`, `agent_installations`, `agent_kill_switches`, `agent_legal_holds`,
`agent_operator_commands`, `agent_operator_feature_flags`, `agent_operator_holds`,
`agent_operator_run_assignments`, `agent_principals`, `agent_readiness_evaluation_state`,
`agent_retention_policies`, `agent_runs`, `agent_schedules`, `agent_tool_grants`, `agent_usage_records`,
`analytics_outbox`, `audio_transcription_jobs`, `audit_records`, `channel_bindings`,
`channel_connections`, `channel_credentials`, `channel_pairing_tokens`, `conversation_summaries`,
`conversations`, `credential_vault`, `delivery_attempts`, `evaluation_runs`, `evaluation_scenarios`,
`integration_connections`, `integration_credentials`, `integration_oauth_states`,
`internal_calendar_events`, `kasiai_user_preferences`, `knowledge_chunks`, `knowledge_sources`,
`memory_consolidation_jobs`, `memory_deletion_jobs`, `memory_records`, `messages`, `model_calls`,
`participants`, `run_attempts`, `run_budget_parallel_leases`, `run_budget_reservations`, `run_budgets`, `run_steps`,
`run_workflow_checkpoints`, `run_workflow_state`, and `tool_invocations`.

The composition tables are also organization-scoped and parent-validated: `agent_skill_definitions`,
`agent_skill_versions`, `agent_version_skills`, `agent_mcp_providers`, `agent_mcp_provider_versions`,
`agent_version_mcp_providers`, and `agent_mcp_provider_rate_windows`.

The direct organization column must agree with the parent relationship. A policy should not trust a
child row's organization column without checking the parent for installation-, conversation-, run-,
agent-, and source-owned tables.

### Parent-owned tables and tables without a direct organization column

| Table | Parent path | Notes |
| --- | --- | --- |
| `agent_versions` | `agent_versions.agent_definition_id -> agent_definitions` | Agent definition owns versions. |
| `agent_client_assertion_replays` | `credential_id -> agent_installation_credentials -> agent_installations` | Replay protection is installation-scoped. |
| `agent_operator_notifications` | Platform operator projection | No tenant column; `FORCE ROW LEVEL SECURITY` makes it operator-only. |
| `agent_operator_projections` | Platform operator projection | Global projection; cross-tenant by design and operator-only under `FORCE ROW LEVEL SECURITY`. |
| `knowledge_chunks` | `source_id -> knowledge_sources` plus copied agent/install scope | It carries organization data, but both source and copied scope must agree. |
| `participants` | `conversation_id -> conversations` plus copied organization | It carries organization data; conversation is authoritative. |
| `conversation_summaries` | `conversation_id -> conversations` plus copied organization | It carries organization data; conversation is authoritative. |
| `schema_migrations` | Database metadata | Migration/operator role only; never runtime tenant data. |

### Explicit platform or control-plane exceptions

Protected system agent definitions are owned by `kasitek-system`, while their installations and
runtime rows carry the consuming organization's ID. Production currently has two such installation
rows and two matching platform knowledge sources; these are intentional system-agent exceptions,
not ownership corruption. Migrations 060 and 062 encode this exception and must be reflected in
RLS policies.

## Evidence and findings

- Local database role: `enoch`, superuser; this is unsuitable for an RLS test.
- Before the role-separation release, the production Agents runtime used `postgres`, a superuser
  with `rolbypassrls = true`. It now uses `kasitek_agents_app`, verified with `rolsuper = false`
  and `rolbypassrls = false`; the first RLS tranche is enabled only after context plumbing and
  restricted-role checks passed.
- Local database: one memory row and related legacy test rows failed the simple parent-organization
  query; they are not a safe basis for validation without scoped repair or quarantine.
- Production database: zero missing-agent rows and zero ordinary agent/organization mismatches.
  The two installation and two knowledge-source mismatches are the protected system-agent cases
  described above.
- Before migration 095, the memory and knowledge ownership-presence constraints were `NOT VALID`.
  The production audit found zero invalid rows, and migration 095 now records all three as
  validated. Local legacy fixture data is not production evidence and must not be promoted.
- Production migrations 091, 092, 093, 094, 097, and 100 through 104 are recorded in
  `schema_migrations`; all 71 runtime tables report both `relrowsecurity = true` and
  `relforcerowsecurity = true`.
  `schema_migrations` reports neither because its privileges are revoked from runtime and
  application roles.
- The transaction context integration test proves organization and actor settings are local to a
  transaction and do not leak across concurrent pool users. The restricted-role RLS suite proves
  cross-organization reads are hidden, cross-organization writes are denied, and explicit
  platform-operator scope can inspect both test tenants.
- Every long-running or one-shot Agents background entrypoint uses the fail-closed
  `runWithRequiredDatabaseContext` boundary. The source-level process matrix test covers Temporal
  activities/recovery, transcription, memory consolidation, Analytics publishing/readiness,
  Discord refresh, and KasiAi maintenance jobs. Missing scopes emit
  `kasitek.database.context_missing.count`; PostgreSQL `42501` denials emit
  `kasitek.database.authorization_failure.count` without SQL text or tenant payloads.

## Required sequence

1. Provision `kasitek_agents_runtime` and a separate login role without `SUPERUSER`, `BYPASSRLS`,
   `CREATEROLE`, or `CREATEDB`; move Agents API and worker connections off `postgres`. This role
   separation is complete; the remaining steps are required before additional RLS groups are
   enabled.
2. Add transaction-scoped organization and actor context to every API, worker, publisher, and
   operator database adapter. Connection-pool session state must never leak between tenants. The
   first context tranche is complete; legacy Temporal activities recover scope from their durable
   run when older workflow inputs lack it.
3. Repair or explicitly exempt any future legacy rows, keep ownership constraints validated, and
   add negative tests using the restricted role.
4. Enable RLS in small migrations, beginning with memory and knowledge, then conversations, runs,
   credentials, effects, approvals, and control-plane tables. Migrations 091 through 094 cover all
   runtime tables; only the administrative migration ledger is intentionally privilege-revoked.
5. Keep migrations and deliberate operator projections on a separately controlled role, with audit
   records for every cross-tenant operation.

## Operational verification and rollback

The RLS migration test asserts that the eight released policy migrations cover exactly 71 runtime
tables and that every policy table has both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL
SECURITY`. This is a source-control guard; it does not replace restricted-role data tests. The
integration suites remain the production-equivalent negative test for seeded cross-tenant rows.

Alert on a non-zero `kasitek.database.context_missing.count` in production and investigate any
unexpected `kasitek.database.authorization_failure.count` after grouping by service, release, and
deployment window. To disable a policy tranche, stop the rollout, deploy the last compatible
artifact, and apply a reviewed administrative migration that disables only that tranche. Do not
grant `BYPASSRLS` or migration privileges to `kasitek_agents_app`. Keep applied migrations and
unresolved rows in place during application rollback so the authorization boundary is not silently
weakened.
