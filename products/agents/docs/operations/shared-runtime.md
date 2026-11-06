# Shared runtime operations

Owner: Agents engineering. Reviewed: 2026-11-03.

This runbook covers the local shared business runtime used by standalone Agents, Growth and
Agency. Product membership, resource access and action outcomes remain product-owned. A completed
task proves execution settlement; it does not verify a model's factual answer.

## Release and storage custody

The local upgrade uses `product-capabilities-v15`, `AgentsBusinessRunV25`,
`AgentsContextCompactionV1`, model policy compiler `model-execution-policy-v3` and schemas099–115.
API and worker must use the same tested source. Schema setup checks an exact installed checksum
before applying an additive suffix in one transaction. Unknown checksums fail before mutation.
Use a dedicated disposable database for validation. The original development databases are not
migration targets for this verification.

The schema directory retains both independent 099 migrations with their original contents:
`099_managed_default_model.sql` from the hosted release and `099_recursive_delegation.sql`
from the local shared-runtime branch. They are ordered by their full filenames. Setup accepts
an exact canonical prefix, or an exact local-branch prefix excluding only the managed-model
099. It applies only files absent from the recognized prefix and records the canonical aggregate
checksum after the transaction succeeds. The deployed hosted checksum
`e95715b4efd7a675dca22b482e37e0e90b1525fa30e169f85e29654561f899b2`
is the canonical prefix through `099_managed_default_model.sql`. Prior local prefixes receive
that independent column addition without replaying recursive-delegation or later migrations.
Unknown or edited prefixes fail before schema changes. Do not overwrite the installed checksum
or recreate a populated database to bypass this check. Retain the additive schema on code rollback.
This reconciliation adds no analytics event, log pipeline, retention rule or permission grant.

Schema106 records an explicit product context selection for new tasks. Apply it before the
compatible API and worker. Keep a worker that understands `product_context` dependencies until
accepted work using them settles; retaining the nullable column during rollback is required.
Existing tasks keep an unset selection rather than adopting a later conversation attachment.

Schema107 retains private canonical-read access receipts. Apply Growth's
`20261103100000_growth_read_access_handles` migration and supporting endpoint before enabling
the worker's negotiated `access-v1` reads, then apply the Agents schema before its API/worker.
Old endpoint responses stay unchanged without negotiation. Retain both receipt tables and the
widened Growth handle constraint during application rollback. Historical canonical reads without
receipts cannot establish current permission and are unavailable for retained reuse. These access
checks do not establish business-content freshness or citations. Prepare/review/commit output
provenance remains outside this read protocol.

Supported Growth reviewed writes separately negotiate `effect-status-v1`. The native operation
keeps its exact result and receipt; model input, retained history and derived context receive only
saved status and an opaque review reference under the recorded information audience. Execution
exports withhold the raw effect body and mark that coverage partial. Staging transfer results use
their own actor, active-state and expiry checks. No additional migration beyond107 is required.
Keep supporting endpoint and worker versions together. Missing old custody prevents model reuse;
it does not authorize another mutation. Current-authority cancellation and exact review-status
controls remain separate, and an already-started effect recovers through its original status-only
path. Retain the private receipt when rolling back; do not restore raw effect output to context.

Schema132 stores opaque product references scoped to the organization, product tenant,
conversation and principal. Product adapters declare which selector fields are converted before
model use and which tool inputs may resolve them. The owning product still checks current access
after resolution. Apply the additive migration before the API and worker that register the new
adapter release; retain the table on rollback.

Schema108 atomically records a nonprogress stop with its input closure. A correction accepted
before that decision resumes the task; a later correction uses normal continuation. Retry recovers
the stored decision rather than recomputing it. Pick up the change at an idle boundary. An older
invocation that already journaled its final stall observation keeps its legacy result path, so
allow that invocation to settle or use normal continuation. Do not rewrite its journal. Keep the
additive table on rollback. A pending compaction joins its original invocation before a new stop
decision; a duplicate workflow invocation response is not permission to launch another compaction.

Schema109 adds an idempotent product-task artifact identity and a one-time managed rollout marker.
Apply it before publishing or running an agent version that selects `artifact.create`. Configure
private S3-compatible storage on both API and worker; without it the worker does not advertise the
file tool. Keep schema109, product artifact evidence and stored objects on rollback, and drain or
route tasks that use the new tool to a compatible worker. Do not remove the marker or replay an
accepted task against a changed tool definition. Untracked older product artifact rows without the
required audience and digest dependency are unavailable for reuse. A restarted exact
`artifact.create` operation may retry its immutable task/operation key and matching payload; a
different payload conflicts. When sandbox or skill execution is authorized, each named export has
its own task/operation/name identity; changing its bytes or content type conflicts. This does not
make sandbox or external effects retryable or enable sandbox where it is unavailable.

