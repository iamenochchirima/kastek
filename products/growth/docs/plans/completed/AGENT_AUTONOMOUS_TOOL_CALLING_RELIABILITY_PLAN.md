---
id: agent-autonomous-tool-calling-reliability
title: Autonomous agent tool-calling reliability
sidebar_label: Autonomous tool-calling reliability
description: End-to-end repair plan for reliable autonomous model/tool turns, durable transcript integrity, provider replay, and recovery.
---

# Autonomous agent tool-calling reliability

**Status:** Core runtime repair implemented; database/Temporal rollout verification pending

**Owner:** Agent Platform

**Last updated:** 2026-09-10

**Risk:** High

**Parent plans:**

- [`Agent Platform Hermes-Aligned Runtime Reliability`](./AGENT_PLATFORM_HERMES_ALIGNED_RUNTIME_RELIABILITY_PLAN.md)
- [`Agent Platform Hermes gap closure and runtime rework`](./AGENT_PLATFORM_HERMES_GAP_CLOSURE_PLAN.md)
- [`Context runtime and telemetry implementation`](./AGENT_CONTEXT_RUNTIME_AND_TELEMETRY_IMPLEMENTATION_PLAN.md)

**Research record:** [`Hermes and Waku tool-calling runtime investigation`](../../research/HERMES_WAKU_TOOL_CALLING_RUNTIME.md)

## Objective

Make the autonomous agent runtime reliably complete model/tool turns across Calendar, Gmail,
Drive, MCP, plugins, skills, and future capabilities. A completed tool call must be visible to
the next model request, must not be executed again because context was projected incorrectly, and
must be recoverable after provider retries, worker loss, approval waits, or checkpoint replay.

The fix must address the primary active-turn planner defect and every adjacent contract that could
recreate the same failure. The result must be one shared runtime contract, not a Calendar-specific
patch, keyword exception, budget increase, browser workaround, or second execution loop.

## Success criteria

- [ ] A live-data request such as “What is on my calendar?” invokes the authorized Calendar tool,
      includes its result in the next model request, and completes without repeated identical calls.
- [ ] The same behavior works for Gmail, Drive, MCP, plugin, skill, and native capability calls.
- [ ] Repeated execution with different arguments remains valid; accidental replay of the same
      operation is prevented or stopped with a typed diagnostic.
- [ ] Parallel tool calls preserve every assistant call and matching result as one model-visible
      round.
- [ ] Provider retries and Temporal worker retries do not repeat a completed model call or
      external effect.
- [ ] A failed tool has explicit semantics: recoverable errors are model-visible, approval waits
      remain resumable, and unknown external effects require reconciliation.
- [ ] Context compaction and checkpoints preserve valid tool-call/result units and never revive a
      stale transcript that caused another call.
- [ ] Grounding, retrieval, model selection, and token budgets cannot prevent authorized live-tool
      reasoning before the model has had a chance to select a capability.
- [ ] The run stops with a precise typed error before another model call if the active transcript
      projection is internally inconsistent.
- [ ] No permanent legacy loop, browser-side inference, generic placeholder fallback, or
      tool-specific duplicate-prevention path remains in the autonomous runtime.

## Root cause and surrounding defects

### Confirmed primary defect

`runBoundedAgentLoop` appends the assistant tool-call response and the tool result, but
`context-planning.ts` resolves the latest user message as the current boundary and skips all units
after it. The next model request therefore excludes the completed assistant/tool round. The model
sees the original request again and repeats the tool. The observed Calendar run invoked the same
tool three times and then exhausted its context/run budget.

Relevant KasiTek locations:

- `agents/src/runtime/loop.ts:1095` — appends the model response.
- `agents/src/runtime/loop.ts:1280` — appends a successful tool result.
- `agents/src/runtime/context-planning.ts:672` — groups assistant calls and tool results.
- `agents/src/runtime/context-planning.ts:718` — incorrectly skips messages after the current user.
- `agents/src/runtime/context-planning.ts:764` — resolves the current boundary to the latest user.

### Confirmed adjacent reliability gaps

1. `DefaultContextPolicy` reconstructs recent durable messages as plain role/content rows and
   drops `toolCalls`, `toolCallId`, and tool names. The durable conversion code preserves those
   fields, but the context builder discards them before planning.
