# Agent batch publishing checklist

**Status:** Active

**Plan:** [`AGENT_BATCH_PUBLISHING_PLAN.md`](./AGENT_BATCH_PUBLISHING_PLAN.md)

**Owner:** Agent Platform and Platform Integrations

**Last updated:** 2026-09-02

This checklist is the execution record for the batch publishing plan. Mark an item complete only
when the implementation and its required verification exist. Record commit, test, deployment, and
follow-up evidence beside the relevant phase.

Status markers: `[x]` complete, `[~]` implemented in part with a named follow-up, `[ ]` pending.

## Phase 0: confirm the contract

- [x] Adopt the rule that a batch publishes all eligible targets already fixed in the approved draft.
- [x] Require each target to be tied to one concrete connected account, not only a platform name.
- [x] Require changes to a target, account, variant, or media to invalidate the previous approval.
- [x] Block the whole batch before provider effects when one selected target fails preflight.
- [x] Make immediate publishing the first release and keep scheduling as a follow-up.
- [x] Use the normalized aggregate states: `SUCCEEDED`, `PARTIAL`, `PROCESSING`, `FAILED`,
      `BLOCKED`, and `UNKNOWN`.
- [x] Use normalized target states with retries limited to failed or reconciled retryable targets.
- [x] Confirm the completion delivery mechanism for durable batches after inspecting Agent worker
      continuation, polling, and gateway delivery capabilities. The approved workflow now retains
      the admitted batch and follows it through a durable status activity/timer before terminal
      delivery, with a bounded fallback when confirmation remains unavailable.
- [x] Record the settled implementation defaults in the plan before changing code.

## Phase 1: contracts and domain model

- [x] Define the versioned preflight result contract.
- [x] Define the versioned batch request and response contract.
- [x] Define bounded reason codes and remediation modes for blocked and failed targets.
- [x] Define the approval snapshot fields and canonical hash input.
- [x] Define the batch and batch-item lifecycle state transitions.
- [x] Define the safe Agent projection for accounts, variants, media, statuses, and errors.
- [x] Define which provider receipts and external IDs remain Core-only.
- [x] Add the Core database model for a durable publish batch.
- [x] Add the Core database model for durable batch items linked to existing publish jobs.
- [x] Add migration and rollback notes for the new records and indexes.
- [x] Add ownership and authorization checks for batch reads and writes.
- [~] Add contract fixtures for one target, multiple targets, duplicate providers, and mixed states.
      In-memory contract coverage and a PostgreSQL mixed-state fixture are present; duplicate-provider
      and claim-race fixtures remain pending.

## Phase 2: Core preflight

- [x] Add the provider-neutral Core preflight module and interface.
- [x] Resolve the post's selected connections and variants without accepting a second untrusted
      account mapping from the Agent.
- [~] Check connection status, credential status, health, webhook requirements, and provider mode.
      Normalized connection and permission inventory checks are wired; provider-specific fixture
      coverage remains pending.
- [x] Check product capability and provider permission readiness through the existing readiness
      contracts.
- [x] Check provider-specific media support and media processing state.
- [x] Check content length, required fields, and variant validity.
- [x] Detect already published, processing, canceled, and non-retryable targets.
- [x] Return normalized results without raw scopes, tokens, URLs, or provider payloads.
- [x] Ensure preflight performs no create, publish, upload, or destructive provider operation.
- [x] Re-run the authoritative preflight immediately before claiming external effects.
- [~] Add Core tests proving every blocked reason prevents provider calls. Pure preflight and
      contract coverage is present; provider-call and database integration fixtures remain.

## Phase 3: durable batch execution

- [x] Add the internal Core batch publish route.
- [x] Require the existing authenticated Agent context and idempotency key.
- [x] Verify the approved snapshot hash before execution.
- [x] Create or reuse a batch record idempotently.
- [x] Create one batch item for each eligible existing publish job.
- [x] Claim target jobs atomically so two workers cannot execute the same item.
- [x] Execute items through existing provider adapters and the social publishing worker.
- [x] Bound concurrency to avoid provider rate limits and excessive external effects.
- [x] Preserve asynchronous `PROCESSING` states and provider reconciliation behavior.
- [x] Aggregate item results without overwriting target-level history.
- [x] Persist `PARTIAL` when some targets publish and others fail.
- [x] Persist `UNKNOWN` when the provider outcome cannot be safely determined.
- [ ] Add reconciliation before retrying unknown outcomes. Provider-specific reconciliation remains
      required; the system intentionally keeps `UNKNOWN` closed to blind retry.