Schema110 adds the shared root-admission gate and immutable operator change history. It stops new
root task admission while allowing an exact idempotent replay and all already accepted roots,
children, and reconciliation to continue. The root admission transaction takes a shared row lock;
the drain takes the conflicting update lock, so an admission either commits before the drain or
observes the closed gate. Apply schema110 before using this control. It does not cancel accepted
work or fence an older API release that does not contain the gate check.

Delegated context packing reserves the complete originating user request alongside the current
assignment before retaining optional continuation receipts. The final assembled request must fit
its selected model policy before it can become a new context snapshot. Existing immutable snapshots
and accepted request identities are not rewritten by this packing correction.

## Retention, archive and index maintenance

| Records | Current retention and removal behavior |
| --- | --- |
| Conversation tasks, public operation receipts, corrections, request manifests and checkpoints | PostgreSQL retains these independently of prompt compaction. There is no archive lifecycle. Optional organization policy can logically expire inactive conversations after 90 days, with active/uncertain work, customer Inbox threads and holds protected. Conversation source deletion prevents future retrieval and invalidates linked memory. It does not erase retained text or immutable snapshots. |
| Candidate and accepted memory | Private actor/agent namespace, additionally product/tenant/client for product users. A proposal exists only after `memory_propose` returns its candidate receipt; user-facing claims that it awaits review must reflect that receipt. Candidates require exact authenticated review. Expiry excludes recall; correction and Forget invalidate derivatives. Forget clears current content and suppresses known earlier content digests. Superseded learned-memory revision bodies are purged after 30 days; forgotten revision bodies are immediately eligible for cleanup, within seven days. Fingerprints and suppression identities remain. See [retention defaults](retention.md). |
| Knowledge | Approved current revisions govern retrieval. Withdrawal invalidates reads and derivatives. Active normalized text remains recoverable; raw/stage object cleanup uses the existing seven-day plus fifteen-minute replay margin. Missing original media is reported as unavailable rather than reconstructed from a summary. |
| Execution artifacts and evidence | Private object custody and exact digests remain independent of context packing. Source, memory, actor, grant and audience checks apply on recovery and derived reuse. A missing object is unavailable. Retained references do not recreate bytes. |
| Restate workflow and journal records | Business V25 explicitly uses seven days. Compaction V1 and automation V1 currently use the pinned Restate1.7.13 server default of one day; their constructors do not override it. Verify the registered service metadata when releasing. These are not PostgreSQL or backup retention periods. Keep accepted workflow registrations until work settles or has an explicit recovery disposition. |
| Operational diagnostics | Bounded task, operation, route, release, state and error identifiers. Prompts, results, credentials and private reasoning do not belong in ordinary telemetry. The local decision trail points to private verification artifacts. |
| Backups and provider copies | [Backup commands and installable schedules](backups.md) provide encrypted nightly snapshots, seven-day database PITR, 35-day snapshot expiry and monthly isolated restore checks. Hosted installation is not performed by this source change. Model routes use the normal credential, grant and source checks; there is no manual provider privacy-verification gate. Previously sent provider copies cannot be recalled. |

Agents has no archive state, archive worker or archive store. Archive-specific failure metrics and
stalled-archive recovery alerts are not applicable. PostgreSQL task history remains live under the
retention policy above; a future archive or purge lifecycle requires its own approved design.

Agents engineering owns the versioned namespace and search-index definitions. The selected database
operator applies them through the schema setup path, which checks installed checksums before applying
the additive suffix. Schema002 owns the `memory_search` GIN index; schema101 owns the partial unique
`product_actor_memory_namespace` index. After a migration, verify its recorded checksum and confirm
each affected index is ready and valid in PostgreSQL's catalog. For a query regression, inspect the
actual plan and database index/table health first. Use the database's configured vacuum/analyze
procedures for routine maintenance. This runtime has no scheduled reindex job; index creation,
replacement or rebuild must use a reviewed schema change or the database operator's planned
maintenance procedure. Do not edit index definitions manually or run a blanket rebuild.

