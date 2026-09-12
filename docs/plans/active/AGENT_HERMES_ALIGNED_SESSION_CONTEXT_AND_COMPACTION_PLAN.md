---
id: agent-hermes-aligned-session-context-and-compaction
title: Hermes-aligned session context and compaction
sidebar_label: Session context and compaction
description: Durable cross-request agent context, provider-aware projection, and active compaction for autonomous sessions.
---

# Hermes-aligned session context and compaction

**Status:** Track A complete — canonical context foundation implemented; Track B runtime integration remains gated on tool/approval contracts

**Owner:** Agent Platform

**Last updated:** 2026-09-12

**Risk:** High

**Execution order:** The context foundation can proceed now against a stable transcript interface and
deterministic tool-round fixtures. Runtime wiring that observes live tool execution, parallel joins,
and approval waits starts after the tool-calling work reaches its tested contract. This is a separate
workstream and must not duplicate the tool dispatcher.

**Related plans:**

- [`Hermes-aligned parallel tool execution runtime`](./AGENT_HERMES_ALIGNED_PARALLEL_TOOL_EXECUTION_PLAN.md)
- [`Autonomous agent tool-calling reliability`](../completed/AGENT_AUTONOMOUS_TOOL_CALLING_RELIABILITY_PLAN.md)
- [`Context runtime and telemetry implementation`](../completed/AGENT_CONTEXT_RUNTIME_AND_TELEMETRY_IMPLEMENTATION_PLAN.md)

**Research references:**

- [`Hermes and Waku tool-calling runtime investigation`](../../research/HERMES_WAKU_TOOL_CALLING_RUNTIME.md)
- [`Hermes and Waku session context decisions`](../../research/HERMES_WAKU_SESSION_CONTEXT_DECISIONS.md)
- [`Hermes architecture research`](../agents/AGENT_HERMES_ARCHITECTURE_RESEARCH.md)
- Local Hermes checkout at `/home/enoch/aworkspace/agents/hermes-agent`.

## Objective

Make the autonomous agent aware of its continuing session instead of rebuilding context from
display messages on every request. Every model-visible user message, assistant response, tool
call, and tool result must become part of one durable, ordered session transcript. Each later
request must load that transcript, project it to the selected provider, and continue from the
active state. When the transcript approaches the provider limit, compaction must replace the
active model context with a valid checkpoint and recent tail.

Success means that context grows across user turns, retains completed tool work, compacts without
losing the goal or an active tool round, and resumes correctly after Temporal worker replacement,
provider retry, approval wait, or process restart.

## Non-negotiable cross-request context contract

The model provider still receives one bounded request at a time. That does **not** mean KasiTek
may start each request with a new or recent-only conversation. The durable session transcript is
the continuing context. The exact lifecycle is:

```text
durable transcript for session/generation
        -> active model-history projection
        -> append current user message
        -> immutable provider request manifest
        -> model/tool round
        -> persist assistant/tool entries in order
        -> next request loads the updated active projection
```

Implementation requirements:

- Every new request must load the session's active model-history projection from the canonical
  durable transcript before adding the new user message.
- The current user message must be appended to that session before the first model request.
- The request must include the accumulated active history, subject only to the provider-aware
  projection and compaction rules below. It must not include only the latest user message or an
  arbitrary recent-message window.
- Every assistant tool-call message must be durable before its external effect starts. Every tool
  result must be durable before the next model request. The final assistant response must be
  durable before the run is reported complete.
- When compaction commits, the compacted checkpoint plus its protected recent tail becomes the
  next active model-history projection. The pre-compaction rows remain available for display,
  audit, and recovery but are excluded from later provider prompts so the context does not regrow.
- The session does not reset after a normal request, Temporal retry, worker replacement, approval
  wait, or provider retry. Only an explicit reset/new-generation operation starts a new active
  transcript generation.
- Waku's bounded recent-history window is **not** the primary KasiTek context architecture. Waku's
  window is useful as a limit for a small local assistant, but adopting it here would recreate the
  current cross-request context reset.

The following source locations are the implementation map for this contract:

