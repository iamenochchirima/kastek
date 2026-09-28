---
id: agent-hermes-aligned-parallel-tool-execution
title: Hermes-aligned parallel tool execution runtime
sidebar_label: Hermes-aligned parallel tool execution
description: Replace KasiTek's all-or-nothing tool-call limit with Hermes-aligned batch dispatch, safety segmentation, durable results, and recovery.
---

# Hermes-aligned parallel tool execution runtime

> Parked on 2026-09-28. This document is preserved for reference, not an active execution queue.
> Review its status and remaining work before resuming it.

**Status:** Parked (previously Active)

**Owner:** Agent Platform

**Last updated:** 2026-09-11

**Risk:** High

**Implementation status:** Core autonomous batch dispatch, Temporal fan-out/join, PostgreSQL
durability, approval pause/resume, duplicate-call replay, JSONB-safe checkpoint identity, typed
failure outcomes, Workflow patching, completed-batch Continue-As-New, and the 18/32/64/128/256
local Temporal scale matrix are implemented and passing. The focused decomposed Temporal suite is
9/9, the recovery suite is 10/10, the worker-loss matrix is 9/9, the PostgreSQL run integration is
10/10, and long-running cancellation/heartbeat coverage passes locally, including application Stop
propagation to an in-flight tool Activity. The remaining unchecked items are open-run compatibility
retirement and manual guided verification. Real-provider validation now passes three consecutive
times through a fresh local Temporal Server, including the empty-provider-response continuation
regression. Context compaction and graph projection remain separate plans.

**Related plans:**

- [`Autonomous agent tool-calling reliability`](../completed/AGENT_AUTONOMOUS_TOOL_CALLING_RELIABILITY_PLAN.md)
- [`Agent Platform Hermes-Aligned Runtime Reliability`](../completed/AGENT_PLATFORM_HERMES_ALIGNED_RUNTIME_RELIABILITY_PLAN.md)

**Primary reference:** Local Hermes checkout at `/home/enoch/aworkspace/agents/hermes-agent`,
revision `9a84bee265daad14340a80d7585928cd8ea1f9eb`, reviewed 2026-09-10.