Learned-memory revision-body cleanup is scheduled by the worker. Complete physical erasure must account for tasks, corrections,
operation output, context snapshots, compaction prefixes/candidates/checkpoints, request manifests,
private continuation, memory revisions, source/evidence/artifact objects, Restate journals and every
backup copy. Deleting only a current memory row cannot establish erasure. Immutable-record triggers
must not be disabled as an ad hoc cleanup shortcut. A separately approved erasure change must retain
the minimum lawful effect/accounting identity, fence affected derivatives and prove that restore
does not resurrect deleted access. This implementation claims learned-memory store cleanup only, not complete physical erasure across independent source, context, effect and provider copies.

Source-conversation deletion requests normal persistent tree cancellation, including waiting child,
review and reconciliation states. The dispatcher cancels the existing accepted invocation; deletion
does not create replacement work. Child-conversation deletion leaves its parent/siblings untouched.
Terminal receipts remain available to authorized operational reconciliation.

## Investigation

Start with the exact product, tenant/client, initiating actor, conversation, work and task. Confirm
the current policy before inspecting content. Use the product activity view or authenticated native
observation. Aggregate diagnostics should contain identifiers and bounded codes only.

| Signal | Inspect | Response |
| --- | --- | --- |
| Recovery returns unavailable | Exact record/object digest, conversation deletion, source policy, actor/client scope, memory revision/expiry and selected artifact audience | Recover an intact currently authorized original. Preserve the unavailable state if it was deleted, expired or withdrawn. Do not fabricate a replacement from a summary. |
| A prepared compaction job stops advancing | Job owner, snapshot, physical operation, capacity request, runtime invocation and checkpoint head revision | Follow the existing workflow invocation and capacity notification. An observation timeout is not termination. Replay the recorded receipt; do not launch a duplicate physical summary or change the frozen prefix. |
| A background summary is rejected or fails | Settled job state/error, current source/memory fence, measured reduction and remaining foreground capacity | Keep the current checkpoint and recent tail. The controller stops optional background retries for that task and uses the foreground overflow path when needed. |
| Source or memory changes during inference | Request manifest, instruction head, generation/revision and `context.response_quarantined` event | Quarantine returned public text and opaque continuation. Rebuild from currently authorized originals. Preserve the physical attempt and observed usage. This cannot recall provider input already sent. |
| A tool cannot be found or loaded | Current direct catalogue, query, accepted tool version, exact handle and schema digest | Broaden metadata discovery or use its cursor, then load the returned exact handle. Discovery and loaded schemas do not grant permission. A revoked or commissioned-only tool must remain absent. |
| Work waits for capacity | Current request/lease, workload class, organization/root ledgers, child subtree and finite finishing reserves | Resume the same waiting invocation when capacity becomes available. Do not reset usage, create replacement task identities or change an explicit allowance to hide a wait. |
| A review/effect is pending or unknown | Exact product review, payload digest, native operation/physical receipt and installed reconciliation policy | Use the declared status-only or idempotent reconciliation path. An uncertain remote acceptance cannot be retried as a new mutation. Cancellation and UI dismissal do not undo effects. |
| An activity panel stops updating | Current observation permission, event/operation cursors, transport and actual terminal receipt | Reconnect observation with its existing task and cursors. Reopening a child does not admit another child. Clear stale content immediately on authority loss. |
| A free model is rate-limited or fails | Selected model/credential revision, physical bounded error, attempt and observed/accounted usage | Preserve the failed trial. Continue only through normal supported recovery or an explicitly selected permitted model. A completed controller or successful controlled provider fixture is not a live model-quality pass. |

The existing `model.invocation` telemetry identifies primary/compaction role, logical operation,
route, observed usage and duration. Join the native model receipt and physical-attempt records when
investigating an attempt. Native task events include `context.prepared`, `context.compacted`,
`context.compaction_settled`, `context.repack_required`, `context.result_previewed` and
`context.response_quarantined`. Runtime observations separate wall elapsed time, logical work time,
model latency and accounted versus observed usage. Inspect the actual receipt rather than inferring
an outcome from a progress sentence.

For a question about current business or workspace records, the shared protocol directs the model
to discover and use an authorized read capability before answering. Product commands already carry
their authenticated scope; the model should not ask the user to repeat a client or workspace name
needed only for an in-scope lookup. A discovered or loaded tool still grants no additional access.

