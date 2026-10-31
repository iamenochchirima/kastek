# Adaptive specialist orchestration

Owner: Agents engineering. Reviewed: 2026-10-31.

The existing organization Assistant remains an ordinary editable business agent. An explicitly
saved `tool-directed` program version 4 gives its model separate discovery, delegation, inspection,
result, follow-up and cancellation tools. The model chooses its next action from actual results;
no topic-to-specialist routing table or required Content workflow controls that choice. The same
capabilities are available to other authorized standalone business coordinators.

The runtime enforces permissions, published version pins, budgets and durable execution. Those
controls do not decide the business plan. This is a coordinator with specialist workers, not
recursive teams: specialists cannot delegate further or acquire personal memory. Sandbox access
requires an explicit matching scope. Cross-product delegation, dynamically invented elevated grants and arbitrary agent
creation during execution remain unavailable. Growth's managed assistant can now coordinate its
three existing same-business specialists through the product integration described below.

## Configuration and release identity

Select specialists and save the coordinator through the ordinary editor. The roster supports up
to 32 explicit same-organization published bindings. Each pin carries permitted sources, tools,
child token/time allocations and a version. Discovery reports current readiness; it does not
silently change pins or grant access. A roster entry is authorization to consider a specialist,
not an instruction to invoke it for a particular topic.

| Control | Supported setting |
| --- | --- |
| Concurrent child tasks | 1–8; default 2 |
| Total child tasks per work | `policy.maxTasks`: positive integer or `null`; default `null`; follow-ups and continued segments count |
| Repeated unchanged observations | `policy.maxStalls`: 1–8; default 3; one replanning opportunity before pause |
| Delegation depth | One level |
| Tasks started per call | One or two |
| Execution allowances | Local/shared call counts, cumulative tokens and active time default to no service cap; explicit grants, quotas, deadlines and concurrency remain enforced |

Schema096 adds prior-task links, versioned work-progress records, idempotent progress updates and
queued user instructions. Schemas097/098 add logical work lineage, immutable continuation segments,
nullable cumulative allowances and integer-safe counters. New publication of program version 4 uses
`product-capabilities-v14` / `AgentsBusinessRunV24`; retain v13/V23 and earlier registered workflows
for their accepted tasks. Versions
1–3 keep their descriptors and behavior. The adaptive tools are not injected into incompatible
product programs. Saving an explicit version 4 configuration enables future compatible admissions;
there is no separate adaptive rollout environment variable. Private phone admissions still require
`AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS` on both API and worker.

A specialist's explicitly pinned version also authorizes its own selected reviewed skill revisions.
Skill revisions belong to that specialist agent; they are not matched against the coordinator's
separate installation IDs. Publication, discovery and child admission revalidate enabled packages
and their requirements against the delegated tool/resource/runtime scope. Discovery exposes only
skill names/descriptions and a count. A package cannot add tools or permissions. Disabling a skill
fences new use and results already influenced by it. Coordinator evidence recognizes specialist
skill provenance only through an actually joined child result and the current matching binding pin;
unselected sibling/private skills remain unavailable.

## Model tools

Growth defaults revision 4 publishes its assistant on program 4 and pins Research, Content and
Campaigns as direct program 3 specialists. Growth membership and signed product authority remain
the source of access; no standalone Agents account or membership is created. Child grants retain
the root's initiating principal and product scope and cannot delegate further. Current specialist
availability and root authority are checked before execution and when consuming child evidence.
See [Growth integration](../growth-integration.md) for managed upgrades, signed instruction and
continuation commands, reviewed child effects, verification and rollback. Other product adapters
do not acquire delegation authority from this Growth-specific publication.

`contracts/orchestration.ts` is authoritative for request and response schemas. Provider tool names
use the existing underscore encoding of these dotted names.
An empty literal discovery filter adds a fixed model-only notice to retry without a filter; a filtered
miss does not establish an empty roster, and the stored tool receipt remains unchanged.

