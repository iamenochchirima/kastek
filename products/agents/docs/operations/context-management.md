# Context management

Owner: Agents engineering. Reviewed: 2026-11-20.

Conversation tasks, queued directions and operation receipts retain the original records. Context
packing selects complete message groups for a particular model request. A continuity checkpoint
is a compact reference to an exact retained prefix; it does not replace those records or confer
permission. `history.search` and `history.read` recover authorized originals when exact details
matter.

Packing and checkpoint adoption do not delete or overwrite the retained task inputs, outputs,
instructions or operation receipts. Failed compaction leaves the previous checkpoint and those
originals intact. Object-backed recovery reads the retained private object and verifies its digest;
missing, interrupted or corrupt content cannot be replaced with summary text. This does not promise
recovery of unsupported media or of a provider preview whose original bytes were never retained.

## Delegated request provenance

Shared-runtime child tasks receive the original request that started the logical work as a separate,
digest-tracked user message. The child's accepted input remains the coordinator's assignment and is
labeled separately. This lets a specialist preserve relevant user intent and constraints without
mistaking coordinator-authored additions for user-supplied facts. Claims added by a coordinator
must be checked against an authorized source or reported as unverified.

The request source is mandatory in the packed child context; if it cannot fit, the context build
fails instead of silently dropping it. It does not expand the specialist's assignment or grant
tools, product access, or effect authority. Parent transcripts and prior user turns remain excluded
unless a separate, authorized recovery mechanism supplies them. No database migration or new
analytics event is required.

## Context capacity

New configurations use `context: {mode: "automatic"}`. At admission, policy compiler
`model-execution-policy-v3` derives the input ceiling from the selected model's sourced window
after output and safety reserves, then intersects service, product and finite work ceilings. The
service compaction-to-input proportion supplies headroom inside that effective input allowance.
Both derived decisions retain provenance in the accepted route. A smaller selected model therefore
receives a smaller usable context; a larger model does not inherit an arbitrary 8,192-token default.

Existing numeric context objects remain explicit limits. Parsing and publication preserve their
shape and digest. Selecting Automatic in the configuration editor is an explicit change; renewal
cannot widen an already accepted grant. Automatic grant creation uses the trusted service input
ceiling and leaves final route narrowing to admission. No stored grants, model bindings or accepted
work are rewritten. This configuration change requires no additional database migration.

## Compaction policy

Automatic context compacts at 85% of the effective input allowance. The service default is
167,116 of 196,608 input tokens; `model-execution-policy-v3` scales the same proportion for a
smaller selected model. Explicit context limits keep their configured `compactAtTokens`.

Route budgets are request-packing limits, not compaction triggers. When history exceeds a route's
history budget, the assembler keeps a contiguous recent window and exposes older turns through
`history.search` and `history.read`. It does not run a summary merely because the route is full.
A separate full-conversation estimate drives the model-pressure forecast, so a 10k or 20k route
request is not treated as a nearly full 196k model window.

Compaction is background work at the 85% threshold. It retains the most recent 15,000 tokens
for a large model window, scaled to 25% of the effective input (with a 1,000-token floor) for
narrow contexts. Foreground compaction is reserved for a request that cannot fit even after route
packing, an explicit narrow context limit, or recovery from an actual overflow. A failed summary
prunes the frozen prefix and continues; the stored turns and their evidence remain available to
history search/read, and a failed or unavailable background job never blocks the reply. Explicit
narrow context limits keep their hard cap instead of silently pruning required context.

A reasoning model can spend the whole compaction output allowance on internal reasoning and
return no summary. The 4,096-token agent output cap is enough for a normal reply but not always
for a summary. The pruning fallback keeps the turn alive; the compaction model and output
allowance still need a dedicated review before relying on summaries alone.

The chat's **Compact context** action admits a hidden maintenance task with a fresh execution
root, freezes the current conversation into the same immutable background job, and settles the
task after adoption. Maintenance tasks are excluded from conversation history and conversation
reads.

Under the shared protocol, tool results the model has already read are shortened to a bounded
opening with an explicit note. The newest result is left whole, and the complete output remains in
the task trace and any retained evidence/artifact handle. This reduces repeat cost without using a
summary call. Compaction requests cap tool output separately.

The context meter reports route-input usage and model-pressure usage separately. A 37% route and
a 7% model window are different facts and must not be presented as one percentage.

### Rollout flags

- `AGENTS_COMPACTION_POLICY=pressure|off` enables automatic summaries or leaves route windowing
  only. The default is `pressure`.