| Area | Current KasiTek code | Required implementation direction |
| --- | --- | --- |
| Cross-request load | [`activities.ts:3887`](../../../agents/src/temporal/activities.ts:3887) loads display conversation messages and [`activities.ts:3896`](../../../agents/src/temporal/activities.ts:3896) loads a separate summary. | Replace this split read with one canonical active-transcript projection. The summary cannot be an alternative context source. |
| Compaction | [`activities.ts:3922`](../../../agents/src/temporal/activities.ts:3922) invokes durable compaction, while [`activities.ts:3996`](../../../agents/src/temporal/activities.ts:3996) currently treats it as an evidence/checkpoint artifact. | Make the committed checkpoint and active cursor drive the next provider projection. Keep the complete transcript as the source of truth. |
| Loop input | [`activities.ts:4724`](../../../agents/src/temporal/activities.ts:4724) passes `loopCheckpoint.messages` or `context.sourceMessages` into the loop. | Those messages must come from the canonical active projection, not a per-run reconstruction or stale checkpoint. |
| In-run growth | [`loop.ts:313`](../../../agents/src/runtime/loop.ts:313) creates the mutable request-local array; [`loop.ts:1121`](../../../agents/src/runtime/loop.ts:1121) and [`loop.ts:1334`](../../../agents/src/runtime/loop.ts:1334) append model/tool messages. | Preserve this within-turn behavior, but persist the same typed entries so the next turn can reload them. |
| Current summary shortcut | [`summary-repository.ts:55`](../../../agents/src/db/repositories/summary-repository.ts:55) rebuilds from only the last 40 messages and truncates to 4,000 characters. | Retire this as the active model-context mechanism. A summary may be a compaction checkpoint only when produced and committed under the canonical compaction contract. |
| Loop checkpoint | [`activities.ts:4990`](../../../agents/src/temporal/activities.ts:4990) persists a loop checkpoint only for step execution. | Checkpoints may accelerate recovery, but they cannot be the only place where model-visible messages survive. |

Hermes source references that define the target behavior are:

- [`context_compressor.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/context_compressor.py): provider-aware thresholding, protected head/tail, tool-result pruning, summary validation, and failure handling.
- [`hermes_state_messages.py`](/home/enoch/aworkspace/agents/hermes-agent/hermes_state_messages.py): durable message rows, active model projection, display projection, and compacted-row exclusion.
- [`turn_facade_lease.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/turn_facade_lease.py): session turn lease, wait/reload behavior, and latest-lineage resolution.
- [`turn_tool_round.py`](/home/enoch/aworkspace/agents/hermes-agent/agent/turn_tool_round.py): persist assistant tool calls before executing effects and persist results before continuation.

Waku comparison references are intentionally treated as contrast, not as the target context
architecture:

- [`app.py`](/home/enoch/aworkspace/agents/waku-agent/waku/app.py): bounded recent-history prompt construction.
- [`session.py`](/home/enoch/aworkspace/agents/waku-agent/waku/runtime/session.py): local session history and compact tool-use logging.
- [`consolidation.py`](/home/enoch/aworkspace/agents/waku-agent/waku/memory/consolidation.py): separate long-term fact/episode consolidation rather than active transcript replacement.

## Problem statement

The provider context window is correctly scoped to one model request. The defect is above the
provider: KasiTek currently keeps a useful working transcript inside one loop execution but does
not persist that complete transcript as the canonical source for the next user request.

The current path loads conversation display rows in
`agents/src/temporal/activities.ts`, while `run-repository.ts` primarily persists the final
outbound response. Intermediate assistant tool calls and tool results live in model/tool audit
records and are not reliably reconstructed into the next model request. Compaction records exist,
but the active prompt still uses a separate conversation summary path. This creates a reset after
each request and makes compaction summarize the wrong source.

This plan fixes that architecture. It does not increase token limits, add keyword exceptions,
reconstruct prompts from audit tables at read time, or add a second agent loop.

## Explicit compaction policy

The initial policy follows Hermes' context compressor rather than using one raw global token limit.
The runtime calculates an effective input budget for the selected provider/model:

```text
effective input budget = provider context window - reserved output space
                         - tool/schema/protocol envelope
                         - safety margin
```

The first implementation uses these model-relative thresholds:

- For context windows of 512k tokens or larger, trigger compaction at 50% of the effective input
  budget by default.
- For context windows below 512k, raise the minimum trigger to 75% of the effective input budget.
- If a minimum-token floor would make the trigger unreachable, cap the trigger at approximately 85%
  of the effective input budget so the provider is not reached first.
- Preserve the protected head, the active turn, and a recent tail. Use an initial recent-tail target
  of approximately 20% of the compaction threshold, subject to the active-turn and fit invariants.
- Treat the threshold as a pre-dispatch compaction trigger, not as permission to send a request that
  is already too large. The hard gate rejects a request only when no valid projection can fit after
  bounded compaction attempts.
- Record the resolved threshold, effective budget, reservations, provider/model, and compaction
  generation in the request manifest. Do not silently fall back to the current 8k compatibility
  default or the run-level total-token budget.

The 50%, 75%, and 85% values are the initial Hermes-aligned defaults. They may become provider/model
configuration later, but the first implementation must have one deterministic default and must not
choose thresholds ad hoc at individual call sites.

## Implementation decisions from Hermes and Waku research

These decisions are now fixed for implementation. They are not invitations to build competing
architectures or to choose a different behavior at individual call sites.

1. **Session identity:** use one stable logical session key composed of organization, agent
   installation, and conversation. Store agent version, selected model, provider, and configuration
   on each turn as metadata; they do not silently create a new context. An explicit Clear/New
   operation creates a monotonic transcript generation. Worker restart, deployment, retry, and
   approval resume continue the same generation.
