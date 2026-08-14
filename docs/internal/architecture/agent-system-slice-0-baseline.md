---
title: Agent-system Slice 0 baseline
slug: /architecture/agent-system-slice-0-baseline
sidebar_position: 6
---

# Agent-system Slice 0 baseline

**Recorded:** 2026-08-13
**Blueprint:** [Agent system execution blueprint](../../../KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md)

This is an evidence inventory, not a claim that the target architecture is
complete. It maps the August 2026 implementation to the canonical blueprint so
subsequent slices can replace partial paths without preserving them by accident.

## Current implementation map

| Blueprint concern | Present implementation | Baseline classification |
| --- | --- | --- |
| Definitions, versions, installations, grants | `agents/migrations/001`, `007`, `017`; `AgentRepository`; `ToolGrantRepository`; `agents/src/http/app.ts` | Partial: installation lifecycle and per-tool grants exist, but there are no installation principals, named runtime credentials, resource constraints, or token exchange. |
| Durable runs and Temporal | `RunRepository`, run attempts/steps/events migrations, `temporal/{workflows,activities,worker}.ts` | Partial: shared durable run foundation exists; the required universal invocation/effect and recovery contract does not. |
| Capability registry and approvals | `agents/src/tools/{types,registry,redaction}.ts`, tool-invocation repository, workflow approval signal | Partial: JSON-schema tool validation and argument hashes exist, but no authoritative cross-surface capability manifest or central policy decision exists. |
| Model gateway | `agents/src/model/*`, credential vault, model-call repository | Implemented foundation: OpenRouter-compatible, OpenAI, Anthropic, and Gemini adapters with isolated runtime credential resolution and metering records. |
| Conversations, channels, knowledge, memory | migrations `003`, `008`, `009`, `012`, `018`–`026`; repositories; `channels/*`; `memory/*`; `knowledge/*` | Partial: durable browser/WhatsApp foundations and scoped stores exist; channel coverage, consent lifecycle, and complete isolation/retention gates remain. |
| KasiAi product surface | protected system installation migration/bootstrap, release gate/evaluations, client Agents/KasiAi routes | Partial: a grounded read-only release foundation exists; shared real capability actions and full product experience do not. |
| Agent-to-core boundary | `agents/src/core/client.ts`; core `controllers/agent_internal.rs` | Obsolete/partial: a static deployment bearer token protects narrow read/channel endpoints. It must be replaced with per-invocation asymmetric delegation and typed domain handlers. |
| Core public API | existing `controllers/public.rs` and `services/public.rs` | Obsolete naming for this purpose: these are anonymous website quote/waitlist handlers, not the developer `/v1` API. |
| Core composition and domain boundary | `src/main.rs`, `routes.rs`, controller/service modules, global `db/models.rs` | Missing target structure: core remains a working controller/service modular monolith; `bootstrap`, normalized identity, domain modules, capabilities, and `api::public_v1` have not been introduced. |
| Product/admin surfaces | direct product routes under `/api/*`; admin Next app with core proxy routes | Partial: existing operations screens and product adapters exist; the protected operator read-model/command boundary is not implemented. |

## Legacy-path check

`./scripts/check-no-legacy-bot-references.sh` passed on 2026-08-13. It scans
live core/client source and generated database types for `/api/bots`, legacy bot
models, and old n8n bot credentials. No legacy route, fallback, or dual-write
path was found by that check.

## Local development and health model

`scripts/run_local_stack.sh` defines separate `core`, `agents-api`,
`agents-worker`, client, admin, tenant, and optional local Temporal processes.
The Agent API exposes `/health/live` and `/health/ready`; core exposes `/health`.
The API and worker use a dedicated Agent Platform database and Temporal mode is
configured through `agents/.env`. The script is the documented launcher, but
an authenticated full-stack smoke could not run in the current environment;
see `BLOCKERS.md`.

## Architecture records

The current approved direction is represented by the canonical blueprint,
capability/MCP architecture draft, and `action-platform-technical-design.md`.
Existing Agent Platform ADRs record the runtime, Temporal, database, provider,
credential, read-boundary, and channel decisions. No additional ADR was needed
for this reconciliation.

## Verification evidence

| Command | Result |
| --- | --- |
| `cd agents && pnpm test && pnpm build` | Passed: 70 tests passed; 21 database/integration tests skipped without an isolated database. |
| `cd server && cargo fmt --check && cargo check -p kasitek-core && cargo test -p kasitek-core` | Passed: 59 tests passed; 2 seeded-database tests ignored. |
| `./scripts/check-no-legacy-bot-references.sh` | Passed. |
| Client/admin lint and production build | Pending blockers B-001, B-002, and B-004. |
| Database/Temporal/authenticated browser smoke | Pending blocker B-003. |

## Evidence format

Every completed slice records: migration or schema change, API/contract path,
test/verification command and result, and commit hash. A checkbox is checked
only when that evidence exists.

## Follow-up verification — 2026-08-14

The local stack was started with core, Agent API, Temporal worker, MCP gateway,
client, and admin processes. Core and Agent/gateway health endpoints returned
successfully. `pnpm run test:e2e:local` passed on isolated `4110/4210` and
standard `4100/4200` Agent/gateway ports, covering credential exchange,
filtered discovery, REST idempotency, durable execution, MCP authentication,
protocol negotiation, and tool acceptance. A temporary verified product
session rendered `/agents` with HTTP 200 and a local admin principal rendered
`/dashboard` with HTTP 200; the temporary product session was deleted after
the check. The authenticated route exposed and fixed a server-rendering bug in
`KasiAiChat` where `window.location` was read during SSR. Browser automation,
provider recovery, seeded core fixtures, and isolated Redis replay remain
open in `BLOCKERS.md`.