- `AGENTS_COMPACTION_BACKGROUND=true|false` controls optional background summaries.
- `AGENTS_COMPACTION_MANUAL=true|false` controls the explicit Compact context action.

Flags are read at the operation boundary; invalid values fail instead of silently changing
behavior. A restart applies a new value without a schema change.

## Request custody and recovery

New publications use `tools.load`2. Models select the exact handles returned by discovery;
the server pins the authorized schema and function name. The input has no competing alias or
model-copied digest fields. Accepted version1 keeps its original input, definition and schema
pins. Successful load receipts retain their original result shape, and later use still checks
the current accepted catalogue and exact definition digest. A renamed, changed, revoked or
specialist-only tool cannot become callable through a guessed handle or a retained load receipt.

Every V15 physical request stores an immutable manifest with its instruction head, exact route,
configuration and policy identities, selected source ranges, dependency manifest, count method and
memory fence. Dispatch rechecks those identities and current information authority. A new direction
fences stale model preparation and related tool admission. A stale interrupted idempotent effect
remains uncertain because admission cannot establish whether its first attempt committed. Completed
receipts remain replayable, and explicitly declared status-only reconciliation can recover a known
effect without starting another mutation.

The runtime rechecks the dispatched manifest when generation returns. Until then, it buffers public
text for the shared protocol. The protocol directs agents to resolve record identifiers through
authorized lookup, ask for recognizable distinguishing details when necessary, and separate the
requested work's prerequisites from requirements for an optional later action. This is shared
interaction guidance, not a deterministic business workflow or proof of answer quality.
A source, memory, membership or provider restriction that invalidates
the response prevents both public text and native continuation from entering later context. Actual
attempt identity and observed usage remain recorded. This does not recall bytes already sent to a
provider. Ordinary new directions apply at the next boundary rather than invalidating unrelated
in-flight generation.

`history.search` defaults to earlier authorized turns. With `part: "operations"`, it searches this
task's retained public receipts and returns operation handles and a paging cursor. `history.read`
accepts exactly one earlier `taskId` or current `operationId` and returns UTF-8 pages, exact digest,
total bytes and completeness. Model operations, private continuation and operation arguments are
excluded. A large tool result that cannot fit the next measured request receives a marked preview
only after its full receipt commits. The exact result remains readable through the handle. Reading
it retains its original evidence dependencies; compaction does not grant new source access.
Search accepts optional `since` and `before` ISO timestamps. `since` includes the boundary and
`before` excludes it, using turn creation or operation start time. The shared history contracts
define both the model-visible input and the native result validator, so a completed read must
also satisfy the same declared output contract before the model receives it.
Search authorization checks each receipt's own output evidence before matching, including reads
that completed before any context snapshot consumed them. Native skill receipts recheck the exact
reviewed package and current installation state. Dependency-only retention keeps previewed sources
fenced without asserting that their full passages appeared in a model request. Preview/search/read
use the same normalized canonical receipt serialization and exact PostgreSQL cursor timestamps.

Newly published version2 `history.search` also supports `part: "artifacts"`. It discovers permitted
current and earlier artifact metadata without requiring an existing artifact ID or the full old
transcript to remain eligible. Results include the originating task, exact artifact ID, stored
digest, name, type, size and `metadataOnly: true`. Name/type keywords and inclusive `since` /
exclusive `before` artifact-creation times filter this metadata; artifact bodies are not searched.
`nextBeforeArtifactId` pages the exact creation-time/ID order, preserving PostgreSQL timestamp
precision. Pages have no cumulative 100-artifact cutoff. Every candidate passes current source,
memory, actor, conversation and artifact-audience checks before matching or preview generation.
Metadata search retains dependency fences but supplies no artifact bytes, passage IDs, citation
handles or retained byte-read link. Accepted search-version1 keeps its original schema and digest.
The standalone task observation's initial artifact list remains capped at 100; this shared recovery
path does not claim that the task UI or every artifact-list API has pagination.

The version2 `history.read` contract also accepts a `taskId` plus an exact `artifactId`
recovered from artifact search or that turn's receipts. Current `artifact.read`, the original artifact audience and
the same agent/conversation/actor/product/resource/caller remain required. This recovers one
permitted text artifact. A current-task artifact uses the existing authorized read; an earlier
artifact records an exact history/evidence link. It does not open the earlier
root's whole artifact list or another conversation. The response pages UTF-8 bytes, preserves a
retained BOM, reports the original SHA digest/byte length and marks incomplete ranges. Supported
task artifacts are text, Markdown and JSON; unsupported encoding or unavailable storage is explicit.
An S3 response interrupted after headers returns `OBJECT_STORE_UNAVAILABLE`, with no partial
content or private transport details. A missing object returns `ARTIFACT_CONTENT_MISSING`.
Subsequent reads and derived reuse require that same narrow link and its current source/memory
fences. An unrelated withdrawn source can make the full old transcript unavailable while leaving
an earlier independent artifact recoverable. Earlier accepted read-version1 contracts retain their
original schema and cannot use this new variant.