2. **Canonical storage seam:** use a PostgreSQL-backed structured transcript adapter as the only
   source of model-visible history. Existing structured message storage may be extended if it can
   satisfy ordering, tool-pair, cursor, digest, and compaction-lineage invariants. Otherwise add an
   explicit transcript table. Never reconstruct active context by joining display messages,
   model-call records, tool-invocation records, or journal events at request time.
3. **Model switching:** preserve the durable transcript and reproject it for the newly selected
   model. Recompute context capacity, output reservation, tool/schema envelope, threshold, and
   tail limits before dispatch. If the new model is smaller, compact before the request. A model
   switch must never reset the session or read the model from process-global mutable state.
4. **Compaction summarizer:** use one named, durable compression operation that produces a
   validated checkpoint from the canonical transcript. Feed the prior checkpoint into the next
   compaction. Follow Hermes' bounded retry behavior: use the configured compression model when
   available and retry once with the session model when appropriate. Do not combine independent
   local summaries, provider-native summaries, and conversation summaries as competing sources.
5. **Large tool results:** retain the complete result as a durable redacted artifact or evidence
   record, and place only a bounded projection, preview, metadata, and retrieval handle in model
   context. Historical media and oversized tool output may be pruned from the active projection,
   but must not disappear from the durable audit record without an explicit retention operation.
6. **Concurrent turns:** acquire one durable lease for the logical session. A second user turn waits
   for the lease and reloads the latest transcript after acquisition; it does not build from a
   stale snapshot or interleave messages. Lease timeout is a typed failure. Parallel tool work
   inside one turn remains owned by that turn and must be joined according to the parallel-tool
   execution plan before the assistant continuation is committed.
7. **Compaction failure:** preserve the original active transcript unless a validated checkpoint is
   committed atomically. Retry only within a bounded policy. A deterministic fallback is allowed
   only when it is explicitly marked, bounded, and validated; terminal provider, quota, timeout,
   or malformed-summary failures must surface as typed context failures before another model call.
8. **Legacy sessions:** load old records conservatively. Reconstruct historical tool pairs only
   when call ID, ordering, arguments, and result identity are exact. Otherwise mark the historical
   boundary as incomplete and begin canonical transcript capture at the next turn. Never fabricate
   a successful tool result or silently delete malformed evidence.
9. **Retention and redaction:** use soft archive as the default lifecycle operation. Keep archived
   transcript rows available for display and recovery while excluding them from active model
   projections. Redact credentials, tokens, URL secrets, and unnecessary customer data before
   persistence, summarization, export, logging, or reintroduction into a prompt. Exact retention
   duration and access roles remain deployment policy values, not alternative context behavior.
10. **Reset semantics:** Clear/New creates a new monotonic transcript generation with lineage to
    the prior generation. Retry, provider retry, Temporal retry, worker replacement, deployment,
    and approval resume continue the existing generation. Agent-version changes are recorded as
    turn metadata unless the user explicitly starts a new generation. Compaction creates an active
    checkpoint/lineage transition, not a user-visible reset.

The only remaining configuration inputs are policy values such as retention duration, access roles,
and the exact compression-model deployment. They must not change the source-of-truth, session
continuity, compaction, or failure semantics above.

## Decisions settled before implementation

These are implementation requirements, not unresolved architecture questions:

- A provider context window remains bounded per model request. KasiTek's session context must grow
  across requests from the durable transcript; it must never reset to the latest message or a
  display-only recent window.
- Hermes is the primary context reference. Waku's bounded recent-history window and local session
  log are comparison material, not the source-of-truth architecture for KasiTek.
- The canonical active context is one PostgreSQL-backed structured transcript projection. Display
  messages, summaries, model-call rows, tool-invocation rows, and journal events are evidence or
  projections; they are not alternative prompt assemblers.
- Compaction is provider-aware and pre-dispatch. It protects the system head, active turn, and
  recent tail, preserves complete tool rounds, commits a validated checkpoint atomically, and
  excludes compacted rows from later prompts while retaining them for audit and recovery.
- A model change reprojects the same durable transcript for the new model and may trigger
  compaction; it does not reset the session or read a process-global selected model.
- Only an explicit Clear/New operation creates a new transcript generation. Retries, Temporal
  retries, worker replacement, deployment, approval resume, and compaction continue the same
  generation.
- The parallel-tool plan owns the complete tool batch and durable fan-out/join first. This plan
  consumes its ordered assistant/tool round and makes it continuous across later user requests;
  it does not introduce another tool dispatcher.

The remaining checklist items below are code, migration, test, rollout, and release-evidence work.
They do not reopen these architectural decisions.

## Scope

### Included

- Durable agent-session identity and serialization of turns for one autonomous session.
- One canonical, ordered, structured transcript for model-visible history.
- Persist-before-effect ordering for assistant tool calls and tool outcomes.
- Provider request projection from the durable transcript.
- Provider-aware context pressure, pruning, compaction, and overflow recovery.
- Compaction activation, generation, cursor, digest, and replay semantics.
- Separation of session context, display conversation, long-term memory, and runtime evidence.
- Migration of existing sessions and removal of the old active-context assembler.
- Context continuity metrics, structured diagnostics, and Temporal/PostgreSQL verification.

