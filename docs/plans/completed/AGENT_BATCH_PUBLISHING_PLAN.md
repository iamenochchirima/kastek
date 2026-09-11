# Agent batch publishing plan

**Status:** Active

**Owner:** Agent Platform and Platform Integrations

**Last updated:** 2026-09-02

## Objective

Allow an Agent to prepare one social post for several connected accounts, optionally create
platform-specific variants, obtain one approval, and publish the approved set through a durable
Core workflow.

The system must tell the Agent and the user what is possible before it calls a provider. A provider
failure, timeout, or partial result must become a durable per-destination status. It must never look
like the whole batch failed when one destination already published, and it must never retry a
confirmed publication as a duplicate.

Success means that the Agent can do the following in one workflow:

1. Resolve the requested platforms to specific connected accounts.
2. Prepare shared or platform-specific content and media.
3. Preflight every destination and show blocked destinations before approval.
4. Ask for one approval covering the exact batch.
5. Start one durable batch effect.
6. Return a clear result for every destination across web, WhatsApp, Telegram, and other gateways.

## Scope

### Included

- A provider-neutral batch publishing module in Core.
- A durable batch record linked to the existing social post, variants, connections, and publish jobs.
- Read-only preflight for permissions, health, capability, account selection, content, and media.
- One Agent batch publishing tool and one approval snapshot.
- Platform-specific content variants prepared before approval.
- Per-destination execution, idempotency, retry, reconciliation, and partial-success reporting.
- Shared result formatting for the Agent gateways.
- Manual UI use of the same Core batch command.
- Tests, structured logs, metrics, documentation, rollout controls, and rollback evidence.

### Excluded from the first release

- Automatic cross-platform content rewriting inside provider adapters.
- Provider permissions that the provider does not offer.
- Publishing to an account that is not explicitly selected in the draft.
- Blindly publishing the valid subset when another selected destination is blocked.
- Cross-provider scheduling orchestration. The data model should remain compatible with scheduling,
  but the first release should focus on immediate batch publishing.
- New social providers. Existing adapters must be brought behind the shared batch seam first.

## Current implementation and constraints

- The manual composer already stores multiple `channels`, `channelSelections`, variants, and media.
- Core already creates one `SocialPublishJob` per selected platform variant.
- The manual immediate-publish path currently loops over
  `/api/social/posts/{postId}/publish` once per platform.
- The Agent currently exposes `kasitek.core.content_post_publish`, which accepts one `postId` and
  one `platform`.
- Existing Core provider adapters and the social worker must remain the owners of provider-specific
  API calls, asynchronous states, and receipts.
- Existing connection permission and action-readiness work must remain the source of normalized
  access, unsupported, unhealthy, and provider-approval states.
- Existing single-platform publishing must remain compatible while the batch tool is introduced.
- The Agent must not receive access tokens, raw scopes, provider payloads, signed media URLs, or
  unbounded provider error text.
- The existing workspace changes in `client/apps/client/src/lib/server-api.ts` and the untracked
  research file are outside this plan and must not be changed or staged as part of it.

Related plans:

- [`AGENT_TOOL_ACTION_READINESS_PLAN.md`](./AGENT_TOOL_ACTION_READINESS_PLAN.md)
- [`AGENT_MEDIA_HARNESS_PLAN.md`](../../archive/deferred-plans/AGENT_MEDIA_HARNESS_PLAN.md)
- [`CONNECTION_PERMISSION_CENTER_PLAN.md`](../../archive/deferred-plans/CONNECTION_PERMISSION_CENTER_PLAN.md)

## Domain model

The plan uses these terms consistently.

### Content post

The workspace-owned content object. It contains shared content, selected channels, account
selections, variants, media, and the existing provider jobs.

### Publish target

One concrete provider account receiving one variant of one content post. A target is identified by
the selected connection and variant, not by a platform name alone. This supports multiple accounts
on the same provider.

### Publish batch

One approved request to execute a fixed set of publish targets. It owns the batch idempotency key,
approval snapshot hash, lifecycle state, and aggregate result. It does not replace the existing
per-target publish job.

### Preflight

A read-only evaluation of the targets before an external effect. It returns normalized readiness
and remediation data. Preflight must not claim jobs, upload media, refresh tokens, or call a
provider operation that creates or changes content.

### Approval snapshot

The immutable representation of the post content, variants, media references, target accounts, and
requested action that the user approved. Core recomputes and verifies its hash before execution.

### Batch item

A durable link between the publish batch and one existing `SocialPublishJob`. The item records the
target-level execution state, normalized error, retry eligibility, and reconciliation state.

## Architecture

### Core batch module