New typed model failures retain only their controlled code, observed HTTP status, fixed failure
stage and dispatched flag. Use those fields to distinguish a provider rejection, an accepted but
invalid stream, and an initiating network failure. SDK reader cleanup does not establish that the
caller cancelled. Older attempts may lack these fields; do not infer their HTTP cause from a later
provider-availability check. Unknown accepted requests keep their original uncertainty.

For OpenAI-compatible SSE, `streamErrorKind` further distinguishes an observed
`upstream_sse_error`, `malformed_sse_json`, or `unclassified` failure. `providerErrorCode` is optional
and contains only an integer from 100 to 599 found as an error-envelope `status` or `code`; it is
separate from the actual HTTP response status. The installed OpenAI SDK can turn an error envelope
into either an error event or a thrown stream error before the Pi parsed-event callback, so the
protected response wrapper observes bounded framing before that boundary and carries the diagnosis
through both paths. It passes the original bytes unchanged. The observation bounds field/data bytes
per frame to 16 KiB and stops observing an oversized frame without rejecting the response.
Oversized and otherwise unrecognized failures remain unclassified. UTF-8 fragments, CR/LF/CRLF,
multiline data, comments, completion sentinels and a final unterminated event retain SDK framing.
No provider message, raw frame, header, reasoning or SDK `errorMessage` enters these fields.
Caller cancellation and physical deadline failures keep their initiating classification. These
diagnostics do not establish the cause of historical attempts or prove a provider is compatible.

An explicit HTTP503 response from a model provider maps to `MODEL_PROVIDER_UNAVAILABLE` with a
rejected model request, even if reading its error body is interrupted after the status arrives. The
same applies when an HTTP200 event stream contains a bounded upstream SSE error envelope with
numeric status503 or code503, whether the SDK emits an error event or throws while consuming the
stream. A complete response was not accepted by the runtime, and no tool call can execute before
response validation. Partial text may already have streamed to the user, and provider billing for
partial generation may remain unknown. Other HTTP200 stream errors, including malformed data,
connection loss and incomplete output, remain uncertain because a provider response may have
started. The transport does not retry or silently select another model.
Choose an available authorized route for new work while preserving the old attempt.

The scalar fields reuse `model.observed` receipts and `model.invocation` logging. No schema
migration, retry, route fallback, model setting, workflow identity or platform release tag is
introduced. Growth and shared Agents UI use the settled failure state and existing provider-
unavailable label. Collector revision, OTLP endpoint, exporters, metric labels and retention remain
unchanged; a new analytics event or dashboard is not applicable. Publish API/worker source together
at an idle boundary after focused transport/reporting checks. Rollback restores the prior
uncertainty classification for stream-level 503 errors without rewriting old receipts or replaying
a physical request.

## Runtime metrics and alerts

The API and worker export native metrics only when an OTLP metrics endpoint is configured and
`OTEL_SDK_DISABLED` is not `true`. The metrics endpoint and alert destination are deployment-owned;
this repository does not provision a dashboard or alert rules. Each API/worker replica reports its
own snapshot. Select the service role or instance before comparing values; do not sum duplicate
snapshots.

| Concern | Available signal | First response |
| --- | --- | --- |
| Stalled task, operation or dispatch | `agents.tasks` by state, `agents.operations` by kind/state, `agents.dispatch.pending` and `agents.dispatch.oldest_ms` | Inspect the exact task, operation receipt, Restate invocation and outbox row. Preserve any started or uncertain physical attempt. |
| Context invalidation | `context.response_quarantined` and `context.repack_required` task events; no aggregate invalidation metric is exported | Use authorized task observation to inspect the event and current source, instruction and memory revisions. Rebuild only from current authorized records. |
| Unknown effect | `agents.operations{kind=tool,state=uncertain}`, `agents.connected.operations{state=uncertain}`, `agents.tool_reviews{state=uncertain}` and `agents.channels.delivery{state=unknown}` | Reconcile the exact product or channel receipt under its declared policy. Never create a new mutation while the earlier effect is uncertain. |
| Capacity pressure | `agents.capacity.requests`, `agents.capacity.oldest_wait_ms` and `agents.capacity.wait_p95_ms` by workload | Inspect the same request, lease, workload, organization/root ledger and child subtree. Resume the accepted invocation; do not reset usage or admit replacement work. |
| Metric collection failure | `agents.metrics.collection_failures` | Check database query health, exporter endpoint and Collector availability. Disable export with `OTEL_SDK_DISABLED=true` only while restoring the configured path. |
| Archive failure | Not applicable: no archive state, worker or store exists | No archive-specific alert or recovery action applies. Investigate PostgreSQL history or a prepared compaction job through its own signal. |

