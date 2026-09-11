# Hermes-aligned durable approval groups and human-in-the-loop execution

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-09-11

**Risk:** High

**Implementation status:** In progress. The durable group schema, repository, batch formation,
Temporal group signal, group decision API, expiry/invalidation transitions, and Studio/activity
controls are implemented. The group contract now also covers selected-operation controls, channel
approval delivery, signal retry, duplicate-call ordering, historical group summaries, decision-time
resource revalidation, terminal typed outcomes, lifecycle conflict/resume events, repository scale
checks, deterministic worker replacement, historical per-operation outcome projections, and
32/64/128/256-operation Temporal barriers, bounded approval evidence in public run-event/SSE
projections, idempotent group-consumed evidence after durable batch commit, and approval lifecycle
OpenTelemetry metric instruments, and concurrent group creation now replays one complete group.
Real-provider sandbox/state verification still requires a
disposable provider fixture;
durable dashboard provisioning, compatibility cleanup, and guided Studio checks remain open.

**Verification boundary:** On 2026-09-11, the real-model Temporal smoke test initially stopped in
the separate context-compaction implementation with `ContextCompactionError(code=no_progress)`
before tool-batch preparation. The context caller was corrected to skip redundant compaction for
an already-fit active projection, and the same real-provider read-only smoke test now passes 1/1
through local Temporal, model dispatch, durable prepare/execute/commit, and continuation. This is
runtime/context evidence only, not approval-group evidence, because the fixture uses an
approval-free read capability. Approval-specific verification currently includes a passing Agents
build, 93/93 PostgreSQL approval/migration tests, 14/14 API tests, a 23/23 full deterministic
Temporal suite, including worker replacement while a group was pending and 32/64/128/256-operation
group barriers, 14/14 API approval-group tests including installation/run binding, missing-scope
rejection, and completed-run rejection, and a 1/1 opt-in
real-provider approval orchestration test using a synthetic external-effect capability through the
actual HTTP decision endpoint, including concurrent duplicate-decision handling. A disposable
fresh database applied all 168 migrations through 176.
A disposable database seeded with a legacy pending approval row applied 173–176 and preserved that
row with no approval-group link and no synthetic group.

**Related plans:**

- [`Hermes-aligned parallel tool execution`](./AGENT_HERMES_ALIGNED_PARALLEL_TOOL_EXECUTION_PLAN.md)
- [`Hermes-aligned session context and compaction`](./AGENT_HERMES_ALIGNED_SESSION_CONTEXT_AND_COMPACTION_PLAN.md)
- [`Hermes/Waku approval research`](../../research/HERMES_WAKU_APPROVAL_RESEARCH.md)

**Primary references:**

- Local Hermes checkout: `/home/enoch/aworkspace/agents/hermes-agent`, revision
  `9a84bee265daad14340a80d7585928cd8ea1f9eb`.