Create one deep Core module with a small provider-neutral interface. The Agent and manual client
should learn batch concepts, not provider request formats.

The module should provide these operations behind one seam:

- `preflight(post_id, target_scope)` returns a complete normalized readiness result.
- `create_or_reuse_batch(post_id, approved_snapshot, idempotency_key)` creates or replays the same
  durable batch without creating duplicate target effects.
- `execute(batch_id)` claims eligible items and hands provider work to the existing social worker.
- `get_status(batch_id)` returns aggregate and per-target state.

Provider implementations remain adapters behind the Core publishing seam. The batch module owns
selection, validation, approval identity, claiming, aggregation, and retry rules. It should not
leak provider-specific details to Agent Platform, gateways, or the client.

### Target selection

The draft is the source of truth for target accounts. The first batch tool accepts a `postId` and
publishes all eligible targets belonging to that approved draft. It does not ask the Agent to pass
provider account IDs or internal job IDs a second time.

If the user changes the target list, account, variant, or media, the Agent must update the draft and
obtain a new approval snapshot. A later retry operates on the existing batch and only selects
retryable targets.

### Preflight result

Each target returns a safe result such as:

- `READY`
- `MISSING_ACCESS`
- `UNSUPPORTED`
- `RECONNECT_REQUIRED`
- `UNHEALTHY`
- `INVALID_MEDIA`
- `INVALID_CONTENT`
- `ALREADY_PUBLISHED`
- `UNKNOWN`

Each blocked result includes a bounded reason code, a short user-facing explanation, and a
remediation mode. `UNKNOWN` must not be converted into `READY` or `MISSING_ACCESS`.

The default first-release policy is fail closed. If any selected target is blocked, the batch does
not start provider effects. The user can fix or remove the target and approve a new snapshot. A
future explicit "publish available destinations" action can be added without changing the batch
model.

### Durable execution

The effect endpoint should return a durable batch identifier and accepted state quickly. The Core
worker executes target jobs through the existing provider adapters with bounded concurrency. It must
support provider responses that remain `PROCESSING`, especially asynchronous media or publishing
flows.

The batch aggregate is derived from target states:

- `SUCCEEDED` when every target is confirmed published.
- `PARTIAL` when at least one target is confirmed published and another is failed or blocked.
- `PROCESSING` when at least one target is still pending or awaiting provider reconciliation.
- `FAILED` when no target published and at least one target failed.
- `BLOCKED` when preflight prevented all external effects.
- `UNKNOWN` only while a provider outcome cannot safely be determined.

The aggregate must not erase target-level state. A timeout after a provider may have accepted the
post enters reconciliation, not an immediate blind retry.

### Idempotency and reconciliation

- Batch idempotency covers the exact post snapshot and target set.
- Existing per-job idempotency remains in force for provider effects.
- A repeated Agent call with the same approved snapshot returns the existing batch result.
- A changed snapshot receives a new approval and a new batch identity.
- Retries select only failed or explicitly retryable unknown targets after reconciliation.
- Confirmed `PUBLISHED` targets are excluded from retry.
- Provider receipts and external post IDs remain Core-owned and are projected only when safe.

### Platform variants

The Agent may request variants through the existing draft `variants` field. It must generate or edit
the variants before approval, and the approval projection must show every selected destination's
content preview and media count.

Core validates provider limits and media requirements. Adapters may reject an invalid variant, but
they must not silently rewrite content after approval. Any automatic adaptation belongs in a
separate draft-generation step that creates a new approval snapshot.

## Agent and gateway behavior

Add a new approval-required Agent capability, tentatively named
`kasitek.core.content_post_publish_batch`. Keep the existing single-platform capability as a
compatibility path and route its implementation through the same Core module where practical.

The Agent workflow becomes:

1. Resolve the user's requested platforms and connected account identities.
2. Create or update one draft with `channels`, `channelSelections`, variants, and media.
3. Call the read-only preflight capability.
4. Ask one approval question that names accounts, platforms, variant summaries, and media.
5. Execute one batch capability after approval.
6. Wait for or query the durable batch status.
7. Report the aggregate plus each destination's result and remediation.

### Follow-up: approved batch completion feedback

The first production trace of the batch flow exposed a completion gap. Core admitted the batch,
persisted three published targets and three failed targets, and marked the batch `PARTIAL`, but the
Agent delivered the initial `PROCESSING` text as its terminal response and never queried the
durable batch status. The approved flow must therefore:

- retain the admitted `batchId` as a typed runtime continuation;
- let the Temporal workflow poll the read-only batch status activity on a durable timer;
- complete and deliver one terminal result containing every destination and its bounded remediation;
- stop after a bounded observation window with an explicit unconfirmed/processing message rather
  than silently ending or claiming success;
