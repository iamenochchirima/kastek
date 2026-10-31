# Adaptive specialist orchestration

Owner: Agents engineering. Reviewed: 2026-10-31.

The existing organization Assistant remains an ordinary editable business agent. An explicitly
saved `tool-directed` program version 4 gives its model separate discovery, delegation, inspection,
result, follow-up and cancellation tools. The model chooses its next action from actual results;
no topic-to-specialist routing table or required Content workflow controls that choice. The same
capabilities are available to other authorized standalone business coordinators.

The runtime enforces permissions, published version pins, budgets and durable execution. Those
controls do not decide the business plan. This is a coordinator with specialist workers, not
recursive teams: specialists cannot delegate further, acquire personal memory or inherit sandbox
access. Cross-product delegation, dynamically invented elevated grants and arbitrary agent
creation during execution remain unavailable.

## Configuration and release identity

Select specialists and save the coordinator through the ordinary editor. The roster supports up
to 32 explicit same-organization published bindings. Each pin carries permitted sources, tools,
child token/time allocations and a version. Discovery reports current readiness; it does not
silently change pins or grant access. A roster entry is authorization to consider a specialist,
not an instruction to invoke it for a particular topic.

| Control | Supported setting |
| --- | --- |
| Concurrent child tasks | 1–8; default 2 |
| Total child tasks per root | `policy.maxTasks`: 1–64; default 16; follow-ups count |
| Repeated identical-operation threshold | `policy.maxStalls`: 1–8; default 3 |
| Delegation depth | One level |
| Tasks started per call | One or two |
| Root limits | Existing token, tool-call, active-time, wall-time, scheduling and authority limits |

Schema096 adds prior-task links, versioned work-progress records, idempotent progress updates and
queued user instructions. Program version 4 is pinned to `product-capabilities-v13` /
`AgentsBusinessRunV23`; retain the earlier registered workflows for their accepted tasks. Versions
1–3 keep their descriptors and behavior. The adaptive tools are not injected into incompatible
product programs. Saving an explicit version 4 configuration enables future compatible admissions;
there is no separate adaptive rollout environment variable. Private phone admissions still require
`AGENTS_MEMBER_ASSISTANT_ORGANIZATIONS` on both API and worker.

## Model tools

`contracts/orchestration.ts` is authoritative for request and response schemas. Provider tool names
use the existing underscore encoding of these dotted names.

| Tool | Behavior |
| --- | --- |
| `agents.discover` | Search/page the permitted roster; return version pins, capability metadata and readiness reasons. |
| `agents.start` | Admit one or two focused briefs; return stable child task handles without joining all results. |
| `agents.status` | Inspect the root's selected or current child tasks without consuming output. |
| `agents.wait` | Wait for any/all selected children for up to 60 seconds; return statuses and timeout state. |
| `agents.result` | Read one terminal child's result by bounded pages; consume only that child's evidence. |
| `agents.followup` | Start a new immutable task in the selected specialist's existing conversation. |
| `agents.cancel` | Request cancellation of one owned child; completed side effects are not undone. |
| `work.update` | Compare-and-set a bounded work record using `expectedRevision`. |
| `work.inspect` | Read the current work record and revision. |

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
A terminal or cancellation-requested root rejects further instructions. These updates do not replace
specialist follow-up tools or bypass approval.

The coordinator can continue independent work while children run. Restate persists operation and
child identities, waits and cancellation intent. Root accounting owns every admitted child until
settled, even if the coordinator no longer needs its answer. The stall check detects the configured number of identical recent operation request digests,
excluding wait/progress inspection, when no child is active. It is a repetition guard, not a semantic
judge of useful progress. Reaching that threshold ends work explicitly rather than claiming success.
Observe the recorded error and receipts before retrying. Unknown physical tool outcomes retain the
existing no-blind-replay policy. A worker restart is different from a tested full runtime crash;
report evidence for each separately.

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
| Platform/release identity | Existing root `VERSION` is unchanged. Record the tested commit as the separately prepared artifact's release ID; no production tag or deployment is claimed. Program v4, harness v13, V23 and schema096 are separate identifiers. |
| API/schema/migration | Additive schema096; versioned model tools and work record; active-root instruction endpoint. Recognized checksum migration only; no legacy data migration requirement or destructive rollback. |
| Rollout | Explicitly save/publish v4 on an owner-controlled organization first, with model/tool permissions and bounded policy. Keep earlier handlers installed. Phone admission has its separate existing organization allowlist. |
| Analytics and success | New `agent.orchestration.lifecycle@1` strict aggregate contract in the existing transactional outbox. Compare terminal outcomes and stalls, child-task counts, cost and latency; answer quality requires owner grading. |
| Logs/metrics/dashboards/alerts | Existing bounded native task/operation observations; no new exporter or Collector routing configuration. Collector revision and OTLP endpoint changes: not applicable. Preserve configured service/release identity. Hosted transport, retention, dashboards and alerts remain unverified pilot gates. |
| Redaction | Aggregate attribute allowlist and schema reject content/identity fields; native private plans and messages stay within authorized product evidence. |
| Documentation | This reference, architecture, feature map and verification skill; owner acceptance artifacts under the existing Harbor adapter. Public marketing/navigation changes: not applicable. |
| Validation | Record actual focused tests, database migration, Restate, responsive browser, builds, boundaries, Analytics registry and version checks with the reviewed commit. Unrun checks remain unverified; no model evaluation is included in implementation checks. |
| Rollback/disable | Stop new v4 admissions by selecting/publishing the earlier compatible configuration; keep V23 available for accepted work or cancel through normal controls. Clear the private-phone allowlist separately if needed. Retain additive tables, pins, journals, receipts and queued Analytics records. Never replay V23 journals through V21/V22 or blindly retry unknown effects. |
| Other impacts | Billing/pricing, new infrastructure, other-product synchronization and browser telemetry: not applicable. |
| Post-release review | Owner schedules after a separately approved pilot; no release date is set by this implementation. |