| Tool | Behavior |
| --- | --- |
| `agents.discover` | Search/page the permitted roster; return version pins, capability metadata and readiness reasons. |
| `agents.start` | Admit one or two focused briefs; return stable child task handles without joining all results. |
| `agents.status` | Page current and authorized prior-segment child tasks without consuming output. |
| `agents.wait` | Wait for any/all selected children for up to 60 seconds; return statuses and timeout state. |
| `agents.result` | Read one current or authorized prior-segment terminal child's result by bounded pages; consume only that child's evidence. |
| `agents.followup` | Start a new immutable task in the selected specialist's existing conversation. |
| `agents.cancel` | Request cancellation of one owned child; completed side effects are not undone. |
| `work.update` | Compare-and-set a bounded work record using `expectedRevision`. |
| `work.inspect` | Read the current work record and revision, or page exact instructions for the same work item. |

Briefs may include selected context, a deliverable and acceptance criteria. They do not include the
parent's full conversation automatically. A follow-up reuses the same pinned specialist, direct
parent/root, member and private child conversation; its prior task must be the latest terminal turn.
An active child conversation cannot accept an overlapping follow-up. History is authorized through
that explicit prior-task chain, not a matching agent name, sibling task or parent transcript.
Member-channel history is not injected into child branches.

Result pages contain up to 4,096 UTF-8 bytes, preserving code-point boundaries. `nextOffset` is a
Unicode code-point offset; `totalBytes` and the full-output SHA256 digest permit reconstruction. A page boundary
is not an incomplete-task outcome. Native outcome and transport availability remain separate.
Reading a result rechecks current authority and evidence, including the original delegated brief.
A selected failed child does not permanently force a root to be partial: the model can inspect the
failure, revise its approach and finish with an evidenced answer. A completed task is not proof
that the answer satisfies the user's request; model acceptance remains separate.

## Progress, user updates and recovery

Work records contain an objective, up to 16 steps, up to eight open questions and up to 32 evidence
child references, within 8 KiB. Step states are `pending`, `in_progress`, `completed` or `blocked`.
They are model-authored claims. Native task state, result receipts and effect approvals remain
authoritative. Progress content returns after compaction as untrusted reference data, separate from
server-confirmed child handles and the progress revision. It cannot grant permissions or override
native outcomes.

The app can queue additional instructions against an authorized active root. An idempotent request
key prevents duplicate instructions; changing content under the same key conflicts. Instructions
enter a later model context without rewriting an in-flight model request or the original task input.
A terminal, cancellation-requested or finishing root rejects further queued instructions. Final input
closure is serialized with instruction admission: if unincorporated updates exist, the coordinator
continues; otherwise its immutable completion intent closes input before settlement. This gate does
not publish an unvalidated outcome or change native task state. Duplicate phone ingress already
mapped to an instruction remains idempotent after closure.
Later roots include these corrections as ordinary user messages in the authorized prior-turn history
group, under the same principal and conversation; specialist conversations do not inherit them.

Telegram and WhatsApp text received while the verified link has an active v4 delegation root is
queued against that same root, with a durable acknowledgment. It does not create another task.
Each correction is limited to 4,000 characters and each root to 32 queued corrections. Oversized
phone messages and exhausted instruction slots receive a durable concise rejection; they do not
create another task or hide authority failures. Rejection notice identities also prevent replay
from turning a previously rejected message into a new request after input closes.
`/status` and `/cancel` retain their explicit controls. Once input closes or work finishes, a new
message becomes the next ordinary conversation turn; legacy programs keep their existing new-turn
behavior. Current membership, provider actor/chat, link generation and grant authority are checked
before steering. These updates do not replace specialist follow-up tools or bypass approval.

