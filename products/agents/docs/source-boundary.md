# Implementation boundary

Owner: Agents engineering. Last reviewed: 2026-10-18.

Agents is a fresh standalone product. Its API and business worker use the dedicated
`agents_platform` PostgreSQL schema. Setup loads the ordered SQL files in
`api/schema/` into a fresh database and checks their combined digest on subsequent
startup. It does not migrate an older database or import Growth state.

## Product scope and implementation gaps

The [target product](architecture/agent-platform-architecture.md#standalone-agents-product)
offers mostly plug-and-play customer-service, FAQ, booking, and intake agents, with connected
customer channels and a shared staff inbox. Growth and Agencies own research, campaign, content,
and agency experiences using the shared execution backend. Shared runtime capability tests do
not establish those offerings in the standalone Agents catalogue.

The current application creates grounded FAQ or customer-service agents from the offering catalogue.
The chosen offering is stored on the agent. The catalogue separates FAQ/customer-service setup from shared execution programs. Booking remains unavailable.
Direct agent chat and principal-scoped conversation history are implemented. Customer website
messages have a separate canonical timeline with staff assignment, human takeover/replies,
resolution and explicit return to automation. Human-owned ingress does not admit model work.
Returning control admits only a new visitor message. Generation checks suppress late automated
output and fence subsequent operations, including inherited specialist authority.
The automation occurrence inbox below is an event deduplication mechanism, not a customer inbox.

Website publication and widget conversations exist. WhatsApp, Facebook, Instagram, booking and
calendar adapters remain unavailable. Connections exposes narrow report/public-repository/GitHub/
Stash profiles. Provider OAuth, verified account identity, resource browsing, provider health and
reauthorization are absent. Current screens do not yet fulfil the target connection experience.
Research/report acceptance fixtures prove execution behavior, not a standalone research product.
The runtime's reviewed personal memory does not imply a personal-assistant catalogue offering.

## Customer agent configuration

The customer editor exposes no personal-memory, skill, specialist, sandbox, connected-tool or report
configuration controls. Shared-harness acceptance provisions those capabilities through the normal
authenticated APIs and retains conversation/task inspection, report review and resource status.
Customer creation loads the actual catalogue, sends the selected FAQ/customer-service offering and
keeps submission unavailable when catalogue loading fails. Website chat reads the canonical customer
timeline; prior browser output caches are discarded before current-policy reads.

## Published execution and evaluation contracts

Trusted `grounded-conversation` and `tool-directed` program releases share the business loop.
Publication validates exact tool/workflow closure and saves a digest of the effective configuration,
program/runtime releases, context policies, tools and connected bindings. Admission saves that
composition on the task; workers validate it before further execution. Task bindings and published
compositions are immutable. Workspace programs and booking providers fail explicitly.
Reviewed report stages live in `workflows/report-delivery/program.ts` and retain digest-bound
approval, one dispatch claim and status-only reconciliation.

The current source release is `modular-programs-v1` / `AgentsBusinessRunV11`. It requires a fresh
dedicated schema. Verification uses separate compiled artifacts and databases. Running older local
artifacts are not upgraded by setup or rewritten to accept the new schema.

Native evaluation trials require an authenticated operator, a dedicated unused agent and the exact
published composition digest. Trial preparation is idempotent. Tasks retain the server-validated
trial binding, a total allocation ceiling and isolated conversation/memory/artifact scope. Suites
must provision controlled external provider resources separately. Revocation fences further work
and requests cancellation; it does not claim an external call stopped. Lookups recover trial and
root identities after lost responses. Authorized native history export retains exact request,
response, evidence and branch records, with explicit coverage gaps.

`POST /evaluation-trials/:id/channel-session` binds the operator-owned trial to its published website
and allowed origin. It returns a normal opaque visitor token, derived using the independent
`AGENTS_LOGIN_RETURN_SECRET`; retries recover the same session. The server supplies trial authority
at ingress. Public callers cannot choose a trial UUID. `GET /evaluation-trials/:id/channel-history`
returns authorized canonical messages, ownership commands, delivery facts and native root IDs.
Operator task/history export for these visitor roots requires the exact trial owner, current
membership and matching server-side publication/session binding. Revocation expires the visitor
session; authorized audit metadata remains available with current-policy payload withholding.

The trusted `adapters/products/product-execution.ts` contract verifies signed short-lived product
assertions against an installed issuer/key and registered tenant mapping. Growth/Agencies actors
retain their own identities; admission does not invent an Agents account or membership. The current
contract consumer supports model replies and approved public knowledge only. Rich product tools,
private product records, delegated specialists, memory and sandbox scopes remain unavailable through
this product adapter until their resource contracts exist. These constraints do not limit the separate
shared harness acceptance fixtures. Production Growth/Agencies integration remains future work.

Execution events persist `agent.observation.v1` metadata and an export intent atomically. Explicit
OpenTelemetry spans carry native scope, program, operation, attempt and usage identities, without
prompt bodies, tool arguments or credentials. The bounded publisher leases pending observations
across replicas and retries Collector failures independently of execution authority and accounting.
Configure `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` to enable export.
Local verification includes actual SDK export through the pinned Collector OTLP receiver, native
PostgreSQL replay/deduplication and outage recovery. This is not a hosted monitoring deployment.

### Metrics and local telemetry access

`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` (or the common OTLP endpoint) enables the pinned SDK metric
exporter. SQL snapshot gauges report native task/operation states, operation usage, queue waits,
dispatch backlog/attempts, Inbox commands/deliveries, allocations, observation backlog and local
pool/lock waits. Labels contain bounded product, program, workload, kind, state, action and process
role values. Tenant, task, customer and connection identities are absent from metric labels.
Snapshots of shared database facts must use one replica or a max aggregation, never sum replicas.
Task/operation/command/usage counts use a rolling 24-hour window including older unfinished work;
completed duration and granted-wait percentiles use one hour. They are gauges, not lifetime counters.

Collection has a 1.5-second SQL deadline and a 15-second export interval. Failed collection emits
`agents.metrics.collection_failures`; it does not alter usage or task state. Export timeouts are
bounded and shutdown flushes before closing the database pool. Set `OTEL_SDK_DISABLED=true` to
disable both telemetry paths. Export failure never proves an operation failed or an effect retried.

For local inspection, use `infra/observability/otel-collector/config.local.yaml` with the Collector
image pinned by the acceptance fixture. Bind OTLP and health ports to loopback. The debug exporter
writes operational metadata to local container logs; restrict Docker/log access to the developer.
Rotate local logs at 10 MiB with three files and remove disposable Collector containers and `.audit`
artifacts within seven days after review. Durable native receipts remain in their isolated fixture
until teardown; this local policy makes no production retention claim. Do not add payload fields to
ordinary telemetry; content reads use the separately authorized history/evidence interfaces.

## Concurrency verification

The dispatcher uses bounded leased batch claims and parallel sends with durable task identities.
Operation capacity uses queued requests, generation-fenced permits and durable Restate wakeups;
a waiting request holds no provider permit or operation reservation. Native operation begin/finish
uses root/task fences. Admission and settlement retain the organization accounting lock. Shared
versioned cursor keys support replica reads. Numeric policies are finite operator configuration.

The [scaling contract](architecture/agent-platform-architecture.md#concurrency-targets-and-workload-definitions)
defines 1,000/10,000 concurrent business-execution targets. Neither has been load-verified.
A controlled two-worker 100-root run is evidence of that workload only; queued roots and active
provider operations are measured separately. Requirements and load acceptance remain in Linear.
Executor routing and physical recovery require their own independent-process acceptance.

## Internal module boundaries

Implemented code lives under `contracts`, `infrastructure`, `execution`, `capabilities`,
`workflows`, `adapters`, `product`, and `composition`. Product identity, agent/version,
website deployment, and execution admission stores have separate implementations;
`product/agents/store.ts` composes their existing management interface. Execution
consumers use neutral record contracts and credential ports. S3 transport is separate
from memory/artifact authorization. Evidence policy and content writes are separate,
so authority checks do not depend cyclically on storage.

`pnpm verify:agents-modules` checks static imports, type imports, re-exports,
string-literal dynamic imports/requires, forbidden dependency directions and file
cycles. Contracts and infrastructure cannot import product routes or programs;
capability/workflow/runtime modules cannot import product implementations. Unsupported
computed module loading fails the check. Negative fixtures prove these checks reject
forbidden edges and cycles. Cross-product checks remain separate.

Composition entry points are `api/src/composition/` and compile to
`api/dist/composition/`. MCP's bounded helper remains adjacent to its adapter under
`adapters/providers/`; schema loading remains relative to the API package schema.
Moving adapter source changes executable digests. Existing immutable bindings are
never rewritten: new acceptance uses newly discovered bindings and published versions
with matching source/compiled artifacts. A previously recorded receipt still resolves
before the live registry; unavailable old releases fail closed for new physical IO.
The structural checkpoint retains Restate V10 handler names, journal steps, operation
IDs and `connected-research-v7`. Existing running compiled owner services are preserved.

The relocation smoke compiles into an ignored output tree rather than deleting a
running `dist` deployment. From the repository root, with a disposable-database-capable
local connection and private-storage settings in the private API environment:

```sh
pnpm --filter @kasitek/agents exec tsc -p tsconfig.json --outDir .artifacts/modular-dist
mkdir -p products/agents/api/.artifacts/schema
cp products/agents/api/schema/*.sql products/agents/api/.artifacts/schema/
node --env-file=products/agents/api/.env products/agents/api/test/modular-launch-smoke.cjs
```

The smoke owns a uniquely named database and child processes. It checks source HTTP
startup, compiled schema/HTTP/worker startup, an actual compiled isolated MCP helper
against a local fixture, cleanup entry initialization and adapter executable hashing.
It does not call a real model/provider or verify cleanup of a live allocation.

## Current modules

| Module in `api/src` | Responsibility |
| --- | --- |
| `contracts/contracts.ts` | Agent configuration, two execution kinds, grants, limits, and task states. |
| `product/identity/auth.ts`, `product/identity/auth-routes.ts`, `product/identity/auth-return.ts`, `infrastructure/config.ts` | OIDC signup/login, one-use safe return links, product sessions, identity configuration and backchannel logout. |
| `product/agents/store.ts` | Membership, drafts, immutable publication, revision pins, ordered admission, root reservations, and paginated authorized turns/events. |
| `product/agents/discovery.ts`, `infrastructure/read-pages.ts` | Principal-scoped agent/conversation/task summaries and signed scope-bound read cursors. |
| `composition/app.ts`, `composition/server.ts`, `adapters/channels/website/widget.ts` | Management and website APIs, continuation, history deletion, progress, cancellation, and widget delivery. |
| `execution/lifecycle/execution.ts` | Current authority, task and operation identities, claims, receipts, and usage settlement. |
| `execution/business/business.ts` | Restate business controller, model and tool rounds, ordered turns, and compaction coordination. |
| `execution/business/model.ts`, `execution/context/context.ts`, `execution/context/continuation.ts` | Provider protocol, conservative request accounting, scoped snapshots, complete message groups and bounded execution checkpoints. |
| `execution/memory/memory.ts`, `product/agents/memory-routes.ts` | Personal memory candidates, authenticated acceptance, revisions, expiry, forgetting, source invalidation, and pinned skills. |
| `infrastructure/object-store.ts`, `execution/artifacts/artifacts.ts`, `execution/artifacts/task-artifacts.ts` | Private S3-compatible content, root/task provenance, explicit transfers, downloads, integrity and deletion. |
| `execution/delegation/delegation.ts`, `capabilities/tool-descriptors.ts` | Published specialist bindings, atomic child admission, bounded results and pinned adapter contracts. |
| `capabilities/sandbox/sandbox.ts`, `capabilities/sandbox/sandbox-executor.ts`, `composition/sandbox-reaper.ts` | Isolated analysis, durable resource/command identities, artifact export and independent cleanup. |
| `execution/lifecycle/dispatcher.ts`, `composition/worker.ts`, `composition/worker-security.ts` | Leased outbox delivery, runtime identity, cancellation reconciliation, request signatures, and worker lifecycle. |
| `product/connections/connections.ts`, `infrastructure/vault.ts`, `workflows/report-delivery/actions.ts`, `adapters/providers/report-delivery.ts` | Scoped encrypted credentials, exact report review, atomic dispatch claims and read-only receipt reconciliation. |
| `product/automations/automations.ts`, `execution/lifecycle/automation-authority.ts`, `product/automations/automation-runtime.ts` | Immutable owner authorization, occurrence inbox, shared admission and Restate UTC timers. |
| `contracts/capability-catalog.ts`, `capabilities/connected-tools/connected-catalog-store.ts`, `capabilities/connected-tools/connected-executor.ts` | Immutable selected tools, executable releases, issued handles and durable connected receipts. |
| `infrastructure/connected-network.ts`, `adapters/providers/github-adapter.ts`, `adapters/providers/stash-adapter.ts`, `adapters/providers/mcp-adapter.ts` | Bounded egress, anonymous/keyed native reads, scoped Stash text and isolated MCP SDK execution. |
| `capabilities/knowledge/knowledge.ts`, `product/agents/knowledge-routes.ts`, `capabilities/knowledge/ingestion-runtime.ts` | Private candidates, owner approval, revision policy and durable import stages. |
| `capabilities/knowledge/document-runtime.ts`, `composition/document-reaper.ts`, `capabilities/knowledge/source-objects.ts`, `execution/artifacts/execution-objects.ts` | Pinned no-network parsing/embedding, physical cleanup and object write/deletion intents. |
| `capabilities/knowledge/retrieval.ts`, `capabilities/knowledge/query-embedding.ts`, `capabilities/knowledge/knowledge-runtime.ts`, `execution/context/evidence.ts` | Scoped lexical/hybrid retrieval, passage references and transitive policy dependencies. |
| `composition/setup.ts` | Fresh database initialization and schema checks. |

The management client is in `web/`. Its chat, configuration, management and explicit
website-publication paths share these APIs. Growth and Agencies retain independent
membership, permissions, and domain records. Embedded execution remains unavailable.

| User entry point | Current behavior | Verification |
| --- | --- | --- |
| `/` | Restored public landing with provider-backed signup and sign-in. | Public-entry browser tests and isolated actual identity signup/verification. |
| `/app/agents` | Compact searchable agent directory with server conversation history. | Chat workspace, discovery and browser regression suites. |
| `/app/agents/:agentId` | Chat, Activity and Configure; instructions, approved knowledge/revision pins, human support, versions and website publication. | Customer configuration/browser suites and actual native fixtures. |
| `/app/agents/:agentId/conversations/:conversationId` | Authorized history pinned to its original agent/version, current-policy output and inline report review. | Scope/recovery browser regressions and PostgreSQL history tests. |
| `/app/tasks` | Paginated authorized root tasks, filters and conversation/review links. | Actual PostgreSQL collection tests and browser navigation checks. |
| `/app/settings` | Real account/workspace identity, workspace creation/switching, theme and sign-out. | Settings browser checks and theme tracking regression. |
| `/app/knowledge` | Upload text/PDF/HTML, import one public URL, inspect candidates, approve, adopt revisions and withdraw. | Actual compiled ingestion, crash recovery and responsive browser acceptance. |
| `/app/connections` | Create report, public repository, GitHub and Stash profiles; select API/MCP tools, replace supported keys and revoke. | Responsive browser mocks and local HTTP/SDK/credential checks; external acceptance is recorded separately. |
| `/app/automations` | Pin report versions, authorize UTC/event triggers, inspect occurrences and control future runs. | Actual Restate timer/event HTTP checks and scheduled-report fixture. |
| `/app/tasks/:taskId` | Inspect root/children/resources, exact report review, permitted downloads and delivery receipts. | Real compiled-worker scheduled-report acceptance and assigned-reviewer regressions. |


### Chat navigation and recovery

Every available business agent opens Chat. Configure groups existing instructions,
source/tool pins, specialist limits, analysis, reports, memory, skills and website
publication. Draft saves and immutable version creation remain separate operations.
An existing conversation keeps its version. A version change starts a new chat.

The global sidebar contains Agents, Tasks, Knowledge, Connections, Automations and
Settings. The agent/history pane is separate from the main conversation. Tablet
collapses global navigation. Mobile uses focus-managed navigation/history drawers
and keeps the composer in the visible workspace.

History discovery is principal-scoped and server-backed. Accepted conversation
links survive browser storage clearing. Unknown admissions retain their original
request key, input and version across ordinary navigation. New chat is blocked until
that unresolved admission is recovered. Navigation does not cancel accepted work.

History initially shows the latest bounded page. Older pages prepend without
changing the active turn. At most four detail reads run concurrently per fetched
page, so earlier report/artifact cards return after reload. Activity and inline
review use the same authorized task data as the standalone task page. Window focus,
visibility return and Refresh conversation reread current history. Evidence denial
and review-decision authorization failures hide cached derived content.

The composer accepts text. Enter sends, Shift+Enter inserts a line break, and IME
composition does not submit. Markdown rendering supports escaped text, headings,
lists, code and HTTP links without raw HTML or executable content. Knowledge file
imports remain a separate approved-source flow. General chat attachments and voice
are unavailable.

## Business execution

The technical categories remain `business` and `workspace`. The business harness
owns its model and tool loop. Restate 1.7.13 with SDK 1.17.3 coordinates durable
steps and recovery. Workspace execution remains unavailable until the separate
Lina adapter is implemented.

Each task pins an immutable agent version and harness release. An ordered
conversation turn uses authorized prior outcomes, selected knowledge, optionally
approved personal memory, pinned skills, and complete model/tool groups. Context
snapshots preserve request digests and source revisions in private PostgreSQL
records. Compaction is an identified model operation with its own budget and
recorded result. Large generated content uses private S3-compatible artifacts.
Context snapshots are not currently stored as S3 objects.

Selected tools are `knowledge.search`, `knowledge.read`, `memory.search`, and
`memory.propose`, `agents.delegate` and `sandbox.analyze`. Trusted code validates their arguments and scope. A memory
proposal creates a candidate. Only an authenticated management action accepts,
corrects, or forgets it. Publishing a skill creates an immutable revision; skill
text cannot install tools or grant permission.

A minimal website FAQ uses this same controller with optional capabilities
disabled. Public visitors receive conversation-scoped context and approved public
knowledge. Personal memory, skills, and memory tools are denied for website
publication and execution.

Provider requests use only `nvidia/nemotron-3-super-120b-a12b:free` through OpenRouter,
with fallback disabled and reasoning effort `none`. Input preflight conservatively
counts serialized UTF-8 bytes against the configured token allowance and reserves
framing separately. This estimate is not an exact tokenizer count. Returned usage,
finish reasons, tool calls, and unexpected reasoning are validated.

## Authorized discovery and history

Authenticated collection routes use explicit summary objects rather than task or
agent configuration records. All routes below are beneath
`/api/organizations/:organizationId`; each request checks current membership.

| Read | Response and order |
| --- | --- |
| `GET /agents/summaries?q=...` | `{agents,nextCursor}`; compact roster with latest immutable version, draft revision and unpublished-change state. Newest-created first, ID tie breaker. Optional trimmed `q` (maximum 120 characters) searches the complete roster by case-insensitive literal name substring before paging. The existing `/agents` management response is unchanged. |
| `GET /conversations?agentId=...&versionId=...` | `{conversations,nextCursor}`; `agentId` required, version filter optional. The exact human issuer/subject, Agents product, execution caller and agent scope must match. Activity descending, conversation ID tie breaker. |
| `GET /tasks?agentId=...&state=...` | `{tasks,nextCursor}`; optional agent/state filters. Root tasks only, newest-created first, task ID tie breaker. Human tasks require exact principal; automation tasks require a current owner membership and either that owner or the pinned occurrence reviewer. |
| `GET /conversations/:conversationId` | `{tasks,nextCursor,conversation}`; newest page of turns in ascending display order. Prepend subsequent pages to load older turns. Conversation metadata includes the pinned version and current latest task/turn IDs independently of the selected page. |
| `GET /tasks/:taskId/events` | `{events,nextCursor}` in sequence order. Child reads require access through their original root. Reviewer-only access returns no events. |
| `GET /tasks/:taskId` | Existing detail response plus `eventsNextCursor`; accepts `eventsLimit` and `eventsCursor` for its embedded event page. |

Collections, conversation turns and standalone events accept `limit` (default 30,
maximum 100) and `cursor`. Cursors bind to the principal, workspace, route and
filters, including the trimmed roster search. They preserve a creation-time snapshot; later admissions appear on
refresh. State and authorization remain current, so revoked or no-longer-matching
records can disappear between pages. Timestamp keysets preserve PostgreSQL
precision and use deterministic ID ties. Cursors carry a key ID, issue time and bounded expiry.
Production replicas require the same versioned key set; old keys remain readable during rotation
until their accepted cursors expire. Development derives a stable key from its configured secret.
Expired or unknown keys return `INVALID_CURSOR`; clients refresh from the first page. Cursors
do not grant authority or preserve access after revocation.

Conversation summaries expose a plain-text title from the first authorized user
input, at most 100 characters with control characters replaced. Clients must render
it as text. Summaries contain no model output, report, source passages, credentials,
request keys or transcript previews. Deleted conversations are excluded from
collections; a retained direct history read masks the deleted input and output.
Reviewer-only task summaries include safe IDs, state, dates and permissions, with a
null conversation ID. They do not expose private inputs or delegated child records.
Subsequent detail and evidence reads retain current source-policy checks.

`test/platform-discovery.test.ts` uses a separate temporary PostgreSQL database and
actual HTTP requests to verify foreign principals, cursor misuse, tied timestamps,
version pins, snapshot admissions, revocation, reviewer metadata and more than 100
turns/events. It makes no model calls and does not change the owner's workspace.

## Admission, limits, and recovery

Admission atomically records the task, stable conversation sequence, root
reservation, and outbox command. Duplicate keys return the same authorized task;
changed payloads conflict. Model, tool, and compaction operations have separate
stable identities and receipts. A recorded result is reused after replay. An
unconfirmed model request becomes uncertain rather than generating another reply.

The development profile allows a root allocation up to 32,000 accounted tokens,
12 model calls including compaction and children, and 24 tool calls. Its model input allowance
is at most 8,192 conservative estimated tokens, with 1,024 output tokens and a
120-second deadline per model call. Root wall lifetime is 24 hours. Accounted
active operation time is bounded to 15 minutes. Every operation reserves time before claim. A late known completion is charged its
actual elapsed time; an uncertain operation consumes at least its reservation. A timeout cannot
hide overspent time or grant more root capacity. Organization limits are two
accepted active roots, two model operations, and four tool operations in flight.

The 100,000-token organization allowance applies to the UTC admission day.
Operations settle the original root reservation even after midnight. This is not
a separate physical-consumption cap for each later day. Uncertain operations
conservatively consume their reservation. Definitive rejection releases unused
usage. Settlement is idempotent at both operation and root level.

A coordinator can admit two version-pinned read-only business specialists with
explicit briefs and source subsets. Children use private conversation branches and
subdivide one root allocation; they do not consume new root slots or organization
reservations. Their current authority is also bounded by the root grant. A parent
waits for all admitted dependent children and identifies partial or uncertain results.
The model supplies only a published specialist binding ID and brief. It cannot
override that binding's allocation or source/tool scope. Trusted admission code
retains explicit narrowing controls.

A coordinator's `connectedToolBindingIds` selects its own model-facing tools.
Each enabled delegation binding separately selects tools from that specialist's
published version. Root grants and publication pins cover the unique union, at
most eight bindings. Selecting a specialist tool does not enable it for the
coordinator. The editor preserves specialist tool selections when a coordinator
removes its own selection, and disables unavailable connection tools.

Same-conversation history can retain an actually joined specialist's evidence
through explicit origin links. Original and current authority, pinned roles and
live source policies remain required. The history walk permits at most 32 origins.
Over-limit candidates are omitted before consumption; an over-limit dependency
already consumed by a task fails its current-policy check.

Optional analysis uses the verified local no-network gVisor Python profile.
The task owns stable allocation and command IDs; reconnect reads receipts/status.
Private artifact references survive resource destruction. An independent reaper
cleans expired and stopping-root resources. Root settlement retains ownership of
pending children and resources. See the runtime reference for setup and limits.

Cancellation records intent and blocks new work. It does not undo an accepted
effect or prove that a provider stopped. An uncertain outcome stays visible.
Runtime journals and workflows retain seven days. Outbox retries stop at 24 hours,
and settled tasks are not submitted again.

Memory changes and expiry invalidate future use through namespace generations
and dispatch checks. Conversation deletion tombstones its source history, cancels
open tasks, and invalidates linked memory. It does not physically erase old
revisions, completed provider requests, journals, or backups.

## Knowledge and connected evidence

Inline text, uploaded files and exact public HTTPS URLs use one private candidate
pipeline. `AgentsKnowledgeImportV1` owns acquisition, extraction, normalization,
chunking and local embedding. Approval does not follow from readiness or internet
availability. A refresh reserves a new immutable revision; versions and grants
pin approved revisions explicitly. The old scalar knowledge API is removed.

Imports allow 10 MiB raw, 1 MiB extracted text, 200 PDF pages and 1,000 chunks.
An organization has at most 200 active sources, 100,000 chunks and two physical
document/query allocations. A version pins at most 20 source revisions. Text,
Markdown, static HTML and text PDFs are supported; OCR, encrypted PDF, DOCX,
archives, authenticated crawling and browser rendering are rejected.

The document profile runs no-network rootless gVisor with one CPU, 512 MiB,
no swap, 64 processes and a 60-second stage limit. Release manifests pin the
Node filesystem provenance, parser/tokenizer packages, BGE FP32 model and gVisor
bundle. Profiles preserve immutable artifact paths across preparation. Worker
recovery attaches to accepted allocation IDs and stored stage receipts.
Independent physical and object cleanup lanes remain responsible after worker
loss. Uncertain writes have tracked intents and repeated deletion tombstones. Connected/evidence/query
bodies also acquire durable object ownership before PUT. Raw-response links require current scope,
a started operation and a live intent row. Root and child settlement wait for query compute to be
confirmed destroyed; neither storage failure nor cancellation releases a physical slot early.

Evidence policy metadata stays available without S3. Bounded personal-memory citation
bodies stay in private PostgreSQL, so memory-only execution and withdrawal checks do
not depend on object storage. Source and connected bodies still require private S3.

PostgreSQL 17 with pgvector stores immutable chunks, full-text indexes and scoped
384-dimensional vectors. `lexical-v1` returns only text matches. `hybrid-v1` uses
the explicitly pinned local BGE release, exact vector search and RRF (k=60),
at most 20 candidates per retriever and five results. Missing semantic runtime
fails visibly; there is no network embedding download or paid/lexical fallback.
The small English benchmark passed twelve held-out positives and three negatives
at 20,000 eligible chunks; measured warm end-to-end p95 was 1,325 ms. These results
do not establish general answer quality or multilingual semantic quality. Lexical
AND matching and the semantic cutoff can miss paraphrased questions against short
policy snippets. The website fixture verifies a reviewed FAQ with explicit question
coverage; it does not prove general retrieval recall.

Each actual retrieval/read operation issues span/hash/date-bound evidence IDs.
Useful tail passages replace prefix context. A bounded continuation reads by
issued evidence ID and UTF-16 offset. Context snapshots persist exact model tool
definitions and selected evidence. Immutable dependency graphs preserve all
influences through history, summaries, specialists, memory proposals and artifacts,
including influences omitted from final citations. Delegated briefs retain their parent input
dependencies separately from the specialist's narrower direct read grants. Derived child
outputs and later memory reuse must still pass the original input policy checks. Shared ancestors deduplicate;
cycles, missing records and conflicting policies fail closed.

Source withdrawal, visibility changes, connection policy and Forget block future
consumption. Model/effect claims recheck current dependencies atomically. A final
answer cannot publish after its source is withdrawn during generation. A consumed dependency
invalidated by withdrawal or Forget ends the current task incomplete; a fresh turn can rebuild
current context without reusing the invalid history. Historical task state and receipts remain,
but current-policy API reads redact unavailable derived output. Browser recovery caches retain
accepted task identities and pending admission inputs rather than accepted transcripts,
derived answers or report bodies. Unsent composer text remains scoped to its account,
workspace, agent and version. Citations
must name supplied evidence; valid provenance does not prove factual entailment.
Report reviewers receive only the prepared report's cited passages. Owner and
visitor passage previews recheck current scope and expose no storage keys.

Connected tools use immutable selected aliases and server-issued public resource
handles. Every read consumes the same root operation budget; credentials stay in
the trusted transport. See [integration boundaries](mcp-integration.md) for protocol,
wire-request bounds and the pending authenticated provider acceptance.

The outbox submits root workflows. Parent workflows submit specialists, while
ordered turns attach to the preceding canonical invocation. Duplicate root sends
resolve the workflow identity before binding it. A submission conflict is not
reported as cancellation.

## Connected reports and automation

`AgentsBusinessRunV10` (`connected-research-v7`) runs the trusted `report-delivery-v1`
workflow after the ordinary agent loop. Required stages select or create a private
report, validate its sources, prepare an exact action packet, wait for human
review, and deliver or reconcile it. A sandbox-enabled report must select one
actual exported artifact by its configured name. Other report agents can publish
their final output as an immutable Markdown artifact. The model cannot invoke
`report.deliver`, select destination URLs or supply credentials.

Connections belong to the organization and initiating account. They select a
server-configured ReportDeliveryHTTP destination/resource, scoped API key and
finite expiry. AES-256-GCM envelopes bind credentials to organization, connection
and credential revision. The keyring stays outside PostgreSQL. Rotation advances
the revision and invalidates pending reviews; old envelopes remain available for
read-only reconciliation of already claimed effects. Redirects are rejected.

The action packet binds immutable task/version/tool/workflow identities, exact
report bytes/digest, destination, connection revision, reviewer and expiry. Human
approval commits once. Dispatch atomically consumes that decision after rechecking
current membership, root authority, connection, report integrity and source fences.
An approval wait holds no provider slot or sandbox, but retains its nonterminal
root slot. Expiry is bounded by 24 hours, root deadline and connection expiry.
Manual approval can refresh an expired, unrevoked grant within its original scope.
One root can prepare one logical delivery. Cancellation before claim prevents the
write; cancellation after claim cannot retract an accepted delivery.

A claimed delivery sends at most one POST. Lost responses trigger bounded status
GETs using the original action identity. An independent reconciler continues
status inspection after task expiry/revocation without renewing write authority.
If no acceptance is observable, the effect stays uncertain; the system does not
promise eventual delivery or blindly resend. The protocol acceptance receiver in
`api/src/acceptance/` persists unique action IDs and receipts across restart. It is
a test destination, not a verified third-party integration. Action and receipt
records have no automatic deletion, exceeding the eight-day replay safety minimum.

Automations have an explicit owner, reviewer, pinned version, bounded input,
30-day maximum authorization and at most 20 accepted occurrences per UTC day.
Their principal remains `automation`; it is never replaced with the owner's human
identity. Each accepted occurrence atomically records its fresh conversation,
grant, task, original root reservation and outbox. Subagents and analysis subdivide
that same root. Personal memory and prior owner conversations are excluded; pinned
organization/agent procedural skills remain available.

`AgentsAutomationV1` uses Restate timers for one-shot UTC instants or anchored UTC
intervals of at least 60 seconds. Downtime coalesces to the latest eligible instant
with a bounded skipped-occurrence summary. At most one occurrence is active per
automation, including review waits; overlap and permission/quota blocks are recorded.
Pause stops future occurrences. Edits pin a new revision for future occurrences;
accepted tasks retain their original authorization. Revoke blocks fresh claims and
requests tree cancellation while existing effects remain reconcilable. Current owner
membership and original authorization expiry are checked at every operation.

Event automations use a revocable per-automation bearer key stored only as a hash.
The API exempts this authenticated endpoint from browser Origin checks; it does not
use cookies for event authority. Event IDs are limited to 128 bytes and data to
8 KiB. An ID plus identical content returns the same occurrence; changed content
conflicts. Event data cannot choose a version, connection, grant or workflow stage.
Keys are returned once; a lost key response requires explicit rotation.

The client exposes Connections, Automations and task details. A configured current
reviewer can inspect and decide an automation's exact report without assuming its
execution identity. Only the owner can stop the task. A reviewer can download the selected prepared report; other private artifacts remain owner-only.

## Verification and release limits

Focused PostgreSQL tests cover memory scope, candidate review, revision conflicts,
forgetting, expiry, source-history deletion, immutable skills, and dispatch locking.
Real MinIO checks cover signed private storage, integrity, lost-response recovery,
and deletion during an upload. The standalone SDK worker check verifies signature
acceptance and denial over HTTP2, including forged invocation requests.

Deterministic provider fixtures exercise model protocol, context, and failure
paths. They do not establish real model behavior. The current real-model browser journey verifies contextual follow-up, approved memory across
conversations, a completed memory.search tool receipt, pinned skills and correction/forget controls.
The website/widget journey and real Keycloak checks remain distinct acceptance paths. Worker signature
fixtures do not certify cluster key distribution or a production deployment.

Public repository reads require no external credential. Keyed Stash and GitHub acceptance remains separately opt-in. Arbitrary destination writes, local-time cron/DST schedules, Lina execution remains unavailable. The external Harbor adapter has controlled FAQ, specialist/research and reviewed-report acceptance; remaining suite criteria stay in Linear. Subagents require explicit published bindings; analysis also requires the pinned backend, resource controls and private storage.
Production rollout, secret management, durable log retention, monitoring, backups,
and signup-email delivery require separate verification. OTLP trace/metric export is explicit
configuration, with local Collector acceptance described above. Services also emit bounded
structured stdout diagnostics.

## Coordination and replica configuration

Dispatch claims use bounded batches (default 32, maximum 128), eight parallel
sends and 120-second leases. Claims use PostgreSQL row locks with `SKIP LOCKED`;
a durable tenant rotation selects bounded per-tenant candidate sets, so an older noisy tenant cannot bury a newly waiting tenant behind its backlog.
Stable Restate workflow keys deduplicate repeated sends after an uncertain response.
Only the current claim owner can persist the invocation binding. Terminal and
deadline sweeps are bounded to 128 rows; continuation publication uses leased claims.

`execution/scheduling/capacity.ts` provides persistent requests, sorted bucket
locks, provisional generation-fenced grants, active holds and a transactional
notification outbox. Operation admission must commit a waiting decision, wait for
its durable notification, then recheck authority before activating a grant.
Active or uncertain provider calls retain their holds until confirmed settlement
or explicit reconciliation. Provisional grants may expire; an expired generation
cannot start a call. No provider wait holds a database transaction.
Each bucket has numbered permit slots with a unique bucket/slot constraint and
database-enforced immutable bounds. Compatible configuration locks and indexed
free-slot claims let independent operations reserve different slots concurrently.
Slot pools grow lazily in batches of at most 32; only pool growth updates its
separate frontier. A failed multi-bucket reservation rolls back all partial claims.
Release clears the matching slot owner and generation with its hold row. Queue
deadlines, provisional expiry and recorded grant delay use the database clock.
Only a promoted queued request publishes a capacity wakeup and grant observation.

`AGENTS_SCHEDULING_POLICY_JSON` contains validated finite operator limits for
product, tenant, workload and provider capacity, queue depth, maximum waiting time,
root admission and daily token allowance. Replica policies must agree: requests
cannot rewrite existing bucket limits. Workload derives from accepted task and
operation metadata. Provider grouping uses the configured `AGENTS_MODEL_ACCOUNT_ID`
(required for production model calls). Connected tools group by their pinned
connection ID unless an operator supplies a verified connection-to-account map in
`AGENTS_PROVIDER_ACCOUNT_MAP_JSON`. Separate connections to the same external
account do not share a provider limit without that map.

List cursors use versioned keys from `AGENTS_CURSOR_KEYS_JSON` (an object of key ID
to a base64url secret containing at least 32 bytes) and `AGENTS_CURSOR_ACTIVE_KEY_ID`.
Production requires explicit keys. Development may derive a separate signing key
from the configured OIDC client secret; isolated tests use a test key. Replicas must
share keys. `AGENTS_CURSOR_MAX_AGE_SECONDS` defaults to 900 and permits 60–86400.
Rotation retains previous key IDs until their issued cursors expire, then removes
them. A cursor binds the principal, filters and snapshot; each read still checks
current authorization. Keys and cursor payloads must not enter logs.

These mechanisms do not establish measured 1,000/10,000 active-agent capacity.
Load acceptance records distinguish admitted, executing and waiting roots and
must report achieved counts and limiting resources separately.

`AGENTS_DATABASE_POOL_POLICY_JSON` declares the total database budget, reserve
and replica count/pool maximum for API, worker, dispatcher, cleanup, evaluation and
migration roles. Startup rejects declared pools whose combined maximum exceeds
the budget. Embedded dispatchers reuse their worker pool. Separate deployments
must declare every replica; this is a configured connection allocation, not
automatic process discovery. Reapers and schema setup use the same role policy.

The controlled acceptance driver is `api/test/scheduling-load.ts`, with separate
API and worker fixture processes in `scheduling-load-process.ts`. It creates only
a uniquely named database/container and disposable principals, uses authenticated
HTTP interfaces and a local HTTP model simulator, and writes measurements under
ignored `.audit/`. Its exploratory direct/tool/delegation/slow mix does not satisfy
the complete workload contract: reports list missing sustained, approval,
ownership and fault-injection scenarios explicitly.

Business operation admission returns a committed waiting decision without creating
an operation or reserving tokens. The workflow waits on a generation-specific
Restate promise and its fixed queue deadline. The notification handler checks the
native request, task and generation before resolving that promise. A queued
operation rechecks grants, ownership, source/memory policy and root limits before
activating its permit. Confirmed settlement releases its holds exactly once;
uncertain settlement retains them. Ordinary capacity waits do not poll every
250 ms. Connected-read reconciliation may separately retry its existing status
check with a bounded durable delay.

Operation start/finish locks the execution root rather than the organization.
Admission and daily quota settlement retain their existing transactional fences;
`maxConcurrentRoots` and `dailyTokenAllowance` come from the validated operator
policy. A provisional permit cannot outlive task cancellation or settlement.
Root admission reads a tenant counter maintained transactionally by task-state
triggers. Children do not consume root slots, and repeated settlement cannot
release the same slot twice.
The scheduler checks conversation authority before taking request/bucket locks,
so a blocked ownership check does not block permit settlement.

Dispatcher routes are keyed by the accepted runtime release. Only explicitly
compatible releases may be claimed. Root submission, continuation, capacity wakeup
and cancellation use the corresponding workflow/ingress/admin route. The default
route serves the current release; unavailable releases remain pending for a
compatible deployment instead of repeatedly consuming a dispatch claim.

## Physical executor routing

Replica deployments configure `AGENTS_EXECUTOR_ROUTES` as a trusted JSON array of
`{id,url,key}` entries and `AGENTS_EXECUTOR_DEFAULT_ID` for new allocations. Keys contain at
least 32 characters and remain in private environment configuration. URLs require HTTPS, except
explicit loopback HTTP for local fixtures. Agents cannot supply routes or signing keys.
`AGENTS_SANDBOX_ENABLED=1` and `AGENTS_DOCUMENT_RUNTIME_ENABLED=1` retain their existing gates.
Without routes, the explicit local backend remains available for single-host development.
It does not qualify as recovery across hosts.

Run each physical host with `node --env-file-if-exists=.env --import tsx src/composition/executor.ts`
from `products/agents/api`, or its compiled `dist/composition/executor.js` entry. Set
`AGENTS_EXECUTOR_ID`, `AGENTS_EXECUTOR_KEY`, `AGENTS_EXECUTOR_JOURNAL_DIRECTORY` and
`AGENTS_EXECUTOR_PORT`. The default bind is loopback. A non-loopback deployment requires a private
TLS endpoint and restricted network access. Each host has its own persistent sandbox/document
cache directories and command journal. Preserve the journal across process restarts. A kernel lock
rejects a second process using that directory, and a durable database identity rejects rebinding
the same executor ID to a fresh directory. Replacing a machine requires a different executor ID.

Signed internal commands bind resource kind, allocation, owner, generation, command identity and
body. Physical handlers recheck current ownership around transitions. Native allocation records
and durable local command intents retain uncertain starts. Status, cleanup and receipt recovery
route to the recorded owner even when the caller has a different local directory. Expired leases
prevent starts but do not release uncertain physical capacity. `AGENTS_EXECUTOR_MAX_ACTIVE`
defaults to two allocations and accepts integers from one through sixteen. Short capacity
transactions finish before any systemd or runtime wait. Command bodies and responses are bounded
at 20 MB; metadata probes share bounded short-lived results.

Transfer requires the original host to prove the allocation stopped, then a generation CAS.
Transfer does not resume an old command on the destination. Stale start, status and cleanup calls
are rejected by the original physical handler. An unreachable original host remains uncertain;
local file absence and lease expiry do not authorize replacement. The bounded reaper also finds
expired owner claims created before native admission; it releases them only after the recorded
host confirms its physical unit is absent or stopped. Keep allocation directories,
command intents and the physical identity file until their uncertainty is resolved. The command
journal is private operational evidence and may contain bounded tool inputs/results. It is not
ordinary telemetry. Remove a disposable fixture's journal after review and teardown; production
journal archival/retention remains a deployment requirement.

`AGENTS_EXECUTOR_VERIFY=1` enables the independent-process acceptance in
`test/resource-executor-process.test.ts`. It uses actual rootless gVisor, distinct physical
executor directories, process death/restart, original-owner sandbox receipt recovery, document
parsing and remote cleanup, confirmed transfer, and stale physical-handler denial. It owns a
fresh database and temporary directories. Protocol tests additionally cover signed-body tampering,
lost acknowledgements, bounded capacity after lease expiry, physical launch/quiescence races and
rejected identity rebinding. Existing sandbox/document safety suites retain their real no-network,
resource-limit and pinned-profile checks. No guest helper/profile bytes changed in this routing
update. These bounded fixtures do not establish 1,000/10,000-root production capacity.