- [x] Allow retries only for failed or explicitly retryable targets.
- [x] Exclude confirmed published targets from every retry path.
- [x] Prevent the legacy per-job retry/run-now path from bypassing `UNKNOWN` reconciliation.
- [x] Add batch status reads for the Agent and authorized client surfaces.
- [~] Keep the existing single-platform route compatible and use the same internal module where
      practical.
- [~] Add Core unit and integration tests for claim races, duplicate requests, timeouts, partial
      success, asynchronous completion, and worker recovery. Unit coverage, timeout/aggregation
      tests, and the PostgreSQL partial/idempotency fixture pass; claim-race and provider-worker
      recovery fixtures remain.

## Phase 4: Agent capability and approval

- [x] Add `kasitek.core.content_post_publish_batch` to the Agent tool registry.
- [x] Add the Core client method and typed request/response models.
- [x] Add the read-only preflight capability or read mode required by the Agent workflow.
- [x] Mark batch publishing as an external effect with durable execution, required idempotency, and
      one approval.
- [x] Project the exact batch targets, account labels, variants, media count, and action into the
      approval resource.
- [x] Add the snapshot/hash reference needed to reject changed approvals.
- [x] Update Agent system guidance to prepare variants before approval and execute one batch tool.
- [x] Prevent Agent instructions from encouraging one publish call per platform.
- [x] Add safe result projection for per-target reason and remediation.
- [x] Add terminal completion formatting for succeeded, partial, processing, failed, blocked, and
      unknown batches.
- [x] Add status continuation or polling so an accepted batch does not leave the Agent waiting
      indefinitely. The workflow polls the read-only status activity after approval, reports the
      terminal per-target result, and emits an explicit bounded-time unconfirmed result.
- [x] Make batch-approved TikTok direct publishing carry the explicit batch approval into the
      provider adapter, while leaving single-post consent enforcement intact.
- [x] Classify authentication/consent failures in batch target output so the Agent reports the
      required remediation and does not advertise a blind retry.
- [~] Add Agent tests for one approval, changed snapshot rejection, partial results, and retry-only
      failed targets. Approval, projection, completion, contract, and retry route tests pass;
      provider retry integration remains.

## Phase 5: gateway behavior

- [~] Define the shared gateway batch-result envelope. The versioned Agent result and shared
      completion formatter carry the normalized batch result; a separately named gateway envelope
      is still pending.
- [x] Add web rendering for aggregate status, target rows, variants, and retry actions.
- [x] Add compact WhatsApp rendering with target-level statuses and remediation.
- [x] Add compact Telegram rendering with target-level statuses and remediation.
- [~] Update other configured gateway adapters to consume the same normalized result. Shared Agent
      completion formatting covers current adapters; dedicated adapter fixtures remain.
- [x] Keep provider-specific wording at the gateway or Core classification layer, not in Agent
      prompts.
- [~] Ensure blocked batches provide an actionable connection-access path where supported. Remediation
      modes are projected; gateway-specific action links remain.
- [x] Ensure no gateway renders an empty `Content posts:` section.
- [~] Add gateway tests for long target lists, partial success, media summaries, and unknown states.
      Shared completion tests exist; gateway-specific fixtures remain.
- [~] Verify mobile and desktop layouts for the web batch preview and status view. Responsive classes
      and the dense target summary are implemented; browser viewport evidence remains.

## Phase 6: manual UI alignment

- [x] Replace the manual composer publish loop with the Core batch command.
- [x] Add preflight feedback before the manual publish confirmation.
- [x] Add one publish action for the selected destinations.
- [x] Show the account identity for every target in the confirmation and result.
- [x] Show each platform variant before publishing.
- [x] Show batch progress and the final aggregate state. Post detail polls the authorized product
      batch-status endpoint while the batch is processing or awaiting reconciliation.
- [x] Add retry for confirmed failed targets only; `UNKNOWN` remains closed until provider
      reconciliation.