2. Provider fallback IDs such as `gemini-tool-0`, `anthropic-tool-0`, and
   `${provider}-tool-${index}` can repeat on later model iterations. KasiTek currently uses that
   provider ID as the durable tool-invocation identity, so distinct operations can collide.
3. The normal loop emits `tool.failed` and persists failure evidence, but does not append a
   model-visible error result before throwing. Autonomous recovery is therefore impossible for
   ordinary tool failures, while the transcript lacks a durable explanation of the interrupted
   round.
4. Context planning, compaction, and message repair each contain overlapping tool-pair logic.
   Their rules can drift and the repair helper can synthesize a generic unavailable result instead
   of exposing canonical transcript corruption.
5. A limited run whose last message is a tool result can be checkpointed after the planner defect.
   That preserves a broken continuation instead of classifying the projection failure as an
   internal runtime error that must be repaired before retry.
6. The knowledge and legacy-memory retrieval repositories typed PostgreSQL `created_at` values as
   strings and sorted them with `localeCompare`. The `pg` driver returns timestamp columns as
   `Date` objects, so a knowledge-classified live-data request could fail before model/tool
   dispatch. Retrieval ordering must use a shared database-timestamp comparator.

### Existing foundations to preserve

- `ModelCallRepository` already treats a started-but-unsettled model operation as unknown and does
  not blindly call the provider again.
- Tool proposals, completions, effect receipts, approvals, and capability readiness already have
  durable seams.
- The effective capability snapshot is resolved for the run and should remain the shared source
  for model schemas, invocation authorization, and evidence.
- Context compaction already validates complete tool pairs; its pair model should be unified with
  the main planner rather than replaced by another compactor.

## Architecture to implement

The runtime will have one canonical transcript and several read-only projections:

```text
User input
   |
   v
Canonical turn transcript
   |  ordered, structured, durable, replayable
   +--------------------+
   |                    |
   v                    v
Provider request    Execution evidence
projection         journal / receipts / metrics
   |                    |
   v                    v
Model adapter       operational consumers
```

The provider request projection may compact old history and bound large results. It may not omit
the active assistant tool call or its matching result. The journal and UI may observe the
execution, but neither may construct or repair model context.

### Canonical transcript invariants

- A user message begins an active turn.
- An assistant message containing tool calls and all matching tool results form one atomic tool
  round.
- A parallel assistant tool-call batch is one unit; every result must retain its call identity.
- The next model request after a tool round contains the complete active round in order.
- Older completed rounds may be compacted only as complete units.
- An incomplete round is represented by a typed interrupted/error result or a durable waiting
  state; it is never silently dropped.
- A transcript projection that cannot satisfy these invariants is rejected before provider spend.

### Identity invariants

Each tool operation will carry separate identities:

- `runtimeOperationId`: KasiTek-generated, unique within the run/turn and stable across retries.
- `providerToolCallId`: provider wire identity, retained when supplied and nullable/secondary when
  a provider does not supply one.
- `modelOperationKey`: durable identity of the model response that requested the operation.
- `sequenceNumber` and `parentOperationId`: causal ordering and nested-operation evidence.

Durable proposals, approvals, effect receipts, replay lookup, checkpoints, and journal events use
`runtimeOperationId`. Provider adapters use `providerToolCallId` only where their wire contract
requires it.

## Hermes and Waku reference decisions

The implementation follows the local Hermes revision `9a84bee265daad14340a80d7585928cd8ea1f9eb`,
reviewed 2026-09-10, and the local Waku checkout. We adopt behavior and invariants, not their
process-local storage or provider assumptions.

