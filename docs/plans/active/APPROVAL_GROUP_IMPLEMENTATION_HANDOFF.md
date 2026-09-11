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
- `846bec0a test(agents): cover approval cancellation outcomes`
- `de1cde6e test(agents): cover approval group terminal transitions`
- `373cc46a test(agents): cover approval group rejection API`
- `41ba363d fix(agents): avoid legacy approval rows in grouped batches`
- `5bae705a fix(agents): revalidate approval resources before decision` (also contains unrelated
  pre-staged context changes; do not treat this as an approval-only cherry-pick)
- `e20f5e10 test(agents): harden approval group decision boundaries`
- `20c790de fix(agents): resume invalidated approval groups`
- `7363bb95 feat(agents): record approval group lifecycle events`
- `02424475 test(agents): cover approval group scale and restart`
- `6a0ee146 test(agents): harden approval group scale boundaries`
- `c21529ca fix(agents): expose safe approval group event evidence`
- `1901fe5d test(agents): preserve approval sibling failures`
- `e7c15aa9 test(agents): isolate approval groups across model turns`
- `331a6cef fix(agents): persist approval group consumed evidence`
- `1f91e213 feat(agents): instrument approval group lifecycle`
- `642e8cf9 feat(agents): standardize approval lifecycle evidence`
- `c43608b5 test(agents): verify approval event metadata`
- `abd27653 docs(agents): record real approval orchestration evidence`
- `90f367b6 docs(agents): record final approval verification`
- `0dfebebe fix(agents): bind approval groups to run installations`
- `7a16d52b docs(agents): record installation binding evidence`
- `e241005f test(agents): cover completed-run approval boundary`
- `2bbc6e84 test(agents): exercise concurrent approval clicks`

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
  before the workflow terminates. Invalidation now uses the same durable signal path and commits
  `APPROVAL_GROUP_INVALIDATED` outcomes before resuming the model turn.
- Exact operation authorization and resource revalidation occur at both decision time and in
  `executeToolCall`; stale resources invalidate the group before approval is accepted.
- The decomposed Temporal path no longer inserts a legacy per-operation approval row during model
  proposal; `prepareToolBatch` owns grouped approval records, while effect-receipt reservation
  remains unchanged.
- Historical run projections and the activity timeline expose each terminal child outcome, including
  partial execution and provider/tool failures. Approved decisions reject an empty selected set.
- Public run-event and SSE projections expose bounded group identifiers, digests, counts, decisions,
  and operation IDs while continuing to filter arguments, resources, credentials, and tokens.
- Durable batch commit now carries the approval-group identity on every result and emits one bounded,
  idempotent `agent.approval.group.consumed` run event after the group reaches `consumed`, including
  operation counts, selected IDs, decision actor, expiry, and measured wait duration.
- Approval lifecycle instrumentation now records bounded requested/displayed/decided/resumed,
  cancelled/invalidated/expired/consumed counts, group and selected-operation size, wait duration,
  decision latency, stale/duplicate/conflict outcomes, and post-approval failed/unknown provider
  outcomes. It does not use group, run, organization, resource, or provider request IDs as metric
  labels. See [`Agent approval-group observability`](../../internal/operations/agent-approval-observability.md).
- Group lifecycle run events now carry the same bounded group/run/batch/plan/policy/count/actor
  metadata, with applicable terminal duration and error code fields. Event metadata coverage is
  asserted at the API boundary.

### API, channel, and Studio surface

- Group decision endpoint: `POST /v1/runs/:runId/approval-group`
- Run detail exposes `approvalGroup` plus historical `approvalGroups`.
- Channel approval prompts resolve the group, not the latest child row.
- Client types and group approval controls are already wired.

### Verification already completed

- `pnpm --dir agents build` passed.
- Client build passed after the group client changes.
- PostgreSQL integration passed: 92/92 tests across approval groups and migration tests, including
  rejected terminal/idempotent decisions and 32/64/128/256-operation persistence/listing.
- API approval-group tests passed: 12/12, including approval and rejection, tenant isolation, installation binding, completed-run rejection, stale digest/resource
  conflicts, expired/cancelled/already-signalled outcomes, 256-operation run-detail history, and
  lifecycle event assertions.
