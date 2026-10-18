# Agents platform architecture

Updated: 2026-10-17.

This is the target architecture agreed with the owner. It defines the shared execution service
and the standalone Agents product separately. Design against these boundaries first. Existing
code is reusable only where it fits. This is a new product built with fresh schemas. Existing
data, histories, credentials, endpoints, and clients impose no migration, preservation, or backward-compatibility
requirements. Legacy data retention is not a prerequisite. The [implementation status](../source-boundary.md) describes
current implementation; it does not constrain the target design.

## Product experience and ownership

| Surface | Customer experience | Authority |
| --- | --- | --- |
| Growth | Users initialize and use content, campaign, and guidance features inside Growth. | Growth membership, resource permissions, commercial entitlement, and business rules. |
| Agencies | Users initialize and use agency agent features inside Agencies. | Agencies membership, client and workspace boundaries, entitlement, and business rules. |
| Standalone Agents | Customers configure support, FAQ, and personal agents through the Agents product. | Agents-product membership, resources, entitlement, and publication rules. |
| Shared execution service | Backends submit authorized work and retrieve progress, results, and reviews. | Authenticated caller plus a validated, bounded execution grant. |

A Growth or Agencies customer does not need an Agents-product account, membership, subscription,
or dashboard visit to use embedded agent features. Execution records retain the verified initiating
user or organization automation identity without manufacturing an Agents-product membership.
Shared human login is compatible with separate product access. Products need not have identical
organization, workspace, client, or resource structures.

Each product owns its interface, business records, and customer authorization. The execution
service calls owning-product APIs and never reads or writes another product's database. Ordinary
product features operate without the execution service. Agent-powered features may depend on it
and must report its unavailability in their own interface.

## Three integration boundaries

| Direction | Contract | Responsibility |
| --- | --- | --- |
| External agents to Growth or Agencies | Product MCP protected by OAuth; deliberately supported, scoped API keys may also be offered. | The product authorizes external clients and exposes its permitted business operations. Connecting does not create an agent definition, version, or installation in the shared execution service. |
| Product backend to shared execution API | Authenticated internal submission, status, progress, results, approval, cancellation, and conversation contracts. | The product verifies access and entitlement. Execution admission validates bounded delegated authority for a permitted agent feature and version. |
| Executing agent to product business API | Typed API adapter using destination-specific scoped delegated credentials. | Trusted execution code proposes no authority of its own. The destination independently enforces resource access, review requirements, and business rules. |

Internal calls do not require MCP. Product APIs and external MCP expose the same owning-product
business operations and permission rules. External MCP does not replace embedded product execution.
The shared service may also use MCP client adapters to connect permitted third-party tools.

## Target architecture

The diagram shows logical modules. Product APIs, product MCP, and product backends can share a
product deployment. The standalone Agents backend and execution API can initially share a codebase
or process where their access boundaries remain explicit.

```mermaid
flowchart TB
  subgraph products[Product experiences]
    growthUi[Growth UI] --> growthBackend[Growth backend]
    agenciesUi[Agencies UI] --> agenciesBackend[Agencies backend]
    agentsUi[Standalone Agents UI] --> agentsBackend[Agents product backend]
  end
  externalAgents[External agents] -->|OAuth or supported scoped key| productMcp[Growth and Agencies MCP]
  productMcp --> productApis[Owning-product business APIs]
  productApis --> productData[(Product-owned records)]
  growthBackend -->|Authorized execution request| executionApi[Shared execution API]
  agenciesBackend -->|Authorized execution request| executionApi
  agentsBackend -->|Authorized execution request| executionApi
  channels[Website and messaging] <--> channelAdapters[Channel adapters]
  channelAdapters <--> executionApi

  executionApi --> admission[Admission and execution grants]
  admission --> records[(Accepted tasks and grant references)]
  admission -->|Business, same transaction| outbox[(Business outbox)]
  outbox --> dispatcher[Outbox dispatcher]
  dispatcher --> restate[Self-hosted Restate]
  restate --> workers[Business-agent workers]
  workers --> productAdapters[Typed product API adapters]
  productAdapters -->|Scoped delegated credentials| productApis
  workers --> externalAdapters[External API and MCP client adapters]
  externalAdapters --> providers[External services]
  workers --> context[Authorized history and knowledge]
  context --> records
  context --> objects[(Private files and artifacts)]
  workers --> sandboxAdapter[Temporary sandbox adapter]
  sandboxAdapter --> sandboxes[Temporary isolated sandboxes]
  sandboxes --> objects
  workers --> models[Model providers]
  restate --> journal[(Restate journal)]

  admission -->|Workspace, after acceptance is persisted| workspaceManager[Workspace manager and Lina adapter]
  workspaceManager --> records
  workspaceManager <--> lina[Isolated Lina runtime]
  lina -->|Scoped native tools| productApis
  lina --> providers
  lina --> models
  lina --> objects

  identity[Keycloak identity and application execution grants] -.-> admission
  identity -.-> productApis
  evaluator[External evaluator adapter] <--> executionApi
```