- [x] Keep single-target actions available for compatibility and recovery.
- [~] Remove client-side provider capability decisions that duplicate Core preflight. Core is now
      authoritative for admission; an existing client media guard remains for immediate UX.
- [~] Add client tests proving one batch request replaces the platform loop. Source-level inspection
      and production build pass; browser automation coverage remains.

## Phase 7: provider adapters and capability coverage

- [~] Inventory current adapter support for Instagram, Facebook, Threads, TikTok, LinkedIn, X, and
      Bluesky.
- [ ] Verify each adapter's media limits and asynchronous behavior with fixtures.
- [ ] Verify each adapter's required product capabilities and permission remediation.
- [x] Verify account selection for multiple accounts on the same provider.
- [x] Add missing adapter preflight implementations without exposing provider-specific details to the
      Agent.
- [x] Mark unsupported operations before execution rather than after a provider call.
- [~] Record provider-specific app-review or production configuration dependencies. The normalized
      preflight/runbook contract is documented; exact provider smoke and production configuration
      evidence remains.
- [ ] Add one controlled provider smoke fixture for synchronous publishing and one for asynchronous
      publishing.

## Phase 8: observability and documentation

- [~] Add structured batch lifecycle logs with service, environment, release, correlation ID, batch
      ID, target count, and bounded outcome code. Batch lifecycle logs are present; release identity
      and correlation enrichment remain a deployment concern.
- [~] Add per-target provider outcome logs without tokens, URLs, full content, or raw payloads.
      Target outcomes are persisted and safely projected; dedicated provider outcome log events remain.
- [ ] Add metrics for batch request, approval, success, partial, blocked, failed, processing age,
      retry, reconciliation, and duplicate suppression.
- [ ] Add dashboards or queries for batch and target failure rates.
- [ ] Add alerts for queue age, unknown outcomes, repeated provider failures, and duplicate-safety
      violations.
