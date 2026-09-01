# Agent composition plan

**Status:** Active — implementation baseline complete; release verification in progress

**Owner:** Agent Platform

**Last updated:** 2026-09-01

## Objective

Give agent versions one typed, versioned composition contract, then use that contract to add
reusable skills, reviewed remote MCP providers, and isolated draft evaluation. Existing published
versions must keep their historical behavior while new specifications fail closed on unknown
fields.

## Scope

### Included

- A strict versioned `AgentSpec` compiler for new agent-version requests.
- Skill identity, version pinning, deterministic matching, and bounded context loading.
- Reviewed remote MCP provider manifests with pinned tool schemas and scoped invocation.
- Draft evaluation that executes deterministic scenarios against a candidate version without live
  channel delivery or live-memory mutation.
- Release, migration, authorization, telemetry, and documentation evidence for each slice.

### Excluded

- Arbitrary user code, shell commands, browser automation, or a sandbox. That is a separate future
  security project.
- Inbound MCP OAuth. API-key and existing installation-credential flows remain the current
  provider-authentication path.
- Rewriting historical `agent_versions` rows or changing their runtime meaning.

## Context and constraints

- Existing versions store broad `configuration` and `policy` JSONB records and must remain
  readable.
- The runtime must continue to enforce platform safety policy after user configuration, skill
  selection, and provider manifests are compiled.
- Every skill, provider, tool, evaluation, memory read, and draft run remains organization-scoped.
- Remote providers are untrusted dependencies. Their schemas, output size, timeouts, egress, and
  credentials must be bounded before a user can invoke them.

## Implementation plan

1. [x] Define the strict `AgentSpec` schema and compile typed requests into the existing immutable
   version record without changing historical versions.
2. [x] Add skill records, version pinning, deterministic matching, and bounded context loading.
3. [x] Add reviewed remote MCP provider manifests, revision pinning, and a safe invocation adapter.
4. [x] Add isolated draft-run and deterministic evaluation execution with persisted evidence.
5. [x] Update user/API/internal documentation, metrics, runbooks, and release records.
6. [ ] Run focused and full verification, deploy safe changes, and record remaining gates.

## Verification

- [x] Type and schema tests reject unknown fields and preserve legacy versions.
- [x] Skill and provider tests cover matching, pinning, revocation, scope, size, timeout, and
  policy failures.
- [x] Draft evaluation tests prove no live delivery or live-memory mutation.
- [x] Agents typecheck, build, and targeted integration checks pass.
- [ ] Production deployment and release metadata are recorded before enabling new behavior.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| User code execution | Defer until a separate sandbox threat model and isolation proof | Agent Platform | Decided |
| MCP provider authentication | Keep API-key/installation credentials first; inbound OAuth later | Agent Platform | Decided |
| Specification compatibility | New requests use strict `specVersion: 1`; historical JSON remains readable | Agent Platform | Decided |
| Skill matching | Deterministic metadata matching before any model-based selector | Agent Platform | Implemented |
| Remote provider rate limits | Atomic PostgreSQL fixed windows enforce limits across API/worker replicas; health/canary policy remains an operations gate | Agent Platform | Implemented with follow-up |
| Draft execution | One bounded model call; no live run, tools, remote providers, knowledge, memory, or delivery | Agent Platform | Implemented |

## Notes and blockers

The provider allowlist, external health checks, and production rollout gates still need provider
ownership decisions. Broader organization-installed provider rollout remains gated.

## Release record

| Field | Decision |
| --- | --- |
| Change | Typed AgentSpec v1, versioned skills, reviewed remote MCP revisions, durable provider rate windows, and isolated draft evaluation. |
| Owner | Agent Platform |
| Risk | high — new database policy tables and bounded calls to untrusted external providers; remote providers remain opt-in and explicitly pinned. |
| Affected services and user surfaces | Agents API, Agents worker/Temporal activities, Agents PostgreSQL, Agent version APIs, evaluation APIs, and composition documentation. |
| Platform release version or release ID | Pending the release commit; runtime metadata must identify the exact commit on API and worker. |
| API/schema/migration changes | `agents/migrations/100_agent_skills.sql`, `101_remote_mcp_providers.sql`, `102_draft_evaluation_mode.sql`, and `103_remote_mcp_rate_limits.sql`; new skills, provider, pinning, and draft-run routes. |
| Feature flag or rollout method | No global enablement switch. Existing versions keep legacy behavior; typed versions, published skills, published providers, and explicit pins are opt-in. |
| Analytics events and success metrics | Draft execution is traced as `evaluation.draft`; provider discovery/invocation failures are structured and bounded. Adoption, rejection, latency, and draft funnel dashboards remain follow-up work. |
| Logs, metrics, dashboards, and alerts | Provider output is redacted and bounded; rate windows are durable across replicas. Provider health dashboards, alerts, and runbook evidence remain open before broad organization-provider rollout. |
| User, API, internal, and operational documentation | AgentSpec and composition API docs plus the internal AgentSpec and tenant-isolation inventory are updated in this change. |
| Validation evidence | Full Agents test suite and typecheck/build pass; focused skills/provider integration tests pass with local PostgreSQL migrations. The generic migration runner remains blocked by pre-existing legacy fixture rows at migration 095. |
| Rollback or disable plan | Stop provider pinning and draft-route rollout, revoke provider versions, deploy the previous artifact, and leave additive migrations in place. Apply reviewed administrative rollback only if a migration must be disabled. |
| Post-release review date | After production smoke verification and first provider/draft usage review. |