| Reference | Adopt | KasiTek adaptation | Reject |
| --- | --- | --- | --- |
| Hermes `agent/turn_tool_round.py:96-139` | Persist the assistant tool-call before effects | Store structured transcript/operation evidence in PostgreSQL and checkpoint state | Keeping the assistant call only in a worker-local array |
| Hermes `agent/tool_executor.py:942-1024` | Persist every result, including errors, before completion projection | Use tool invocation lifecycle, redacted model-visible outcomes, effect receipts, and Temporal recovery | Emitting a failure event while omitting the model result |
| Hermes `agent/turn_context.py:917-1003` | Build provider requests by walking the ordered transcript | Use one shared KasiTek transcript module and provider adapters | Latest-user cutoffs or intent-based reconstruction |
| Hermes `hermes_state_messages.py:774-836` | Restore typed tool calls, IDs, and ordering | Preserve `ModelMessage` structure through durable context reconstruction | Flattening tool messages into plain text |
| Hermes `context_compressor.py:4166-4227` | Align compaction boundaries to complete tool groups and active tails | Share atomic transcript units with the provider planner and checkpoints | Separate, drifting pair implementations |
| Hermes tool-call persistence tests | Test persistence before/after each side-effect boundary | Add PostgreSQL/Temporal failure-injection tests | Relying only on happy-path unit tests |
| Waku `waku/loop/agent.py:41-114` | Pass the same ordered working transcript into the next iteration | Use the durable canonical transcript instead of a process-local list | Letting graph or UI state replace the loop transcript |
| Waku `waku/runtime/session.py:90-107` | Preserve a compact record of completed actions as a duplicate-safety aid | Use a bounded runtime repetition guard after transcript correctness is fixed | Using semantic dedupe as the primary repair |

## Execution plan

### Phase 0 — Establish the failing contract and remove misleading assumptions

- [x] Record the current failing Calendar run shape without modifying unrelated agent work.
- [x] Add a deterministic loop fixture that returns the same Calendar call when its result is
      absent and a final answer when the result is present.
- [x] Assert the current failure in a red test: one user message, assistant call, tool result,
      second model request, and repeated-call count.
- [x] Inventory every caller of `runBoundedAgentLoop`, `AgentHarness.runTurn`, context planning,
      checkpoints, tool invocation persistence, and provider adapters.
- [x] Identify the durable owner: ordered conversation/model-call/tool-invocation evidence plus
      the versioned loop checkpoint preserve the structured active round; no second transcript store
      was introduced.
- [x] Remove the latest-user cutoff and generic silent repair path from the autonomous runtime. The
      browser/graph remains a read-only consumer and is not allowed to infer model state.

### Phase 1 — Build one deep canonical transcript module

Create one small interface with the complex pairing, validation, selection, and replay behavior
behind it. The module should be usable by the loop, context planner, compactor, checkpoint reader,
provider tests, and durable adapter.

- [x] Define structured transcript types for ordinary messages, assistant tool rounds, tool
      outcomes, interruption/error outcomes, turn identity, and cursor/digest.
- [x] Implement atomic unit construction for single messages, complete tool rounds, parallel calls,
      and nested/parent operation metadata.
- [x] Implement active-turn selection: the newest user is not an upper bound; the active assistant
      and tool tail remains eligible until the turn reaches a terminal/waiting state.
- [x] Make pair validation reject missing, duplicate, orphaned, or out-of-order results before a
      provider call.
- [x] Replace duplicate `buildMessageUnits` implementations in `context-planning.ts` and
      `context-compaction.ts` with this module.
- [x] Replace silent generic message repair with explicit transcript rejection and a typed approval
      waiting state; no placeholder can hide a successful result lost by projection.
- [x] Add tests for current-tail selection, multiple tool calls, repeated iterations, old-history
      compaction, orphan detection, and active-turn preservation. Parallel calls are preserved as
      one atomic assistant round and covered by loop/provider-envelope tests.

### Phase 2 — Preserve the canonical transcript through durable context and checkpoints

- [x] Update `DefaultContextPolicy` so structured durable messages retain role, tool calls,
      tool-call IDs, names, arguments, and result status.
- [x] Ensure `durableConversationMessageToModelMessage`, `memorySourceMessages`, context source
      messages, and loop input use the same structured representation.
- [x] Define the durable owner for in-progress turn transcript state. Existing PostgreSQL
      run/model/tool evidence owns execution facts; the loop checkpoint owns only the bounded
      continuation needed for a waiting/limited activity.
- [x] Version the durable checkpoint contract from v1 to v2. Valid v1 checkpoints are upgraded
      deterministically; malformed or tampered state is rejected and cannot reach a provider.
- [x] Store transcript cursor, transcript digest, turn ID, and compaction generation with
      checkpoints.