When explicitly selected in a tool-directed agent version, `artifact.create` writes UTF-8 text,
Markdown or JSON to the existing private task store, up to 1 MiB. The file is not a product business
record or an external delivery. Growth and Agency task files retain their producing task, exact
digest, originating tenant and actor, conversation and client audience, permitted model
destinations, and inherited source/memory dependencies. Current originating-product authorization
and the original source fences apply before and after storage access. Model, delegated and compaction
requests must also satisfy the recorded provider audience. A selected same-work or earlier-turn
artifact may be handed to a child; an unselected file does not grant that child access. Retained
recovery stays within the same authorized conversation, not arbitrary conversations. Product
artifacts without the new exact dependency cannot be reused. Digest and source custody do not
independently verify the truth or freshness of file contents.
Literal valid citations present in the verified artifact bytes retain a separate citation registry.
Recovery can validate those exact citations through its narrow artifact/history link, including in
a derived report or assigned review. It does not mark the underlying full passages as supplied to
the model, and handle-only recovery cannot use generic passage reads to fetch additional source
text. Unselected, foreign and withdrawn citations remain unavailable.

Retained evidence uses iterative, cycle-safe graph traversal. Historical depth, node count and edge
count do not create lifetime limits. Each individual dependency manifest remains bounded to 1,024
unique dependencies, and each operation retains its own citation bounds. New evidence nodes retain
the current dependency frontier so repeated context snapshots do not create a dense graph. Recorded
parent lists and digests remain immutable. Source withdrawal still invalidates all dependent joins.
Schema104 removes the older database cardinality checks on retained parent/evidence-ID arrays.
Those arrays contain accumulated graph metadata, not a model request. Manifest and per-operation
citation bounds remain enforced by the runtime. The recognized-checksum setup path accepts the
exact schema103 predecessor and applies104 once, preserving installed records. An unknown checksum
still fails before mutation.

## Memory assertions

Memory records retain their assertion origin, context and reported conflict state in addition to
revision and freshness timestamps. Hypothetical and unspecified statements cannot silently become
current business records. Conflicts default to `not_assessed`; `reported` and user `resolved` are
explicit retained assertions, not a semantic conflict detector or fact verification. Authenticated
review/correction records the exact classification, actor and expected revision. Any such correction
advances the namespace generation and record revision before a later model request can use it.
The shared memory review shows these fields. New memory tool releases expose them to the model;
accepted earlier tool versions keep their exact schema and result projection. Schema105 is additive.
Task memory reads and candidate proposals require their separate current grant operations.
The model sees only the permitted memory tools, and a task without memory-read access does not
load personal memory into its context. An assistant acknowledgement is not an accepted memory:
the user reviews a candidate before it becomes available for future recall. Model context identifies
the review status of accepted memories separately from their original source and from independent
verification, so a reviewed preference is not mistaken for an unreviewed model proposal.
Forget remains a suppression and invalidation operation, not physical erasure of revisions.
Deleting an owned source conversation also requests normal tree cancellation for its tasks and
descendants, including tasks waiting for children, review or reconciliation. Persistent cancellation
markers let the existing dispatcher wake/cancel those invocations. Deleting a child conversation
cancels that subtree, not its parent or sibling. Terminal tasks and effect receipts remain unchanged.
Deletion is idempotent and follows organization, task, conversation, then memory lock order.

## Compaction jobs

Schema100 records immutable compaction jobs, prepared model manifests and continuity checkpoints.
Each job freezes complete groups and digests, its source manifest, memory generation and expected
checkpoint revision. A background job additionally pins its exact saved compaction snapshot and
previous summary. The conversation permits one prepared background job at a time. Preparation
returns the actual job ID and owner task ID; callers must never submit an earlier task's job with
the current task's identity. An abandoned job from a terminal task is classified as uncertain when
its physical operation started or became uncertain, and failed otherwise.