Each queued instruction has a stable context-group identity. Under policy v2, context assembly
loads one undelivered instruction at a time and keeps the latest instruction exact in every primary
request. Instruction delivery requires a completed primary-model operation with a matching context
snapshot; a compaction request or omitted group does not count. Pending instructions carry across
continuation segments, and final input closure checks the whole work item. Instructions remain outside
compaction. Earlier instructions can be read exactly through bounded, authorized `work.inspect` v2
pages using `instructionSequence: "0"` and `instructionOffset: 0`, then following `instructionPage.next`.
Each page contains at most 1,024 UTF-8 bytes; offsets count Unicode code points. The default empty
inspection request still returns only saved progress. Snapshots retain selected instruction identities
for replay. Accepted policy v1 tasks retain their previous context and closure behavior.

The coordinator can continue independent work while children run. If admitted child token
reservations temporarily leave insufficient room for the next coordinator model request, v4 waits
for that work to settle. The original grant, root budget and deadline remain unchanged. Exhausted
model-call, time or actual-token limits still stop work. The bounded `specialists.budget_wait` task
event records `child_token_reservations` without request content.

Rolling child operations can also temporarily reserve enough shared tokens or active time to block
a sibling or coordinator. When actual spent usage would still permit the request, the runtime
waits durably for those physical reservations to settle, rechecks authority and rebuilds context
before another model attempt. This applies to primary generation and compaction. Polling does not
make model calls. The event reason is
`shared_execution_reservations`; spent allowances, uncertain outcomes and expired authority are
not treated as temporary capacity. Native Restate verification holds a real controlled child
request, observes this committed wait under a20,000-token root and releases it before confirming
that the coordinator and both rolling children complete with no outstanding reservations.

Restate persists operation and
child identities, waits and cancellation intent. Root accounting owns every admitted child until
settled, even if the coordinator no longer needs its answer. The current stall check compares recent
operation names, request identities and results, including repeating short action cycles, when no
child is active. Equivalent generated orchestration handles do not establish progress; business
resource identifiers and result content remain significant. Changed results count as
progress; waits and progress inspection are excluded. Rewriting the same work record under a new
revision is not progress. A repeated unchanged observation adds a replanning observation to the
model context; another unchanged action pauses with `ORCHESTRATION_STALLED`. This is a repetition
guard, not a semantic judge. The v13/V23 detector remains request-only for its pinned journals.
Observe the recorded error and receipts before retrying. Unknown physical tool outcomes retain the
existing no-blind-replay policy. A worker restart is different from a tested full runtime crash;
report evidence for each separately.

## Optional execution policy and continuation

`model-execution-policy-v2` separates an agent's `maxModelCalls` / `maxToolCalls` from the team's
`maxRootModelCalls` / `maxRootToolCalls`. All four service defaults are `null`, meaning no count cap.
`maxRootTokens`, `maxDurationMs`, `maxWallDurationMs` and `policy.maxTasks` are also optional
allowances. New work has no implicit wall deadline when `maxWallDurationMs` is null. Older accepted
finite deadlines remain binding; authority grants, call/queue waits and review expiries stay finite.
An omitted or null layer cannot erase a finite operator, product or accepted policy ceiling. The
model cannot raise its allowance. Request/output/context sizes, call deadlines, depth, concurrency,
organization quota, authority expiry and the task deadline remain separate finite controls.
Compaction is context management, and its model usage still enters the shared ledger.

Specialist bindings can use `null` for `maxTokens` and `maxActiveMs`. Such work reserves only the
next bounded physical operation against root policy and organization quota; it does not reserve
an unlimited allocation upfront or stop at a hidden per-child cumulative default. Explicit finite
published scopes remain enforced and cannot be enlarged by a brief or follow-up. New Growth
revision4 bindings use this rolling reservation behavior. Earlier finite pins remain finite.

Continuation creates a new immutable root task linked by `prior_task_id` and a stable `work_id`.
Original tasks, operations, results, reviews and effect receipts remain immutable. Local coordinator
and shared team usage remain cumulative across those segments; continuation is not a quota or
spending reset. New route limits intersect the accepted prior policy. Pending or uncertain physical
outcomes require reconciliation before continuation. Historical handles confer no new permission.
The latest correction remains exact after compaction, undelivered corrections carry forward, and
earlier corrections remain available through work-scoped instruction pages. Prior results and
progress remain reference data and recheck current authority and source provenance.