- treat an approval as the explicit TikTok direct-post consent for a batch that names TikTok, while
  preserving the existing direct single-post consent requirement;
- classify provider authentication and consent failures as actionable target outcomes so retry does
  not repeatedly execute a target that cannot succeed until its connection or consent changes.

Approval projections must include the batch ID or stable preview reference, exact target accounts,
variant previews, media count, and the requested action. They must not show raw provider scopes or
credentials.

Gateway renderers should use one shared batch result formatter with channel-specific limits:

- Web can show an expandable target table and retry controls.
- WhatsApp and Telegram should show a compact summary followed by target lines.
- Other gateways should receive the same normalized result and choose their own presentation.

No gateway should render an empty `Content posts:` section for a batch result.

## Manual UI alignment

The composer already has the right draft data. Update it to call the same batch command rather than
looping over one-platform publish requests. Add a preflight view before the existing publish
confirmation, then show:

- One publish action for all selected destinations.
- Per-destination progress and result.
- A batch summary state.
- Retry for failed or reconciled targets only.
- A clear link to connection access remediation when preflight blocks a target.

The client must not own provider capability rules or decide whether a timeout is safe to retry.

## Implementation plan

1. [x] Confirm the target, approval, state, and first-release policies recorded in this plan. The
   implementation uses the proposed defaults: the draft owns targets, invalid targets block the
   batch before provider effects, and immediate publishing is the first release.
2. [x] Define versioned Core and Agent contracts for preflight, batch execution, status, errors, and
   approval projections. Capability versions, JSON schemas, approval revision, reason codes, and
   remediation modes are now registered.
3. [x] Add the durable batch and batch-item data model with a safe migration and snapshot hashing.
4. [x] Implement Core preflight using the existing connection permission, readiness, media, and
   provider adapter seams.
5. [~] Implement durable batch claiming, execution, aggregation, idempotency, retry, and provider
   reconciliation. Durable admission, existing atomic job claiming, aggregation, retries for
   confirmed failures, and explicit unknown classification are implemented; generic provider
   reconciliation for unknown outcomes remains a release follow-up.
6. [x] Add the Agent client, capability manifest, approval projection, system guidance, and terminal
   completion formatting.
7. [~] Add the shared gateway result contract and renderers for web, WhatsApp, Telegram, and other
   configured gateways. The existing versioned Agent response and shared completion formatter now
   carry the normalized result; dedicated expanded gateway/retry renderers remain follow-up work.
8. [x] Change the manual composer and post detail views to use the same batch command. The composer
   now uses Core preflight plus one batch admission, and post detail polls the product batch status
   endpoint for durable progress and retries confirmed failed targets without touching published ones.
9. [~] Add tests, structured telemetry, runbook guidance, and current public/internal documentation.
   Focused and full Agent/Core checks, structured logs, runbook, architecture, public operations, and
   Agent API documentation are in place; feature metrics, dashboards, and provider smoke fixtures
   remain release gates.
10. [ ] Roll out behind a feature flag, run controlled provider smoke tests, and record release
    evidence before broad enablement.

The detailed execution checklist is [`AGENT_BATCH_PUBLISHING_CHECKLIST.md`](./AGENT_BATCH_PUBLISHING_CHECKLIST.md).

## Verification

- [~] Contract tests cover one post, several providers, several accounts on one provider, variants,
  media, and normalized preflight reasons.
- [~] Core tests prove blocked batches make no provider calls.
- [ ] Core tests prove one batch approval creates one durable batch and one item per target.
- [ ] Idempotency tests prove repeated requests do not duplicate provider effects.
- [~] Timeout and unknown-outcome tests prove reconciliation precedes retry.
- [~] Partial-success tests prove published targets remain published while failed targets remain
  retryable.
- [x] Agent tests prove one approval is requested for the whole batch.
- [x] Agent tests prove target account, variant, and media details appear in the approval projection.
- [~] Gateway tests cover compact and expanded batch summaries without empty sections.
- [~] Manual UI tests prove the composer no longer loops over one-platform publish calls. The source
  path uses one preflight and one batch request; browser automation coverage remains.
- [~] Type checks, lint, Core tests, Agent tests, client build, and relevant migrations pass. Focused
  checks pass; browser automation and external provider smoke evidence remain.
- [ ] Staging smoke tests cover at least one provider with synchronous publishing and one provider
  with asynchronous processing.
- [ ] Production smoke testing uses a non-sensitive test post and records provider receipts and
  final batch state.

## Release record decisions