`AgentsContextCompactionV1` processes that frozen job. The foreground controller owns prefix
selection and the launch/join decision. The workflow adds no separate planner or scheduler. It
uses the accepted compaction model and the normal durable operation, source, memory, provider,
token and active-time checks. Its capacity requests use the existing background workload class.
Atomic admission leaves a primary finishing call inside finite local/shared call ceilings and
checks a bounded foreground token/time reserve against the same ledgers. A child also retains the
existing root finishing allowance. These checks do not add a new limit or charge the finishing
reserve as usage. The reserve comes from the already prepared primary request.
The ordinary dispatcher resumes a queued job through its workflow key, rather than sending the
notification to the parent business workflow.

The parent keeps its previously journaled workflow call when joining a background job. If Restate
reports that the workflow was already started by the one-way send, the parent attaches to that
invocation instead of starting another compaction. When a reused earlier job makes the new send
itself a duplicate, the parent waits for the recorded job's terminal state. Pending or uncertain
work is not reported as a completed compaction.

The worker validates the frozen group digests against the prepared request before generation.
Summary evidence derives from that exact snapshot. Appended groups and newer directions stay
outside the prefix. Adoption rechecks authority and source/memory validity, requires a nonempty
complete response that reduces the prefix, and compares the expected checkpoint revision under a
conversation lock. A newer checkpoint supersedes the older candidate. Rejection or failure keeps
the current checkpoint and original records available. Replay uses the recorded physical receipt;
it does not generate another summary.

Loading a carried checkpoint imports its frozen source evidence into the current task before
covered history is omitted. The import retains the authorized producer/history edge. A source
withdrawn after loading therefore still fences the next physical request and its returned text or
opaque continuation. Foreground jobs pin their prepared snapshot too; a checkpoint committed before
its summary node was created can recover that snapshot's evidence. Import replay keeps its original
parents rather than selecting evidence that arrived later.

## Native compaction

| Installed protocol | Portable checkpoint path | Provider-native compaction |
| --- | --- | --- |
| OpenAI-compatible Chat Completions | Supported | Unavailable |
| OpenAI Responses | Supported | Unavailable |
| Anthropic Messages | Supported | Unavailable |
| Google GenerateContent | Supported | Unavailable |

No installed adapter declares a provider-native compaction operation. Every installed route uses
the portable retained-record path; a provider's separate compaction API is not inferred from
ordinary model or token-count support. The controlled background workflow proof uses a compatible
Chat Completions provider. Existing protocol fixtures verify native message/continuation transport
separately; this is not a claim of live compaction testing against every provider.

Private continuation is selected only for matching assistant/tool groups on the same task and
accepted route digest. Provider, protocol, model, destination and credential revision must match.
Compaction requests do not inherit that opaque history. Prepared-context and current-source checks
run before dispatch and again before accepting returned text/native state. Incompatible or narrowed
state cannot restore access; the portable records are the recovery source. No implicit remote
conversation pointer is used by this workflow.

The launch interface is `prepareCompactionJob` with `mode: "background"` and `snapshotId`, followed
by `run({jobId, taskId})` on the returned job's workflow key. `readCompactionJobOutcome` returns
`pending`, `adopted`, `superseded`, `rejected`, `failed` or `uncertain`. Only `adopted` supplies a
currently authorized checkpoint. A checkpoint older than the current head returns `superseded`.
The controller removes only the returned compacted group IDs from its working context and keeps
the complete recent tail. It must join or resolve its own pending job before final settlement.

When required context no longer fits, an optional background job that has not admitted a physical
operation can yield to foreground recovery. Under the same organization lock used by operation
admission, the controller records `COMPACTION_FOREGROUND_REQUIRED`, releases queued or provisional
capacity and wakes the job. A delayed worker cannot start that retired job. The controller joins
its settled outcome, rebuilds a foreground prefix from retained records and disables further
optional background work for this task. The frozen original groups and current tail remain intact.
An admitted or uncertain physical attempt cannot be replaced this way; the controller joins its
original outcome and preserves its recorded usage. Known foreground failures and invalid summaries
also settle their job rows, rather than leaving a prepared job that appears pending indefinitely.

Failed preparation never removes prompt groups. A foreground model rejection, unavailable storage
or retrieval failure preserves original records and the previous usable checkpoint. Explicit
Continue can admit a new work segment under current authority, original allowances and existing
receipts. Unknown physical work must settle or reconcile before continuation. Compaction does not
retry an identical nonreducing candidate; whole-context progress is checked after adoption, and a
failed optional background route is not repeatedly relaunched by the same task.

