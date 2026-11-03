---
owner: engineering
last_reviewed: 2026-11-02
---

# Shared agent conversation UI

## Release identity and scope

Local release record: `shared-agent-ui-v2`, tracked by KAS-259 and the approved shared runtime upgrade. The shared conversation, composer, activity, context and specialist modal live in `@kasitek-labs/ui/agent`. Growth, standalone Agents and configured Agency execution own their adapters and business controls. Restricted customer and Admin histories reuse plain message rendering without receiving internal execution visibility.

Risk is standard for presentation and high sensitivity for authorized transcript projection. The presentation layer adds no execution authority. It accompanies the shared runtime upgrade, including recursive lineage in schema099 and V15/V25 execution; that runtime owns capability and effect decisions. Timing and observation read existing task/event receipts and need no additional database migration. Transport additions are compatible read projections; unavailable elapsed time is null. Platform production version, deployment artifact identity and production review date are not applicable until a release is authorized; the local record is not a production version.

## Observation and recovery

Growth session routes `/api/agents/tasks/:taskId/activity` and `/activity/live` provide current-policy root/child observations. Complete ancestor lineage, actor, product scope and evidence authority remain server enforced. A requested descendant is verified against the authorized root, and its own child cards open the same shared modal with Back navigation. Independent event and operation cursors are scope bound. Retained public assistant updates exclude private reasoning; tool expansion exposes safe operation metadata, not arbitrary arguments/results. Old records without additional detail remain explicit.

Opening and closing a modal changes observation only. Modal transport disconnect, terminal task state, uncertain effects and revoked evidence remain distinct. Read-only reconnect never resubmits an effect. Source withdrawal clears cached activity and derived conversation output; new authority is checked before restoration. Visible settled history periodically rechecks current policy. Product review, cancellation and continuation controls retain their existing request identities and receipts.

Shared UI is bundled into independently deployed frontends. A source change reaches each consumer only after its artifact is rebuilt and released. Build shared packages first and preserve shared source/style scanning in each frontend build context. Do not copy shared renderers into product source. `pnpm test:shared` includes UI behavior and consumer-import checks.

Website widgets poll an allowlisted `responseStatus` alongside visitor-authorized messages. It
describes only the latest visitor turn in the current ownership generation while automation is
active and no later assistant or human reply exists. Pending work shows a replying status;
incomplete, failed, cancelled and uncertain outcomes show concise feedback even when no reply
was published. The projection excludes task identifiers, internal errors and execution details.
It clears when a newer turn or published reply supersedes it. An accepted message never gains
the send-retry action used for an unconfirmed transport request.

This status projection ships with the Agents API/widget artifact. No schema, permission,
analytics or logging change is required. Rollback uses a compatible API artifact; no retained
message or task is rewritten. Focused verification covers native PostgreSQL authorization and
latest-turn selection, plus widget polling, reload and existing send-failure behavior.

## Documentation and observation decisions

Current references: shared UI README, Growth feature map and execution architecture, Agents source boundary and README, Admin README and the project verification skill. Session-only routes are not new public v1 API operations. Website and staff messaging retain their delivery/ownership semantics.

Existing registered command/review telemetry and request logging remain authoritative. New business outcome events are not applicable because this change adds observation, not new effects. Browser behavior evidence is captured by controlled checks and actual computer use; this change does not introduce browser telemetry, prompt/body logging or a new Collector/exporter. Use bounded route/task/operation identifiers and error codes when investigating observation failures. Credentials and private provider payloads must not enter evidence.

## Validation and rollout

The implementation issue records commands, actual results and limitations. Evidence is retained under `.audit/shared-agent-ui/`, including backend native tests, shared/consumer checks, product builds, controlled browser cases and actual in-app observations. Controlled provider behavior does not establish autonomous model quality. The live trial retains failed model behavior separately; completed execution is not factual verification.

Rollout is local and isolated first. The owner authorized actual in-app testing in the disposable Growth organization. A dedicated local frontend/API may use an available port when another development session owns the usual endpoint. No production rollout, push or merge is implied.

Before release, verify full-page, dock, mobile, specialist and standalone task entry points; keyboard/IME behavior; focus and scroll restoration; current-policy withdrawal; history paging; terminal replay; exact reviews and outcome recovery. Record actual same-organization root/child identities for live specialist acceptance.

## Rollback

Revert the shared module and its product adapters together and rebuild affected frontend artifacts. Optional read projections can be disabled while retaining native tasks, operation journals and effect receipts. Closing a UI or rolling back observation must not cancel accepted work, delete evidence or repeat effects. No data rollback is required. Set the production post-release review date when deployment is authorized.

## Per-turn duration

Conversation execution status and subagent modal headers show a compact execution duration. Growth uses the native task elapsed projection, which freezes at the recorded terminal outcome. Growth, standalone and Agency use acceptance time through the native terminal event, including queue, authorization, review and descendant waits. Active clocks advance between observations and freeze after the terminal receipt. Later task metadata updates cannot extend a completed duration. Standalone task responses expose observedAt, elapsedMs and finishedAt; missing or invalid timing stays null and is omitted by the UI. Model latency and active-operation usage remain separate. No new persistence, analytics event or permission is introduced by timing.

All three execution adapters use `agentRuntimePresentation` for context, compaction, model timing
and observed/accounted usage. Standalone task detail reads reuse the current-authority scalar
projection and existing history hydration. Optional `workElapsedMs` records original logical
request acceptance through the selected task's current or terminal endpoint; it appears separately
when it differs from that task's duration. An unavailable origin remains null. Restricted customer
histories do not gain these internal measurements.

The shared memory review shows assertion origin, freshness, scenario context and reported conflicts.
Visible memory panels recheck their displayed pages every five seconds and on return to the tab.
A failed read clears cached records and the current review; a changed or forgotten record closes
its stale review. A fresh authorized read is required to restore records. Pending mutations pause
the background refresh. The shared activity renderer also owns the model-row suppression policy
for every host; model latency and counts remain available in Context measurements.
Acceptance and correction submit the exact chosen classification under the record's expected
revision; unresolved or unassessed conflicts do not become verified facts. These controls reuse the
existing memory command and analytics event. Schema105 belongs to the shared runtime release, not
the UI timing change. Existing accepted tool schema pins retain their earlier projection. No new
provider, namespace, exporter, external effect or physical-erasure promise is introduced.

## Specialist modal styling

The shared modal uses layered theme surfaces, a muted violet specialist header, a collapsed assignment disclosure, and a narrower response column with larger headings and clearer tables. Growth and standalone Agents pass the current authorized assignment to this shared presentation. Activity, citations, nested navigation, timing and reading-position behavior retain their existing sources and controls. A working footer reflects the observed active state; it adds no execution action.

Risk: low, frontend presentation only. Release identity: local `shared-agent-ui-v1` follow-up, no deployment. Rollout and rollback use the frontend artifact rebuild described above. API, schema, migrations, analytics events, structured logging and new operational metrics: not applicable. Internal documentation: this record and shared UI README. Validation: shared component tests, affected frontend builds, focused lifecycle/responsive browser checks and in-app visual verification. Production review date: not applicable until a deployment is authorized.
