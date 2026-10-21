# Implementation boundary

Owner: Agents engineering. Last reviewed: 2026-10-20.

Agents is a fresh standalone product. Its API and business worker use the dedicated
`agents_platform` PostgreSQL schema. Setup loads the ordered SQL files in
`api/schema/` into a fresh database and checks their combined digest on subsequent
startup. It does not migrate an older database or import Growth state.

## Product scope and implementation gaps

Model-provider contracts and a reviewed JSON registry now exist under `api/src/contracts/`
and `api/src/adapters/models/`. Registry records cover twelve providers and remain marked
`planned` until adapter conformance establishes support. Shared messages no longer depend on
the business adapter's file. The running agent configuration and model loop still use their
existing OpenRouter/Nemotron route; the new registry alone does not enable another provider.

Authenticated organization routes at `/api/organizations/:organizationId/model-providers`
now save labeled provider accounts, list public metadata, rotate keys, revoke access and
remove accounts. Only owners manage secrets. The existing encrypted vault keyring backs a
separate model-credential domain bound to tenant, connection, endpoint, protocol and revision.
Endpoint changes require a new key. Revocation removes encrypted key material and revokes use
grants; reconnecting does not revive those grants. Physical-call credential resolution checks
the exact consumer, model, role, provider definition and current revisions. It never consults
an environment key as fallback. Discovery and inference verification remain separate work;
new connections report `saved`, not verified inference.

Schema039 adds dedicated model connection, credential and use-grant tables. Setup retains its
fresh-database/checksum contract; existing databases are not silently rewritten. The routes
reuse `connection.lifecycle` telemetry with the bounded `model_provider` provider label.
Credential values and request/provider bodies are excluded. No new analytics event or exporter
configuration is introduced. Disable new routes/dispatch to stop setup; preserve non-secret
historical records for receipt attribution. No production rollout has occurred.