The primary model's configured compaction threshold is an upper trigger. Positive growth between
successive measured primary snapshots reserves additional headroom and can advance that trigger.
This is a labelled forecast, not a guarantee about the next tool response. The planner preserves
recent complete groups and does not relaunch the same eligible prefix without new content. A
failed optional background job disables further optional launches for that task; physical overflow
still uses the foreground path. Finite configured operation, token and active-time allowances reserve
a bounded primary request before optional compaction. Null work allowances remain null.

## Observability and verification

Physical compaction calls emit the existing `model.invocation` telemetry with role `compaction`,
task/root/operation identity, route and policy digests, observed usage and duration. Native
`context.compacted` and `context.compaction_settled` events record background mode, state, compacted
group count and bounded error code. They do not contain summary or source text. A dedicated
product analytics event is not applicable; these are runtime outcomes, not another user action.
Collector configuration and retention are unchanged. No new exporter or dashboard is introduced.

`context-journal.test.ts` uses an owned PostgreSQL database and native Restate1.7.13. Its controlled
provider cases cover capacity wait/resume, a concurrent retained correction, duplicate submission,
foreground/background compare-and-swap, revocation during inference and exact observed accounting.
The journal case also recovers an exact first-turn detail after 1,000 generated retained turns.
The generated records do not claim to be 1,000 live model interactions. Ordinary live-model
application acceptance is separate from this controlled runtime proof.
The retained-history case in `growth-product-http.test.ts` also exercises conversation and current
operation search/read through the actual shared worker and both product APIs. Its model responses
are controlled; it proves contract dispatch and recovery, not autonomous retrieval judgment.

For a stuck job, inspect its state, task state, physical operation receipt and capacity request
before retrying. A prepared job with a waiting capacity request should receive its notification
at `AgentsContextCompactionV1/<jobId>/capacity`. Keep uncertain receipts and their accounting;
never reset usage or change a frozen job to force adoption. An invalidated summary requires
rebuilding context from currently authorized originals.

## Release impact

This local upgrade uses schema100 for journal/checkpoint custody, schema104 for retained evidence
graph metadata, and the `AgentsContextCompactionV1` worker registration alongside
`product-capabilities-v15` / `AgentsBusinessRunV25`. API and worker must use the same tested source
and schema. Refresh the owned Restate registration and inspect its service list; an HTTP200 from
an existing registration does not prove the new service was installed. Older accepted business
workflows keep their registered identities.

Rollout is through the shared runtime publication and worker registration. To disable background
launch, stop new launches in the foreground controller, retain the workflow until existing jobs
settle, and keep retained records/checkpoints. Do not drop the schema or rewrite accepted job
identities during rollback. Retain schema104 after graph metadata exceeds the older array limits;
reinstating those limits would require discarding custody. No deployment, owner-database migration or platform release tag is
included in the local implementation. Commit/artifact identity and a post-release review date
belong to the eventual release record.

Artifact discovery adds history-search contract version2 without a database migration, a new
business-workflow identity or a platform release tag. Publish a new agent configuration to opt in;
accepted search-version1 compositions remain unchanged. API and worker must pick up the same
tested source at an idle boundary. Keep version2 handlers while accepted version2 work remains.
New analytics, exporter configuration, dashboards and external effects are not applicable. Existing
operation receipts, dependency fences and bounded error codes cover search/read outcomes. The
focused artifact fixture verifies 101 discovered records across exact cursors, metadata-only
custody, revoked/foreign omission and byte recovery through a discovered handle; this is controlled
storage/authorization proof, not evidence of autonomous model retrieval quality. Disabling new
version2 publications does not remove retained artifacts or rewrite accepted schema pins.

## Turn routing and product tool exposure

New turns are routed deterministically as conversation, knowledge, catalogue, action,
confirmation, complex or workspace. Each route carries its own input, knowledge, history,
tool-result and product-schema budget. The route only narrows the agent's configured tools; it
never adds authority.

Product tool namespaces come from the binding authority, not the generated alias. Conversation
exposes no product tools. When the product schema surface exceeds the route cap, the schemas are
deferred and selected through `tools_discover` / `tools_load`; `tools.load` validates against the
route's input budget. Knowledge-only agents on knowledge and catalogue routes do not receive
discovery tools.

Conversation answers are projected through `publicAnswerText` at every task read, so evidence
handles never reach Evals, the website or a connected channel. The stored task output retains the
handles for evidence mapping. The evidence endpoint returns cited passages when the answer carries
handles; otherwise it returns the retained evidence supplied to that task. Reports keep their
citation contract.

Evidence transactions serialize per organization with a transaction-scoped advisory lock instead
of locking the organization row. This keeps context assembly from blocking unrelated reads and
writes. No database migration is required.