Hosted alert thresholds and destinations remain unconfigured until the release owner selects them.
No new Collector, exporter, dashboard or browser telemetry pipeline is introduced by this runtime
change. Do not alert from a progress sentence; confirm the native task, operation or product receipt.

## Disable, rollback and restore

1. Stop default rollout. On schema110 deployments, close new root admission with the operator
   command below. Growth tenant disable and Agency trust/setup disable are emergency scope
   revocations: they also remove observation access, revoke grants and request cancellation. Do not
   use them as an admission-only drain. The owning product/operator must retain authorized
   reconciliation custody for any uncertain effect.

   ```sh
   # Read the current revision from the primary Agents database before each command.
   # The value below is an example; replace it with the revision you just read.
   psql "$AGENTS_DATABASE_URL" -c \
     'SELECT accepting_roots,revision FROM agents_platform.platform_admission_gate WHERE id=1'
   export AGENTS_ADMISSION_CONTROL_ACTION=drain
   export AGENTS_ADMISSION_CONTROL_ACTOR=release-operator
   export AGENTS_ADMISSION_CONTROL_REASON='rollback preparation'
   export AGENTS_ADMISSION_CONTROL_EXPECTED_REVISION=7
   pnpm --filter @kasitek/agents control:admissions
   ```

   The CLI compares the supplied revision under the gate row lock. If another operator command has
   advanced it, the command fails with a revision conflict; re-read the gate and decide again rather
   than retrying automatically. Every accepted command advances the revision and writes an
   immutable event, including a repeated drain or resume that leaves the gate state unchanged.
   Confirm the output reports `acceptingRoots: false`, then inspect the gate row and immutable event
   in `agents_platform.platform_admission_gate` and `agents_platform.platform_admission_gate_events`.
   New root requests fail with `PLATFORM_ADMISSIONS_PAUSED`; an exact replay returns its existing
   task. Accepted roots, their children, and reconciliation continue. Wait for those roots to reach
   a recorded terminal or explicitly reconciled state before removing their workflow registration.
   If the rollback target predates schema110 enforcement, block root traffic at the product ingress
   before routing to that binary; it will not honor the database gate.
2. Identify every accepted task, child subtree, prepared compaction, review, capacity lease and
   uncertain effect under the affected release. Let valid work settle on its pinned registration,
   or record its explicit cancelled/incomplete/uncertain disposition through normal task controls.
   Do not remove a workflow while its accepted invocation still requires it. If observation is
   revoked, investigate through the owning product's authorized operational records rather than
   restoring a user's revoked grant or reading a stale browser cache.
3. Select the last tested supported configuration for new work and rebuild the affected frontend
   adapters together. Keep immutable accepted configuration/tool/model identities and receipts.
   Do not roll back schema104 after retained graph arrays exceed the old constraints. Keep additive
   journal, namespace and assertion columns during application rollback.
4. Recheck identity, current membership/client/resource policy, source withdrawal and memory
   generation before reopening traffic. Read the gate's current `revision` again, set it as
   `AGENTS_ADMISSION_CONTROL_EXPECTED_REVISION`, and use
   `AGENTS_ADMISSION_CONTROL_ACTION=resume` with a new operator reason. Confirm
   `acceptingRoots: true` and its new event revision. A restored UI must observe the original task
   rather than resubmit it. Reconcile physical effects with the owning product before allowing a
   fresh attempt.
5. For recovery from backup, restore into an isolated dedicated database and object store first,
   with outbound model/effect dispatch disabled. Match PostgreSQL, object, vault/configuration and
   Restate custody to the same recovery point. Compare retained digests and inventory missing
   objects, accepted work and externally confirmed effects.
6. Apply deletion, withdrawal, suppression and credential/membership revocations recorded after
   that recovery point before permitting retrieval or inference. If those later control records
   cannot be recovered, keep affected namespaces unavailable. Never treat old backup permissions as
   current authority. Then verify original task observation and status-only reconciliation before
   explicitly authorized promotion.

Hosted backup creation, retention, erasure and promotion are not configured or executed by this
local upgrade. Do not restore over the owner's current database during verification. A release
record must name the recovery point, exact tested artifact, owner, review date and remaining gaps
before a hosted rollout is approved.