Authority still expires when a work item has no wall deadline. Renewing root access can renew
expired derived specialist grants while preserving their original operation scope, version pins,
allocations and accounted usage. Specialist-owned reviewed skills remain available even when the
coordinator has no skills of its own. Revoked grants, inactive membership and terminal children
cannot be renewed. An expired undelivered continuation control can receive a fresh grant for the
same waiting generation; it does not create a second effect or reset usage. Policy v2 does not
impose a fixed count of authority renewals.

Boundary reasons distinguish local/shared model or tool counts, root/specialist tokens and active
time. The runtime records `work.replan_requested` without content. If another finishing call cannot
fit, the current runtime can return a deterministic partial result from authorized saved progress
and eligible findings without spending another model call. A compaction sequence that does not
reduce input before another primary turn pauses with `COMPACTION_NO_PROGRESS`.
Only a successful valid summary establishes the progress baseline. An expired authority or
invalidated context before compaction does not count as an unsuccessful compaction cycle.
The model-facing checkpoint omits empty bookkeeping and retains positive omission counters before
dropping confirmed handles; canonical
operation and provenance records remain unchanged. Replanning observations stay in current input
until a primary response receives them, including across intervening compaction.
New orchestration tool definitions omit repeated JSON Schema dialect declarations from the model
request, while server argument validation and legacy v13 definitions retain their contracts.

If the final SDK payload exceeds the accepted input allowance before generation dispatch, the
runtime retains the private prepared-input count. For a proven pre-dispatch rejection using the
serialized-byte counter, it can repack a new snapshot with the strictly increasing measured
serialization overhead. The original input allowance is unchanged, rejected attempts settle with
zero known generation usage, and `context.repack_required` records only bounded numeric overhead.
Provider context responses, unknown outcomes and uncertain physical calls do not use this recovery.

Strict monetary caps remain unsupported where price or token bounds cannot be enforced; this
change does not qualify provider token estimates or introduce commercial billing.

## Observability and private evidence

`agent.orchestration.lifecycle@1` is a registry-backed aggregate event for started, revision,
completed, failed and stalled outcomes. Its attributes contain only action, bounded native outcome,
progress revision, specialist-task count and timestamp. Normal organization scope is retained;
task, agent, conversation and member identifiers are not exported as attributes. Event identities
use an opaque hash for deduplication. Briefs, plans, questions, tool arguments, messages, credentials
and result bodies are excluded. Native `task_events`, operation receipts and bounded observations
retain authorized task/root/child correlation for investigation.

Use started/completed/failed/stalled counts and specialist-task distributions to compare outcomes;
do not count a work-step claim or an adapter acknowledgment as success. Inspect current root
status, operation error codes, outstanding children, progress revision and resource usage when a
run stops. Repeated tool errors require a different plan or an explicit unavailable outcome, not
unbounded retries. Hosted delivery, retention, dashboards and alerts need pilot evidence; a local
outbox or debug exporter alone does not establish them.

## Verification and owner acceptance

The project [verification skill](../../../../.agents/skills/verify-agents/SKILL.md) names deterministic
engineering checks. Controlled model responses establish contracts, isolation, context provenance,
replay and UI behavior. They do not establish autonomous planning quality or live-channel delivery.

Controlled native phone cases in `organization-assistant-runtime.test.ts` join verified
Telegram/WhatsApp ingress, an active v4 root, a same-root correction, four completed specialist
turns including a same-conversation revision, and one accepted final private outbox send. Their
model and provider responses are deterministic. The separate member-channel suite covers rejection
limits and replay after input closure. These checks do not certify live provider transport or
model decision quality. Record the tested commit and actual invocation alongside their evidence.