Admission selects one execution contract. Every accepted task has a persisted stable identity.
Only business tasks enter the Restate outbox; Lina submission follows its own accepted task.
Both paths use verified scope and common user-facing lifecycle conventions. Business
workflow recovery belongs to Restate. Lina owns its task execution and recovery. No default
Restate supervision layer is added around Lina. Adapters remain modules until scaling or isolation
requires separate deployments. No general message broker, Redis service, or standalone tool
gateway is selected by this diagram.

## Identity and authorization

The initial platform uses self-hosted Keycloak 26.6.0 with OIDC authorization code, PKCE, state and
nonce, plus separate browser and execution-service registrations. Fresh Agents records own product
membership and revocable bounded execution grants. Keycloak caller identity alone grants no tenant
authority. Growth and Agencies resource mapping and delegated product-token policy remain later work.

| Concept | Target responsibility |
| --- | --- |
| Human identity | Verified issuer and subject, independent of product access. |
| Organization or tenant ownership | Explicit ownership references and validated mappings across product boundaries. |
| Product membership | Access to a particular product; membership in one does not imply membership in another. |
| Product workspace and resource permissions | The owning product resolves permitted clients, workspaces, records, and operations. |
| Backend service identity | Growth, Agencies, and Agents backends authenticate as distinct applications. Caller identity alone grants no customer access. |
| Organization automation identity | Explicit owner and revocable grants for scheduled or background work. |
| Run identity and correlation | Stable accepted task, initiating principal, acting service, grant, feature version, and causal audit references. |

IDs and scope fields in a request are not self-authorizing. Admission validates the caller's right
to request the feature and the trusted product authorization behind its execution grant. The standalone Agents backend validates its browser session and product membership before
submitting authorized work. Embedded Growth requests instead carry Growth-validated scope from
its authenticated backend. Both enter shared execution through explicit service admission.
Execution tenant references must not assume that product workspace IDs are interchangeable.

### Execution grant

The initial application grant is a persisted record validated at admission and before model effects.
It identifies the initiating human or website visitor, authenticated caller, product, organization,
resource, immutable version, approved knowledge, operations, limits, expiry and revocation. Standalone
grants last at most 30 minutes; visitor grants last 10 minutes. Automation and embedded-product
issuance remain unavailable. This record is not a universal OAuth schema.

| Field group | Content |
| --- | --- |
| Origin and ownership | Origin product, organization, and product-specific workspace or resource scope. |
| Principal and caller | Verified initiating human or automation identity, acting backend, and issuer references. |
| Feature | Permitted agent feature, immutable version, and stable request identity. |
| Authority | Allowed operations, connection and resource restrictions, and required reviews. |
| Limits | Lifetime, usage allocation, and relevant task or delegation limits. |
| Lifecycle | Grant identity, owner, current validity, revocation, and run correlation. |

User-delegated work uses a bounded subset of current authorized rights. Background work uses an
explicit organization automation grant with its own scope and lifetime. It does not retain a
browser session as permanent authority. The execution service validates or adopts grants through
trusted product authorization before admitting work. The issuer, storage owner, validation mechanism,
and exact wire schema remain decisions.