## Verification evidence

The implementation issues and local audit trail record exact commands and results. Focused owned
fixtures cover checkpoint CAS/replay and source withdrawal, namespace correction/Forget, recursive
scope, retained artifact provenance, reviewed canonical actions, lost acknowledgements, worker
restart and status-only reconciliation. Ordinary in-app model trials are recorded separately,
including failed grounding, search and provider-availability trials. See
[context management](context-management.md), [adaptive orchestration](adaptive-orchestration.md)
and the [Growth integration contract](../growth-integration.md).

## Capability activity presentation

Authorized task observations derive readable operation labels and categories from the same native
presentation hints or accepted product/connected binding metadata used by the effective catalogue.
Unknown operation names keep a generic label and are not copied into diagnostics. Valid accepted
identities can appear in an explicit Technical details disclosure; arguments, schemas, results and
private model reasoning are excluded. Connected metadata remains reference data, not authority.

Discovery and schema-loading calls carry explicit activity kinds. The shared renderer groups only
consecutive calls in the same task, retaining individual identities, outcomes and recorded timing
inside the group. Public updates, unrelated operations and different task identities split groups.
The group shows failed/unknown call counts and uses the measured first-start to last-end span when
all timing is available. Grouping neither creates progress updates nor changes execution/retries.
Existing evidence withdrawal and restricted customer history behavior still applies.

These are additive observation fields and consumer presentation changes, with no data migration,
new analytics event or log/export pipeline. Deploy compatible API and rebuilt consumer artifacts;
older consumers ignore the fields. Rollback restores prior presentation while retaining accepted
operations and their authorization checks.

## Credential reflection and retained receipts

Model dispatch checks prepared requests and completed responses for the active model credential.
It buffers text until the check finishes, including for older runtime releases. Connected-tool
execution checks its active authorization before storing a provider response. These checks cover
the exact value and common JSON-escaped, URL-encoded, Base64, and Base64URL forms; unknown
credentials, other secrets, and arbitrary transformations remain outside this check. A failed
progress observer cannot change a completed model call into a retry.

Ordinary replies, task progress and activity, authorized history, and supported text/JSON artifacts
use one recipient projection. It replaces known internal task, version, grant, operation, and
resource-selector values from the authorized task lineage while leaving native receipts available
to permission-checked tools. Growth public platform account identifiers remain hidden in ordinary
output unless the current user explicitly asks for that identifier; internal control identifiers
stay hidden even then. This is exact known-value protection, not semantic secret detection. Legacy
partial records and binary artifacts have limited coverage, and authenticated technical exports
retain their separate native contract.

Model history reads use the connected or built-in tool's current model-facing view while retaining
the native operation receipt. The digest and offsets describe that view. When a view differs from
an older receipt, history returns a notice so a task can restart at offset zero; already transmitted
or displayed content cannot be recalled.


## Capability exposure and assignment upgrades

New publications pin discovery/loading version3 and the measured capability-exposure-v1 policy.
The initial directory and schema selection are shared by standalone, product, automation and
descendant business tasks. See [product capabilities](../product-capabilities.md#tool-discovery)
for limits, trusted metadata and retained version1/2 behavior. An oversized tools_load request
returns TOOL_SCHEMA_LIMIT before a successful load receipt; reduce the selection or use replace.
Accepted context snapshots and earlier protocol schemas remain immutable.

Growth command and provisioning publications share a 256KiB UTF-8 content limit. The
provisioning HTTP route allows that publication plus a 16KiB request envelope. Structural
validation, signed service authority and operation permissions still apply. These transport
limits do not change model context or execution allowances.

Apply schema115 before enabling [Growth capability updates](growth-capability-upgrades.md).
It records a capability baseline for three-way previews, independently of custom instructions/model
ownership. No provider, key, backup, exporter or hosted schedule is added. Schema/command releases,
worker and consumer artifacts must match. Rollback stops new updates and restores compatible code,
retaining the additive baseline, accepted versions, operation receipts and reconciliation paths.

The owned test installation has no Analytics reporting resolver token or signing key. Legacy
analytics.read authorization checks reportingDependencies, which reports REPORTING_UNAVAILABLE for
this missing configuration after its permission checks. This is a confirmed readiness gap; the exact
historical authorization response was not retained, so it is not attributed to a search miss. Canonical operations retain their own
current reporting/entitlement prerequisites. Do not claim analytics is ready or add deployment
credentials as part of capability discovery.