The [target product](architecture/agent-platform-architecture.md#standalone-agents-product)
offers mostly plug-and-play customer-service, FAQ, booking, and intake agents, with connected
customer channels and a shared staff inbox. Growth and Agencies own research, campaign, content,
and agency experiences using the shared execution backend. Shared runtime capability tests do
not establish those offerings in the standalone Agents catalogue.

The current application creates grounded FAQ or customer-service agents from the offering catalogue.
The chosen offering is stored on the agent. Offering names remain separate from execution programs.
The standalone Booking creation choice remains unavailable. Customer-service agents can explicitly
configure Google Calendar appointments, and other agents can open optional setup through Tools.
Direct agent chat and principal-scoped conversation history are implemented. Customer website
messages have a separate canonical timeline with staff assignment, human takeover/replies,
resolution and explicit return to automation. Human-owned ingress does not admit model work.
Returning control admits only a new visitor message. Generation checks suppress late automated
output and fence subsequent operations, including inherited specialist authority.
The automation occurrence inbox below is an event deduplication mechanism, not a customer inbox.

Inbox conversation lists order by `updated_at DESC, id DESC` using the existing tenant/activity
index. Shared versioned cursors retain the exact timestamp and identity and bind the workspace,
actor and filters; they do not look up mutable anchor rows. An activity change after the cursor
snapshot appears on a fresh list read.

Staff and visitor timelines expose at most 100 messages per read. Earlier messages and Latest
messages replace the current page. Polling rechecks that page's current evidence policy; request
identity includes the conversation and selected page so delayed results cannot replace another
view. No unbounded browser history merge retains withdrawn output. `nextSequence` is the last
returned message for bounded `after` reads; `latestSequence` is the canonical conversation
watermark regardless of the selected page. `earlierBefore` identifies the next older page.

Visitor chat instances and pending-send storage bind both deployment and visitor token. Route
changes withhold the prior deployment's view while the new session initializes. A late send
acknowledgement from an unmounted session cannot clear another session's pending input.

Website publication and widget conversations exist. WhatsApp, Facebook, and Instagram remain
unavailable. Google Calendar appointments use their own reviewed service policy rather than a
personal generic binding. The Tools catalogue exposes built-ins, native API and MCP integrations,
agent-specific recommendations, and current connection readiness. Custom MCP setup supports encrypted
keys, resumable OAuth, discovery, compatible tool selection, credential rotation, and disconnect.
Selection creates immutable executable bindings for operator runs. Endpoint discovery or OAuth alone
does not grant an agent access. Native API import previews OpenAPI operations or an advanced structured request editor and authentication
alternatives before explicit credential and operation selection. Generic writes require exact review.
MCP resources, fixed template instances and prompts use the same immutable bindings, execution
grants, controller, budgets, private receipts and evidence as connected tools. Exact URI/prompt
handles are selected explicitly; template values and the SDK-expanded URI are pinned together.
Resource URIs never become network or local filesystem destinations. Prompt activation requires
exact single-use approval; returned roles remain external tool-result data. Reviews show readable
target names and evidence records the actual RPC method. No prompt becomes an installed skill.
The bounded category/authority-keyed MCP descriptor cache has a maximum 30-second metadata TTL, explicit
uncached refresh, and pinned-schema/current-authority checks before each send. It does not claim
persistent change notifications. Live provider OAuth acceptance and verified generic provider
account identity remain separate gates.
Research/report acceptance fixtures prove execution behavior, not a standalone research product.
The runtime's reviewed personal memory does not imply a personal-assistant catalogue offering.

## Customer agent configuration

The customer editor has Tools and Skills catalogues with search, recommendations and explicit
draft selection. Skills include reviewed KasiTek procedures and private SKILL.md/ZIP package
imports, exact public GitHub commit/path imports, file previews, and exact-digest owner review. Complete packages retain immutable files,
source identity and content digests. Private imports require explicit draft selection. The curated Add action installs the official package
and selects its reviewed revision in the unsaved draft. Publication
and runtime loading reject unreviewed packages. Import, installation and review never execute scripts.
Package-based skills load names and descriptions first. Selected agents receive
`skills.activate` and `skills.read` with a separate `skill.read` grant. Activation
loads reviewed instructions; file reads require prior activation. Complete loads
are limited to 4,096 UTF-8 bytes and the current model budget. Larger files fail
explicitly. Exact package/file digests and loaded text survive compaction through
durable receipts. Legacy text revisions retain their existing eager loading.
Tool-directed versions with selected skills and the separately enabled `sandbox.analyze` capability
also expose `skills.run`. The model alias is `skills_run`. Activation is required; loading script
source with `skills.read` is optional. Execution selects an exact reviewed `scripts/*.py` entry,
limited to 16 KiB, and records the package digest, script digest, revision and relative path.
The existing `python-analysis-v1` gVisor runtime stages the complete package read-only under
`/input/skill`. Reviewed sibling modules, package-root modules and packaged resources are available.
The entry runs with Python `-I -S -B`, a fixed wrapper and validated paths passed as arguments.
Package files and authorized artifact inputs share the existing 32-file and 4 MiB input limits.
Current `skill.read`, `sandbox.execute`, `artifact.read` and `artifact.write` grants are required.
Execution uses the original admitted resource-operation deadline and existing root budgets.
No host execution, injected credentials, network access or dependency installation is available.
Other languages and unavailable sandbox backends fail explicitly.
Script receipts and generated artifact dependencies retain the complete package digest through
compaction and continuation. Disabling or removing the package fences launch, later artifact access
and dependent execution. Normal finalization destroys the allocation; the independent reaper retains
cleanup responsibility after worker loss or failed cleanup.
This behavior uses `modular-programs-v5` and `AgentsBusinessRunV15` with a fresh
schema through `038_skill_script_runtime.sql`. An older worker or database is not upgraded in place.
Skill update and rollback select one reviewed revision per publisher/source family. Requirements
recheck existing connections, permissions, and runtime access; they never grant capabilities.
Disabled or removed packages remain immutable records and lose current execution authority.
Skill requirements expose repair actions in the exact revision preview. Connection setup uses the
shared connector flow and returns to that same agent/revision. The owner explicitly chooses current
server-ready bindings, saves the draft, then adds the reviewed skill. Installation never selects a
connection or grants access automatically. Catalogue readiness refreshes after a saved draft revision.
A Python runtime requirement opens contextual General Analysis configuration. This control also appears
when analysis is already enabled; the default FAQ form remains compact. Enabling analysis is a separate
explicit draft change for compatible tool-directed versions. The grounded program cannot enable it,
and the editor does not switch programs. Missing isolation backends still block publication.
Unknown runtimes remain unavailable. Personal-memory, specialist and report configuration remain
outside the customer editor; shared-harness acceptance provisions those capabilities through authenticated APIs.
Website publication permits only enabled, reviewed server-curated instruction packages with their
exact shipped digest. Private and repository packages remain operator-only. Generic personal
connection bindings remain unavailable to website visitors. Google Calendar uses a separate pinned
service policy. Operator chat can publish reviewed procedural skills and selected generic tools.
Customer creation loads the actual catalogue, sends the selected FAQ/customer-service offering and
keeps submission unavailable when catalogue loading fails. Website chat reads the canonical customer
timeline; prior browser output caches are discarded before current-policy reads.

The trusted channel-port acceptance uses normal native human grants and canonical fixture records
for specialist and approved-report takeover races. It proves inherited claim fencing and status-only
reconciliation of a provider-accepted report after takeover. Public website publication still rejects
delegation, analysis and report workflows; those tests do not establish an advanced website offering.

`AGENTS_INBOX_RECOVERY=1` enables `test/customer-inbox-recovery.test.ts` with a fresh database,
owned Restate instance and independent worker processes. It kills the worker during a model call,
then checks queued-root cancellation, stable invocation identity, conservative unknown-outcome
accounting, late-output suppression and canonical human context after restart. Returning control
admits only the next new visitor message; queued and human-owned messages are not replayed.
The controlled local provider records physical calls without external model requests.

## Google Calendar appointment authority

A server-configured Google connector and encrypted vault make connection setup available.
Owners explicitly select a writable calendar and opt into organization service sharing. A booking
policy pins that calendar, owner, policy revision, time zone, duration, notice, advance window,
and opening hours. Selecting a policy changes the agent draft; publication remains explicit.
The separate Booking creation offering remains unavailable. The [integration reference](mcp-integration.md#google-calendar-bookings)
records provider configuration and authority boundaries.

Website proposals belong to the scoped visitor task and current conversation ownership generation.
Exact confirmation is a durable wait. Provider insertion starts only after current authority and
conflict checks. Staff takeover fences subsequent insertion even when a customer already approved.
Confirmed output uses the authoritative receipt. Unknown acceptance remains uncertain and requests
shared Inbox handoff only while the original automated ownership binding remains current. Existing
human ownership is preserved. Staff can inspect the selected conversation's appointment status and
request GET-only reconciliation; staff cannot approve or decline for the customer.
**Check status** uses only a leased provider GET for the deterministic event, never another insertion.
It does not rewrite the original uncertain task outcome. Active claims return `BOOKING_IN_PROGRESS`.
Public booking projections omit private task and Google event identities.

## Published execution and evaluation contracts

Trusted `grounded-conversation` and `tool-directed` program releases share the business loop.
Publication validates exact tool/workflow closure and saves a digest of the effective configuration,
program/runtime releases, context policies, tools and connected bindings. Admission saves that
composition on the task; workers validate it before further execution. Task bindings and published
compositions are immutable. Workspace programs remain unavailable. Google Calendar is the only
implemented booking provider; availability still requires the configured OAuth application and vault.

Execution loading reads current task, version, and connected-binding records and validates their
schemas on every call. A private cache reuses only successful pure composition compilation for
identical validated configuration and full binding content, under the process's fixed compiler
and runtime contracts. It holds at most 128 entries and 4 MiB of serialized key/result content;
oversized entries bypass it. This byte bound does not measure JavaScript heap overhead.
Cached results and compiler descriptors are deeply immutable.
The worker still checks both saved task and root-version compositions on every load. Grants,
source policy, memory, channel ownership, execution availability, and authority decisions are
outside this cache. Cache keys contain configuration content and must never enter logs or
telemetry.

Reviewed report stages live in `workflows/report-delivery/program.ts` and retain digest-bound
approval, one dispatch claim and status-only reconciliation.

Built-in contract JSON schemas are generated once per fixed capability name and stored as
deeply immutable metadata. Their published digests are unchanged. This cache contains no task,
configuration, or live authority state. Operation admission, receipt persistence, and task
settlement read only immutable organization/root keys before locking, then reload and validate
the full execution under the original locks. Current authority and dependency checks still run.

The current source release is `modular-programs-v5` / `AgentsBusinessRunV15`. It requires a fresh
dedicated schema through `038_skill_script_runtime.sql`. Verification uses separate compiled artifacts and databases. Running older local
artifacts are not upgraded by setup or rewritten to accept the new schema.

Each operation journals its physical outcome and attempt identity before a separate durable step
persists its native receipt. Database retries replay the retained result without repeating provider
I/O. A crash before that journal acknowledgement remains uncertain. Receipt persistence verifies
the current attempt, terminal state, output and accounting; a conflicting existing receipt is never
upgraded to success. `AGENTS_OPERATION_RECOVERY=1` enables the actual worker SIGKILL and
PostgreSQL failure cases in `test/operation-journal-recovery.test.ts`.

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

`agents.dispatcher.phase.passes` counts completed dispatcher passes per replica, and
`agents.dispatcher.phase.duration_ms` records their wall time, including pool and network waits.
Their only labels are the five fixed phase names and `ok` or `error`. A successful phase means
its pass resolved, not that every task or provider operation succeeded. These counters and
histograms are process-local, unlike the shared database snapshot gauges.

Connection management emits metadata-only JSON lifecycle logs and separate root OTLP spans
through `observability/connection-telemetry.ts`. Connect, authorization/callback, discovery,
refresh, reconnect, rotation, selection/probe and disconnect records carry a fixed flow/outcome,
elapsed time and trace ID. Existing authorized row reads and mutation `RETURNING` values supply
connection, organization, policy revision and authorization generation when known. Credential
checks are separate from actual refreshes. These flows do not invent task/agent identities or
log URLs, scopes, provider bodies, callback data, credentials or customer text. Generic runtime
task observations retain agent/version/run/operation lineage and the resolved authorization
generation; explicit connected-result latency survives while the enclosing operation is active.

Control-plane export is best effort, with at most 64 pending span exports and a three-second
exporter timeout. It never acquires another database connection or awaits a log/export result
before settling business work. This differs from the durable task observation outbox.
`agents.connection.lifecycle.attempts` and `.duration_ms` are process-local attempt counters and
histograms with fixed provider/flow/outcome/failure-class labels, not authoritative effect counts.
The `agents.connected.provider.attempts` and `.latency_p95_ms` gauges derive from actual persisted
physical receipts over one hour, with bounded provider, phase and response/failure labels; legacy
profiles coalesce into one `other` provider. The [integration reference](mcp-integration.md#connection-observability)
links focused helper, actual OTLP receiver and PostgreSQL producer checks.

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
defines 1,000/10,000 concurrent business-execution targets. The controlled two-replica 1,000 profile
passes its frozen dispatch, child activation, per-tenant, status, and Inbox control thresholds.
It reaches 1,000 simultaneous model HTTP requests and correctly completes 1,000 roots and 100
children, with exact physical-call and effect receipts. Other traffic distributions and fault
profiles require separate results. Four- and eight-replica mixed 10,000-root tests
miss admission, queue, and drain targets within the declared connection budget. The 10,000 target
remains unmet. Queued roots and active provider operations are measured separately. Requirements,
versioned reports, and load acceptance remain in Linear.
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
The current business workflow is `AgentsBusinessRunV15`, with harness release
`modular-programs-v5`. Isolated verification preserves existing running owner services
and their original compiled artifacts.

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
| `product/agents/store.ts` | Product composition facade for the identity, agent, deployment and admission stores. |
| `product/identity/identity-store.ts`, `product/agents/agent-store.ts`, `product/deployments/deployment-store.ts` | Membership and sessions, drafts and immutable versions, and website deployment bindings. |
| `execution/admission/admission-store.ts`, `execution/admission/authority-store.ts` | Shared task admission, root reservations, authority persistence and authorized conversation/event reads. |
| `contracts/programs.ts`, `execution/programs/composition.ts`, `execution/programs/publication.ts` | Trusted program policies, compatible capability/workflow closure and immutable published composition digests. |
| `capabilities/tool-contracts.ts`, `contracts/workflows.ts` | Validated capability inputs/results, authority and resource requirements, and exact workflow confirmation contracts. |
| `product/agents/discovery.ts`, `infrastructure/read-pages.ts` | Principal-scoped agent/conversation/task summaries and signed scope-bound read cursors. |
| `composition/app.ts`, `composition/server.ts`, `adapters/channels/website/widget.ts` | Management and website APIs, continuation, history deletion, progress, cancellation, and widget delivery. |
| `execution/lifecycle/execution.ts` | Current authority, task and operation identities, claims, receipts, and usage settlement. |
| `execution/business/business.ts` | Restate business controller, model and tool rounds, ordered turns, and compaction coordination. |
| `execution/business/model.ts`, `execution/context/context.ts`, `execution/context/continuation.ts` | Provider protocol, conservative request accounting, scoped snapshots, complete message groups and bounded execution checkpoints. |
| `execution/memory/memory.ts`, `product/agents/memory-routes.ts` | Personal memory candidates, authenticated acceptance, revisions, expiry, forgetting, source invalidation, and pinned skills. |
| `infrastructure/object-store.ts`, `execution/artifacts/artifacts.ts`, `execution/artifacts/task-artifacts.ts` | Private S3-compatible content, root/task provenance, explicit transfers, downloads, integrity and deletion. |
| `execution/delegation/delegation.ts`, `capabilities/tool-descriptors.ts` | Published specialist bindings, atomic child admission, bounded results and pinned adapter contracts. |
| `capabilities/sandbox/sandbox.ts`, `capabilities/sandbox/sandbox-executor.ts`, `capabilities/skills/script-runtime.ts`, `composition/sandbox-reaper.ts` | Isolated analysis and reviewed package scripts, immutable script provenance, durable resource/command identities, artifact export and independent cleanup. |
| `execution/lifecycle/dispatcher.ts`, `composition/worker.ts`, `composition/worker-security.ts` | Leased outbox delivery, runtime identity, cancellation reconciliation, request signatures, and worker lifecycle. |
| `execution/scheduling/capacity.ts`, `execution/scheduling/capacity-turns.ts`, `execution/scheduling/dispatch-claims.ts` | Durable resource queues, independent tenant turns, generation-fenced permits and bounded replica claims. |
| `workflows/report-delivery/program.ts` | Durable report review waits, exact dispatch and status-only reconciliation through the shared operation lifecycle. |
| `product/inbox/inbox-store.ts`, `product/inbox/inbox-routes.ts`, `composition/inbox.ts` | Staff authorization, assignment, customer history, ownership changes, human replies and delivery fencing. |
| `observability/event-store.ts`, `observability/observations.ts`, `observability/connection-telemetry.ts`, `observability/telemetry.ts`, `observability/metrics.ts` | Durable typed task observations, authorized reads, replay-safe export, separate metadata-only connection lifecycle traces/logs and bounded receipt/attempt metrics. |
| `product/connections/connections.ts`, `infrastructure/vault.ts`, `workflows/report-delivery/actions.ts`, `adapters/providers/report-delivery.ts` | Scoped encrypted credentials, exact report review, atomic dispatch claims and read-only receipt reconciliation. |
| `product/automations/automations.ts`, `execution/lifecycle/automation-authority.ts`, `product/automations/automation-runtime.ts` | Immutable owner authorization, occurrence inbox, shared admission and Restate UTC timers. |
| `contracts/capability-catalog.ts`, `capabilities/connected-tools/connected-catalog-store.ts`, `capabilities/connected-tools/connected-executor.ts` | Immutable selected tools, executable releases, issued handles and durable connected receipts. |
| `infrastructure/connected-network.ts`, `adapters/providers/github-adapter.ts`, `adapters/providers/stash-adapter.ts`, `adapters/providers/mcp-adapter.ts` | Bounded egress, anonymous/keyed native reads, scoped Stash text and isolated MCP SDK execution. |
| `capabilities/knowledge/knowledge.ts`, `product/agents/knowledge-routes.ts`, `capabilities/knowledge/ingestion-runtime.ts` | Private candidates, owner approval, revision policy and durable import stages. |
| `capabilities/knowledge/document-runtime.ts`, `composition/document-reaper.ts`, `capabilities/knowledge/source-objects.ts`, `execution/artifacts/execution-objects.ts` | Pinned no-network parsing/embedding, physical cleanup and object write/deletion intents. |
| `capabilities/knowledge/retrieval.ts`, `capabilities/knowledge/query-embedding.ts`, `capabilities/knowledge/knowledge-runtime.ts`, `execution/context/evidence.ts` | Scoped lexical/hybrid retrieval, passage references and transitive policy dependencies. |
| `adapters/providers/connector-registry.ts`, `adapters/providers/default-connectors.json` | Validated supported-connector records and installed-handler selection; metadata does not supply executable code. |
| `product/catalogue/`, `product/agents/skill-package-store.ts`, `capabilities/skills/` | Contextual catalogues, immutable skill imports, family revisions, exact review, requirements, and current installation authority. |
| `product/connections/remote-connections.ts`, `product/connections/api-connections.ts`, `capabilities/reviews/tool-reviews.ts` | Generic MCP/API onboarding, selected bindings, and exact tool approval. |
| `product/connections/google-calendar-connections.ts`, `product/connections/google-calendar-oauth.ts`, `adapters/providers/google-calendar.ts`, `workflows/booking/` | Calendar OAuth, explicit service sharing, pinned booking policies, customer confirmation, conflict checks, and GET-only reconciliation. |
| `composition/setup.ts` | Fresh database initialization and schema checks. |

The management client is in `web/`. Its chat, configuration, management and explicit
website-publication paths share these APIs. Growth and Agencies retain independent
membership, permissions, and domain records. Embedded execution remains unavailable.

| User entry point | Current behavior | Verification |
| --- | --- | --- |
| `/` | Restored public landing with provider-backed signup and sign-in. | Public-entry browser tests and isolated actual identity signup/verification. |
| `/app/inbox` | Authorized website assignment, takeover, replies, resolution, explicit return, and scoped appointment status/recovery without customer approval. | Canonical Inbox HTTP/browser, `inbox-bookings.spec.ts`, and durable takeover/status acceptance. |
| `/app/agents` | Compact searchable agent directory with server conversation history. | Chat workspace, discovery and browser regression suites. |
| `/app/agents/:agentId` | Chat, Activity, General/Tools/Skills/Website setup, immutable skill selection, exact-revision requirement repair, contextual compatible Analysis access and optional pinned booking policy. Connect saves draft selections before navigation. | `catalogue.spec.ts`, `skill-requirements.spec.ts`, `bookings.spec.ts`, and actual API `catalogue-live.spec.ts` / `catalogue-execution-live.spec.ts`. |
| `/app/agents/:agentId/conversations/:conversationId` | Authorized history scoped to its original agent and principal, per-turn configuration snapshots, current-policy output and inline report review. | Scope/recovery browser regressions and PostgreSQL history tests. |
| `/app/tasks` | Paginated authorized root tasks, filters and conversation/review links. | Actual PostgreSQL collection tests and browser navigation checks. |
| `/app/settings` | Real account/workspace identity, workspace creation/switching, theme and sign-out. | Settings browser checks and theme tracking regression. |
| `/app/knowledge` | Upload text/PDF/HTML, import one public URL, inspect candidates, approve, adopt revisions and withdraw. | Actual compiled ingestion, crash recovery and responsive browser acceptance. |
| `/app/connections` | Restricted profiles, custom MCP OAuth and separate Tools/Resources/Templates/Prompts selection, native API preview/credentials/selection, and owner-managed Google Calendar sharing. | Connection browser contracts, published controlled MCP/API execution and actual API/controlled Google browser acceptance; live Google OAuth remains pending. |
| `/app/automations` | Pin report versions, authorize UTC/event triggers, inspect occurrences and control future runs. | Actual Restate timer/event HTTP checks and scheduled-report fixture. |
| `/app/tasks/:taskId` | Authorized task detail, exact tool/report review, exact appointment confirmation, and status-only booking recovery. | `tool-reviews.spec.ts`, `bookings.spec.ts`, and real API booking confirmation. |
| External website widget | Public conversation, exact two-step appointment confirmation, and Check status without event resend. FAQ widgets do not fetch bookings. | Generated-script `website-bookings.spec.ts`; actual isolated Restate/PostgreSQL `booking-business.test.ts`. |


### Configuration activation

`POST /api/organizations/:organizationId/agents/:agentId/configuration` accepts
`configuration`, `expectedRevision`, optional `name`, and optional `confirmImpact`.
It returns `{agent,snapshot,deployments}`. Optimistic revision checks reject stale
editors. A save requiring channel or authority confirmation returns
`CONFIGURATION_CONFIRMATION_REQUIRED` before mutation. No-op saves reuse the current
snapshot. Invalid snapshots or unsafe public deployment settings roll back together.
Deployment IDs and origins stay stable. Evaluation-owned deployments do not advance.

Ordinary `POST /tasks` accepts `agentId` instead of `versionId`. Current snapshot
selection, grant creation and admission share the organization transaction lock with
configuration saves. A request may instead supply an explicit `versionId` for
product/evaluation tooling; supplying both selectors is invalid. Isolated evaluations
require explicit snapshots. New website connections omit `versionId` and use current
saved settings; the explicit publication contract remains available internally.

Existing conversations can span configuration snapshots. Their agent, tenant, principal,
channel session and human ownership boundaries remain fixed. Customer conversation
bindings remain immutable; each persisted task link proves its turn's snapshot.
Ordinary settings changes preserve accepted turns. Reduced authority revokes old grants,
and historical snapshots cannot mint removed permissions or larger budgets. Current
connection, source, skill and Inbox authority checks still apply to every operation.

### Chat navigation and recovery

Every available customer agent opens Chat. Configure contains General, Tools, Skills, and Website
sections with knowledge pins, optional appointments, package review, and explicit publication.
Developer and product fixtures configure specialists, analysis, reports, and personal memory through
authorized APIs. Save changes validates, snapshots and activates configuration atomically.
Numbered versions are internal provenance, not a normal client workflow. Existing conversations
use current saved configuration for their next turn; accepted turns retain their snapshot.
Retries recover the original task across saves without reserving another grant or budget.
Connection setup may persist an incomplete draft, which remains pending until Save changes.
The collapsed configuration history loads a prior configuration for a fresh validated save.

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
knowledge. Personal memory, memory tools, generic personal bindings, and private or repository skills
are denied for website publication and execution. Exact reviewed server-curated instruction packages
and a separately pinned Google Calendar service policy have explicit public authority contracts.

Provider requests use the explicitly selected Nemotron route through OpenRouter:
`nvidia/nemotron-3-super-120b-a12b` (paid, the default for new drafts), or
`nvidia/nemotron-3-super-120b-a12b:free`. Published versions retain their selected
route; execution never silently switches a free version to paid. Both routes use
the same approved tokenizer and accounting profile, with provider fallback disabled
and reasoning effort `none`. The canonical response model alias is accepted only
for this exact approved model. Input preflight conservatively
counts serialized UTF-8 bytes against the configured token allowance and reserves
framing separately. This estimate is not an exact tokenizer count. Returned usage,
finish reasons, tool calls, and unexpected reasoning are validated.

HTTP 401, 402, 403, 404 and 429 produce bounded authentication, billing, access,
availability and rate-limit error codes. Provider response bodies are not exposed
to users or logged. Other rejected requests and uncertain outcomes remain distinct;
uncertain generation is not retried automatically.

## Authorized discovery and history

Authenticated collection routes use explicit summary objects rather than task or
agent configuration records. All routes below are beneath
`/api/organizations/:organizationId`; each request checks current membership.

| Read | Response and order |
| --- | --- |
| `GET /agents/summaries?q=...` | `{agents,nextCursor}`; compact roster with latest immutable version, draft revision and unpublished-change state. Newest-created first, ID tie breaker. Optional trimmed `q` (maximum 120 characters) searches the complete roster by case-insensitive literal name substring before paging. The existing `/agents` management response is unchanged. |
| `GET /conversations?agentId=...&versionId=...` | `{conversations,nextCursor}`; `agentId` required, version filter optional. The exact human issuer/subject, Agents product, execution caller and agent scope must match. Activity descending, conversation ID tie breaker. |
| `GET /tasks?agentId=...&state=...` | `{tasks,nextCursor}`; optional agent/state filters. Root tasks only, newest-created first, task ID tie breaker. Human tasks require exact principal; automation tasks require a current owner membership and either that owner or the pinned occurrence reviewer. |
| `GET /conversations/:conversationId` | `{tasks,nextCursor,conversation}`; newest page of turns in ascending display order. Prepend subsequent pages to load older turns. Conversation metadata identifies the latest turn snapshot and task/turn IDs independently of the selected page; each task retains its own snapshot. |
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

Connected reads retain an immutable claim token and deadline derived from the original
operation, binding and task limits. A concurrent caller follows the live claim without
adopting it or sending another request. An expired or orphaned claim becomes uncertain;
expiry never authorizes another provider request. Attempt admission and result publication
check the token, state and database deadline atomically. Late physical receipts remain
facts, while late result publication is refused. Provider waits retain no transaction or
session-lock connection. Evidence checks inside an existing transaction use its client.

The outbox submits root workflows. Parent workflows submit specialists, while
ordered turns attach to the preceding canonical invocation. Duplicate root sends
resolve the workflow identity before binding it. A submission conflict is not
reported as cancellation.

## Connected reports and automation

`AgentsBusinessRunV15` (`modular-programs-v5`) runs the trusted `report-delivery-v1`
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

Public repository reads require no external credential. Keyed Stash and GitHub acceptance remains separately opt-in. Model-chosen destinations, local-time cron/DST schedules, and Lina execution remain unavailable. The external Harbor adapter has controlled FAQ, specialist/research and reviewed-report acceptance; remaining suite criteria stay in Linear. Subagents require explicit published bindings; analysis also requires the pinned backend, resource controls and private storage.
Production rollout, secret management, durable log retention, monitoring, backups,
and signup-email delivery require separate verification. OTLP trace/metric export is explicit
configuration, with local Collector acceptance described above. Services also emit bounded
structured stdout diagnostics.

### Catalogue and booking release record

| Field | Decision and evidence |
| --- | --- |
| Change | Contextual Tools/Skills catalogues, immutable package lifecycle and approved isolated Python execution, generic MCP/API selection and exact review, skill requirement repair with contextual compatible Analysis access, Google Calendar policy and customer booking confirmation. |
| Owner | Agents engineering. |
| Risk | High: encrypted provider credentials, external writes, visitor identity, and durable recovery. |
| Affected services and surfaces | Agents API, business worker, PostgreSQL, management editor, Connections, task activity, website chat and generated widget. Other channel providers are unchanged and unavailable. |
| Platform release version or ID | Runtime `AgentsBusinessRunV15` / `modular-programs-v5`. Canonical platform `VERSION` remains `0.1.0`; no production release tag or promoted deployment is claimed. Runtime, schema, and customer-created version identities remain separate. |
| API/schema changes | Fresh ordered schema through `038_skill_script_runtime.sql`; 028–038 add remote connections, skill packages/runtime/state, tool review, native API operations, Google OAuth/calendar policy, booking records, the V15 task default, immutable Google connector-definition pins, and immutable skill-script execution provenance. Setup validates the complete schema digest and does not migrate an existing owner database. |
| Rollout method | Explicit provider configuration, owner connection and service-sharing consent, exact skill review, draft selection, immutable publication, exact customer confirmation, and separately enabled isolated analysis for package scripts. Missing Google configuration is unavailable. The standalone Booking offering remains disabled. |
| Analytics and success criteria | New product analytics events: not applicable. Fixture success criteria are one insertion per approved appointment, zero pre-confirmation inserts, correct current-policy denial, no insertion during status recovery, one sandbox command per admitted script operation, exact package provenance, current withdrawal denial, and resource cleanup. Adoption analytics and production alerting are not established. |
| Logs, metrics, dashboards, alerts | Existing bounded `agent.observation.v1` and task events include `tool.booking_availability`, `tool.booking_claimed`, `tool.booking_result`, and `tool.booking_reconciled`. Skill execution reuses bounded tool observations, native operation receipts and sandbox allocation/command status; schema038 records immutable package/script provenance. Metadata excludes credentials and full arguments. Collector revision and endpoint changes: not applicable; existing exporter configuration applies. Release identity is the accepted V15 composition. Bounded metadata projection provides the source-level redaction boundary. Production dashboards, alerts, retention, and hosted OTLP signal acceptance remain unverified. Disable the existing exporter to stop telemetry delivery without changing operation receipts. |
| Documentation | Current README, implementation/feature map, architecture, integration boundary, threat model, and runtime reference updated together. No new planning document. |
| Validation evidence | Actual isolated PostgreSQL/Restate/API/independent-worker booking acceptance in `api/test/booking-business.test.ts`; controlled signed OIDC/provider integration tests; actual API browser in `web/test/catalogue-live.spec.ts`; generated widget with controlled HTTP endpoints in `web/test/website-bookings.spec.ts`; responsive management/approval regressions. `skill-requirements.spec.ts` verifies connection repair, explicit binding adoption, compatible Analysis opt-in and grounded-program denial. `catalogue-execution-live.spec.ts` verifies published controlled MCP/API execution and real API skill requirement repair. Real gVisor package execution in `api/test/skill-script-runtime.test.ts`, existing independent-cleanup suite in `api/test/platform-sandbox.test.ts`, and published activation/script/final-answer acceptance in `api/test/platform-business.test.ts`. See coverage below. |
| Rollback or disable | Withdraw the booking policy or disconnect access to block future effects; disable/remove skill installations or rotate/revoke selected connections as applicable. Preserve immutable versions, receipts, original uncertain outcomes, key access, and accepted worker artifacts. Status recovery still requires current permitted authority. Do not downgrade a V15 task to an incompatible worker or reverse the fresh SQL in place. |
| Post-release review | At the first staging promotion and before enabling a live Google OAuth application. No production release date is assigned. |

The real isolated booking journey verifies a durable pending visitor proposal with zero insertion,
worker SIGKILL and a new process, the same accepted Restate invocation, exact scoped confirmation,
one provider event, and receipt-backed customer output. It also verifies cross-visitor denial,
Inbox takeover before insertion, explicit return with a new ownership generation, automatic handoff
for uncertain booking outcomes, and GET-only recovery by the scoped visitor or staff conversation.
Same-organization unrelated conversations expose no borrowed booking, and takeover after provider
acceptance preserves human ownership and the original uncertain operation. The provider and model are controlled HTTP fixtures.
The separate Google OIDC tests use a controlled signed issuer, not Google's live authorization system.

The actual API browser verifies curated/private package review and publication, same-family
revision comparison and lifecycle changes, native operation bindings, Google connection callback,
calendar selection and sharing, policy draft pins, and operator confirmation. Its external OAuth
navigation and Google HTTP responses are explicit fixtures. The generated widget tests use the
actual emitted script over HTTP with controlled public endpoints; they verify exact two-step
confirmation, expiry, status-only recovery, and stable focus at 1440, 768, and 390 pixels.
These layers establish local contracts, not a live Google calendar account or production readiness.

The separate five-case `catalogue-execution-live.spec.ts` browser suite uses the real API, vault,
fresh PostgreSQL database, private MinIO bucket, isolated Restate container and independent worker.
Its model, MCP/API providers and OAuth authorization server are controlled HTTP fixtures; no paid
model or live provider account is used. It verifies URL discovery and explicit selection, immutable
publication, normal chat execution with exact approval, credential replacement and reselection,
provider-expiry uncertainty, disconnect fencing, full-page OAuth cancellation and cross-tab consent,
and one-use callbacks. The skill case imports and reviews a package, returns from connection setup
to the exact revision, explicitly adopts bindings, saves, adds the skill and applies the configuration with Save changes.
Separate resource/template/prompt selections execute through that same normal workflow; template
values pin the exact URI. The final run passed five cases and checked seven completed private receipts
with seven successful approved provider invocations. The expired native credential produces an
additional denied HTTP request and an uncertain operation without a completed provider receipt;
discovery and OAuth traffic are outside this successful-effect count. The fixture cleans only its
own services and database.

Skill repair and typed MCP selection also have mocked transport regressions. Catalogue checks passed
thirteen cases. The final remote-picker and requirement-repair check passed fourteen cases, including
readable requirement labels, grounded-program denial, reloaded typed categories and disabled unsupported
tool/template rows with server-supplied reasons. Inventory rows cannot create executable bindings.
The repair and template forms were checked at 1440, 768 and 390 pixels. Compatible Analysis enablement
and grounded-program denial are browser contracts; real isolated Python execution is established by
the separate gVisor/Restate tests below, not by the controlled connection browser suite.

With `AGENTS_TEST_DATABASE_URL` configured for disposable database creation, the durable
booking acceptance runs from the repository root:

```sh
pnpm --filter @kasitek/agents exec vitest run test/booking-business.test.ts test/booking-workflow.test.ts test/google-calendar.test.ts test/google-calendar-connections.test.ts
```

Live Google consent and token refresh against a configured application, production credential
operations, hosted observability, and other channel/provider journeys remain separate gates.
MCP resources and prompts have separately selected execution scopes. Directory reads returning
unselected URIs, reserved template expansion operators and unsupported client capabilities remain
unavailable. Package import remains inert; explicit approved Python execution uses the existing isolated sandbox.

Approved package execution was verified with fresh disposable databases, a separate Restate container
and test allocation directories. The affected check passed 14 cases: five script authorization/execution
cases, seven real gVisor lifecycle cases, and two published skill/compaction cases. The Python case executes
a script larger than 4 KiB without a script-read call, imports reviewed helpers, reads packaged data,
exports a receipt-backed report and destroys its allocation. Withdrawal before guest launch prevents
execution; withdrawal afterward blocks artifact access. Typecheck, dependency-cycle checks and product
boundaries passed. These checks do not establish production sandbox availability or operational certification.

With the local isolated sandbox prepared and `AGENTS_TEST_DATABASE_URL` set for disposable database creation:

```sh
AGENTS_SANDBOX_VERIFY=1 pnpm --filter @kasitek/agents exec vitest run test/skill-script-runtime.test.ts test/platform-sandbox.test.ts test/platform-business.test.ts
```

## Coordination and replica configuration

The live dispatcher runs five independent bounded loops on its existing pool: root dispatch,
capacity grants, capacity notifications, controls, and reconciliation. Each loop has at most one
pass in flight. Successful root-dispatch and capacity-notification acknowledgements, and committed
capacity grants, rejections or expired-generation transitions, count as progress. Productive passes
in these three loops await `setImmediate` and continue with another bounded pass. Cursor movement,
skipped locks, rolled-back changes, unsuccessful reservations and HTTP responses without a native
acknowledgement do not count. Idle and failed passes wait one second. Controls and reconciliation
remain periodic. Slow maintenance does not prevent the next root batch from being claimed.
Shutdown wakes idle loops, checks stop after each yield and awaits every in-flight batch before
closing the pool. A batch drains its workers before throwing. The one-shot `dispatchTasksOnce`
entry still awaits all phases in order.
Dispatch rotation uses `scheduling_tenants`; capacity rotation and resource cursors use
`capacity_tenants`. Organization registration creates both rows atomically. Their locks are
independent, so maintenance of one turn cannot block or suppress the other scheduler.

Dispatch claims default to batches of 32, eight parallel sends, and 120-second leases.
Operators can set `AGENTS_DISPATCH_POLICY_JSON`, for example
`{"batchSize":128,"parallelism":32,"leaseMs":120000}`. The worker validates this setting
before opening its database pool or HTTP listener. Unknown fields, malformed JSON, and values
outside the bounds fail startup without echoing the configuration. Batch size is 1–128,
parallelism is 1–32, and lease duration is 30–300 seconds. This policy does not increase the
database connection budget. The controlled load fixture explicitly selects 128/32 through
the same loader; those results describe that profile, while an unconfigured worker uses 32/8.
Phase duration metrics include SQL and HTTP waits but exclude the idle backoff and the event-loop
yield between passes.

Claims use PostgreSQL row locks with `SKIP LOCKED`;
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
Only the first insertion of a request can seek direct admission, which yields to older eligible
waiters across tenants. Replaying a waiting request returns its durable waiting decision.
Scheduled promotions use durable tenant rotation, then a cyclic resource class and provider
account turn. Classes are model, connected, local and generic. One class cursor and three provider
cursors per tenant record assigned opportunities. A failed reservation or crash after assignment
can consume an opportunity. This does not promise equal grants or a wall-clock service bound.

Fresh schema `021_scheduling.sql` derives class and account from exactly one native provider
bucket with a recognized class and 40 lowercase hexadecimal characters. Missing, malformed or
mixed provider keys map to one generic queue. Generated columns cannot accept caller overrides.
An insert trigger derives immutable organization identity from the task and a composite foreign
key enforces it. Tenant/class/account indexes support cyclic account seeks without grouping the
platform backlog. Scheduled predecessor checks use the selected tenant and exact resource queue,
including the single generic queue. Interactive requests use creation time; other workloads add
five seconds. Every grant still rechecks current authority, deadlines, generation and all shared
bucket limits before reserving slots atomically.

Each capacity sweep selects two independently bounded sets within its tenant rotation: the
due prefix for authority and expiry housekeeping, and waiting requests within the assigned
resource queues for promotion. Eligibility precedes the promotion ranking and cutoff. Availability
checks use only bucket keys referenced by the selected tenants' due requests. Availability means
an unowned slot or room to grow the slot frontier; the final atomic reservation rechecks it.
Expired provisional grants remain in housekeeping even when their own holds fill their buckets.
Housekeeping alone cannot promote valid waiting work. Deduplication preserves promotion intent
when both sets select a request. Expired provisional holds release their slots and requeue under
a new generation and the original deadline. A later pass can promote that generation. Replaying
an expired grant also returns waiting after this transition, without an immediate direct regrant.
The sweep deduplicates both sets, so it attempts at most twice its configured limit, 128 requests
at the default limit of 64. Candidate transactions run with at most four workers and at most half
the configured pool size, rounded down with a minimum of one. Errors are rethrown only after
all workers drain. When the pool allows at least two candidate workers, one blocked authority
check cannot serialize every unrelated candidate. Smaller pools retain serial sweeps. These
bounds add no database connections.
Candidate output limits do not bound all scan work. The due set still materializes selected
tenants' pending backlogs, and promotion ranking sorts the selected queues. Account seeks use the
queue index, but only measured workloads establish the total scheduling cost.

`AGENTS_SCHEDULING_POLICY_JSON` contains validated finite operator limits for
product, tenant, workload and provider capacity, queue depth, maximum waiting time,
root admission and daily token allowance. Replica policies must agree: requests
cannot rewrite existing bucket limits. Workload derives from accepted task and
operation metadata. Provider grouping uses the configured `AGENTS_MODEL_ACCOUNT_ID`
(required for production model calls). Connected tools group by their pinned
connection ID unless an operator supplies a verified connection-to-account map in
`AGENTS_PROVIDER_ACCOUNT_MAP_JSON`. Separate connections to the same external
account do not share a provider limit without that map.

`localProviderActive` optionally sets the deployment-wide bound for the existing local-provider
bucket. Without it, local operations use `providerActive`, preserving the configured fallback.
Model and connected-provider buckets still use `providerActive`. Local operations include
knowledge, memory, delegation admission, sandbox work, report preparation and built-in report
delivery; this is not a database-only limit. Product, tenant, class and workload bounds still apply.
All replicas must agree on existing immutable bucket limits. A mismatched request fails with
`CAPACITY_POLICY_CONFLICT`; requests cannot resize live buckets.
A queued operation has no operation record or active-time reservation yet. Its recorded capacity
and task deadlines continue to apply. After activation, its original execution timeout includes
pool waits and is never reset. A delegation operation releases its permit after child admission,
before the parent waits for child results.

The controlled load tool preserves its default `baseline` resource allocation. The explicit
`AGENTS_LOAD_RESOURCE_PROFILE=bounded-local` profile sets local-provider concurrency to 64
and, with four replicas, uses six API and eight worker connections per replica under an
80-connection declared budget. Its report counts the shared eight-connection driver/snapshot
pool once and the one-connection administrator pool once, alongside process pools and reserve.
The profile preserves arrival rates, operation delays, runtime CPU/memory limits, task deadlines,
queue thresholds and drain limits. A profile setting alone establishes no capacity claim.

List cursors use versioned keys from `AGENTS_CURSOR_KEYS_JSON` (an object of key ID
to a base64url secret containing at least 32 bytes) and `AGENTS_CURSOR_ACTIVE_KEY_ID`.
Production requires explicit keys. Development may derive a separate signing key
from the configured OIDC client secret; isolated tests use a test key. Replicas must
share keys. `AGENTS_CURSOR_MAX_AGE_SECONDS` defaults to 900 and permits 60–86400.
Rotation retains previous key IDs until their issued cursors expire, then removes
them. A cursor binds the principal, filters and snapshot; each read still checks
current authorization. Keys and cursor payloads must not enter logs.

Scheduling mechanisms alone do not establish capacity. The controlled 1,000 profile has separate
passing evidence; the 10,000 target remains unmet. Load records distinguish admitted, executing and waiting roots and
must report achieved counts and limiting resources separately.

`AGENTS_DATABASE_POOL_POLICY_JSON` declares the total database budget, reserve
and replica count/pool maximum for API, worker, dispatcher, cleanup, evaluation and
migration roles. Startup rejects declared pools whose combined maximum exceeds
the budget. `acquireTimeoutMs` defaults to 5000 and accepts a finite 100–120000ms
operator setting. It bounds waiting for a connection; SQL statement and query deadlines
remain 15 and 20 seconds. Embedded dispatchers reuse their worker pool. Separate deployments
must declare every replica; this is a configured connection allocation, not
automatic process discovery. Reapers and schema setup use the same role policy.

The controlled acceptance driver is `api/test/scheduling-load.ts`, with separate
API and worker fixture processes in `scheduling-load-process.ts`. It creates only
a uniquely named database/container and disposable principals, uses authenticated
HTTP interfaces and a local HTTP model simulator, and writes measurements under
ignored `.audit/`. `AGENTS_LOAD_FULL=1` runs the versioned `scheduling-workload.v3.json`
contract: 30 seconds of steady arrivals, a 10-second burst, then at most 120 seconds
of drain. It includes approved-source FAQ evidence/citations, memory tools, delegated
children, delayed report review and actual receiver receipts, plus canonical website
claim/takeover/reply/return and reconnect controls. Owned local object storage and a
pinned actual Collector supply evidence without using paid model providers.

`AGENTS_LOAD_ROOTS` accepts 100, 1000 or 10000; `AGENTS_LOAD_REPLICAS` accepts 1, 2,
4 or 8. `AGENTS_LOAD_SINGLE_TENANT=1` and `AGENTS_LOAD_NOISY=1` select the tenant
pressure cases. `AGENTS_LOAD_FAULT` selects duplicate-messages, worker-loss,
provider-throttle, collector-outage, lease-expiry or reconnect. A selected fault that
was not injected is reported as unmet. Expected uncertainty and provider failures
remain visible rather than being rewritten as completed outcomes.
The current manifest also grades each configured tenant's status and dispatch latency,
requires actual probe coverage, checks each control tenant, and audits canonical messages
after drain for stale-generation assistant deliveries. Fault reports retain injection and
restoration times and require native reconciliation within 30 seconds; worker-loss
uncertainty remains a separate outcome. Previous manifest results are not retroactively
claimed to meet these newer fairness and recovery criteria.
Root dispatch uses root outbox timestamps. Children use admission to first native operation as
a conservative activation bound, graded separately against 30 seconds. Every child requires a
sample except a confirmed cancellation before any native operation. A child that starts and is
later cancelled still counts. Legacy child outbox cleanup times are retained as ungraded
metadata because they include execution time. Bounded native phase records correlate admission,
context, capacity request/grant, notification, native operation, and physical request timestamps.
Physical model requests are matched to native operation/attempt identities by exact provider
response IDs and canonical serialized request digests. Fault fixtures additionally resolve the
unique native context digest before local dispatch; missing or ambiguous attribution fails.
Receiver verification compares action/task/root/artifact identities, approved payload and byte
digests, native receipts and actual POST audits. Equal aggregate totals cannot establish success.
Parsed Collector span/trace/observation identities and metric names are retained as bounded local
metadata before owned containers are removed. Verifier calibration rejects substituted effects,
stale attempts, repeated physical requests, unexpected failures and missing safety evidence.

`AGENTS_LOAD_BARRIER=operations` holds actual model HTTP responses until the
configured simultaneous active-operation target is reached or the finite hold expires.
It records actual nonterminal roots and active requests separately before release.
This is a separate concurrency dimension from steady mixed traffic. Restate profiles
are explicit TOML files; each run saves the server's actual dumped configuration.
The 10000 profile uses a 1536MiB Restate container with an invoker limit of 10000
and a 60-second database acquisition wait. Worker heaps are 1024MiB with fewer than eight
replicas. The eight-replica comparison uses 512MiB worker heaps, 256MiB API heaps, and requires
at least 8GiB available host memory before startup. Each API pool has one connection and each
worker pool has four, retaining the four-replica profile's 32 worker connections. Driver,
migration, and reserve allocations bring the eight-replica declaration to 54 connections.
All replica pools must fit the declared 60-connection budget. These local profiles do not establish
production sizing, high availability or real-provider limits. Reports retain executable
source hashes, pool/lock/resource measurements, all failures and missing dimensions.

Diagnostic CPU profiling is separate from acceptance. The following fixture command enables
internal inspector sessions on API0 and worker0 only, without a debugger port or heap snapshots:

```sh
AGENTS_LOAD_FULL=1 AGENTS_LOAD_ROOTS=10000 AGENTS_LOAD_REPLICAS=4 \
AGENTS_LOAD_DIAGNOSTIC_PROFILE=1 \
node --env-file=products/agents/api/.env \
  --import ./products/agents/api/node_modules/tsx/dist/loader.mjs \
  products/agents/api/test/scheduling-load.ts
```

Sampling starts 20 seconds into the workload and stops after 30 seconds, at a 1ms interval.
Profiles are saved under `.audit/agents-load-profile-<run UUID>/`. The run report's
`profiling.evidence` contains bounded query-family counts, totals, maxima, and histogram-based
latency bounds. It contains no SQL text or parameters. These client timings include response
handling and do not isolate database server execution time. The diagnostic snapshot omits the
120-second drain, retains unfinished outcomes, sets `diagnosticOnly=true` and
`acceptanceEligible=false`, and intentionally exits with code 2. It cannot qualify a load target.

Business operation admission returns a committed waiting decision without creating
an operation or reserving tokens. The workflow waits on a generation-specific
Restate promise and its fixed queue deadline. The notification handler checks the
native request, task and generation before resolving that promise. A queued
operation rechecks grants, ownership, source/memory policy and root limits before
activating its permit. Confirmed settlement releases its holds exactly once;
uncertain settlement retains them. Ordinary capacity waits do not poll every
250 ms. Connected-read reconciliation may separately retry its existing status
check with a bounded durable delay.

A known provider outcome is retained in the Restate journal before native receipt
persistence starts. The receipt step may retry three recognized PostgreSQL failures
locally, then Restate retries that durable step using the journaled outcome. It never
reissues provider I/O. The business loop accepts success only when the persisted
attempt, terminal state, output and accounting match. A conflicting terminal receipt
is preserved. A crash before the physical-result journal acknowledgement remains
uncertain; a worker crash after acknowledgement can recover the same known result.

Mutable task rows use PostgreSQL `FOR NO KEY UPDATE`. Task identity is immutable;
this mode still excludes concurrent writers while allowing FK `KEY SHARE` checks
from Inbox cancellation and typed-event inserts. Runtime authority checks take the
task writer lock before checking the current customer conversation. A stronger task
key lock would recreate the conversation/task foreign-key deadlock during takeover.

Reviewed-evidence projection reuses its current transaction connection for the task
manifest. It does not reacquire the pool while holding the organization fence. A
single-connection regression verifies the normal reviewer read and current grant
revocation rejection without weakening membership or source-policy checks.

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

## Bounded native API response handling

Native API release `native-api-v2` consumes immutable response policies from the structured
request editor or the OpenAPI `x-kasitek-response` extension. Projection selects up to
sixteen named JSON Pointer fields. Optional cursor pagination and transient-status retries
require an explicit owner-attested GET read policy; default operations and reviewed writes
retain one physical request. The existing connected executor checks authority before every
request, stores private response pages and replays completed observations without resending.

Pages and retries share at most eight physical requests, a 30-second maximum within the
original operation deadline, and a combined 1MiB page-receipt budget. Retries accept only
429/502/503/504, honor bounded Retry-After, and never repeat transport uncertainty. Cursors
are values in a declared query parameter on the pinned origin. Repeated cursors fail; the
page limit returns explicit incomplete status and continuation. No secondary execution engine,
arbitrary fetch URL, executable projection expression or automatic write retry is introduced.

The API template extension and safe operation DTO are additive; schema038 already supplies
the immutable JSON storage. Adapter executable digests pin the new policy implementation.
Existing operation/physical-attempt events and private receipts provide durable runtime observability;
connection lifecycle logs/spans and receipt-derived provider metrics are described in the telemetry section above;
new analytics events, collector endpoints and infrastructure deployment are not applicable.
Verification combines controlled HTTP, isolated published-grant PostgreSQL execution and
mock-transport browser checks at desktop/tablet/mobile widths. Live provider compatibility
remains a separate gate. Disable or replace the selected binding to stop new admissions;
retain receipts and the accepted executable release for in-flight recovery.