These values must be completed with actual release evidence before this plan is moved to
`docs/plans/completed/`.

| Release concern | Decision | Evidence required | Status |
| --- | --- | --- | --- |
| Change | Agent and manual multi-destination publishing with one approval | Final commit and release notes | Defined; release evidence pending |
| Owner | Agent Platform and Platform Integrations | Named release owner | Defined |
| Risk | High. The feature creates external provider effects across several accounts | Staging and controlled production evidence | Open |
| Affected surfaces | Core, social worker, Agent API, Agent worker, MCP/gateway delivery, web client, WhatsApp, Telegram, provider adapters | Deployment IDs and smoke results | Open |
| API and schema | Versioned preflight/batch/status capabilities, durable batch records, and single-publish compatibility | Contract diff, migration result, and rollback validation | Implemented locally |
| Rollout | Existing capability grants and `effect_execution_enabled` hold the effect boundary; dedicated organization/provider allowlist flag remains a release follow-up | Flag name, default, enablement log | Partial |
| Analytics | No new analytics registry events in this slice; batch lifecycle metrics and dashboard ownership remain release work | Registry decision plus dashboard/query | Partial; no new registry event declared |
| Logging | Batch lifecycle events use bounded organization, post/batch IDs, counts, status, and redacted messages; dedicated per-target provider events remain | Redaction review and log query | Partial |
| Metrics and alerts | Batch completion, partial, target failure, unknown age, retry, duplicate suppression, and queue-age monitoring remain to be added | Dashboard and alert links | Pending |
| Documentation | Internal architecture, Agent REST, social operations, and provider failure runbook updated | Updated document links | Implemented locally |
| Validation | Core library/route tests, PostgreSQL migration and batch fixture, full Agent suite/build, client build, and changed-component lint pass | CI and deployment evidence | Implemented locally; staging pending |
| Rollback | Stop new batch admissions, preserve in-flight reconciliation, retain records, and keep single publish available | Tested rollback procedure | Documented; staging validation pending |
| Post-release review | Review after controlled production rollout and again after broad enablement | Review date and owner | Pending |

Collector configuration change: not applicable unless the implementation adds or changes the
OpenTelemetry pipeline. Existing release identity and redaction rules still apply.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Batch scope | One batch publishes every eligible target already fixed in the approved draft | Product and Agent Platform | Decided and implemented |
| Invalid target policy | Block the whole batch before provider effects; add valid-subset publishing later as an explicit action | Product | Decided and implemented |
| Approval scope | Approval covers an immutable snapshot hash of targets, variants, media, and action | Agent Platform | Decided and implemented |
| Durable record | Add a first-class batch record and batch items linked to existing publish jobs | Core | Decided and implemented |
| Execution | Core worker owns execution and reconciliation; Agent does not loop through providers | Core and Agent Platform | Decided and implemented |
| Content adaptation | Agent creates visible variants before approval; adapters validate and do not rewrite silently | Product and Integrations | Decided and implemented |
| Scheduling | Immediate batch publishing is first release; scheduled batch execution follows the same model | Product | Decided for first release |
| Provider readiness | Reuse normalized permission and action-readiness contracts | Integrations | Decided and implemented |
| Compatibility | Retain the single-platform tool and route it through the same batch implementation during migration | Agent Platform | Decided and implemented |
| Provider coverage | Confirm exact media and permission support from each current adapter before enabling a target | Integrations | Open |
| Batch status delivery | Use immediate accepted completion plus durable status capability, worker refresh, and product-surface polling; automatic Agent push continuation remains a follow-up | Agent Platform | Partial |

## Notes and blockers

- No local implementation blocker is known.
- Production incident follow-up (2026-09-02): a WhatsApp batch request reached the deployed
  Agent runtime, but the active protected KasiAi installation was still on version 6
  (`kasiai-initial-v9-connection-filters`). Its second model response proposed six legacy
  single-platform publish calls after one content read, which exceeded the four-tool run limit
  and produced the generic execution-limit response before any provider effect. The compiled
  `release-kasiai.js --rollout` command was run on the production Agents API image; it created
  and rolled out version 7 (`kasiai-initial-v12-content-batch`) to both protected installations.
  The source implementation was already deployed; this was a missed explicit protected-agent
  release step.
- The local migration, Core tests, Agent suite/build, and client build pass. Staging and production
  provider evidence has not yet been run.
- Generic provider reconciliation for an indeterminate result is intentionally still closed: the
  system records `UNKNOWN` and does not retry until a provider-specific reconciliation path exists.
- The existing manual loop and single-platform Agent capability remain as compatibility/recovery
  paths while batch retry and provider smoke coverage are completed.
