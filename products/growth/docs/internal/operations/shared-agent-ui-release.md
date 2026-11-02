---
owner: engineering
last_reviewed: 2026-11-02
---

# Shared agent conversation UI

## Release identity and scope

Local release record: `shared-agent-ui-v1`, tracked by KAS-259. The shared conversation, composer, activity, context and specialist modal live in `@kasitek-labs/ui/agent`. Growth and standalone Agents own their adapters and business controls. Customer, Agency and Admin histories reuse plain message rendering without receiving internal execution visibility.

Risk is standard for presentation and high sensitivity for authorized transcript projection. This change does not add agent abilities, change models or quotas, enable deeper delegation, or change effect approval. It has no database migration or new worker/runtime version. Transport additions are compatible read projections. Platform production version, deployment artifact identity and production review date are not applicable until a release is authorized; the local record is not a production version.

## Observation and recovery

Growth session routes `/api/agents/tasks/:taskId/activity` and `/activity/live` provide current-policy root/child observations. Parent-child ancestry, actor, product scope and evidence authority remain server enforced. Independent event and operation cursors are scope bound. Retained public assistant updates exclude private reasoning; tool expansion exposes safe operation metadata, not arbitrary arguments/results. Old records without additional detail remain explicit.

Opening and closing a modal changes observation only. Modal transport disconnect, terminal task state, uncertain effects and revoked evidence remain distinct. Read-only reconnect never resubmits an effect. Source withdrawal clears cached activity and derived conversation output; new authority is checked before restoration. Visible settled history periodically rechecks current policy. Product review, cancellation and continuation controls retain their existing request identities and receipts.

Shared UI is bundled into independently deployed frontends. A source change reaches each consumer only after its artifact is rebuilt and released. Build shared packages first and preserve shared source/style scanning in each frontend build context. Do not copy shared renderers into product source. `pnpm test:shared` includes UI behavior and consumer-import checks.

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

Conversation execution status and subagent modal headers show a compact execution duration. Growth uses the native task elapsed projection, which freezes at the recorded terminal outcome. Standalone completed tasks use their recorded creation and update timestamps. This is end-to-end duration, including waiting and specialist work, not model latency. Missing timing stays omitted; no new API, persistence, analytics or permission change is required.

## Specialist modal styling

The shared modal uses layered theme surfaces, a muted violet specialist header, a collapsed assignment disclosure, and a narrower response column with larger headings and clearer tables. Growth and standalone Agents pass the current authorized assignment to this shared presentation. Activity, citations, nested navigation, timing and reading-position behavior retain their existing sources and controls. A working footer reflects the observed active state; it adds no execution action.

Risk: low, frontend presentation only. Release identity: local `shared-agent-ui-v1` follow-up, no deployment. Rollout and rollback use the frontend artifact rebuild described above. API, schema, migrations, analytics events, structured logging and new operational metrics: not applicable. Internal documentation: this record and shared UI README. Validation: shared component tests, affected frontend builds, focused lifecycle/responsive browser checks and in-app visual verification. Production review date: not applicable until a deployment is authorized.