- Opt-in real-provider approval integration passed: 1/1 through a real configured model, durable
  group creation, the actual HTTP group-decision endpoint, Temporal signal/resume, and one
  synthetic external-effect invocation. It also submits two concurrent decisions and verifies one
  accepted response plus one idempotent response. This validates orchestration only; it is not provider
  sandbox/state-reconciliation or Studio evidence.
- The full deterministic Temporal tool-execution suite passed: 21/21, including the
  18-operation group, rejection, invalidation, expiry, cancellation, retry/failure matrix,
  replay, cancellation, history, worker replacement, 32/64/128/256-operation approval groups,
  partial provider failure, and fresh groups on later model turns.
- The full deterministic Agents suite passed: 1,213 tests in 199 files; 172 integration tests
  were skipped because their optional service flags were not enabled.
- `pnpm --dir agents build` passed after the decision-time invalidation and lifecycle changes.
- Resource-revalidation unit tests passed.
- Fresh disposable migration audit passed through migration 176 with 168 applied migrations.
- Legacy disposable migration audit passed through migration 176: a pre-173 pending approval row
  remained pending with `approval_group_id` null and no synthetic approval group was created.

The real-provider Temporal smoke test initially reached the local worker but stopped in the separate
context-compaction work with `ContextCompactionError(code=no_progress)` before tool-batch preparation.
The context caller was then corrected to skip redundant compaction when an active projection already
fits its retained-unit policy. The same real-provider test now passes 1/1 through local Temporal,
real model dispatch, a connected read capability, durable prepare/execute/commit, and continuation
after the active checkpoint. This is context/runtime evidence only: it does not prove the approval
group path, because the fixture intentionally uses an approval-free read tool.
The separate opt-in approval fixture now passes 1/1 through the real model, grouped proposal
creation, two concurrent requests to the actual HTTP approval endpoint (one accepted and one
idempotent), Temporal group resume, and one synthetic external effect. It does not prove a real
provider sandbox mutation or before/after provider-state reconciliation.

## Reproduction commands

Run the deterministic Temporal suite:

```sh
pnpm --dir agents build
RUN_TEMPORAL_INTEGRATION_TESTS=true \
TEMPORAL_TEST_ADDRESS=127.0.0.1:7233 \
pnpm --dir agents exec vitest run test/temporal-tool-execution.integration.test.ts --reporter=dot
```

Run the opt-in real-provider approval orchestration test (the local Temporal server and the
configured `agents/.env` provider credentials must already be available):

```sh
set -a
source agents/.env
set +a
RUN_REAL_MODEL_INTEGRATION_TESTS=true \
RUN_AGENTS_DB_INTEGRATION_TESTS=true \
RUN_TEMPORAL_INTEGRATION_TESTS=true \
TEMPORAL_TEST_ADDRESS=127.0.0.1:7233 \
TEMPORAL_NAMESPACE=default \
pnpm --dir agents exec vitest run test/temporal-real-approval.integration.test.ts --reporter=dot
```

The local Temporal dev server should already be running on `127.0.0.1:7233`; verify before starting
another one. The worker-replacement case is in the same test file and can be selected with
`-t 'worker is replaced'`.

## Immediate next work

1. Complete lifecycle observability: provision the documented dashboards/alerts in a durable
   backend, and validate bounded structured logging and signal delivery in a hosted environment.
   Metric instruments, consistent event metadata, and group-level consumed evidence are implemented
   and locally verified.
2. Run the real-provider/sandbox and guided Studio tracks, including refresh/reconnect, duplicate
   approval clicks, partial provider failure, and provider-state reconciliation.
3. Preserve the fresh-database and legacy-row migration evidence, run the rollback drill, and do
   not remove the legacy single-operation reader until the open Temporal history compatibility
   window is drained.
4. Complete the remaining scale evidence at the live Studio surface; API historical projection and
   Temporal barrier handling now pass at 32, 64, 128, and 256 proposals.
5. Cover remaining approval races and later-barrier behavior: group creation versus decision,
   second approval-required segments, later model turns, and approval after completed runs.

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
