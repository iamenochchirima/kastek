---
title: Agents tenant isolation inventory
owner: agent-platform
last_reviewed: 2026-08-31
---

# Agents tenant isolation inventory

This inventory covers the public schema of the Agents PostgreSQL database. It was checked against
the local migrated database on 2026-08-31 and the production database through the Agents API
container. The schema contains 64 base tables. RLS is currently disabled on all of them.

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

These tables carry `organization_id` and should receive a direct organization policy after the
runtime context mechanism exists:

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
`participants`, `run_attempts`, `run_budget_reservations`, `run_budgets`, `run_steps`,
`run_workflow_checkpoints`, `run_workflow_state`, and `tool_invocations`.

The direct organization column must agree with the parent relationship. A policy should not trust a
child row's organization column without checking the parent for installation-, conversation-, run-,
agent-, and source-owned tables.

### Parent-owned tables and tables without a direct organization column

| Table | Parent path | Notes |
| --- | --- | --- |
| `agent_versions` | `agent_versions.agent_definition_id -> agent_definitions` | Agent definition owns versions. |
| `agent_client_assertion_replays` | `credential_id -> agent_installation_credentials -> agent_installations` | Replay protection is installation-scoped. |
| `agent_operator_notifications` | Platform operator projection | No tenant column; keep outside tenant RLS or add an explicit projection scope. |
| `agent_operator_projections` | Platform operator projection | Global projection; cross-tenant by design and operator-only. |
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
- Production Agents runtime role: `postgres`, superuser with `rolbypassrls = true`; RLS would be
  bypassed until the service connection is moved to a restricted login role.
- Local database: one memory row and related legacy test rows failed the simple parent-organization
  query; they are not a safe basis for validation without scoped repair or quarantine.
- Production database: zero missing-agent rows and zero ordinary agent/organization mismatches.
  The two installation and two knowledge-source mismatches are the protected system-agent cases
  described above.
- Existing ownership constraints for memory and knowledge are `NOT VALID`, so they protect new
  writes but do not prove all legacy rows are clean.

## Required sequence

1. Provision `kasitek_agents_runtime` and a separate login role without `SUPERUSER`, `BYPASSRLS`,
   `CREATEROLE`, or `CREATEDB`; move Agents API and worker connections off `postgres`.
2. Add transaction-scoped organization and actor context to every API, worker, publisher, and
   operator database adapter. Connection-pool session state must never leak between tenants.
3. Repair or explicitly exempt legacy rows, validate ownership constraints, and add negative tests
   using the restricted role.
4. Enable RLS in small migrations, beginning with memory and knowledge, then conversations, runs,
   credentials, effects, approvals, and control-plane tables.
5. Keep migrations and deliberate operator projections on a separately controlled role, with audit
   records for every cross-tenant operation.