### Excluded

- Parallel tool fan-out, safety segmentation, and durable joins; those belong to the parallel tool
  execution plan.
- Provider/model selection UX or fallback policy.
- Grounding policy except where it incorrectly prevents context assembly or live-tool reasoning.
- Studio graph rendering and execution visualization.
- Playground/Live deployment and credential-environment behavior.
- A new semantic memory product. Long-term memory remains supplementary evidence, not a replacement
  for session transcript history.

## Architectural decision

The runtime will have one durable context source and read-only projections:

```text
Durable agent-session transcript
        |
        +--> provider request projection
        |       +--> exact token/byte fit and model dispatch
        |
        +--> display conversation projection
        |
        +--> runtime journal, metrics, and observability
        |
        +--> compaction checkpoint and active-tail projection
```

The canonical transcript is not reconstructed from `model_calls`, `tool_invocations`, journal
events, browser state, or the final display reply. Those records remain valuable evidence and must
reference transcript entries, but they do not become an alternative context assembler.

The durable implementation will use a PostgreSQL-backed transcript adapter behind a small runtime
interface. The adapter may extend existing structured message storage where it can satisfy all
invariants; otherwise it will introduce an explicit session-transcript table. The decision must
be made during Phase 1 from schema evidence, not by silently continuing to join unrelated audit
tables.

## Canonical transcript contract

Each session has a stable identity independent of a browser render. Each transcript entry has:

- `sessionId`, `turnId`, and monotonically increasing `sequence`;
- a typed entry kind: user, assistant response, assistant tool-call batch, tool result,
  interruption/error result, waiting state, or compaction checkpoint;
- structured model content, preserving role, tool name, arguments, provider tool-call ID, and
  runtime operation ID without flattening tool messages into text;
- parent operation, parallel-group, and causal ordering metadata where applicable;
- a durable idempotency key, source run ID, created time, and transcript generation;
- an immutable entry digest and session head digest.

The transcript invariants are:

- The inbound user message is appended before the first model request.
- The assistant response containing tool calls is committed before any external effect starts.
- Every tool result, including a typed recoverable error, is committed before the next model call.
- A parallel assistant batch remains one model-visible round and every result retains its call ID.
- A final assistant response is committed before the run is reported complete.
- An incomplete round is represented as waiting, interrupted, failed, or unknown-effect state; it is
  never silently dropped or converted into a successful final answer.
- A transcript cursor/digest mismatch rejects the projection before provider spend.

## Work split and sequencing

The implementation is deliberately divided so context work can proceed without waiting for another
agent to finish tool execution and approval behavior. The boundary is the canonical transcript
adapter. Context owns the transcript source-of-truth, active projection, and compaction; the
tool-calling work owns how live tool operations are dispatched and completed.

### Track A — Context foundation: proceed now

This track can be implemented and verified end to end for ordinary user/assistant turns and for
deterministic transcripts containing committed tool rounds. It does not change the other agent's
tool dispatcher or approval state machine.

- Define the transcript entry contract, session/generation identity, cursor, digest, idempotency,
  and compaction lineage.
- Add the PostgreSQL transcript/session seam and repository operations for append, projection,
  cursor verification, compaction activation, and turn serialization.
- Preserve structured tool-call fields in the schema and projection even before live tool execution
  is wired to write them.
- Move ordinary cross-request context loading to the canonical active projection, including the
  current user append and final assistant commit.
- Build the provider request manifest from that projection with model capacity, output reservation,
  tool/schema envelope, byte/token fit, and bounded diagnostics.
- Implement active compaction, checkpoint validation, protected head/active tail, atomic pointer
  advancement, and failure preservation using deterministic transcript fixtures.
- Add migration/backfill logic for user/final assistant history and conservative legacy-boundary
  handling.
- Add context-only unit and integration tests, including multi-turn continuity, compaction,
  model switching, retries of idempotent appends, and digest/cursor rejection.
- Update context architecture, recovery, migration, and release documentation.

Track A is complete when a normal multi-turn session can load, project, compact, and reload its
canonical context without reading `conversation_summaries`, joining audit tables, or depending on
the in-memory loop. Tool entries can be supplied by fixtures or the transcript adapter during this
track; live tool execution is intentionally not claimed as complete.

### Track B — Runtime integration: pick up after tool-calling/approval work

This track begins when the other agent has stabilized the live tool-call, parallel-batch, retry,
and approval contracts. It integrates those behaviors with the context foundation without taking
ownership of their implementation.

- Connect model tool-call persistence to the transcript append-before-effect boundary.
- Connect successful, failed, timed-out, cancelled, deferred, and approval-blocked results to
  transcript append-before-continuation.
- Integrate parallel assistant batches, ordered joins, safety segments, and result identities with
  the transcript's causal ordering.
