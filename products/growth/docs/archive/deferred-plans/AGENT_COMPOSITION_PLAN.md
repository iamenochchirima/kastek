# Agent composition plan

**Status:** Active — implementation baseline and effective-config API released; editor and operations gates remain

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
6. [x] Run focused and full verification, deploy safe changes, and record remaining gates.
7. [x] Expose a sanitized effective configuration projection and bounded candidate-versus-deployed
   diff for release tooling; editor rendering and publication gating remain follow-up work.

## Verification

- [x] Type and schema tests reject unknown fields and preserve legacy versions.
- [x] Skill and provider tests cover matching, pinning, revocation, scope, size, timeout, and
  policy failures.
- [x] Draft evaluation tests prove no live delivery or live-memory mutation.
- [x] Agents typecheck, build, and targeted integration checks pass.
- [x] Effective configuration projection and version-diff route tests pass without exposing prompt,
  credential, endpoint, or workflow internals.
- [x] Production deployment and release metadata are recorded before enabling new behavior.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| User code execution | Defer until a separate sandbox threat model and isolation proof | Agent Platform | Decided |
| MCP provider authentication | Keep API-key/installation credentials first; inbound OAuth later | Agent Platform | Decided |
| Specification compatibility | New requests use strict `specVersion: 1`; historical JSON remains readable | Agent Platform | Decided |
| Skill matching | Deterministic metadata matching before any model-based selector | Agent Platform | Implemented |
| Remote provider rate limits and health | Atomic PostgreSQL fixed windows enforce limits across API/worker replicas; durable health checks fail closed before publication, pinning, and invocation | Agent Platform | Implemented with dashboard/allowlist follow-up |
| Draft execution | One bounded model call; no live run, tools, remote providers, knowledge, memory, or delivery | Agent Platform | Implemented |
| Effective configuration | Expose only sanitized runtime-relevant state and compare effective sections, not immutable version identity | Agent Platform | Implemented; editor integration remains |

## Notes and blockers

The provider allowlist and production alert-routing gates still need provider ownership decisions.
The durable health check, fail-closed runtime gate, and effective-config API are released; editor
integration, draft evidence, and broader organization-installed provider rollout remain gated.

## Release record

| Field | Decision |
| --- | --- |
| Change | Typed AgentSpec v1, versioned skills, reviewed remote MCP revisions, durable provider rate windows, isolated draft evaluation, and sanitized effective configuration/diff projection. |
| Owner | Agent Platform |
| Risk | high — new database policy tables and bounded calls to untrusted external providers; remote providers remain opt-in and explicitly pinned. |
| Affected services and user surfaces | Agents API, Agents worker/Temporal activities, Agents PostgreSQL, Agent version APIs, effective configuration/release tooling, evaluation APIs, and composition documentation. |
| Platform release version or release ID | `9e94c4cc`; `KASITEK_RELEASE_ID` and `KASITEK_COMMIT_SHA` are set to this SHA on API, worker, and MCP Gateway. |
| API/schema/migration changes | Migrations `100_agent_skills.sql` through `104_remote_mcp_health.sql`; new skills, provider, health, pinning, draft-run, and `GET /v1/agent-versions/{agentVersionId}/effective-config` routes. No new migration was required for the projection. |
| Feature flag or rollout method | No global enablement switch. Existing versions keep legacy behavior; typed versions, published skills, published providers, and explicit pins are opt-in. |
| Analytics events and success metrics | Draft execution is traced as `evaluation.draft`; provider discovery/invocation failures are structured and bounded. The read-only projection adds no new analytics event; adoption, rejection, latency, and draft funnel dashboards remain follow-up work. |
| Logs, metrics, dashboards, and alerts | Provider output is redacted and bounded; rate windows and health state are durable across replicas. Remote MCP operation counters/histograms and the provider runbook are released; hosted dashboards, alert routing, and allowlist ownership remain open before broad organization-provider rollout. |
| User, API, internal, and operational documentation | AgentSpec and composition API docs, effective-config contract, remote MCP provider runbook, plus the internal AgentSpec and tenant-isolation inventory are updated in this change. |
| Validation evidence | Full Agents suite: 635 passed, 84 skipped by existing integration gates across 108 passed and 27 skipped files; Agents typecheck/build and public docs build pass; workflow bundle compiles; focused effective-config, skills, provider, and REST conformance tests pass. Production migrations 100–104 are present, API/worker/Gateway deployments `8143b117-316c-481e-b870-975206a25c76`, `7e1ad93e-ef5e-4582-8805-de5afad5a805`, and `1893a570-333d-4c3c-b196-5f3ca035d2e1` are successful, the worker is running, all three release variables match `9e94c4cc`, and readiness is 200. The database-backed provider integration gate remains skipped locally because no isolated `AGENTS_DATABASE_URL` is configured; the generic migration runner remains blocked by pre-existing legacy fixture rows at migration 095. |
| Rollback or disable plan | Stop provider pinning and draft-route rollout, revoke provider versions, redeploy the previous artifact `271191c7`, and leave additive migrations in place. Apply reviewed administrative rollback only if a migration must be disabled. |
| Post-release review date | After production smoke verification and first provider/draft usage review. |