- [ ] Add worker-loss tests at: before assistant persistence, after assistant persistence, before
      tool execution, after tool completion, before model dispatch, and after model response.
- [ ] Confirm a retry replays completed results and resumes from the canonical transcript without
      repeating a completed effect.

### Phase 3 — Separate runtime operation identity from provider IDs

- [x] Generate a stable `runtimeOperationId` from the durable model operation identity and tool
      position, with a unique per-run fallback for providers that omit IDs.
- [x] Preserve provider IDs separately for OpenAI-compatible and Anthropic serialization; map
      Gemini function responses by its supported name-based contract without using index IDs as
      durable identity.
- [x] Add additive database fields/constraints for runtime operation identity where necessary.
      Preserve existing columns during rollout; do not drop old identity data until all readers and
      replay paths use the new contract.
- [x] Move tool invocation, approval, effect receipt, checkpoint, and replay lookups to runtime
      operation identity.
- [x] Detect and reject identity reuse with different tool names or argument hashes.
- [x] Test duplicate provider IDs across iterations, parallel calls, provider fallback, worker
      retry seams, and approval identity propagation. Provider IDs remain wire-only; streaming
      normalization retains them without using them as durable keys.

### Phase 4 — Make tool outcomes model-visible and recovery-safe

- [x] Persist the assistant tool-call round before executing any tool side effect, following
      Hermes’ persist-before-effect ordering.
- [x] Persist successful tool results before completion projection and before the next model call.
- [x] Define typed outcome classes:
      - recoverable tool error: append a redacted model-visible error result and allow the model
        to choose retry, alternate capability, or final response;
      - approval required: persist pending operation and pause without fabricating a result;
      - cancellation/timeout: append an interruption result when safe, otherwise return a typed
        interrupted state;
      - unknown external effect: stop and require reconciliation; never invite blind retry.
- [x] Ensure `tool.failed`, durable failure evidence, model-visible result, and run status share
      one operation identity and causal order.
- [x] Add autonomous recovery tests for ordinary tool failure, unavailable capability, malformed
      arguments, timeout, cancellation, approval wait, and unknown external-effect outcome.
- [x] Ensure the model cannot claim a failed tool succeeded because a generic fallback message or
      final status hid the failure.

### Phase 5 — Align provider adapters with the transcript contract

- [x] Add a shared provider-envelope conformance suite for OpenAI-compatible Chat, streaming
      OpenAI-compatible, Anthropic, and Gemini adapters.
- [x] Verify assistant tool calls and results remain adjacent and correctly identified in every
      serialized request.
- [x] Verify multiple calls in one assistant response and multiple iterations.
- [x] Verify error results serialize as model-visible tool results without leaking internal
      credentials or unredacted sensitive output.
- [x] Verify provider responses are normalized into the canonical transcript without losing names,
      arguments, IDs, or finish reasons.
- [x] Verify provider-specific IDs never become the sole durable runtime identity.

### Phase 6 — Make compaction, budgets, retries, and grounding subordinate to transcript truth

- [x] Make compaction call the shared transcript-unit selector and preserve the complete active
      turn; only older completed units may be summarized or bounded.
- [x] Add a pre-dispatch invariant: if a completed active tool call has no matching selected
      result, reject with an internal context-projection code before spending another model call.
- [x] Keep context budget, model budget, tool-call budget, cost budget, and wall-clock budget
      separate. Do not increase budgets to compensate for missing transcript state.
- [x] Ensure a projection failure cannot be checkpointed as an ordinary limited continuation.
- [x] Preserve the existing durable model-call behavior: completed operations replay, started
      unknown operations reconcile/fail closed, and provider retries are bounded.
- [x] Keep grounding/retrieval review after model/tool selection. Remove or constrain any lexical
      keyword path that can block an authorized live-data request before the model sees its tools.
- [x] Add a provider-neutral repeated-identical-call circuit breaker as a final safety net. It must
      emit a typed diagnostic and never replace transcript correctness or effect idempotency.
- [x] Normalize database timestamp ordering in knowledge and memory retrieval. PostgreSQL `Date`
      values, ISO strings, and malformed adapter values must not cause retrieval to throw.

### Phase 7 — Verify every autonomous entry path uses the same runtime