- [x] Update [Agent workflow execution docs](https://github.com/Kasitek-Labs/kasitek-agents/blob/main/docs/architecture/workflow-execution.md) with batch approval and
      durable execution semantics.
- [x] Update `docs/internal/architecture/agent-media-harness.md` with batch media preflight and
      per-target delivery behavior.
- [x] Update `docs/public/docs/operations/social-connections.md` with user-facing batch publishing,
      permissions, partial results, and retries.
- [x] Add Agent tool or integration documentation for target selection, variants, and one approval.
- [x] Add or update the provider failure and reconciliation runbook.
- [x] Record `not applicable` for collector configuration if telemetry code does not change.

## Phase 9: verification and release

- [~] Run formatting, lint, type checks, and targeted unit tests for Core, Agent Platform, and client.
      Core check, Agent full suite/build, client build, and targeted client lint pass; whole client
      lint is blocked by generated `.vercel` output and a pre-existing source warning.
- [x] Run Core migration validation and database integration tests. Prisma validation/generation,
      the additive migration, existing social SQL integration, and the batch PostgreSQL fixture pass.
- [x] Run Agent tool, approval, workflow, gateway, and completion tests.
- [~] Run client tests and production build checks. The production build passes; focused client tests
      remain.
- [x] Verify the single-platform compatibility path.
- [~] Verify no provider calls occur for blocked batches. Admission is fail-closed and pure preflight
      coverage passes; provider-call integration coverage remains.
- [x] Verify one approval covers all targets.
- [~] Verify repeated approval execution does not duplicate confirmed publications. The organization
      idempotency constraint and database fixture pass; provider-effect replay remains.
- [~] Verify timeout, unknown, asynchronous, and partial-success behavior. Unit/contract coverage
      passes; provider and database smoke coverage remains.
- [ ] Deploy the exact tested artifacts to staging.
- [ ] Run staging smoke tests with non-sensitive accounts and media.
- [ ] Enable the feature for a controlled organization or provider allowlist.
- [ ] Run a production smoke test and record final batch and provider states.
- [~] Record Core, Agent API, Agent worker, client, and gateway deployment IDs. Production Core,
      Agent API, Agent worker, and MCP Gateway deployments were successful from the tested source;
      the protected KasiAi version 7 batch release was then explicitly rolled out to both
      installations. Staging and final provider smoke evidence remain pending.
- [ ] Complete the release record in the plan with version, commit, migration, rollout, metrics,
      documentation, validation, and rollback evidence.

## Follow-up incident record: partial batch with missing Agent feedback

**Change:** Automatic terminal feedback and provider-failure classification for approved batch
publishing.

**Owner:** Agent Platform and Platform Integrations.

**Risk:** standard. The change affects the Agent worker's post-approval wait path and Core's
target-result classification; it does not change the batch approval snapshot or provider effect
idempotency.

**Affected services and user surfaces:** Agent API/Temporal worker, Core social publishing worker,
WhatsApp and other Agent gateways, and batch target status projections.

**Platform release version or release ID:** pending the next commit and deployment.

**API/schema/migration changes:** no database migration and no public route change; one internal
Agent activity contract is extended.

**Feature flag or rollout method:** existing batch capability and Agent installation rollout;
not applicable to add a new flag for this corrective behavior.

**Analytics events and success metrics:** reuse existing run/tool and batch lifecycle events;
success is terminal feedback delivered for every admitted batch, including partial outcomes.

**Logs, metrics, dashboards, and alerts:** existing Core batch lifecycle logs and Agent run events;
add bounded status-follow-up events if implementation requires new observability. No credentials,
tokens, media URLs, or message bodies may be logged.

**User, API, internal, and operational documentation:** update the batch workflow architecture and
provider failure runbook with the automatic terminal status behavior and TikTok batch-consent rule.

**Validation evidence:** pending implementation and targeted tests.

**Rollback or disable plan:** revert the Agent/Core commit; the existing durable batch status route
and manual status/retry path remain available.

**Post-release review date:** pending deployment.
- [ ] Document how to disable new batch admissions while allowing in-flight batches to reconcile.
- [ ] Monitor post-release errors, queue age, provider responses, partial results, and support reports.
- [ ] Move the plan and checklist to `docs/plans/completed/` only after all release gates pass.

## Evidence log

| Date | Phase | Evidence | Owner |
| --- | --- | --- | --- |
| 2026-09-02 | Planning | Plan and checklist created; defaults recorded before implementation. | Agent Platform |
| 2026-09-02 | Implementation | Core durable batch records, fail-closed preflight, idempotent admission, per-target aggregation, confirmed-failure retry, Agent capabilities, one approval, shared completion formatting, and manual composer/status/retry paths implemented. | Agent Platform and Platform Integrations |
| 2026-09-02 | Verification | Prisma validation/generation, Core compile, full Core library suite (246 passed, 3 environment-dependent ignored), database batch tests, full Agent Vitest suite (672 passed, 84 environment-skipped), Agent build, client production build, changed-component lint, and route/catalog checks passed. Whole client lint remains noisy because it scans generated `.vercel` output. | Agent Platform |
| 2026-09-02 | Database verification | Additive Prisma migration applied to local PostgreSQL; existing social integration SQL and `social_publish_batch` integration test passed, including partial aggregation, organization scoping, and duplicate idempotency rejection. | Platform Integrations |
| 2026-09-02 | Retry safety | Legacy per-job retry/run-now now rejects indeterminate provider outcomes; confirmed failures clear the indeterminate marker. Focused Core tests pass. | Platform Integrations |
| 2026-09-02 | Batch retry | Batch retry endpoint, Agent approval capability, manual retry control, and fail-closed blocked-admission integration test implemented. Focused Core and Agent checks pass; live provider retry evidence remains. | Platform Integrations |
| 2026-09-02 | Route correction | Mounted the product batch retry route inside the existing `/api/social` scope so `POST /api/social/publish-batches/{id}/retry` reaches the handler in the deployed route tree; legacy route-preservation test passes. | Platform Integrations |
| 2026-09-02 | Documentation | Architecture, Agent REST, social connections, provider failure runbook, plan, and checklist updated. | Agent Platform |
| 2026-09-02 | Production incident follow-up | Agents production run inspection showed the generic execution-limit response was caused by protected KasiAi version 6 proposing six legacy single-platform publish calls after one content read; no provider effect ran. Compiled `release-kasiai.js --rollout` created version 7 (`kasiai-initial-v12-content-batch`) and rolled it out to both protected installations. | Agent Platform |
