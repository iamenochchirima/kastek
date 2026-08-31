# KasiAi content tool loop fix

**Status:** Complete

**Owner:** platform-ops

**Last updated:** 2026-08-31

## Objective

Ensure a successful KasiAi content-draft write produces a final response instead of repeating
content tools until the bounded tool or token budget is exhausted.

## Scope

### Included

- Compact model-facing projections for workspace connections and content results.
- An explicit successful completion marker for draft create/update operations.
- KasiAi guidance to stop after a successful draft write.
- Production deployment and protected KasiAi version rollout.

### Excluded

- Publishing or scheduling behavior.
- Provider credentials, database schema, and migration changes.
- Changes to the bounded execution limits themselves.

## Context and constraints

- The failing run had four successful content operations, then attempted a fifth tool call and hit
  the configured `maxToolCalls` limit of four.
- Full connection and post responses were being replayed into each subsequent model context,
  increasing input tokens on every iteration.
- Production does not synchronize protected KasiAi instructions during service startup; the
  explicit release command is required.

## Implementation plan

1. [x] Inspect the failed run trace and identify the repeated tool/budget path.
2. [x] Add compact connection/content projections and successful draft completion markers.
3. [x] Update the protected KasiAi instructions and regression coverage.
4. [x] Deploy Agents API and Worker, then release and roll out KasiAi.
5. [x] Verify builds, targeted tests, production health, and release-gate evidence.

## Verification

- [x] Agents TypeScript build passes.
- [x] Targeted tests pass: 25 tests across content capability, capability surface, Core adapter,
  and runtime suites.
- [x] Full Agents suite: 456 passed, 45 skipped; two route-count assertions fail because a
  separate committed route addition changed their expected counts.
- [x] Agents API deployment `769487af-698a-4ea4-9874-b90c4d7aa263` succeeded.
- [x] Agents Worker deployment `18560430-bdef-4d4e-837f-68cbef269795` succeeded.
- [x] KasiAi release gate passed; version `6` was released and rolled out to two installations.
- [x] Core health endpoint returned `status: ok` after deployment.
- [ ] A new external channel message was not sent by the release operator; retry the user’s
  request in the channel for final end-to-end confirmation.

## Release record

| Field | Decision |
| --- | --- |
| Change | Stop repeated KasiAi content-tool calls after successful draft writes and reduce model-facing tool payloads. |
| Owner | platform-ops |
| Risk | standard; Agents runtime response projection and protected prompt update |
| Affected services and user surfaces | Agents API, Agents Worker, KasiAi chat, content draft tools |
| Platform release version or release ID | commit `a972b67f`; API deployment `769487af-698a-4ea4-9874-b90c4d7aa263`; Worker deployment `18560430-bdef-4d4e-837f-68cbef269795`; KasiAi version `6` |
| API/schema/migration changes | No API or database migration; model-visible tool results gain `operation` and `completed` fields for draft writes. |
| Feature flag or rollout method | Not applicable; existing Agents deployment and explicit protected KasiAi rollout |
| Analytics events and success metrics | No new event; existing run status, tool-call count, token usage, and failure telemetry are sufficient. |
| Logs, metrics, dashboards, and alerts | Existing bounded run failure and tool/model telemetry; no new signal required. |
| User, API, internal, and operational documentation | `agents/docs/THREAT_MODEL.md` updated; this release record added. |
| Validation evidence | Targeted tests and build passed; production deployments succeeded; KasiAi release gate passed; Core health returned OK. |
| Rollback or disable plan | Redeploy the prior Agents API/Worker commit and roll KasiAi back to the prior published version if the projection or completion behavior causes regressions. |
| Post-release review date | 2026-09-01 |

## Notes and blockers

The failed run is terminal and will not replay automatically. A fresh user message is required to
confirm the live channel response.