- [ ] Exercise the standard autonomous conversation loop.
- [ ] Exercise resumed approved-tool execution.
- [ ] Exercise Temporal activity retry and checkpoint replay.
- [ ] Exercise MCP and plugin capability execution through the shared capability runtime.
- [ ] Exercise any workflow/graph path that can invoke the autonomous loop and verify it does not
      maintain a second transcript or identity scheme.
- [ ] Confirm child-agent boundaries receive bounded context and typed results rather than a copied
      parent transcript; child execution is out of scope for this repair except for parity checks.
- [ ] Remove obsolete tool-specific, browser-side, and duplicate loop logic after parity tests pass.

### Phase 8 — Add reliability evidence, then release

- [x] Emit bounded structured evidence for transcript cursor/digest, active operation IDs, selected
      result IDs, projection rejection, repetition guard, retry, replay, and reconciliation.
- [ ] Do not log full prompts, credentials, raw provider payloads, or unredacted tool results.
- [ ] Add metrics for repeated identical calls, projection rejections, tool recovery outcomes,
      unknown effects, model replays, and budget exits.
- [x] Update the internal runtime architecture plan and the Hermes/Waku research record
      with final adopt/adapt/reject decisions.
- [ ] Remove temporary compatibility flags and repair paths after the exact removal criteria are
      met; no permanent dual runtime remains.

## Current implementation evidence

The first runtime slice is implemented in the shared autonomous loop:

- `agents/src/runtime/transcript.ts` owns tool-operation identity and atomic transcript units.
- `agents/src/runtime/loop.ts` attaches a stable runtime operation ID to every normalized model
  tool call, preserves the provider wire ID separately, returns recoverable capability failures
  as typed tool results, keeps infrastructure failures terminal, and stops an identical
  no-progress loop with `TOOL_REPETITION_GUARD`.
- `agents/src/runtime/context-planning.ts`, `context-compaction.ts`, and `message-context.ts`
  use the same operation-aware pairing rules; the active assistant/tool tail is no longer cut off
  at the latest user message.
- Knowledge and legacy-memory retrieval use a shared timestamp comparator that accepts PostgreSQL
  `Date` values and safely orders malformed timestamps last.
- Durable context reconstruction and loop checkpoints retain tool-call metadata and runtime
  operation identity.
- Temporal lifecycle, approval, effect, step, replay, and execution-observability adapters use
  the runtime operation identity for autonomous tool evidence while retaining provider IDs in the
  model transcript and event payloads.

Focused verification currently passes:

- `test/model-adapters.test.ts`
- `test/loop-checkpoint.test.ts`
- `test/context-planning.test.ts`
- `test/context-planning-loop.test.ts`
- `test/context.test.ts`
- `test/context-compaction.test.ts`
- `test/message-context.test.ts`
- `test/loop-step.test.ts`
- `test/migration.test.ts`
- `test/temporal-fault-injection.test.ts`
- `test/grounding.test.ts`
- `agents` TypeScript build

The focused command currently passes 158 tests. The full `agents` suite passes 1,152 tests and
skips 124; database/Temporal integration cases remain gated in this workspace.

The targeted retrieval regression pass also passes 14 tests, including PostgreSQL-shaped `Date`
timestamps and malformed timestamp ordering.

The full `agents` suite still has one pre-existing dirty-worktree failure in
`test/context-capability.test.ts` for malformed explicit capacity; it is unrelated to this
transcript/tool-loop slice. The Temporal fault-injection regression introduced by the recovery
semantics was corrected and now passes.

## Verification checklist

### Focused unit tests

- [x] Active `user → assistant(tool call) → tool result` selection.
- [x] Second model request contains the completed result.
- [x] Same tool call is not repeated when the scripted model stops after receiving its result.
- [x] Parallel tool-call batch remains atomic.
- [x] Repeated calls with different arguments remain distinct.
- [x] Provider ID collisions do not collide runtime operations.
- [x] Tool errors are model-visible when classified recoverable.
- [x] Orphan/missing pairs fail validation rather than being silently fabricated.
- [x] Compaction never splits a tool round.

### Integration and recovery tests