- Make approval wait/resume continue from the same session generation and transcript cursor.
- Make Temporal worker-loss, retry, unknown-effect, and continue-as-new recovery reload the
  canonical transcript rather than relying on a per-run checkpoint.
- Validate the actual tool result projection, large-result artifact handling, and compaction of
  completed or pending tool rounds.
- Run shadow comparison, canary cutover, legacy-reader removal, and full autonomous-session tests.

Track B is complete only when real model/tool runs preserve tool calls and results across later
user requests, approvals, retries, worker replacement, and compaction. Until then, the context
foundation should remain behind a controlled integration boundary rather than pretending the
whole autonomous path is finished.

#### Task B handoff checkpoint — 2026-09-11

The parallel-runtime agent resumed the live integration gate after the approval work reached its
handoff checkpoint. The local Temporal server and configured real provider were reachable when the
test was forced to `127.0.0.1:7233` and namespace `default`; the run did not reach model tool-batch
preparation because the context boundary failed first with `ContextCompactionError` / `no_progress`.
The failing fixture is `agents/test/temporal-real-model.integration.test.ts`, which seeds 24
conversation messages and then exercises the real model through the decomposed Temporal runtime.

Observed evidence:

- The canonical transcript shadow comparison first matched at source cursor 25.
- On the subsequent current-user append, the shadow comparison correctly skipped with
  `canonical_compacted`; the active projection contained a checkpoint plus a 21-message tail.
- `executeLoopForRun` then called `compactDurableContext` again on that already-compacted active
  projection. The compactor selected zero omitted units and raised `no_progress` after retries,
  so model dispatch and tool-batch preparation were never exercised.
- The direct compaction contract still intentionally rejects a genuinely zero-omission request;
  the caller must avoid treating an already-fit active projection as a new compaction failure.
- A context-unit regression was added locally for a one-message omission replaced by one bounded
  summary. It passes with the focused context tests, but it does not fix the repeated-compaction
  caller case above.

Resolution and verification:

- The runtime caller now computes whether the active canonical projection actually needs another
  lossy rewrite. If it already fits the retained-unit policy, it skips the direct compactor and
  carries forward the active session generation; the independent Memory V2 checkpoint path remains
  enabled when required.
- The caller change builds successfully and the focused context, transcript, and planning tests
  pass 31/31.
- The configured real-provider test now passes 1/1 against the local Temporal server. It exercised
  model dispatch, a real `test.real_read` tool proposal, durable prepare/execute/commit, and the
  continuation after the active checkpoint. The earlier `no_progress` failure is resolved.
- Shared-worktree note: the caller change is currently visible in `agents/src/temporal/activities.ts`
  alongside the context agent's existing edits and is intentionally not independently staged;
  preserve that file and the related context test changes when Task B resumes. The same file also
  contains the approval-runtime guard that skips the legacy per-operation approval insert when
  `stepExecutionEnabled` is true; grouped `prepareToolBatch` owns those approval records, so do
  not remove or overwrite that guard while continuing the context work.
- The local Temporal recovery and worker-loss matrices now pass 19/19 after the recovery fixture
  was updated to use the durable approval-group signal and to annotate the approval-required
  operation before execution. This proves the fan-out/recovery seam; it does not replace the
  remaining canonical transcript and live-provider Track B checks.

Current state for the next Task B agent:

- The approval-group implementation is complete for the local end-to-end scope. Its plan and local
  evidence record are now in `docs/plans/completed/`; hosted deployment is outside that task.
- The context caller's repeated-compaction `no_progress` failure is fixed. The local configured
  real-model Temporal test now passes through model dispatch, tool proposal, durable
  prepare/execute/commit, and continuation.
- Task B still owns canonical transcript continuity, live tool-call/result persistence, compaction
  integration, approval wait/resume continuity, retry and worker-loss recovery, large-result
  handling, and its remaining browser/provider checks.

Next context-agent action:

1. Add or retain a deterministic regression for a second model request after active compaction,
   then run the remaining context Track B checks: tool-result transcript assertions, pending and
   completed approval rounds, worker-loss/retry recovery, large-result handling, and browser/live
   provider checks. Do not weaken transcript validation or bypass compaction merely to make a
   provider test pass.

The approval-specific implementation and evidence remain owned by the parallel-runtime workstream.
The real-provider failure above is context integration evidence only; it is not evidence of an
approval failure. Do not mark Track B complete until live tool-call/result continuity, approval
wait/resume, retry/worker-loss behavior, large-result handling, and the remaining browser/provider
checks are separately demonstrated.

### Track A implementation evidence

- [x] PostgreSQL session/transcript schema, tenant scope, forced RLS, ordered append, idempotency,
      generation reset, active checkpoint pointer, and projection digest checks are implemented in
      migrations 174, 175, and 176 plus `SessionTranscriptRepository`.
- [x] Ordinary conversation admission imports legacy user/final rows conservatively, appends the
      current user before context construction, reads only the active canonical projection, and
      commits the final assistant entry before terminal run persistence.