The owner-run [case manifest](../../evaluation-adapters/harbor/cases/adaptive-orchestration.json)
and [rubric](../../evaluation-adapters/harbor/cases/adaptive-orchestration-rubric.json) define outcome,
permission, recovery, cost and latency assessment against a single-agent baseline. They are not a
runnable Harbor suite and do not claim a new evaluation or live-model run. Do not silently substitute
a model, approve effects, or reuse active production organizations when preparing acceptance.

## Release record

| Concern | Decision |
| --- | --- |
| Change, owner, risk | Adaptive standalone business coordination; iamenochchirima; high because delegation, durable context and permissions change. |
| Services and surfaces | Agents API, Restate worker, editor, active task/chat progress and queued user updates; existing private channel entry points. |
| Platform/release identity | Existing root `VERSION` is unchanged. Record the tested commit in implementation verification evidence as the artifact's release ID; no production tag or deployment is claimed. Program v4, policy v2, harness v14, V24 and schemas096–098 are separate identifiers. |
| API/schema/migration | Schemas096–098; versioned tools/work record, logical work lineage, nullable allocations, exact counters and authenticated continuation. Recognized checksum migration only; no legacy data migration requirement or destructive rollback. |
| Rollout | Explicitly save/publish v4 on an owner-controlled organization first, with model/tool permissions and bounded policy. Keep earlier handlers installed. Phone admission has its separate existing organization allowlist. |
| Analytics and success | New `agent.orchestration.lifecycle@1` strict aggregate contract in the existing transactional outbox. Compare terminal outcomes and stalls, child-task counts, cost and latency; answer quality requires owner grading. |
| Logs/metrics/dashboards/alerts | Existing bounded native task/operation observations; no new exporter or Collector routing configuration. Collector revision and OTLP endpoint changes: not applicable. Preserve configured service/release identity. Hosted transport, retention, dashboards and alerts remain unverified pilot gates. |
| Redaction | Aggregate attribute allowlist and schema reject content/identity fields; native private plans and messages stay within authorized product evidence. |
| Documentation | This reference, architecture, feature map and verification skill; owner acceptance artifacts under the existing Harbor adapter. Public marketing/navigation changes: not applicable. |
| Validation | Record actual focused tests, database migration, Restate, responsive browser, builds, boundaries, Analytics registry and version checks with the reviewed commit. Unrun checks remain unverified; no model evaluation is included in implementation checks. |
| Rollback/disable | Stop new v4 admissions by selecting/publishing the earlier compatible configuration; keep V24 and V23 available for their accepted work or cancel through normal controls. Clear the private-phone allowlist separately if needed. Retain additive tables, pins, journals, receipts and queued Analytics records. Never replay V24/V23 journals through another workflow identity or blindly retry unknown effects. |
| Other impacts | Billing/pricing, new infrastructure, other-product synchronization and browser telemetry: not applicable. |
| Post-release review | Owner schedules after a separately approved pilot; no release date is set by this implementation. |

Growth integration release decisions: Growth web/API, Agents API/worker and shared contracts are
affected. Manifest/default/policy revision 4 enables only same-business specialist delegation;
the existing adapter stays at release 2. Apply Agents schemas097/098 before enabling the matching API and worker.
`growth.agent.command@1` records `tasks.instructions` and `tasks.continue` through the existing
outbox without instruction bodies. Native root/child/operation observations retain bounded error
codes. New exporters, Collector changes, credentials in telemetry, pricing changes and customer
sends are not applicable. Rollout uses fresh managed defaults or an explicit managed upgrade;
operator customizations remain preserved. Rollback disables new adaptive admissions and keeps the
pinned V21/V23/V24 handlers for accepted work. Local live-model computer-use acceptance is separately
authorized and must record actual outcomes, rather than treating scripted model fixtures as model
quality evidence. Production promotion, hosted monitoring and a post-release date remain separate.

## Optional-policy release record