- [ ] Calendar, Gmail, and Drive live-data reads.
- [ ] MCP and plugin capability reads.
- [ ] Native tool timeout and malformed-argument failures.
- [ ] Approval pause and resume.
- [ ] Worker loss before and after tool execution.
- [ ] Provider retry after transient provider failure.
- [ ] Unknown external-effect outcome and reconciliation.
- [ ] Context pressure with large tool output.
- [ ] Existing model-selection persistence remains effective.

### Manual guided verification

- [ ] Send one Calendar query and confirm exactly one tool execution.
- [ ] Repeat the same question in a new run and confirm it is a separate admitted run, not a
      replayed old operation.
- [ ] Trigger a tool failure and confirm the agent either recovers or reports the typed failure;
      it must not silently claim success.
- [ ] Switch providers/models and confirm the same transcript contract applies.
- [ ] Reconnect or retry during a run and confirm completed work is not executed again.

## Scope

### Included

- Autonomous model/tool loop reliability.
- Canonical transcript selection, persistence, replay, and compaction.
- Provider adapter serialization and response normalization.
- Tool operation identity, lifecycle, retry, and failure semantics.
- Durable model/tool/checkpoint/budget interaction.
- Grounding and capability admission only where they can block live-tool reasoning.
- Reliability-focused structured evidence and internal documentation.

### Excluded

- Studio graph styling or visualization behavior.
- Playground/Live deployment and credential-environment management.
- Connection-directory ordering or connection UX.
- New guided, workflow, or customer-support agent product behavior.
- Adding Hermes as a dependency or copying Hermes storage/process state.
- Increasing limits as a substitute for fixing transcript correctness.

## Release record

**Change:** High-risk autonomous agent transcript and tool-calling reliability repair.

**Owner:** Agent Platform.

**Affected services and user surfaces:** `agents` runtime, Temporal activities/workflows,
PostgreSQL run/tool/model evidence, provider adapters, autonomous agent chat, MCP/plugin/native
capability execution. Visualization is not part of acceptance for this plan.

**Platform release version or release ID:** To be assigned by the release owner.

**API/schema/migration changes:** Expected additive runtime-operation/transcript/checkpoint
contract changes. Migration must be backward-compatible during rollout; destructive cleanup waits
until all readers use the new identity and transcript contract.

**Feature flag or rollout method:** Use a short-lived canary flag only if required for staged
deployment. There will be no permanent legacy execution path. Roll back to the last tested artifact
and stop new autonomous runs if transcript invariants or duplicate-effect metrics regress.

**Analytics events and success metrics:** Reuse the existing runtime/tool lifecycle registry. Add
bounded events only for projection rejection, repeated-call guard, recovery outcome, replay, and
reconciliation if no existing event covers them. Success is zero accidental repeated identical
tool calls in the regression suite and no completed effect executed twice after worker retry.

**Logs, metrics, dashboards, and alerts:** Structured run, turn, operation, provider, model,
capability, attempt, and bounded error code. Alert on projection rejection, repeated-call guard,
unknown effects, and rising tool recovery failures. No prompt or secret logging.

**Documentation:** Update the internal runtime architecture plan and research record. Public
documentation is not applicable unless an externally visible error or recovery behavior changes.

**Validation evidence:** Focused unit tests, provider-envelope tests, PostgreSQL/Temporal failure
matrix, agent build/typecheck, and the manual guided checks above.

**Rollback or disable plan:** Disable the canary before starting new autonomous runs, preserve
durable evidence, and redeploy the last tested artifact. Do not delete transcript, tool, effect, or
checkpoint records during rollback.

**Post-release review date:** Seven days after staged release, owned by Agent Platform and
platform operations.

## Exit gate

- [ ] All phases affecting the shared autonomous loop are implemented and verified.
- [ ] The Calendar reproduction completes with one invocation and no context-budget spiral.
- [ ] The same regression passes through at least one non-Google capability and one MCP/plugin
      capability.
- [ ] Provider, worker-loss, approval, timeout, and unknown-effect tests pass.
- [ ] No active code path still uses latest-user cutoff, provider index IDs as durable identity,
      silent successful-result omission, or a second transcript assembler.
- [ ] Release record, internal documentation, migration evidence, rollback plan, and verification
      artifacts are complete.