- [x] Provider request manifests carry source cursor, transcript generation, active projection
      digest, compaction generation, provider capacity, reservations, and bounded fit accounting.
- [x] Hermes-aligned soft pressure and retained-tail selection are centralized in the context
      planner; compaction activation preserves complete deterministic tool rounds and archives old
      rows without deleting them.
- [x] Unit coverage verifies continuity, structured tool pairs, compaction replay/failure
      preservation, generation reset, digest/cursor rejection, manifest identity, and provider
      model-relative thresholds. TypeScript build and focused context suites pass.
- [x] PostgreSQL-backed context runtime integration passes 2/2 tests, and local Temporal
      context-compaction recovery passes 2/2 worker-loss cases (before and after persistence)
      against the configured local services. This confirms the context durability seam; it is
      not evidence that the Track B tool/approval path is complete.
- [ ] Browser and the remaining local live-integration evidence remain pending. The configured
      real-provider test now passes 1/1 against local Temporal after the active-projection
      no-progress fix; it exercised a real model tool proposal, durable prepare/execute/commit,
      and continuation after compaction. The local Temporal recovery and worker-loss matrices
      now pass 19/19 after the approval-batch fixture was aligned with the durable group signal.

### Phase ownership map

| Existing phase | Track A now | Track B later |
| --- | --- | --- |
| Phase 0 | Context inventory, ordinary cross-request regression, compaction fixtures | Live tool/approval regression fixtures |
| Phase 1 | Full transcript/session schema and repository seam | Verify integration with tool-operation identities and approval leases |
| Phase 2 | User/final assistant boundaries and idempotent turn writes | Live assistant tool-call/result persistence and Temporal recovery |
| Phase 3 | Provider projection, manifest, fit, and diagnostics | Actual tool schemas/results, batch boundaries, and large-result artifacts |
| Phase 4 | Compaction engine, validation, active pointer, and deterministic tests | Compaction during real pending/completed tool rounds |
| Phase 5 | Additive migration and shadow infrastructure | Production cutover and removal of legacy readers |
| Phase 6 | Context, migration, and deterministic integration verification | Real Temporal/provider/tool/approval and failure-injection certification |

## Execution plan

### Phase 0 — Freeze scope and capture the red regression

- [ ] Confirm the parallel tool execution plan is complete enough to emit ordered, durable
      operation/result records and record its final commit/checkpoint.
- [x] Preserve the current in-run tool-loop tests; they prove active tool context can grow during
      one run but do not prove cross-request continuity.
- [x] Add a deterministic cross-request fixture: one model request emits a tool call and the next
      model request receives the prior assistant call and exact tool result. The live runtime
      admission boundary remains covered by the Track B integration gate.
- [x] Assert the deterministic second-request manifest contains the committed
      prior user message, assistant tool-call entry, and exact tool result; a recent-only or
      latest-user-only manifest must fail the test.
- [x] Add a compaction fixture: context grows, compacts, and continues from the
      compacted checkpoint plus recent tail rather than restart from only the latest user message.
- [x] Inventory all context readers and writers, including conversation messages, model/tool
      repositories, checkpoints, summaries, compaction revisions, leases, and Temporal retries.
- [x] Record the removal list before implementation so no compatibility assembler survives by
      accident.

### Phase 1 — Establish the durable session and transcript seam

- [x] Define the small transcript interface for admission, append, read projection, compaction
      activation, cursor verification, and turn finalization.
- [x] Define or extend the PostgreSQL schema for session identity, ordered entries, head cursor,
      digest, compaction generation, and idempotent append keys.
- [x] Reuse the existing session lease/fencing mechanism so only one active turn mutates a session
      head at a time.
- [x] Make append operations transactional and retry-safe. A Temporal retry must observe the
      already committed entry instead of inserting a duplicate.
- [x] Keep display messages as a projection of the canonical transcript. Do not use the display
      projection as the model-context source after cutover.
- [ ] Keep `model_calls`, `tool_invocations`, effect receipts, and journal events as evidence with
      transcript references rather than as a second transcript. Live tool references are completed
      in Track B.
- [x] Add integrity checks for sequence gaps, duplicate idempotency keys, digest mismatch, orphan
      tool results, missing tool results, and invalid turn transitions.

### Phase 2 — Persist every turn boundary in the correct order

- [x] Append the inbound user entry at run admission.
- [ ] Append the complete assistant tool-call batch before dispatching any tool effect.
- [ ] Append each completed, failed, timed-out, cancelled, or approval-blocked tool result with
      its runtime operation identity before model continuation.
- [x] Append the final assistant response before completion/delivery projection.
- [ ] Make waiting and resumed approval turns continue from the same session transcript cursor.
- [ ] Make worker-loss recovery load the transcript by cursor/digest and replay only uncommitted
      work; never rebuild context from the last display reply.