- [OpenAI Agents SDK human-in-the-loop flow](https://openai.github.io/openai-agents-python/human_in_the_loop/).
- [Temporal workflow message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing).
- [Restate human-in-the-loop pattern](https://docs.restate.dev/ai/patterns/human-in-the-loop).

## Objective

Replace KasiTek's per-operation approval mismatch with a durable, standard approval model that can
review one logical action group, resume the same Temporal Workflow, execute approved operations
with the existing safety and parallelism rules, and preserve exact per-operation audit evidence.

Success means that a request such as “delete these 18 calendar events” produces one reviewable
approval group. One approval decision authorizes those 18 exact operations, the workflow resumes
after a restart, every operation executes at most once, and any individual provider failure is
reported as an execution outcome rather than as an approval failure.

## Scope

### Included

- A canonical approval domain model: action proposal, approval group, approval decision, operation
  authorization, bounded approval grant, and execution outcome.
- Immutable approval groups for the current model turn or approval barrier.
- Group-level approve, reject, expire, cancel, and idempotent repeated-decision behavior.
- Optional approve-selected behavior without silently approving unselected operations.
- Temporal pause/resume through a durable Workflow message boundary.
- PostgreSQL persistence for group identity, plan digest, exact proposals, decisions, and audit
  history.
- API and Studio projections that expose all pending operations instead of the latest approval row.
- Bounded session grants for narrowly scoped capability/resource patterns, with explicit expiry.
- Structured approval lifecycle events, metrics, logs, runbook updates, and release evidence.
- Removal of the broken single-approval projection and endpoint after the compatibility window.

### Excluded

- Replacing Temporal or making the runtime durable-execution-provider neutral.
- Implementing tool fan-out, safety segmentation, or provider retry policy. Those remain owned by
  the parallel tool execution plan.
- Context growth or compaction.
- Handoff behavior for guided, workflow, or customer-support agents.
- Channel approval tokens and operator command approvals. Those are separate approval domains and
  must not be mixed into autonomous tool approval state.
- A permanent global “approve everything” switch.
- A Calendar-specific bulk tool. The generic batch runtime must handle distinct Calendar calls.

## Why the current implementation fails

The current runtime has one approval record per side-effecting operation, but the read and control
surfaces behave as though a run has one approval:

- `agents/src/db/repositories/approval-repository.ts:getForRun()` returns only the newest approval.
- `agents/src/http/app.ts` accepts one `providerToolCallId` and one `argumentsHash`.
- `client/apps/client/src/lib/agent-platform.ts` exposes one `AgentApproval`.
- `client/apps/client/src/components/dashboard/studio/studio-page.tsx` renders one approval action.
- `agents/src/temporal/workflows.ts` waits on one selected call, then validates the returned decision
  against that call's operation identity and arguments hash.

When a model emits 18 delete calls, the database can contain 18 valid pending approvals while the
UI displays the newest one and Temporal waits for another one. Approving the displayed record is
then correctly rejected by the identity check, but the user experiences it as a broken approval
system.

The fix is to make the approval barrier itself a first-class durable object. Exact per-operation
identity remains necessary, but it becomes a child of an approval group rather than the only user
facing approval contract.

## Canonical domain contract

### Action proposal

An action proposal is created before an approval-required effect can execute. It contains:

- stable `runtimeOperationId` and `providerToolCallId`;
- capability name and version;
- normalized arguments hash;
- redacted preview data and resource snapshot;
- installation, run, batch, segment, and sequence identity;
- policy revision and permitted effect key;
- expiration and required approval scope.

The proposal is immutable. If arguments, target resource, capability version, policy revision, or
plan identity changes, the runtime creates a new proposal and requires a new decision.

### Approval group

An approval group is the complete set of approval-required proposals for one approval barrier. It
contains:

- `approvalGroupId`;
- run, conversation, installation, batch, and model-turn identity;
- ordered proposal IDs;
- a canonical `planDigest` over the reviewed proposals and policy revision;
- status, expiration, and decision metadata;
- bounded display metadata and redacted preview data.

The group is the meaning of “Approve all.” It covers only the proposals whose IDs and digest were
shown to the reviewer. Tool calls generated by a later model turn require a new group.

There is at most one active approval group per autonomous run. This prevents concurrent approval
barriers from interleaving decisions and makes Temporal resumption unambiguous. Historical groups
remain queryable after the active group is consumed.

### Approval decision and operation authorization

The group decision records who decided, when, what scope was selected, and which plan digest was
accepted. Group approval does not erase per-operation identity checks. Before each effect executes,
the runtime verifies:

- the group is approved and unexpired;
- the operation belongs to that group;
- the operation was included in the approved selection;
- the operation identity and arguments hash still match;
- the resource snapshot and policy revision are still valid;
- the operation has not already been consumed, cancelled, or superseded.

The resulting operation authorization is the exact proof consumed by the tool Activity. A late,
duplicate, stale, or mismatched decision is an idempotent no-op or a typed conflict; it never runs a
side effect.

### Approval grants

Session approval is a separate grant, not an enlarged approval group. A grant must be scoped to a
capability pattern and resource selector, bound to the installation and actor/session, and have an
explicit expiry. It may satisfy future group proposals only when the proposal matches the grant.

The first implementation will not add a permanent global grant. Destructive capabilities remain
explicitly reviewed unless a future policy decision adds a narrower administrative grant type.

### Execution outcomes

Approval rejection, expiry, cancellation, provider failure, retry exhaustion, and unknown external
effect are different outcomes. Group approval must not turn a provider failure into an approval
failure, and one failed operation must not erase the durable outcomes of its siblings.

## Target execution contract

```text
model emits a complete tool batch
            |
            v
persist all operation proposals
            |
            v
create one approval group for required effects
            |
            +--> execute approval-free reads under the parallel-tool plan
            |
            v
pause the Temporal Workflow durably
            |
            v
reviewer approves, rejects, or selects operations
            |
            v
validate group digest and exact operation bindings
            |
            v
execute approved operations using the existing safety segments
            |
            v
persist one outcome per operation and continue the same model turn
```

The approval layer decides whether an effect may execute. It does not decide whether operations
are parallel-safe. Once authorized, the existing parallel execution plan owns concurrency, barriers,
durable fan-out, joins, retries, and result ordering.

## Implementation checklist

### Phase 1 — Freeze the contract and coordinate the active parallel plan

- [x] Record this plan as the approval source of truth for group semantics.
- [x] Amend the approval section and decision table in
      `AGENT_HERMES_ALIGNED_PARALLEL_TOOL_EXECUTION_PLAN.md`; its current “one approval record per
      operation” wording must become “one approval group containing exact per-operation records.”
- [x] Preserve the existing batch, segment, and runtime operation identities introduced by the
      parallel execution work.
- [x] Define the approval state machine and allowed transitions:
      `pending -> approved | partially_approved | rejected | expired | cancelled | invalidated`,
      followed by `consumed` only after all selected operations have terminal outcomes.
- [x] Define the compatibility boundary for open Temporal runs before changing the Workflow command
      sequence. No new approval behavior may be deployed against an open history without Temporal
      patching/versioning.

### Phase 2 — Add durable approval-group persistence

- [x] Add an additive migration using the next available migration number after the active runtime
      migrations. Create an approval-group table with organization, installation, run, batch/turn,
      plan digest, policy revision, status, expiry, decision, actor, and timestamps.
- [x] Add `approval_group_id` to the existing approval records and retain one immutable record per
      operation for exact authorization and audit.
- [x] Add constraints and indexes for one active group per run, group operation ordering, pending
      expiry scans, and idempotent decision keys.
- [ ] Do not rewrite or regroup pending approvals from old open runs in place. Represent them through
      a bounded compatibility projection and let their versioned Workflow path reach a terminal
      state before removing the old reader.
- [x] Add repository methods to create or replay a group, list its complete operation set, fetch the
      active group, decide the group atomically, expire it, cancel it, consume operations, and return
      idempotent results for repeated decisions.
- [x] Make the group digest deterministic and redacted. Never include credentials, access tokens,
      full private message bodies, or unrestricted tool arguments in the digest preview or logs.

### Phase 3 — Build policy and approval-group formation

- [ ] Keep capability manifests as the policy input for whether a call needs approval. Reads remain
      approval-free when policy permits; controlled writes, external effects, and privileged calls
      remain gated.
- [x] Collect all approval-required proposals in the current model-emitted batch before any such
      effect executes.
- [x] Create one group for the current approval barrier, preserving model order and exact operation
      IDs. Do not create a separate user prompt for every sibling call.
- [x] Allow approval-free reads to execute according to the parallel execution plan, but never let
      an approval-required effect cross its boundary before the group decision. The mixed-batch
      Temporal regression commits the read before the approval pause and executes the gated effect
      only after the group decision.
- [x] Support group approval, group rejection, and approve-selected with explicit operation IDs.
      Unselected operations receive a typed rejected result and cannot execute.
- [x] Revalidate resources, capability version, policy revision, and arguments at decision and
      execution time. Stale plans become `invalidated` and require a new model proposal.
- [ ] Add bounded session grants only after the group path works. Match them against capability,
      resource selector, installation, actor/session, policy revision, and expiry. Do not implement a
      blanket future approval.

### Phase 4 — Replace the Temporal per-call wait with a group wait

- [x] Add a durable approval-group decision message to the Workflow contract. Use a validated
      Temporal Update for the primary decision path, or a Signal with an equivalent durable command
      record if the existing client integration requires it.
- [x] Have the Workflow create or load the group, set the run to `awaiting_approval`, and wait on
      the active group ID rather than a single call or the latest database row.
- [x] Resume the same Workflow and same model turn after approval. Do not create a new user message,
      new model turn, or replacement run to continue an approval.
- [x] Pass a validated per-operation authorization proof into each tool Activity. The Activity must
      recheck identity and consume authorization atomically before the external effect.
- [x] On rejection, expiry, cancellation, or invalidation, record typed results for every unexecuted
      proposal, release pending effect reservations, and continue or finish the model turn according
      to the existing runtime contract.
- [x] Preserve partial success: completed siblings remain completed, failed siblings remain failed,
      and unexecuted siblings remain rejected, expired, or cancelled.
- [x] Add Temporal patch/version handling and a removal condition for the old per-operation wait.
      Remove the old path after no open runs depend on it; do not keep it as an indefinite fallback.

### Phase 5 — Replace the API and Studio approval surface

- [x] Replace the single `approval` run-detail field with an active approval group plus its complete
      operation list and historical group summaries.
- [x] Add `POST /v1/runs/:runId/approval-group` with a group decision contract carrying
      `approvalGroupId`, decision scope, expected `planDigest`, selected operation IDs when needed,
      and an idempotency key.
- [x] Keep tenant authorization and `runs:approve` enforcement at the group endpoint. Validate that
      the actor can approve the run before accepting the decision.
- [x] Return explicit outcomes for approved, already-decided, expired, stale-digest, unauthorized,
      and invalidated requests. A duplicate click must never create a second decision or execution.
- [x] Build one compact approval card showing the logical action, operation count, affected
      resources, expiry, and expandable per-operation details.
- [x] Provide `Approve all`, `Approve selected`, and `Reject` for the current group. Label “all” as
      the current group only; never imply approval of future actions.
- [x] Show partial execution and per-operation failures after resume. Do not collapse them into a
      generic approval error.
- [ ] Remove the single-approval state, latest-row projection, and dead mismatch error path after
      the compatibility window.

### Phase 6 — Observability, audit, and operational recovery

Decision-conflict, invalidation, resumed, and idempotently consumed group run events are now
emitted at the API or durable batch boundary and covered by API/repository tests. The remaining
release work is lifecycle metadata consistency, durable dashboard/alert provisioning, and hosted
real-use evidence.

- [x] Emit lifecycle events for group requested, displayed, approved, partially approved, rejected,
      expired, cancelled, invalidated, resumed, consumed, and decision conflict.
- [x] Include group ID, run ID, batch ID, plan digest, operation count, selected count, actor,
      policy revision, applicable terminal duration, and bounded error code. Redact arguments and
      resource data. The event contract uses the same bounded metadata for every group lifecycle
      event; error code and duration are omitted only when not applicable.
- [x] Add OpenTelemetry metrics for approval wait duration, approval-group size, approval decision
      latency, stale decisions, duplicate decisions, expiry rate, partial approvals, and
      post-approval provider failures. The provider-neutral dashboard and alert contract is in
      [`Agent approval-group observability`](../../internal/operations/agent-approval-observability.md);
      durable backend provisioning remains a release-environment gate.
- [x] Update the Temporal recovery runbook with approval-group restart, expiry, stale-plan, and
      partial-success handling.
- [x] Update the internal execution architecture document and the supported API documentation if
      the group endpoint is exposed outside the Studio client.
- [x] Add a migration and rollback runbook. Rollback must not replay an already-approved external
      effect or reopen a consumed group.

## Verification matrix

### Unit and repository checks

- [x] Create one group for 18 distinct calls and verify all 18 exact operation records are attached.
- [x] Verify a group digest changes when reviewed identity or policy revision changes. Resource
      snapshot and capability-version coverage remains part of the resource-revalidation tests.
- [x] Verify approve, reject, expire, cancel, consume, and invalidation transitions reject illegal
      repeats.
- [x] Verify concurrent approve requests produce one accepted decision and idempotent responses for
      all duplicates.
- [x] Verify stale UI decisions cannot authorize a different group or operation.
- [x] Verify selected approval executes only selected operation IDs and returns typed rejection
      outcomes for the remainder.
- [x] Verify credentials, tokens, and unredacted arguments never appear in previews, digests, logs,
      or analytics payloads.

### PostgreSQL and API integration

- [x] Apply the additive migration to a fresh database and a database containing legacy approval
      rows. Both disposable audits reached migration 176; the legacy pending row remained
      ungrouped after migration 173.
- [x] Verify active-group uniqueness, complete operation listing, expiry scanning, tenant isolation,
      and decision idempotency under concurrent requests.
- [x] Verify the run-detail endpoint returns every pending operation, not the newest row only.
- [x] Verify the decision endpoint returns explicit stale, expired, unauthorized, and already-decided
      results.

### Real-use test harness requirements

- [ ] Run two complementary test tracks. The deterministic track must use a model-gateway fixture
      that emits an exact 18/32/64/128/256-call response so every operation identity and outcome can
      be asserted. The real-provider track must use an actual configured model, the real capability
      schema, the local Temporal Server, the real worker, PostgreSQL, and the HTTP approval endpoint.
- [ ] Use a disposable staging organization and a sandbox or test connection containing uniquely
      labelled resources such as `approval-e2e-<runId>-<index>`. Never run destructive approval tests
      against a user's production calendar, inbox, drive, or content.
- [ ] Drive the real-provider track through the same path as Studio: submit a user message, let the
      model produce the tool batch, observe the pending approval group through the run API/SSE
      surface, submit the group decision, and observe the resumed conversation and operation
      outcomes. Do not call repository methods directly as the only proof.
- [ ] Capture before-and-after provider state and compare it with the selected operation IDs. The
      pass condition is one and only one provider effect per selected operation, zero effects for
      rejected or expired operations, and durable evidence that reconciles with provider state.
- [ ] Record the model name, model response ID, run ID, Temporal Workflow ID, approval group ID,
      plan digest, migration version, and release identity for every real-provider run. Redact
      credentials and private arguments from the artifact.
- [ ] Repeat the real-provider run after refreshing the Studio page, reconnecting the event stream,
      and submitting a duplicate approval click. The result must remain one group decision and one
      execution per selected operation.
- [ ] Kill or replace the Temporal worker while the run is waiting for approval, then approve from
      the real API. Repeat once after one external effect has completed. Both runs must resume the
      same Workflow and never replay a completed effect.
- [ ] Run a real follow-up turn after the approved batch. Confirm that the previous decision is not
      reused for a new side effect and that a new approval group is displayed when policy requires
      it.

### Temporal and real-tool verification

The PostgreSQL persistence, API historical projection, and deterministic Temporal barrier checks now
cover 32, 64, 128, and 256 proposals. A live Studio rendering/reconnect check at those sizes remains
open.

- [x] Run an 18-operation approval-required scenario through local Temporal with one group approval
      and confirm all 18 distinct calls execute exactly once. The test uses a deterministic provider
      fixture; destructive calendar verification remains in the real-use sandbox track below.
- [ ] Repeat with 32, 64, 128, and 256 proposals to verify group persistence, UI/API projection,
      Temporal history handling, and no per-call approval prompt explosion.
- [x] Restart or replace the worker while the group is pending; approve afterward and confirm the
      original Workflow resumes without duplicate effects.
- [x] Submit two approval decisions concurrently and confirm one decision, one resume, and one
      execution per operation.
- [x] Let the group expire and confirm no effect executes, all unexecuted operations are typed as
      expired, and the run does not report an approval identity mismatch.
- [x] Change a resource or policy revision before approval and confirm the plan invalidates safely.
- [x] Force one provider failure after group approval and confirm sibling outcomes remain durable and
      the failure is reported as a tool execution failure.
- [x] Verify a later model turn creates a new group and cannot reuse the prior approval.
- [ ] Verify a bounded session grant matches only its declared capability/resource scope and stops
      matching after expiry.
- [x] Verify approval-free read tools execute without a group, while write, external-effect, and
      privileged tools create a group according to their manifest and policy. Manifest discovery,
      installation acceptance, and the mixed Temporal batch boundary cover this locally; the
      real-provider sandbox remains a release gate.
- [x] Ensure channel approval prompts address the durable group rather than selecting the newest
      child approval row; channel tokens resolve group IDs and preserve the existing channel security
      binding.
- [x] Ensure duplicate tool calls wait behind the canonical operation when that operation requires
      approval, so an incomplete alias cannot be committed before the group decision.
- [ ] Verify an approval request racing with group creation cannot be accepted against a partial
      proposal set. The API must return a typed not-ready or stale-group result and the user must see
      the complete group before deciding.
- [x] Verify a decision submitted by another organization, installation, run, or unauthorized actor
      cannot approve the group, even when the caller knows the group ID and digest.
- [x] Verify selection tampering, operation duplication, reordered operation IDs, and changed
      arguments are rejected by digest and exact identity validation.
- [x] Verify cancellation while the approval card is open, approval after cancellation, approval
      after expiry, and approval after the run has already completed.
- [x] Verify a provider failure, timeout, retry exhaustion, and unknown external effect after group
      approval produce distinct operation outcomes and do not reopen or duplicate the approval. The
      deterministic Temporal matrix confirms one committed outcome and one attempt per operation;
      real provider state reconciliation remains in the sandbox track.
- [x] Verify a second approval-required segment in the same run creates a new group only after the
      first group has been consumed, with no interleaved approval prompts.
- [x] Run the existing focused parallel-tool, recovery, worker-loss, and real-provider suites to
      prove that the approval change does not regress durable fan-out or continuation behavior.
- [ ] Perform the guided Studio test with one user action producing many deletes, including approval,
      refresh/reconnect, partial failure, and final conversation response.

## Release record

```text
Change: Durable Hermes-aligned approval groups for autonomous tool execution
Owner: Agent Platform
Risk: high
Affected services and user surfaces: agents runtime, Temporal Workflows and Activities, PostgreSQL,
  approval API, Studio chat, capability tools, provider adapters, execution observability
Platform release version or release ID: TBD at release time
API/schema/migration changes: additive approval-group schema and group decision endpoint; existing
  per-operation records remain as child authorization evidence; legacy reader removal follows the
  open-run compatibility window
Feature flag or rollout method: Temporal Workflow patch/version gate plus staged rollout; no blanket
  approval bypass flag
Analytics events and success metrics: approval-group lifecycle events; success is one accepted group
  decision, zero stale-identity mismatches, one execution per selected operation, and durable resume
  after worker restart
Logs, metrics, dashboards, and alerts: OpenTelemetry instruments and a provider-neutral dashboard /
  alert specification are checked in; durable backend provisioning, retention, notification
  ownership, and hosted signal validation remain release-environment gates. Redact all credentials
  and sensitive arguments.
User, API, internal, and operational documentation: update Studio/API approval documentation,
  internal execution architecture, Temporal recovery runbook, and migration/rollback runbook
Validation evidence: completed unit/redaction/SSE, PostgreSQL concurrency and 32/64/128/256
  persistence, idempotent consumed-event evidence, 14/14 API, local Temporal 23/23,
  local recovery/worker-loss 19/19, worker-replacement,
  expiry, stale-plan, partial provider failure, later-group, 18-operation, and 1/1 synthetic
  real-provider approval-orchestration checks; fresh and legacy migration-state audits reached 176.
  Real provider sandbox/state reconciliation, live Studio scale/reconnect, durable
  telemetry backend, and guided Studio checks remain pending.
Rollback or disable plan: stop admitting new group-version runs, preserve and drain already-approved
  groups, roll back only at a Temporal-compatible Workflow boundary, and never reopen consumed groups
Post-release review date: TBD at release time
```

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Approval meaning | “Approve all” covers the immutable current approval group only | Agent Platform | Decided |
| Exact identity | Group approval still requires per-operation identity, arguments, resource, policy, and expiry validation | Agent Platform | Decided |
| Temporal boundary | Approval decision resumes the same Workflow and model turn through a durable message boundary | Agent Platform | Decided |
| Parallel execution | Approval does not choose concurrency; the parallel tool plan owns safety segmentation and durable fan-out | Agent Platform | Decided |
| Permanent grants | No permanent global grant in this implementation; bounded session grants are the maximum reusable scope | Agent Platform | Decided |
| Partial approval | Support explicit selected operation IDs; unselected operations receive typed rejected results | Agent Platform | Decided |
| Group expiry | Use the existing 30-minute approval TTL for the first implementation; make the policy configurable in a later bounded-grant change | Agent Platform | Decided |
| Approval actor policy | Confirm whether all `runs:approve` actors may approve every capability or whether capability-specific reviewer roles are required | Product/Platform | Pending |
| Open-run migration | Confirm the deployment window for draining old per-operation approval Workflows | Release owner | Pending |

## Notes and blockers

- The existing parallel execution plan has approval items marked complete using per-operation
  semantics. Those items are not sufficient for the observed multi-delete failure and must be
  amended before either plan is considered complete.
- Existing approval, effect, and run records are valuable evidence and must not be deleted or
  rewritten destructively.
- The first implementation uses the existing `runs:approve` authorization boundary and preserves
  the legacy per-operation endpoint for channel and open-run compatibility. Removing that path
  requires the Temporal open-run drain/versioning check documented above.