**Durability reference:** [Restate parallel tool calls](https://docs.restate.dev/ai/patterns/parallelization),
[durable agents](https://docs.restate.dev/ai/patterns/durable-agents),
[approval pause/resume](https://docs.restate.dev/ai/patterns/human-in-the-loop), and
[retry/error handling](https://docs.restate.dev/ai/patterns/error-handling).

## Objective

Make the autonomous runtime execute model-emitted multi-tool responses using Hermes' tested
execution contract across Calendar, Gmail, Drive, MCP, plugins, skills, and future capabilities.

The runtime must accept a valid tool batch, persist it, classify calls by safety, execute safe calls
in parallel and side-effecting calls sequentially, persist every result, and continue the same
model turn. Each call must execute as a durable operation and each parallel segment must have a
durable fan-out and join. A batch must not fail merely because it contains more calls than an
arbitrary `maxToolCalls` value.

Success is recognized when the 18-calendar-delete failure shape executes through the normal
dispatcher with per-call results, instead of being rejected before the first delete. No
calendar-specific execution path or custom bulk tool is part of this plan.

## Scope

### Included

- Hermes-aligned multi-tool response acceptance and dispatch.
- Separation of model/API iteration limits from tool count within one model response.
- Safety-aware parallel and sequential execution segments.
- Persist-before-effect and per-result durability.
- Approval-group barriers containing exact per-operation authorization, guardrail, timeout,
  idempotency, retry, and recovery behavior.
- Structured tool-call/result transcript preservation through context planning and compaction.
- Runtime lifecycle events and receipts for every proposed, started, completed, failed, blocked,
  or interrupted call.
- Removal of the current all-or-nothing tool-batch rejection path and its dead compatibility code.

### Excluded

- A Calendar-specific `delete_batch` or other custom domain bulk tool.
- Increasing the existing tool limit as a standalone fix.
- Model-selection UX or provider fallback behavior.
- Grounding policy, connection setup, plugin installation, or capability-directory work.
- Studio graph redesign. The existing graph may consume the corrected runtime events, but it is not
  the execution source of truth.
- Playground/Live deployment behavior.

## Context and constraints

- Hermes accepts a complete assistant tool-call batch, persists the assistant call before effects,
  executes through a safety-aware dispatcher, and records one result per call.
- Hermes parallelizes only calls classified as safe or explicitly opted into parallel execution.
  External side effects remain sequential unless their tool contract declares otherwise.
- Hermes treats ordinary tool failures as model-visible per-call results. Persistence failure is a
  separate terminal condition because continuing from non-durable state is unsafe.
- Restate confirms that parallel execution in a durable agent must use durable execution primitives,
  not an untracked in-memory `Promise.all`. Completed operations must replay without re-execution,
  while incomplete operations resume from the first unfinished step.
- The LLM tool batch and the durable execution fan-out are separate layers. The model emits one
  batch and receives one ordered result round; the runtime may create many durable operations
  underneath without adding an extra model round-trip.
- Approval is a durable group pause/resume boundary. A waiting batch must suspend and resume at its
  exact approval-group identity after a decision, while each selected operation still consumes its
  own exact authorization after worker or process restarts.
- Retryable failures and terminal failures must be different typed outcomes. A terminal tool error
  may be model-visible without being treated as a runtime crash.
- KasiTek must preserve its existing PostgreSQL evidence, Temporal recovery, tenant authorization,
  capability grants, approval policy, effect receipts, and redaction boundaries.
- The current failure is caused by `agents/src/runtime/loop.ts` rejecting an 18-call model response
  when only three calls remain under `maxToolCalls=4`, then counting the rejected proposals as used.
- The current calendar tool remains a single-event tool. The runtime must execute distinct calls
  through the generic dispatcher; this plan does not add a calendar exception.
- No legacy loop, browser-side inference, generic fallback, or parallel execution path may remain
  active after migration.

## Hermes execution contract

```text
model response with N tool calls
             |
             v
validate and normalize the complete batch
             |
             v
persist assistant tool-call message
             |
             v
create one durable operation per call
             |
             v
segment by safety and dependency barriers
       |                         |
       v                         v
durable parallel fan-out   durable sequential steps
       |                         |
       +------------+------------+
                    v
              durable join
                    |
                    v
persist one ordered result for every call
                    |
                    v
send the intact tool round back to the model
```

The model/API iteration budget limits how many provider turns the loop may perform. It does not
reject a valid multi-tool response because the response contains many calls. Tool-level safety,
timeouts, provider limits, approvals, and per-call guardrails remain enforced during dispatch. Raw
in-memory parallelism is not sufficient for a durable run; every fan-out item and the join must be
represented by the durable execution system.

## Temporal implementation contract

Temporal remains the durable execution provider for this plan. The agent runtime owns model/tool
semantics, while the Temporal Workflow owns orchestration and the Activities own all nondeterministic
or external work.

The target execution shape is:

```text
agentRunWorkflow
        |
        +-- modelActivity(model operation key)
        |       returns one complete assistant response
        |
        +-- prepareToolBatchActivity
        |       validates, persists the assistant batch, and returns segments
        |
        +-- safe segment: Promise.all(executeToolActivity(call) ...)
        |       each promise is a Temporal Activity execution
        |
        +-- sequential effect segment: await each executeToolActivity(call)
        |
        +-- commitToolBatchActivity
                persists ordered results and continuation state
                        |
                        +-- next modelActivity
```

Temporal-specific rules:

- The Workflow must remain deterministic. It may schedule Activities, await their results, and
  make decisions from recorded Activity results; it must not call providers, tools, PostgreSQL, or
  nondeterministic APIs directly.
- `modelActivity` performs one provider request and uses a stable model operation key so Activity
  retry or Workflow replay does not spend the same model operation twice.
- `prepareToolBatchActivity` is the persist-before-effect boundary. It stores the complete
  assistant tool-call batch and one durable operation identity per normalized call before any
  external effect is scheduled.
- `executeToolActivity` executes exactly one tool call. It owns authorization, approval state,
  effect receipts, idempotency, provider calls, result persistence, timeout handling, and bounded
  redaction. A tool Activity must not launch an untracked internal fan-out.
- `Promise.all` is allowed in the Workflow only when each item is a scheduled Temporal Activity.
  It is the durable fan-out/join mechanism for one parallel-safe segment. The input array must be
  in model-emitted order so the resulting array preserves that order even when Activities finish
  out of order.
- A sequential effect segment is represented by ordered Activity commands in the Workflow. A
  side-effecting call is not considered complete until its Activity has durably recorded its
  result or an explicit unknown-external-effect state.
- Ordinary tool failures are typed results returned to the Workflow and then to the model. Activity
  exceptions are reserved for retryable infrastructure failures, persistence failures, cancellation,
  or unknown effects that require Temporal retry/reconciliation behavior.
- Activity options must define start-to-close and schedule-to-close limits, heartbeat behavior for
  long-running calls, cancellation handling, retry policy, and non-retryable error types. Activity
  identity must remain stable across retries and replay.
- Child Workflows are not the default representation for tool calls. Use Activities within the
  existing run Workflow first. Introduce Child Workflows only when a separate service boundary,
  independently managed entity, or Workflow History partitioning requirement is demonstrated.
- The Workflow must periodically use Continue-As-New at a safe batch boundary when Temporal
  History approaches the configured threshold. It must carry forward only the durable continuation
  state and must never Continue-As-New while a tool fan-out or join is incomplete.
- Changes to the Workflow command sequence require a Temporal versioning/patching strategy or a
  new Workflow type. The implementation must not silently deploy reordered Activity calls against
  open runs.

The current broad `executeLoop` Activity is a migration boundary only. It must not remain the
primary execution path after this plan is complete; model calls and tool calls must be visible to
the Workflow as separate durable operations.

## Implementation plan

### Phase 1 — Establish the Hermes conformance contract

- [x] Record the exact current runtime path from `runBoundedAgentLoop` through tool dispatch,
      approvals, journal persistence, checkpoints, and provider request assembly.
- [x] Map each KasiTek boundary to the Hermes reference modules:
      `turn_tool_round.py`, `run_agent.py`, `tool_dispatch_helpers.py`, `tool_executor.py`,
      `turn_context.py`, and approval modules.
- [x] Add red tests for the current failure: one successful list call followed by 18 distinct
      delete proposals with `maxToolCalls=4`, proving the current loop rejects the batch before
      any delete dispatch.
- [x] Define the conformance invariants for accepted batches, safety segmentation, result pairing,
      persistence ordering, approval waits, recovery, and model continuation.

### Phase 2 — Remove the all-or-nothing tool-count gate

- [x] Remove the check that rejects an entire response when
      `response.toolCalls.length > remainingToolCalls`.
- [x] Stop incrementing the runtime tool counter by calls that were never executed.
- [x] Separate model/API iteration accounting from the number of tool calls in one assistant
      response, following Hermes' normal loop contract.
- [x] Retain `maxToolCalls` only as a true run-level execution budget. It no longer rejects a
      complete provider response atomically; exhausted calls receive typed per-call results.
- [x] Keep per-call deadline, provider-rate, approval, authorization, and guardrail enforcement.
- [x] Make any true runtime exhaustion produce a typed, actionable result rather than the generic
      “couldn't finish” fallback.

### Phase 3 — Implement Hermes-style batch dispatch

- [x] Normalize and validate the complete model-emitted batch before dispatch.
- [x] Deduplicate only identical `(tool name, normalized arguments)` calls. Preserve distinct
      calls such as the 18 different Calendar event IDs.
- [x] Add a single safety-segmentation decision point for all capabilities:
      parallel-safe, sequential barrier, or blocked.
- [x] Run read-only and explicitly parallel-safe calls with bounded concurrency.
- [x] Run external-effect calls sequentially in emission order unless their manifest explicitly
      declares safe parallel execution.
- [x] Preserve original call order in the model-visible results even when safe calls finish out of
      order.
- [x] Continue the batch after ordinary per-call failures, timeouts, or blocked calls, recording a
      typed result for each call.
- [x] Keep one model-level batch and one model continuation round; do not split a provider response
      into multiple model calls merely to execute its tools.
- [x] Reserve terminal interruption and persistence failure for cases where continuing would make
      the transcript or effect state unsafe.

### Phase 4 — Add durable fan-out, join, and recovery

- [x] Persist the assistant tool-call batch before executing any external effect.
- [x] Split new executions from the broad `executeLoop` Activity into a Workflow-visible model
      Activity, batch-preparation Activity, one-tool-call Activity, and ordered batch-commit
      Activity. The old Activity remains only behind the Temporal patch gate for already-open
      histories and is not used by new executions.
- [x] Create the durable execution record for every normalized tool call before dispatch, including
      its batch ID, segment ID, sequence position, runtime operation ID, Temporal Activity ID, and
      provider call ID.
- [x] Have the Workflow schedule one Temporal Activity per tool call. Use `Promise.all` only in the
      Workflow for parallel-safe segments; never use an in-memory fan-out inside an Activity for
      provider effects.
- [x] Await the complete Activity segment in the Workflow before advancing to the next segment or
      model iteration. Treat the Workflow await as the durable join and persist the ordered batch
      outcome through the commit Activity.
- [x] Persist each tool result, with its stable runtime operation ID, Temporal Activity ID, and
      provider call ID, in original model-emitted order before allowing the next model iteration.
- [x] Make operation identity stable across provider retries, Temporal retries, worker loss, and
      checkpoint replay.
- [x] Replay a durable completed result instead of executing the same external effect again, and
      resume only incomplete operations after a worker or process failure.
- [x] Classify per-call failures as retryable, terminal, approval-waiting, interrupted, or
      unknown-external-effect. Retry only retryable failures and expose terminal results to the
      model without converting them into a generic loop crash.
- [x] Represent the durable join as incomplete until every required call has a terminal result or
      an explicit unknown/waiting state; never silently drop a call/result pair.
- [x] Define Activity retry, timeout, heartbeat, cancellation, and non-retryable-error policies for
      model calls, read-only tools, and external-effect tools separately. Tool-budget consumption
      is claimed once per durable runtime operation in the same PostgreSQL transaction as the
      counter increment, so a Temporal retry cannot consume the same logical call twice.
- [x] Add Temporal Workflow patching for the command-sequence migration and a Continue-As-New
      checkpoint at a completed batch boundary for long-running runs. The local integration test
      forces a low threshold and verifies the original execution is `CONTINUED_AS_NEW`, all 128
      calls across the rollover remain committed, and the next model step resumes.
- [x] Add failure-injection coverage at assistant persistence, before dispatch, after each effect,
      result persistence, worker loss, and model continuation boundaries. The focused Temporal
      suite now retries model-step, batch-preparation, and ordered-commit Activities while proving
      one tool execution; the recovery suites cover worker loss before and after durable effects.

### Phase 5 — Align approval groups and guardrails with Hermes

- [x] Apply authorization and approval to the complete current side-effecting proposal group, not
      to an unexecuted proposal count or a latest-row projection.
- [x] Serialize approval barriers so concurrent calls cannot interleave user decisions; “Approve
      all” is scoped to the immutable current group only.
- [x] Implement group waits as durable pause/resume points tied to the exact group digest and
      operation identities; approval must survive worker or process restart without replaying
      completed calls.
- [x] Support group approval, rejection, and explicit selected-operation decisions while retaining
      exact child approval records for each operation.
- [x] Ensure a resumed approval executes only selected call identities and arguments, with the
      Activity re-reading the approved child authorization before the effect.
- [x] Keep duplicate-call, repeated-operation, and provider retry guardrails as last-resort safety
      controls after correct transcript and dispatch behavior is in place.

### Phase 6 — Preserve the complete active tool round in model context

- [x] Ensure the next provider request contains the assistant batch and every matching tool result
      for the active turn.
- [x] Keep tool-call IDs, names, arguments, result status, and ordering through durable context
      reconstruction.
- [x] Make checkpoint transcript digests canonical across PostgreSQL JSONB key reordering.
- [ ] Compact only complete older tool groups; never split the active batch or omit its results.
      Deferred to `AGENT_HERMES_ALIGNED_SESSION_CONTEXT_AND_COMPACTION_PLAN.md`; this plan only
      guarantees the active tool round is complete and ordered before continuation.
- [ ] Reject an internally inconsistent projection before provider spend with a precise typed
      context error. Deferred to the session-context plan.
- [ ] Keep the canonical transcript separate from the execution journal and UI projections.
      Deferred to the session-context and observability plans; the batch commit boundary remains
      the handoff contract between them.

### Phase 7 — Integrate observability without changing execution semantics

- [x] Emit lifecycle evidence for batch admission, each call proposal, start, completion, failure,
      block, approval wait, interruption, segment boundaries, fan-out, and join completion.
- [x] Include parallel-group identity, sequence position, runtime operation ID, provider call ID,
      durable operation ID, join ID, redacted arguments, duration, retry class, and bounded error
      code.
- [ ] Ensure the graph, activity panel, run status, and replay endpoints consume the same durable
      execution evidence. Deferred to the separate execution-observability plan.
- [ ] Remove browser-side inference that turns generic activity strings into tool state. Deferred
      to the separate execution-observability plan.

### Phase 8 — Remove dead paths and complete the migration

- [x] Delete the old whole-batch rejection logic, proposal-count accounting, and obsolete fallback
      branches after the new dispatcher is verified.
- [x] Remove tests that assert the old failure behavior and replace them with Hermes conformance
      tests.
- [x] Search the repository for remaining `maxToolCalls` assumptions and classify each as removed,
      migrated to iteration policy, or explicitly retained for a separate low-level sandbox.
- [ ] Remove the broad Activity execution path after all open-run compatibility and Temporal
      versioning/patching requirements are satisfied; no legacy dispatcher or hidden in-Activity
      parallel path may remain active. Release follow-up: the path is currently reachable only for
      histories replayed with `patched("agent-parallel-tool-activities-v1") === false`; new runs
      are covered by tests that fail if `executeLoop` is selected.
- [x] Confirm Calendar, Gmail, Drive, MCP, plugin, skill-backed, and native capability calls all
      use the same dispatcher lifecycle. The capability staging smoke test invokes one fixture for
      each source family through the lifecycle-required runtime and asserts one proposal, prepare,
      handler, and completion path per operation.

## Verification

- [x] Unit test: 18 distinct external-effect calls are accepted and produce per-call results with
      `maxToolCalls=4` no longer causing atomic batch rejection; the explicit run budget executes
      the admitted subset and types the remainder.
- [x] Unit test: safe independent calls execute concurrently within the configured worker bound.
- [x] Unit/integration test: concurrent calls use durable operation records and a durable join rather than an
      in-memory-only fan-out.
- [x] Unit test: a sequential side-effect call acts as a barrier around parallel-safe segments.
- [x] Unit test: one failed call produces a model-visible error while other valid calls receive
      results.
- [x] Unit test: identical duplicate calls are removed, while distinct arguments are preserved.
- [x] Integration test: approval wait and resume execute exactly the approved operation.
- [x] Integration test: worker interruption after a completed effect does not repeat that effect.
- [x] Integration test: worker interruption during a parallel segment replays completed operations
      and resumes only incomplete operations.
- [x] Integration test: parallel completion order differs from model-emitted order but the next
      model request receives results in the original call order.
- [x] Integration test: the next model request receives the complete active tool round.
- [x] Integration test: provider retry and Temporal retry preserve call identity and receipts;
      the Temporal retry fixture proves one provider success and one ordered commit, while the
      PostgreSQL Activity tests prove durable replay returns the stored result without a second
      provider invocation and a retry consumes the tool budget once.
- [x] Integration test: retryable and terminal tool errors follow different recovery paths.
- [x] Temporal integration test: parallel tool Activities are scheduled by the Workflow, survive
      worker interruption, and join without repeating completed effects.
- [x] Temporal integration test: long-running tool Activities heartbeat, receive application
      cancellation through the workflow's tracked Activity scope, and terminate without a false
      failure or completion. The production Worker bounds heartbeat throttling at five seconds;
      worker-loss recovery remains covered by the separate recovery matrix.
- [x] Temporal replay test: Workflow command history remains deterministic across the migration
      patch and existing open runs continue on their recorded path. The local replay test runs
      the decomposed Workflow history through Temporal's replay validator without a command
      sequence violation.
- [x] Temporal integration test: Continue-As-New carries the completed batch continuation state
      and never abandons an in-flight fan-out or join.
- [x] Scale test: a deterministic model fixture emits batches of 18, 32, 64, 128, and 256 distinct
      calls through the real Temporal Workflow and Worker.
- [x] Scale test: a legacy response limit smaller than the batch does not reject the batch, while
      an explicit run-level budget still stops execution with a typed, observable result when it
      is genuinely exhausted.
- [x] Scale test: bounded parallelism records the maximum in-flight Activity count and never
      exceeds the configured worker and run concurrency limits.
- [x] Mixed-batch test: parallel-safe reads, sequential external effects, and a second parallel
      segment execute across the correct safety barriers without reordering model-visible results.
- [x] Multi-round test: the model emits several tool batches across multiple continuations, and
      every batch remains paired with the complete assistant/tool transcript. The focused local
      Temporal suite covers two ordered tool rounds followed by model continuation.
- [x] Provider-variation test: when a decomposed model slice returns an empty final response, both
      after a durable tool result and on the first model turn, the runtime preserves the durable
      transcript boundary and schedules the next model slice instead of converting the run into a
      generic execution-limit failure. The regressions are covered in `test/loop-step.test.ts` and
      passed through three consecutive real-model runs.
- [x] Failure-matrix test: inject an ordinary tool failure, timeout, authorization block, provider
      rate limit, retryable infrastructure error, cancellation, and unknown external outcome in
      different branches of the same batch; verify each outcome follows its typed recovery path.
- [x] Recovery-scale test: interrupt workers before dispatch, during parallel execution, after a
      completed durable effect, during result persistence, and before model continuation; verify
      completed operations are not repeated and incomplete operations resume. The 9-case worker-loss
      matrix plus the decomposed 18-call replay and ordered-commit-loss tests pass locally.
- [x] Idempotency-scale test: replay and retry every call in a large batch and verify one durable
      receipt per operation, including distinct calls with similar but non-identical arguments. The
      18-call worker-loss test verifies one provider invocation per distinct operation and replays
      the durable result after replacement.
- [x] History-scale test: run multi-tool batches against an injected low Continue-As-New threshold,
      then verify the continuation preserves pending state, transcript order, operation identity,
      and the next model iteration. Production retains the 2,000-event default.
- [x] Real-model/local-Temporal test: configure a non-production model credential, start a local
      Temporal Server and the real Agent Platform worker, submit a request that produces tool
      calls, and verify the full model → Workflow → Activities → persisted results → model
      continuation path. Use the controlled read-only `test.real_read` capability; three runs
      passed against a fresh local Temporal Server without destructive external effects.
- [x] Real-model consistency test: repeat the live-model run enough times to capture provider
      variations, while using deterministic fixtures for exact batch-size and failure assertions.
      Three consecutive real-provider runs passed, including provider tool-name normalization and
      post-tool empty-response recovery.
- [x] Multi-run test: execute several large runs concurrently across separate task queues or run
      partitions and verify tenant/run isolation, fair concurrency, independent joins, and no
      cross-run operation or receipt reuse. The local 18/32/64/128/256 Temporal matrix runs the
      five run partitions concurrently and asserts each run's committed count and bounded fan-out.
- [x] Runtime check: Calendar, Gmail, Drive, MCP, plugin, skill-backed, and native calls share the
      same dispatch lifecycle. The capability-source smoke test covers all seven source families
      through one lifecycle-required capability runtime.
- [x] Protected KasiAi run configuration allows approved multi-call batches to complete within a
      bounded `maxToolCalls=32` budget; local stack synchronization and the release-gate regression
      test verify the published configuration.
- [x] Typecheck, targeted agent tests, agent build, and `git diff --check` pass. No agent lint
      script is configured; lint is recorded as not applicable for this slice.
- [ ] Manual guided test: list many items, confirm a multi-call action, observe per-call execution,
      partial failure reporting, worker recovery, and final continuation in the execution
      observatory.

## Release record

```text
Change: Hermes-aligned multi-tool execution and recovery contract, including the protected KasiAi
  approved-batch budget correction
Owner: Agent Platform
Risk: high
Affected services and user surfaces: agents runtime, Temporal activities, PostgreSQL execution evidence,
  provider adapters, capability tools, approvals, agent chat, execution observatory
Platform release version or release ID: TBD at release time
API/schema/migration changes: additive migrations 169-172 add runtime/batch identity, the explicit
  `unknown` tool-invocation status, and idempotent tool-budget claim state; migrations are applied
  locally and contain no destructive data rewrite. The protected KasiAi version configuration now
  uses a bounded `maxToolCalls=32`; no API or database schema change is required for that correction.
Feature flag or rollout method: no new feature flag; the Temporal patch gate protects open histories and
  staged rollout remains required for the autonomous runtime
Analytics events and success metrics: product analytics not applicable; operational lifecycle events and
  retry/unknown-effect metrics are required
Logs, metrics, dashboards, and alerts: required for batch size, parallel segments, per-call outcomes,
  approval waits, retries, unknown effects, and loop limits
User, API, internal, and operational documentation: update internal runtime and recovery documentation;
  public documentation not applicable unless behavior is exposed as a supported API contract
Validation evidence: unit tests, real-Activity/PostgreSQL batch tests, Temporal recovery and worker-loss
matrices (10/10 and 9/9), focused decomposed Temporal tests (9/9), retry/terminal/unknown/cancellation/
Continue-As-New integration tests, 18–256-call local Temporal scale test, three consecutive
real-model/local-Temporal runs, protected KasiAi release-gate regression, local stack
synchronization, build/typecheck, and `git diff --check`; manual UI evidence remains pending
Rollback or disable plan: roll back the runtime artifact and checkpoint-compatible code; do not replay
  completed external effects; reconcile unknown provider outcomes before retry
Post-release review date: TBD
```

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Execution model | Follow Hermes' complete-batch, safety-segmented dispatcher | Agent Platform | Decided |
| Parallelism | Parallelize only safe or explicitly opted-in calls; side effects remain sequential by default | Agent Platform | Decided |
| Tool-count limit | Do not reject a valid model batch because of a per-response `maxToolCalls` ceiling | Agent Platform | Decided |
| Protected KasiAi batch budget | Keep the protected run bounded at `maxToolCalls=32`, which is large enough for the approved multi-occurrence batch while retaining an explicit run-level guardrail | Agent Platform | Decided |
| Bulk domain tools | Do not add Calendar-specific or other custom bulk tools for this fix | Agent Platform | Decided |
| Durable storage | Preserve Hermes ordering semantics using PostgreSQL, Temporal, and the existing journal | Agent Platform | Decided |
| Durable fan-out | Use one Temporal Activity per tool call and Workflow-owned `Promise.all` for parallel-safe segments; do not create a Child Workflow per tool call or use raw in-memory fan-out for external effects | Agent Platform | Decided |
| Result ordering | Reconstruct results in original model-emitted order after durable execution completes | Agent Platform | Decided |
| Approval waits | Treat approval as a durable pause/resume boundary tied to one immutable group digest; each selected operation still requires exact child authorization | Agent Platform | Decided |
| Error classes | Separate retryable, terminal, waiting, interrupted, and unknown external outcomes | Agent Platform | Decided |
| Temporal Activity boundary | Model calls and provider effects are Activities; the Workflow only orchestrates deterministic commands and recorded results | Agent Platform | Decided |
| Temporal history | Use Continue-As-New only at completed batch boundaries when Workflow History requires it | Agent Platform | Decided |
| Temporal deployment safety | Use Workflow patching/versioning or a new Workflow type before changing the command sequence for open runs | Agent Platform | Decided |
| Approval semantics | Create one immutable approval group per barrier with one child record per side-effecting operation, keyed by stable runtime operation ID and normalized-argument hash. Serialize the prompt, pause the Workflow durably, and execute only selected child authorizations after the group decision. | Agent Platform | Decided |
| Low-level sandbox limits | Keep per-call resource, timeout, provider, and isolated-code limits as separate guardrails. They must never become a batch-count rejection or a reason to reject otherwise valid sibling calls. | Agent Platform | Decided |

## Notes and blockers

- The guided UI run remains an external/manual verification item; the non-production provider path
  has already been exercised through three real-model/local-Temporal runs.
- The reported 21-operation local run was approved correctly but inherited the protected KasiAi
  version's stale `maxToolCalls=4` setting; four deletes completed and the remaining 17 were typed
  budget failures. Source synchronization now publishes `maxToolCalls=32`, and automatic retry is
  not appropriate for a deterministic exhausted-budget result.
- Manual Studio verification could not be run in this environment because no browser surface is
  available; it remains a release/operator check rather than an automated local-test gap.
- Full agent-suite verification on 2026-09-11: 194 test files passed, 1 failed, and 42 were
  skipped; 1,175 tests passed and 142 were skipped. The sole failure is
  `test/context-capability.test.ts` for malformed provider context capacity resolution; it belongs
  to the separate session-context plan and does not exercise the parallel tool dispatcher.
- The focused dispatcher/recovery/capability run passed 35/35 tests under concurrent local Temporal
  worker load. This includes the nine-case worker-loss matrix and the ordered-join recovery cases
  with 30-second checkpoint observers, which avoids mistaking local worker-bundle scheduling
  contention for a recovery failure.
- The expanded focused run passed 72/72 tests across loop slicing, decomposed Temporal execution,
  recovery, worker loss, capability staging, adapters, and retrieval gates. The real-provider
  integration passed three consecutive runs on a clean local Temporal database; its fixture
  disables credit billing and memory-v2 only to isolate this plan's dispatcher contract.
- The architecture decisions for this plan are settled. Remaining work is open-run compatibility
  retirement, manual guided verification, and release evidence; it is not a request to choose a
  different dispatcher, add a domain-specific bulk tool, or introduce a second autonomous loop.
- This plan executes before the session-context plan. Its commit boundary must leave a complete,
  ordered assistant/tool round that the context plan can project across user requests.
- Existing autonomous tool-calling reliability work must be reconciled with this plan before
  implementation is marked complete; the old all-or-nothing batch path cannot remain active.
