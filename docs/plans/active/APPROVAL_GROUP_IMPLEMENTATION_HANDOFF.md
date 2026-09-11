# Approval-group implementation handoff

Last updated: 2026-09-11

## Current objective

Implement durable, Hermes-aligned approval groups for autonomous tool execution. One model turn
may propose many approval-required operations, but the reviewer sees one immutable approval group.
The group decision resumes the same Temporal Workflow/model turn, while each operation keeps its
own exact identity, authorization, effect receipt, and terminal outcome.

## Commits already made by this workstream

- `f6b75b5d feat(agents): add durable approval group foundation`
- `62713bf2 feat(agents): complete durable approval group flow`
- `22d680db fix(agents): correct legacy approval insert`
- `38800da5 test(agents): verify approval groups against postgres`
- `965560cf docs(agents): record approval group verification`
- `bafaf267 fix(agents): route channel approvals through groups`
- `21516b17 docs(agents): record real model verification boundary`
- `3338c33f test(agents): verify 18-operation approval group`
- `d606750b fix(agents): harden approval group terminal states`
- `81fb012d feat(agents): expose approval group history`
- `3fcb2986 fix(agents): invalidate stale approval resources`
- `a8e12de3 fix(agents): persist terminal approval outcomes`

The current branch is `rewrite`. Do not stage all changes: another agent is actively implementing
session context and compaction in the same worktree.

## What is implemented

### Persistence and repository

- Migration: `agents/migrations/173_durable_approval_groups.sql`
- Repository: `agents/src/db/repositories/approval-repository.ts`
- Durable group statuses: pending, approved, partially_approved, rejected, expired, cancelled,
  invalidated, consumed.
- One active group per run, deterministic plan digest, exact child operation records, idempotent
  decisions, tenant-scoped queries, and group history.
- Expiry and invalidation materialize terminal child states. Resource revalidation at execution
  invalidates a stale group before the external effect.

### Temporal runtime

- Workflow group signal and durable group wait are in `agents/src/temporal/workflows.ts`.
- New decomposed tool path is gated by `agent-parallel-tool-activities-v1`.
- Group approval executes selected operations, rejects unselected operations with typed results,
  preserves partial outcomes, and resumes the same model turn.
- Rejection, expiry, and cancellation now commit a typed result for every unexecuted operation
  before the workflow terminates.
- Exact operation authorization and resource revalidation occur in `executeToolCall`.

### API, channel, and Studio surface

- Group decision endpoint: `POST /v1/runs/:runId/approval-group`
- Run detail exposes `approvalGroup` plus historical `approvalGroups`.
- Channel approval prompts resolve the group, not the latest child row.
- Client types and group approval controls are already wired.

### Verification already completed

- `pnpm --dir agents build` passed.
- Client build passed after the group client changes.
- PostgreSQL integration passed: 83 tests across approval groups and migration tests.
- Temporal deterministic suite has passed the 18-operation group, rejection path, retry/failure
  matrix, replay, cancellation, and history cases.
- The new expiry case passed in isolation and now verifies all four unexecuted operations become
  `APPROVAL_EXPIRED`.
- Resource-revalidation unit tests passed.

The real-provider Temporal smoke test reached the local worker but stopped in the separate context
compaction work with `ContextCompactionError(code=no_progress)` before tool-batch preparation.
That is not approval evidence and belongs to the session-context plan.

## Most recent test detail

The full Temporal command previously reported 11 passing and one test-harness failure because the
new expiry test omitted the `expirationSignal` import. That was fixed. The focused expiry test then
passed. The expiry test also needed a `cancelApprovalGroup` stub because Temporal proxy activity
properties are always truthy; the production worker must register that Activity.

Run the full deterministic suite again:

```sh
pnpm --dir agents build
RUN_TEMPORAL_INTEGRATION_TESTS=true \
TEMPORAL_TEST_ADDRESS=127.0.0.1:7233 \
pnpm --dir agents exec vitest run test/temporal-tool-execution.integration.test.ts --reporter=dot
```

The local Temporal dev server should already be running on `127.0.0.1:7233`; verify before
starting another one.

## Immediate next work

1. Run the full Temporal suite and commit only approval-related changes if anything remains.
2. Add an approval-cancellation integration case mirroring the expiry case; assert every operation
   is committed as `APPROVAL_CANCELLED`, no tool Activity runs, and the group is cancelled.
3. Add repository transition tests for cancel, expire, consume, invalidation, illegal repeats, and
   stale selected-operation/digest decisions.
4. Add HTTP/API integration coverage for tenant authorization, explicit expired/stale/already-
   decided responses, run-detail history, and duplicate approval clicks.
5. Complete decision-time resource revalidation. Current API rechecks proposal identity and
   installation policy; current resource snapshot revalidation is at execution time in the
   Temporal Activity. Do not mark the plan complete until this distinction is resolved.
6. Add lifecycle/audit/metrics coverage for requested, displayed, approved, partially approved,
   rejected, expired, cancelled, invalidated, resumed, consumed, and decision-conflict events.
7. Add scale tests for 32, 64, 128, and 256 proposals and a worker-restart-while-waiting test.
8. Update the approval plan checkboxes only when the behavior is actually implemented and tested.

Primary plan:
`docs/plans/active/AGENT_HERMES_ALIGNED_APPROVAL_GROUPS_AND_HUMAN_IN_THE_LOOP_PLAN.md`

## Worktree boundary

The following broad dirty changes belong to the other agent and must not be staged or reverted:

- context/session/compaction runtime and migrations;
- `agents/src/temporal/activities.ts` context changes;
- context-related tests and real-model test;
- parallel-tool plan and session-context plan;
- unrelated server, client, docs, and operational changes.

Use `git diff -- <approval-file>` and `git add -p` when a shared file contains both workstreams.
Never use `git add .`, `git reset --hard`, or checkout another agent's files.

## Important architectural constraints

- Approval groups are for the current immutable model-turn barrier only; never create a permanent
  global approve-all switch.
- The approval layer does not choose parallelism. The parallel execution plan owns segmentation,
  fan-out, retries, joins, and result ordering.
- Approval rejection/expiry/cancellation/provider failure/unknown effect are distinct outcomes.
- A repeated approval click must be idempotent and must never replay an external effect.
- A stale resource, capability version, policy revision, or argument must invalidate the group and
  require a fresh proposal.
- Do not remove the legacy single-operation path until the Temporal open-run compatibility window
  has been explicitly drained and versioning evidence is recorded.