| Concern | Decision |
| --- | --- |
| Change / owner / risk | Optional execution allowances, rolling specialist reservations and immutable continuation; iamenochchirima; high because admission, accounting and durable journals change. |
| Services / surfaces | Agents API and Restate worker, Growth API/setup worker and in-app conversation controls, standalone agent editor policy display and shared product contracts. |
| Release identity | Policyv2, harnessv14 / `AgentsBusinessRunV24`, schemas097/098 and Growth manifest/default/policy revision4. Root `VERSION` is unchanged; record the tested commit SHA and local artifact identities in implementation verification evidence. No production release tag is assigned. |
| API / schema | Nullable optional allowances, wall deadlines and specialist scopes, stable work lineage and continuation receipts; exact task/root cumulative counters. Apply recognized097 then098 upgrades before matching API/worker artifacts. Accepted v1 policies and v13/V23 journals remain pinned. |
| Rollout | Register compatible workers first; publish revision4 managed defaults or explicitly upgrade unmodified managed configuration for an owned pilot organization. Preserve operator customizations and finite grants. Hosted staging/production promotion remains unverified. |
| Analytics / success | Reuse `agent.orchestration.lifecycle@1` and `growth.agent.command@1`. The orchestration contract widens `specialist_tasks` from64 to the exact-integer bound without adding fields or changing its event identity. Update the Analytics registry before producers emit larger counts. Compare terminal outcomes, stalls, child tasks, accounted usage and latency. A model-authored completed step is not a success metric. |
| Logs / metrics | Native operation receipts and bounded `work.replan_requested` / `work.continued` events provide investigation facts. No new Collector revision, OTLP endpoint or exporter: not applicable. Credentials, prompts, results and queued instructions stay out of aggregate telemetry. Hosted retention, dashboards and alerts remain unverified. |
| Documentation | This runbook, architecture, source boundary, Growth integration and verification skill. New public marketing/navigation: not applicable. |
| Validation | 291 distinct core policy, lifecycle, accounting, context and integration checks passed across a combined run and an isolated provenance-suite retest after a fixture timeout. 39 native PostgreSQL/Restate and signed Growth checks passed across the combined run and affected cancellation retest; two optional computer-use cases were skipped. Four persisted v13 pins remain readable. API build/type checks and product boundaries passed; the internal module checker retains seven existing violations. Controlled responsive UI checks remain separate from actual visible Growth acceptance, which is incomplete because browser control is disabled. Record exact logs and tested commit in implementation evidence; no staging/production check is claimed. |
| Rollback / disable | Stop new revision4/v14 admissions or publish a compatible future configuration. Drain or cancel accepted work using its pinned workflow; retain V24, V23 and earlier required handlers, accepted policy snapshots,097/098 lineage/counters, receipts and journals. Never reinterpret a V24 journal on V23, undo quota by editing counters, or blindly retry uncertain effects. Reverting schema is not the rollback path. |
| Other / post-release | Commercial billing, new infrastructure and browser telemetry: not applicable. Owner schedules post-release review after a separately approved deployment; no deployment date is assigned. |

## Model capacity after interruption

A failed or interrupted model call can remain uncertain while its physical permit is reclaimed.
The normal capacity phase processes a bounded set of owned permits and releases only model or
compaction permits whose persisted transport deadline has passed. A matching private continuation
must prove that the call used the deadline-enforced model runtime; older or unknown paths retain
their holds. The bound is the earlier of the task deadline and operation start plus reserved duration.

The fixed `resource.capacity_released` event records the operation identity and uncertain outcome.
This releases local concurrency, not the provider outcome or possible billing: operation/task
uncertainty, conservative token/time charges and monetary reservations remain unchanged. Business
effect holds still require explicit reconciliation. No cleanup retries a model request or business
operation. A queued follower still rechecks authority and its original queue deadline after wakeup.

For a blocked follow-up, inspect the model class's held requests, their immutable operation kinds,
private continuation proof and persisted deadlines. Keep the dispatcher and compatible worker
running for canonical reclamation; do not delete holds or reset accounting manually. A queue deadline
that already expired remains expired, so a later user request creates a new bounded task. There is no
schema migration or new exporter. Rollback preserves receipts and usage records; retain compatible
cleanup for admitted calls rather than converting uncertain outcomes to success.