OAuth Token Exchange is a candidate for obtaining destination-specific delegated credentials while
retaining subject and acting-service identity. Provider support and policy must be verified.
Credentials intended for execution admission cannot simply be forwarded to Growth or Agencies.
Destination services validate the applicable issuer, signature, expiry, audience, and actual
resource permissions. Token exchange alone defines neither tenant policy nor application reviews,
durable grants, or immediate revocation. See [RFC 8693](https://www.rfc-editor.org/rfc/rfc8693.html)
and [OAuth security best practice](https://www.rfc-editor.org/rfc/rfc9700.html).

### Embedded campaign request

```mermaid
sequenceDiagram
  participant user as Growth user
  participant growth as Growth backend
  participant execution as Shared execution API
  participant worker as Business worker
  participant authority as Identity and grant authority
  participant business as Growth business API
  user->>growth: Request campaign preparation
  growth->>growth: Verify membership, resource permission, and entitlement
  growth->>execution: Authenticate and submit feature, version, verified scope
  execution->>execution: Validate grant and persist stable run with outbox command
  execution-->>growth: Accepted run identity
  worker->>authority: Obtain current destination-scoped authority
  authority-->>worker: Bounded Growth credential
  worker->>business: Request permitted operation
  business->>business: Enforce resource rights, review, and business rules
  business-->>worker: Operation outcome and receipt
  growth->>execution: Follow progress, results, and reviews
  execution-->>growth: Authorized lifecycle state
  growth-->>user: Display progress and results in Growth
```

The worker represents the Restate business path after durable dispatch. The authority participant
is a logical responsibility, not a selected new service. Rejected grants and missing entitlement
produce no accepted work. Repeated requests resolve to the same authorized logical run under the
agreed idempotency contract.

## Agent definitions and runtime contracts

The target model separates an agent or product feature, its immutable configuration version,
execution grant, connection, deployment binding, and run or task. The execution discriminator below
is settled. The remaining configuration and wire schemas still need definition.
An embedded feature can reference a product-managed version without creating a standalone Agents
subscription or customer-owned agent record.

Remove `system_hosted`, `kasitek_hosted`, and `external_connected` as target categories. Retire
protected KasiAi identity, bootstrap, dedicated controls, and implicit privileges. Future Growth
and Agencies guidance agents use ordinary feature/version and authorization contracts. Their role
comes from configuration and permitted operations.

Legacy `general`, `custom`, and audience fields do not define the replacement data model. Product
use cases, interaction policy, runtime binding, and deployment are separate decisions. A private
support-agent test is not a different personal-assistant offering. An external MCP client is an
integration principal and does not need a fabricated agent installation.

Published versions pin instructions, model settings, knowledge revisions, tool bindings, and
policy configuration. Each run records its admitted version. Current grants, resource permissions,
and required reviews are still checked before effects. A deployment can bind a version to a
website or channel without a hosting-mode enum.

### Two technical execution categories

Each immutable agent version declares exactly one `executionKind`:

```ts
type AgentExecutionKind = "business" | "workspace";
```

| Category | Execution owner | Supported behavior |
| --- | --- | --- |
| `business` | Our agent execution code runs on shared workers. Restate coordinates durable work. | Model-directed planning and tool use, agent delegation, defined workflow stages, approvals, schedules, and optional temporary execution sandboxes. |
| `workspace` | Lina executes inside an isolated workspace and owns its native runtime lifecycle. | Native model and tool loop, files, commands, browser work, workspace state, continuation, and recovery. |

Admission routes the version's `executionKind` to the business execution backend or the Lina
adapter. A caller cannot override the category in a message or bypass its grants by changing a
label. Technical execution category grants no permissions by itself.

Research agents, campaign managers, social-media agents, support agents, and FAQ agents can all
use `business`. Their purpose and enabled capabilities differ. They do not require separate
engines or services. `business` supports a model-directed agent loop, including planning and
subagents. Defined workflows enforce required stages and can invoke agent loops. Agents may
request permitted workflows. Conversation, asynchronous work, and workflow coordination are
execution patterns within this backend, not additional agent categories.

Lina is a separate execution owner. A business agent using an isolated browser or code tool keeps
`executionKind: "business"`; that capability does not change it into a workspace agent.
Subagents are configured agents invoked under bounded child-task authority. Websites and messaging
are channels. Sandboxes are execution resources. None adds a third category.

### Common platform lifecycle

Both categories implement the same platform operations while keeping their native runtime state
and recovery ownership separate. These are contract responsibilities, not selected HTTP paths.

| Contract | Required behavior |
| --- | --- |
| Submission | Validate scope, version, grants, and limits; record a stable accepted task and runtime reference. Repeated authorized requests do not create another task. |
| Status and progress | Return factual state and bounded progress. Reconnect reloads the accepted task instead of submitting it again. |
| Cancellation | Record the request and report the confirmed outcome or remaining uncertainty. A transport disconnect alone is not proof of termination. |
| Result | Report completion or failure with meaningful output, delivery state, and any uncertain operations. |
| History and artifacts | Return authorized records or references under current product, tenant, and resource policy. Do not force Lina's internal state into a Restate journal. |

Business admission commits the accepted task and outbox command atomically. The workspace path
persists its accepted identity and follows the original Lina task without a Restate dependency.
Exact Lina submission deduplication and lifecycle mapping must be verified against its contract.

### Business-agent capability configuration

An immutable business-agent version configures these capabilities explicitly. Current grants and
resource permissions still bound their use at execution time.

| Configuration | Contract |
| --- | --- |
| Instructions, model, and limits | Purpose, model settings, context selection, and bounded execution time and spending. |
| Knowledge | Approved source revisions and retrieval permissions. |
| Tools and connections | Selected operations and authorized accounts with resource restrictions. |
| Delegation | Enabled or disabled; allowed child agent versions, bounded grants, and root-task concurrency, depth, time, and spending limits. |
| Temporary sandboxes | Enabled or disabled; permitted operations, authorized inputs, resource and network limits, lifetime, and artifact rules. |
| Workflows and reviews | Permitted workflows and stages enforced by trusted code, including reviews required before effects. |
| Triggers | Authorized user requests, channel messages, schedules, or events. Background work requires its explicit automation grant. |

The initial platform delegation contract supports `business` parent tasks invoking `business`
child tasks. Cross-runtime delegation requires a separately defined contract before it is enabled.
Each child has stable parent, child, and root-task identities. Retries follow that child rather
than starting another one. A child receives a bounded task, explicitly granted tools and resources,
and an allocation within the root budget. Delegation does not multiply the available authority or
spending limit. Parent completion, failure, timeout, and cancellation behavior for children must be
specified and verified against the selected Restate mechanisms before enabling delegation.

### Temporary execution sandboxes

A business agent or permitted subagent can request temporary isolated compute for code, browser,
or file-processing tools. Trusted code authorizes and provisions the resource; generated code
runs outside shared trusted workers. Restate provides durable coordination, while the sandbox
provides isolated compute. A sandbox is not the persistent Lina workspace runtime.

The sandbox adapter binds each allocation to an authorized task or subtask and a stable operation
identity. It defines permitted reuse within that scope, expiry, and destruction. Parent sandbox
access, credentials, and files are not inherited by a child. Any sharing needs explicit grants.

Before enabling the capability, define CPU, memory, storage, concurrency, network access, filesystem,
credential injection, time, and spending limits. Define how validated inputs enter and authorized
results and artifacts leave. Required outputs must be captured before cleanup. Expiry, cancellation,
worker failure, and retries need verified outcomes. A lost response cannot trigger blind repetition
of a command with unknown external effects. The provider, isolation technology, exact limits,
allocation API, and recovery behavior remain unselected.

### Minimal website FAQ configuration

A website FAQ agent is a `business` agent using approved knowledge retrieval. Its configuration
contains instructions, approved knowledge sources, model and execution limits, and a website
binding to a selected immutable version. Safe defaults keep the creation form short.

For this minimal configuration, delegation and sandbox access are explicitly disabled. No external
business-action tools, extra workflows, or scheduled triggers are enabled. Knowledge retrieval
remains available within the approved public-source scope. Enabling more capabilities later
requires an explicit configuration and authorization change, not a new execution category.

A campaign manager may enable research and creative subagents, approved tools, temporary sandboxes,
and a required publication review. A research agent may enable search, analysis tools, and delegated
research tasks. Both use the same business execution backend as the FAQ agent, with different
capability configurations and grants.

## State ownership

| State | Owner | Other systems retain |
| --- | --- | --- |
| Human identity and authenticated applications | Selected identity infrastructure | Verified subject, issuer, and service references. |
| Product membership, entitlements, permissions, and domain records | Growth, Agencies, or standalone Agents product | Validated scope, authorization references, and operation receipts. |
| Accepted runs, versions, grant references, conversations, and queryable status | Shared execution records under verified product and tenant scope | Stable IDs and authorized projections. Exact product-configuration ownership is part of the schema design. |
| Business workflow position, timers, and recorded step results | Restate | Repairable status projection in PostgreSQL. |
| Workspace task execution, context, continuation, and workspace state | Lina | Authorized task, history, status, and artifact references. |
| Business facts and accepted external effects | Owning product or provider | Scoped references and confirmed or uncertain operation outcomes. |
| Knowledge files and generated artifacts | Private object storage or authoritative Lina workspace | Authorized references and required metadata. |
| Credentials | Protected secret storage and selected authorization infrastructure | Opaque references outside model context and ordinary transcripts. |
| Execution usage | Shared execution metering | Stable run, operation, and attempt attribution. |

Product permission truth remains with the product even when execution records retain a grant
reference. PostgreSQL status is a repairable projection of runtime facts and cannot launch a
second run. Reference data needed to recover a recorded runtime result must outlive that recovery
window.

## Business-agent durable execution

1. The product backend or verified channel binding establishes caller, product, tenant, principal,
   conversation, and permitted feature scope.
2. Admission validates the execution grant. One PostgreSQL transaction records the accepted task,
   immutable version, grant reference, and outbox command.
3. The dispatcher delivers a stable invocation to Restate. Delivery retries do not create another
   logical run.
4. Restate invokes business handlers. Model calls, external effects, and other nondeterministic
   operations use supported durable boundaries.
5. Trusted context retrieval and tool execution enforce current grants, resource scope, required
   reviews, and budgets. Destination credentials are obtained for the actual target API.
6. The worker records bounded outcomes and delivers through the authorized channel or requesting
   product. Reconnect follows the existing task.

Restate stores grant references, not permanent authority. Resume and new actions require valid
current credentials and policy checks. Revocation prevents future authorized effects according to
the selected enforcement contract. It cannot undo an already accepted external effect. Unknown
outcomes require reconciliation before retry.

Human takeover changes conversation ownership before admitting new automated actions. Active
reasoning receives a cancellation request. Already-started operations can still complete and must
report their actual outcome. Restate cancellation and child coordination use the pinned public SDK mechanisms verified by runtime probes; application-level tree outcomes still require recorded child receipts.

Delegated agents use established runtime mechanisms and explicitly bounded child grants. A child
cannot exceed delegated authority. Parent, child, and root-task identities, spending, concurrency,
and depth limits remain distinct. General teams follow a verified bounded delegation use case.

## Workspace-agent execution through Lina

The execution API accepts an authorized `workspace` task, such as a personal-assistant request. The workspace manager locates or provisions
the isolated workspace and maps the stable platform request to Lina's task identity. It follows
status, requests cancellation, and returns authorized history and artifacts. Reconnect does not
resubmit the task.

Lina owns its native model and tool loop, context, continuation, history, permission mechanisms,
and recovery. This path requires neither Restate nor Temporal. The platform remains responsible
for granting bounded workspace and connection access, credential delivery, resource limits, and
the user-facing lifecycle. Platform-supplied credentials must preserve destination and resource
scope without appearing in task prompts. Provider and isolation technology remain unselected.

## Adapter boundaries

| Adapter | Responsibility | Authority boundary |
| --- | --- | --- |
| Product API | Calls typed Growth, Agencies, or other product operations. | Destination verifies delegated authority and current product rules. |
| External API or MCP client | Invokes explicitly selected provider operations. | Scoped connection, grants, resource limits, reviews, and effect reconciliation. |
| Channel | Verifies provider ingress, preserves event identity, and delivers replies. | Tenant and conversation authority come from trusted bindings. |
| Temporary sandbox | Provisions isolated, task-scoped compute and exports authorized results. | Explicit tool grants, resource and network limits, bounded lifetime, and verified cleanup. |
| Lina runtime | Maps submit, status, cancel, history, and artifacts. | Lina owns execution; platform grants bound accessible workspaces and services. |
| Evaluation | Submits isolated version-pinned trials and collects evidence. | Generic execution contracts; evaluator formats and grading stay outside ordinary execution. |

Trusted tool code validates arguments, derives scope, checks current policy, resolves credentials,
invokes the adapter with a stable operation identity, and records the outcome. Models propose
operations; they do not issue grants. Authenticated tool results and retrieved documents remain
untrusted content. A general marketplace and arbitrary uploaded server code are outside the
initial support slice.

## Entitlements, metering, and billing

Product-plan entitlement, individual permission, and run execution authority are separate checks.
A paid campaign feature does not let every employee publish. Products own commercial packaging.
The shared backend owns execution metering and runtime limits.

The standalone platform owns root allocations and an operation-keyed usage ledger in its dedicated
PostgreSQL database. Admission reserves up to 32,000 accounted tokens per root against a
100,000-token organization allowance attributed to the root's admission UTC day. Settlement,
including after midnight, uses that same accounting day. Every model call, tool round and
compaction has a stable operation identity. Unknown model outcomes conservatively retain their
reservation and are not regenerated blindly.

The development profile limits model input to a conservative 8,192-token envelope, output to
1,024 tokens, and each model request to 120 seconds. Serialized UTF-8 bytes bound the pinned
byte-level tokenizer's content tokens, with 512 tokens reserved for provider framing. Ingestion
still limits a user message to 16 KiB. Root limits are 12 model calls, 24 tool calls, 15 minutes
of summed active operation time and a 24-hour wall deadline. Two accepted nonterminal roots per
organization are distinct from the two model/four tool operation slots. Waiting work releases
compute slots. Commercial billing and future product packaging remain separate decisions.

## Tenant isolation, memory, and capacity

Enforce verified product, tenant, and resource scope at admission, database access, memory,
retrieval, connections, tools, files, exports, streams, and background work. Account and workspace
IDs across products require validated mappings. Combine database scoping and row-level security
where appropriate; runtime roles must not bypass the selected isolation policy.

Business history and selected memories retain explicit ownership and source access. Documents
remain in private storage behind authorized retrieval. Current business facts stay in their
owning product. Anonymous public questions receive conversation-scoped context. Private memory
across conversations requires verified identity and permission.

Shared workers and data infrastructure are the long-term default. A configured agent needs no
permanent process. Isolate code and computer execution, bound resource use and telemetry, and add
dedicated capacity only for measured load or explicit isolation requirements. Availability,
throughput, and multi-replica stream behavior remain unverified.

## Current implementation and remaining decisions

The platform uses fresh Agents-owned schemas, Keycloak sessions, organization membership,
immutable agent/knowledge versions, explicit website bindings, bounded grants and atomic
admission/outbox. The inherited Temporal, protected KasiAi, hosting-mode and synthetic-installation
implementation is removed. No existing database is migrated or modified.

### Business harness

The connected-knowledge foundation separates mutable import jobs and source policy from sealed
source revisions and chunks. Imports start private and unapproved. Current organization owners
approve candidates, change visibility and withdraw sources; each revision's importer can inspect
that candidate and cancel their pending work. Refreshing a source does not give its original
importer access to another account's candidate. Publication checks the accepted source generation and job deadline under the
organization lock. A cancelled or withdrawn import cannot seal a late result. Revision bodies use
private, content-addressed object keys; chunk offsets count UTF-16 text units and bind a text hash.
The authenticated Knowledge API admits uploads and exact public HTTPS URLs. AgentsKnowledgeImportV1
runs acquisition, isolated parsing, token-aware chunking, local embedding and atomic index publication.
Text, Markdown, static HTML and text PDFs are supported. OCR, encrypted PDFs, DOCX, archives,
authenticated crawling and script-rendered pages are unavailable. Import readiness, owner approval
and AgentVersion publication are separate actions.

The pinned document runtime uses rootless gVisor with no network, one CPU, 512 MiB of memory,
no swap and 64 processes. PDF.js, Readability, the tokenizer and the local FP32 BGE model have
hashed release manifests. The runtime checks installed package bytes, helper/model/tokenizer and
gVisor bundle hashes before launch, with stat-sensitive digest caching. Older profiles without a
package manifest remain inspectable for cleanup but cannot launch new inference. Private stage receipts survive worker loss and physical resource
destruction. A resource reaper runs independently of storage credentials; a separate object reaper
tracks write intents and repeated deletion tombstones for interrupted uploads. Active sealed
raw/text objects remain private. Replay stage objects remain available for seven days plus a
15-minute cleanup allowance.

Capability catalogs pin explicit model aliases, schema digests, resource handles and executable
adapter releases. Recorded receipts resolve before the live adapter registry, so a catalog change
cannot alter replay. Evidence manifests retain influencing source, connection and memory policy
generations separately from model-visible text. Dependency collection deduplicates shared ancestors
and rejects cycles, missing records and conflicting generations. Native/MCP reads share the
business operation controller and root budgets. API and worker pin matching executable artifacts;
recorded receipts resolve before registry lookup. Public repository connections use anonymous native
GitHub and DeepWiki reads; Stash uses selected private item IDs and encrypted bearer credentials.
These profiles retain the same task, connection and evidence authority boundaries.

The versioned AgentsBusinessRunV8 Restate workflow owns repeated model/tool execution. Each task
pins its agent configuration and harness release. Ordered conversation turns wait for the preceding
execution and its recorded result. A short database transaction assigns order and freezes eligible
history; it does not run the agent loop or hold a lock during external work.

The context assembler selects authorized prior exchanges, knowledge, accepted personal memory,
reviewed pinned skills and complete tool-call/result groups. Each ordinary or compaction model
request has an immutable context snapshot, digest, source references and memory invalidation fence.
Recorded compaction reduces older groups while retaining unresolved requests and operation/artifact
references. A single complete tool group can be compacted when it overflows the next request.
If the fixed instructions, tools and resulting summary still exceed the limit, execution ends
incomplete instead of repeatedly compacting an empty context. Replaying a recorded context keeps
its original evidence parents and rechecks their current policy.
Summaries are derived data and never grant authority or prove an effect succeeded.
Every influencing source/connection/memory dependency survives the summary and child join.
A delegated brief retains an immutable snapshot of its parent dependencies, checked under
the parent authority. Narrow specialist retrieval grants do not erase that provenance.
Once consumed evidence is withdrawn or forgotten, the current task stops incomplete rather than
discarding its dependency records. A fresh turn can select current evidence and omit invalid history.

Personal semantic/episodic memory uses scoped PostgreSQL records and transactional full-text search.
Model proposals remain candidates until authenticated management acceptance. Correction uses an
expected revision. Forget suppresses future learned-memory retrieval and invalidates dependent
context. Original conversation content has a separate source-deletion operation. Expiry advances
selection generations. These controls do not claim physical erasure of prior provider requests,
journals, revisions or backups. Procedural skills are immutable reviewed revisions pinned at
publication; they cannot install tools or expand permissions.

The trusted executor exposes selected knowledge.search/read, memory.search/propose, agents.delegate and sandbox.analyze operations.
Tool schemas, arguments, current grants, memory fences, time and root usage are checked before
admission. Model names and prompt instructions cannot grant a tool. The minimal FAQ uses the same
controller with its optional capabilities disabled. Website publication rejects personal memory,
memory tools, private skill bindings, connected reads and private source revisions.

Operation receipts and per-operation settlement survive retries. A started model request without a
confirmed receipt becomes uncertain instead of generating again. Expected denials are recorded
outcomes rather than infinite runtime retries. Expired grants enter a durable authority wait;
authenticated continuation obtains a bounded replacement grant and follows the same task. Cancellation
and deadline commands stop future admissions and request runtime cancellation; confirmed receipts
remain the effect evidence. PostgreSQL status and progress remain repairable projections.

Restate server 1.7.13 and SDK 1.17.3 are pinned and tested together. Runtime retention is seven days,
outbox retry is bounded to 24 hours, and settled tasks are not redispatched. The API returns bounded
operation/progress records, and Test reconnects to the original task. Private context/receipt data
stays in the dedicated database; large artifacts use a scoped private S3-compatible adapter.
Workers validate signed Restate requests when configured. Production requires signing keys.
Unsigned workers default to loopback; exposed unsigned development requires explicit opt-in.

Local verification covers actual PostgreSQL/Restate operation recovery, context and memory
invalidation, bounded accounting, compaction replay, and real-model UI follow-ups plus memory-tool
use. Actual MinIO checks cover private storage and lost-response/deletion handling. HTTP2 signature
fixtures cover valid and forged worker requests. These checks do not certify hosted production,
cluster key distribution, backups, capacity or monitoring. See the
[runtime reference](../../../../infra/agents-runtime/README.md) and
[implementation boundary](../source-boundary.md).

### Business subagents and temporary analysis

A published coordinator pins same-organization specialist AgentVersions, permitted
knowledge and read tools, and child token/time ceilings. Atomic delegation slots
persist one child per parent operation and slot. Children run the common controller
in private branches, without joining the parent conversational input queue. V1
allows two outstanding children and one delegation edge. Personal memory,
credentials, sandbox access and further delegation are not inherited.

Root-owned accounting reserves one original organization allocation and subdivides
it for children. Root admission, outstanding children and executing provider slots
are separate limits. The parent releases execution slots while Restate joins all
admitted children in stable slot order. Partial results remain distinguishable
from complete success. Cancellation, deadlines and root revocation stop future
child admissions; dependent work remains owned until accounted for.

The optional python-analysis-v1 profile runs generated Python inside rootless
gVisor with no network, using a pinned read-only Python filesystem. A transient
systemd user service enforces one CPU, 512 MiB memory, no swap and 64 host tasks;
the guest also enforces process/file bounds. Scratch is limited to 256 MiB,
commands to 120 seconds and leases to ten minutes or the root deadline. Each analysis
operation reserves 240 seconds from the shared root active-time budget for input
reads, readiness, command execution, export and confirmed destruction. The command
deadline remains 120 seconds. Inputs
are explicitly staged, and exports are checked for paths, links, type, count and
size. No host tool execution, model keys, database credentials or Docker socket
enter the guest.

Allocation and command identities survive worker loss. Reconnect attaches or
reads a receipt; it never interprets a lost response as permission to rerun code.
Required outputs enter scoped private storage before normal destruction. Durable
export references allow operation replay after destruction. The independent
sandbox reaper cleans expired or stopped-root allocations without depending on
the original worker. Execution outcome and resource disposition are separate;
root settlement waits for dependent resource accounting.

Task artifact authorization retains root/task/producing-operation provenance and
explicit transfer references. Management artifact APIs cannot bypass task scope.
Downloads validate the initiating account, current membership, root scope and
source availability, and use a private attachment response. Artifacts outlive
compute; deleted/revoked sources cannot silently become fresh model inputs.

Backend setup and verification are local development evidence, not hosted
multi-tenant certification. The selected runtime must enforce its limits before
analysis is enabled. Missing backend or storage fails closed. No ordinary host
process or unverified runtime is used as fallback.

### Connected action and automation implementation

The trusted `report-delivery-v1` workflow shares the business harness and root
budgets. Model output cannot perform a delivery. A private artifact and exact
immutable action packet precede review; current authority and source validity
must still pass an atomic dispatch claim. Cancellation before claim blocks the
write; an accepted external effect remains reconcilable after cancellation.
`ReportDeliveryHTTP` uses a server-configured resource and encrypted scoped API
key. Its persistent acceptance receiver proves the protocol locally and does not
establish a concrete third-party provider integration.

Automation authorization pins the owner, reviewer, version, input and finite
limits. Restate `AgentsAutomationV1` supplies one-shot/interval UTC timers;
authenticated events use a deduplicated occurrence inbox. Atomic occurrence
admission reuses task/grant/quota/outbox boundaries. The automation principal
remains distinct across delegation, analysis and artifacts. It receives no
personal memory or owner conversation history. Pause/edit apply to future runs;
revoke blocks new claims and requests cancellation. See the
[implementation boundary](../source-boundary.md#connected-reports-and-automation)
for exact limits, review semantics and uncertainty handling.

### Unavailable capabilities

Exactly two execution categories remain. Workspace tasks fail before acceptance until the Lina
adapter is implemented. The initial connected action is exact reviewed report delivery through ReportDeliveryHTTP; arbitrary business-write adapters remain unavailable. Durable UTC one-shot/interval schedules and authenticated events use explicit automation authorization. Additional workflow profiles remain unavailable. Delegation and analysis require their published configuration, bounded current grants and available runtime/storage.
The standalone runtime probes exercise future coordination mechanisms without exposing those
capabilities in the product. External MCP, embedded Growth and Agencies admission and evaluator
adapters are also unavailable.

Remaining work includes embedded-product authorization/resource mapping, concrete third-party adapters,
commercial billing, production storage operations, other channels, Lina hosting and production
containment certification, monitoring and deployment. Requirements and
checklists stay in Linear. Repository documents describe maintained contracts and actual behavior.

## Related records

- [Multi-product foundation specification](https://linear.app/kasitek/document/agents-multi-product-execution-foundation-and-architecture-reset-01fcce619f68)
- [Core harness specification](https://linear.app/kasitek/document/agents-durable-business-harness-context-and-memory-implementation-plan-bb256ca81fa9)
- [Downstream support delivery](https://linear.app/kasitek/document/agents-recoverable-support-run-and-website-acceptance-e9c335ebe5bc)
- [Implementation status](../source-boundary.md)
- [Integration boundaries](../mcp-integration.md)
- [Security boundaries](../THREAT_MODEL.md)
- [Platform login](platform-login.md)