- [ ] Store checkpoint references to the canonical transcript generation. A loop checkpoint may
      accelerate recovery, but it cannot become a competing source of conversation truth.
- [x] Verify that repeated user requests are new turns on the same session, not fresh empty
      contexts and not replays of prior runs.

### Phase 3 — Replace context assembly with one provider projection

- [x] Create one deep context-runtime interface that loads the active transcript state and returns
      an immutable provider request manifest.
- [x] Make the interface's first operation a durable active-projection read keyed by session and
      generation. Do not accept a caller-provided fresh message list as the cross-request source.
- [x] Preserve typed assistant/tool structure through every adapter and serializer.
- [ ] Include the active turn tail until it is terminal, waiting, or explicitly interrupted.
- [x] Resolve provider/model capacity for the selected route and reserve output, tool schemas, and
      protocol envelope separately from input history.
- [x] Measure the actual request manifest, including tool definitions and tool results, before
      dispatch.
- [x] Treat memory/retrieval as bounded supplementary evidence. It may add relevant facts but may
      not replace missing session history or silently rewrite the transcript.
- [x] Persist the request manifest digest, source cursor, compaction generation, component counts,
      and provider capacity as bounded evidence.
- [x] Add an assertion that every manifest identifies the transcript cursor/generation it was built
      from and that the cursor advances after a committed user, assistant, or tool entry.
- [x] Remove the old path that assembles model context from `conversationSummary` and incomplete
      display rows after the new projection is verified. The only retained display-row reader is
      the bounded generation-1 bootstrap described in Phase 5.

### Phase 4 — Make compaction active, pair-safe, and replayable

- [x] Implement the explicit Hermes-aligned threshold policy above from the selected provider/model
      capacity and effective input budget; no call site may introduce its own threshold.
- [x] Define normal, soft, and hard pressure states. Soft pressure starts compaction before the
      next provider request; hard pressure rejects only after bounded compaction cannot produce a
      valid fit.
- [x] Select compaction units from the canonical transcript, never from final display messages or
      unpaired audit records.
- [x] Preserve complete assistant/tool rounds and recent active-tail messages in deterministic
      fixtures. Parallel batches, pending approvals, and unresolved live effects remain Track B.
- [x] Generate a bounded validated checkpoint from omitted context and deterministic completed
      tool actions/results. Richer pending-work fields remain Track B.
- [x] Persist the checkpoint and atomically advance the session's active compaction pointer before
      the next model request.
- [x] Keep immutable pre-compaction entries for audit/replay, but exclude them from later provider
      projections once the active checkpoint is committed.
- [x] Make compaction idempotent by source cursor and generation. A retry must not create competing
      active summaries.
- [x] Invalidate old usage anchors after compaction and rebuild the context snapshot from the new
      active cursor.
- [x] Delete or demote the current `conversation_summaries` path so it cannot silently override the
      canonical compaction checkpoint.
- [x] If compaction cannot preserve a valid transcript, return a typed context failure before
      another provider call; never continue with a plausible but incomplete context.

### Phase 5 — Migrate existing data and remove the reset architecture

- [x] Add an additive migration for the transcript/session records and indexes.
- [x] Backfill existing user and final assistant messages as legacy transcript entries with an
      explicit legacy generation marker.
- [x] Do not fabricate historical tool-call/result pairs from audit rows unless correlation,
      ordering, arguments, and result identity are exact; otherwise mark the historical boundary
      as incomplete and start canonical capture from the next turn.
- [x] Write the canonical transcript for new turns and compare it against the legacy projection
      during a bounded shadow period. The comparison is digest/count-only, capped at 128 entries,
      and skips already-compacted projections whose archived history is intentionally absent.
- [x] Cut new model requests over to the canonical projection after canonical admission and
      projection checks pass; the legacy reader remains only as a generation-1 empty-session
      bootstrap.
- [x] Remove the legacy active-context read path, duplicate compaction assembler, and temporary
      compatibility flags. Keep only the one-time generation-1 bootstrap reader required for old
      display data.
- [x] Update internal architecture and operational documentation with the final source-of-truth
      and recovery rules.

### Phase 6 — Verify long-running autonomous sessions

- [x] Unit-test transcript ordering, typed entries, idempotent append, digest checks, and pair
      validation.
- [x] Integration-test 2, 5, 18, 32, 64, and 128 deterministic tool operations across multiple
      user turns; confirm every result remains available in the later canonical projection.
- [x] Run a long-session test with enough turns to trigger compaction more than once.
- [x] Verify context occupancy rises across turns, drops after compaction, and rises again from the
      new checkpoint instead of returning to zero after every request.
- [x] Run the real configured model against local Temporal with a connected capability. The
      `temporal-real-model.integration.test.ts` fixture passes 1/1 and reaches model, prepare,
      tool, commit, and continuation after compaction.
- [ ] Repeat the live integration shape with deterministic provider fixtures for exact canonical
      transcript assertions.
- [ ] Inject worker loss before and after user append, assistant-call append, tool-result append,
      compaction activation, model dispatch, and final response append.
- [x] Test concurrent requests for one session and verify lease fencing prevents interleaved turns.
- [ ] Test provider retry, Temporal retry, approval wait/resume, cancellation, timeout, and
      unknown external-effect outcomes.
- [ ] Test large tool outputs, provider byte limits, small context limits, and output reservation.
- [ ] Verify the display conversation, activity panel, and observability consume the same runtime
      evidence without becoming context sources.
- [x] Run the relevant agents build, lint/typecheck, focused tests, PostgreSQL migration tests,
      and Temporal recovery tests. Guided browser and local real-provider checks remain Track B
      work owned by the live runtime integration track.

## Removal gates

The work is not complete while any of these remain active in the autonomous path:

- model context assembled from only display messages or the final response;
- tool calls/results recovered by joining audit tables at request time;
- compaction stored without an active pointer used by the next provider request;
- a process-local transcript treated as the cross-request source of truth;
- a silent fallback that drops malformed or incomplete history;
- a second context assembler or second autonomous loop;
- a permanent dual-read or compatibility path after migration verification.

## Release record

**Change:** High-risk durable session-context and compaction repair for autonomous agents.

**Owner:** Agent Platform.

**Affected services and user surfaces:** Agent runtime, Temporal activities/workflows, PostgreSQL
session/transcript storage, provider adapters, autonomous chat, memory/retrieval projection, and
runtime observability.

**Platform release version or release ID:** To be assigned by the release owner.

**API/schema/migration changes:** Additive transcript/session/compaction schema and indexes;
backfill and cutover must be repeatable. Destructive removal of legacy readers waits until all
active runs and readers use the canonical contract.

**Feature flag or rollout method:** Short-lived shadow-read/canary controls may be used for
cutover. No permanent dual runtime is allowed after verification.

**Analytics events and success metrics:** Reuse existing runtime events where possible. Add bounded
metrics for context continuity, active transcript cursor, compaction activation, projection
rejection, session fencing, and context reset regressions. Success is zero unexplained cross-turn
context resets and no loss of a committed tool result.

**Logs, metrics, dashboards, and alerts:** Log session, turn, run, cursor, generation, provider,
attempt, and bounded error code. Never log full prompts, credentials, or unredacted tool output.
Alert on sequence gaps, digest mismatch, projection rejection, failed compaction, concurrent-turn
fencing, and unexpected context resets.

**Documentation:** Update internal runtime architecture, recovery runbook, migration notes, and
the Hermes/Waku research record. Public documentation is not applicable unless behavior exposed to
customers changes.

**Validation evidence:** Cross-request transcript tests, compaction tests, PostgreSQL migration
tests, Temporal worker-loss/retry tests, real-model local-Temporal run, provider-envelope checks,
and guided browser verification.

**Track A verification record (2026-09-11):** TypeScript build, typecheck, diff checks, migration
tests, transcript repository tests, context planner/builder/compaction tests, manifest tests, and
loop context-boundary tests pass. PostgreSQL transcript durability passes 3/3 tests, including
ordered reload/compaction/generation reset, concurrent append and lease fencing, and deterministic
2/5/18/32/64/128-operation multi-turn projections. PostgreSQL context runtime integration passes
2/2 tests against the local agents database. Local Temporal context-compaction recovery passes 2/2
worker-loss cases. The broader local Temporal recovery and worker-loss matrices now pass 19/19
after the approval-batch fixture was aligned with the durable group signal; this is local seam
evidence and does not replace Track B transcript or live-provider checks. The canonical path
now performs a bounded 128-entry digest/count-only legacy shadow comparison and no longer reads
conversation summaries for model context; legacy display import is limited to an empty generation-1
bootstrap. Real-provider and browser evidence remain Track B work. These gaps do not block
Track A's deterministic context foundation and are not evidence that Track B tool/approval behavior
is done.

**Rollback or disable plan:** Stop admitting new autonomous turns to the canary, preserve durable
transcript and compaction evidence, and redeploy the last tested artifact. Do not delete transcript
or checkpoint rows during rollback.

**Post-release review date:** Seven days after staged release, owned by Agent Platform and
platform operations.

## Exit gate

**Track A exit gate:**

- [x] Context survives multiple user requests at the canonical transcript seam.
- [x] Context grows, compacts, and grows again from the active checkpoint in deterministic fixtures.
- [x] Deterministic tool calls/results remain model-visible and pair-safe in later projections.
- [x] Existing memory/retrieval remains supplementary and cannot reset the session transcript.
- [x] Release evidence, migration evidence, rollback instructions, and internal documentation for
      the foundation are recorded.

**Track B exit gate:**

- [ ] Live tool calls/results remain model-visible across later turns, approvals, retries, and waits.
- [ ] Temporal worker replacement and unknown-effect recovery are certified against the canonical
      transcript.
- [ ] Pending tool rounds, large-result artifacts, shadow cutover, and legacy-reader removal are
      complete.
