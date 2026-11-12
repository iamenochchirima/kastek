# Product capabilities

Owner: Agents engineering. Last reviewed: 2026-11-03.

Business agents use the same model/tool loop. Compatible `tool-directed` versions accept installed
product capabilities alongside native and connected tools. Instructions, selected
capabilities and current authority determine an agent's available work. A preset
name does not select a separate execution engine or grant access.

## Business workflows

Agents may select immutable playbook references in `configuration.procedures`, default `[]`.
Behaviour → Tools → Workflows exposes the per-agent catalogue. `after-hours-assistance@1`
provides the first **After-hours support** workflow. The ordinary agent discovers and loads
selected definitions through `procedures.*`, while durable instances track revision-checked
progress and verified domain receipts. A definition never expands tool or tenant authority.

Support facts come from the backend. The agent gives the customer-facing workflow reply;
request tools save state without sending an additional system message. Human-assistance request tools keep a pending human
request independent from agent speaking ownership; staff takeover and explicit human-only
choices still fence automated work. Optional contact preferences are customer-evidenced data,
not promises of an outbound call or message. Only verified domain outcomes can satisfy workflow
completion. Cancellation does not undo recorded effects or withdraw the separate support request.

Schemas116/117 store instances, commands and human requests. Definition version1 opt-in does
not change `product-capabilities-v15` / `AgentsBusinessRunV25`. This capability is separate
from `capabilities.workflows`, the existing report-delivery feature. See
[Business workflows](operations/business-procedures.md) for API, scope, receipt and rollout rules.

## Customer follow-ups

`/app/customers` includes Contacts and Follow-ups alongside Enquiries. Customer-consented support
details populate Contacts automatically using the verified website participant or channel sender.
Follow-ups shows the saved request, preferred contact, status, assignee, agent and original
conversation. Existing saved preferences can be brought across with the explicit support-contact
backfill command. A matching email alone never merges customers.

Agents ask for a name when collecting contact preferences, reuse details already supplied and
save an email/phone promptly if the name is not yet available. A customer may decline a name
without losing their support request. No email or call is sent by saving these details.

## Publication and installation

Shared contracts in `packages/contracts/src/product-capabilities.ts` describe
product descriptors, manifests, bindings, invocations, evidence and opaque review
references. They contain no Growth or Agency operation definitions. Products own
their operation schemas, instructions and presets.

An operation descriptor pins its schema, description, handler reference, effect,
authority, review/retry policy, evidence behavior and limits. The manifest pins
its operation set and installed adapter reference. A trusted publication selects
existing installed implementations. It cannot install code, supply a URL or
credential, change SQL, or establish tenant mapping.

The executable registry validates adapter releases and handler references before
publication or execution. Descriptor metadata is shared; network destinations,
clients and credentials belong to each `ProductRuntime` instance. One runtime's
service configuration cannot redirect another runtime's calls.

The published composition and accepted task pin configuration, product manifests,
descriptors, bindings, adapter references, model routes and resource ceilings.
Compiler cache identities include these inputs. Changed or missing releases fail
instead of silently replacing accepted dependencies. Customers save configuration;
immutable version creation remains a background operation.

Direct `productBindings` determine the agent's own catalogue. Optional
`commissionableProductBindings` pin a separate pool available only through an explicitly selected
specialist role's `productBindingIds`. That pool is part of immutable composition but never adds
child-only schemas to an ancestor's model request. Publication validates both pools against
installed descriptors. A child's accepted configuration narrows its published ceiling through
its immediate parent, while current destination permission remains separately required.

## Tool discovery

The effective direct catalogue contains only currently available authorized tools. New publications
pin `tools.discover` and `tools.load` version3. Their readable category/purpose/effect metadata and
safe `tool:alias` handles share the catalogue identity used by exact schema loading and invocation.
Version1/2 definitions, result shapes, descriptor digests and accepted receipts remain unchanged.
The policy is shared by every runtime host. Existing published versions retain their pinned
contracts until republished; Growth's reviewed capability upgrade publishes the new contracts.
Neither rollout rewrites an accepted task or its stored context snapshots.

Version3 requests begin with a bounded capability directory. It describes direct tools, selected
reviewed skills and separately permitted specialists; it does not expose a child's tools as direct
parent authority. Trusted native/product/installed-adapter metadata supplies orientation. External
MCP/custom API descriptions remain tool reference data; the trusted directory reports their category
and count without importing those descriptions as instructions. Unavailable configured operations
are counted without presenting their names as currently callable.

The `capability-exposure-v1` policy measures schemas using the accepted model counting profile.
It reserves one fifth of the input/request allowance for target schemas in addition to the measured
discovery controls. Explicit eager preferences and automatic candidates must fit this allowance and
maxTools; overflow stays deferred. A small all-fitting set is callable directly without discovery.
Version3 schema loads validate the entire prior-plus-new selection before persisting success;
oversized sets return `TOOL_SCHEMA_LIMIT` with fewer/replace guidance. Loading grants no authority.
The directory uses one eighth of the input/request allowance with a minimal totals/category fallback;
the complete request still passes the ordinary context-fit gate. All omitted details remain explicit.
If that full request still exceeds the accepted context limit, the worker may compact the directory
only when every listed operation remains directly callable, and there are no selected skills,
specialists, or unavailable product bindings. It preserves the summary and tool schemas and marks
the directory as incomplete. If the reduced request still exceeds the limit, normal compaction or
the bounded context-limit response applies; the worker does not drop conversation evidence or
silently remove tools.

Browse mode enumerates; bounded batched purpose queries use normalized/stemmed ranked overlap
across readable metadata and parameter descriptions. Results carry matched/returned counts,
completeness and paging. Exact listed handles can be loaded without a preceding search. A lexical
miss is not evidence that a capability does not exist. The renderer reuses only an identical measured
directory; authority and availability are rebuilt before cache reuse. Compaction does not remove
this first-request orientation on subsequent requests. Stored context snapshots are never rewritten.

Retained history, customer/channel limits and exact schema gates remain unchanged. Existing
version1/2 publications retain their accepted loading policy. New shared publications, Growth
capability updates and ordinary immutable-version publication use the new protocol.

## Authority and execution

A product binding identifies origin product, tenant and optional `originClientId`, destination
product, tenant and optional `clientId`, mapping reference, policy revision, operation and immutable
digests. Origin and destination identities remain separate, including when both products use client
scopes. Matching strings establish no cross-product access.

New V15 invocations also carry work/root/parent/task lineage and an information envelope.
Information authority is separate from action authority. The default audience is the verified
origin actor, product tenant, conversation and optional Agency client. Eligible provider
destinations pin provider/protocol/endpoint, connection/account and credential revision, model
identity and accepted route receipt. A product can narrow the envelope's provider set; it cannot
substitute another recipient or widen it. These internal envelopes are retained as evidence
provenance, not serialized into model-visible tool results.

The shared runtime checks these independent authorities:

1. The accepted task, current execution grant and selected binding.
2. An installed originating-product authorizer, including current product access.
3. Destination authorization for the exact operation, mapped actor and resources.

A destination mapping cannot replace the originating product's authorization.
An origin without its installed authorizer remains unavailable. Model-visible
tools include only currently available selected bindings. Destination permission
denials remove that tool from availability; transport/integrity failures remain
errors. Execution rechecks authority before each operation.

API and worker use the same configured-runtime factory. Agency can run without Growth credentials.
Ingress service assertions, originating-product authority checks and destination operation calls
use separate signed contracts and audiences. A model receives no service signing credential.
Signed Growth and Agency service ingress uses those signatures instead of a browser Origin header.
Browser writes retain their Origin check.

The model can choose no tools, repeat a read, change its order or correct a
recoverable argument error. The business loop contains no Growth preset dispatch
or required product-tool sequence. Permission revocation, corrupt evidence and
uncertain writes retain their stop/reconciliation behavior. Tool results and
descriptions never grant authority.

Bounded discovery/read tools return resource handles, continuation and source
revisions. Attached context records the user's focus; it does not grant general
record access or limit discovery to one attachment. Every observation retains its
binding and source revision through subsequent context, compaction, history,
artifacts and delegated dependency checks. Later use rechecks destination access
and the exact source revision.

Every model role checks its actual provider destination against influencing product information.
An exact-conversation audience is not a general cross-conversation cache. Explicit human acceptance
of a memory allows only the reviewed saved text in the same product/actor/client/agent memory
namespace. Its recorded transition proves the accepted revision, source graph and named reviewer;
original resource and provider dependencies remain current. Original source handles are not
transferred with this memory. Permitted child briefs retain exact transition provenance through
the authorized ancestor chain. Summaries and agent-written progress cannot approve this transfer.

Reviewed effects use opaque product-owned review references. The destination
owns the payload, exact approval, expiry, one-use decision and authoritative
receipt. Shared execution waits durably and reconciles an uncertain operation
before another effect attempt. A saved receipt, not model text, establishes a
completed write.

## Managed model catalogue

Platform-managed provider connections expose the provider's discovered catalogue. An explicit
`AGENTS_DEFAULT_MODEL_IDS` operator allowlist can restrict a deployment; an empty
`managed_model_ids` value means the full catalogue. The model picker remains searchable by model and
provider name, and filters model routes whose tool support is unsupported or unverified.

The full managed catalogue is available while the workspace has AI credits. At zero credits the
picker filters platform-managed connections to free models and reports that the allowance is
exhausted. Customer-supplied provider connections remain independent of that allowance filter on
paid plans.

## Growth configuration

Growth owns `products/growth/api/src/agents/manifest.ts`. Its four presets are Growth assistant,
Research, Content and Campaigns. Current publications derive tools from the shared Growth operation
catalogue, including content, media, contacts, Inbox, bookings, campaign reads and analytics.
Research and Campaigns receive permitted reads. Content receives the content, workspace, connection,
review and analytics selection; Assistant receives the full published catalogue. Current product
permissions, account scope, provider readiness and domain rules remain required.

Installed writes, including publishing, scheduling and Inbox sends, retain exact review and owning
product receipts. Campaign launch has no installed operation. Missing analytics infrastructure makes
the report operation unavailable. Native adapter release `2` retains the earlier bounded product
tools. Releases `3`, `4` and `5` match the immutable operation publications for revisions `6`, `7`,
and `8`/`9`/`10`. Release `6` is current revision `11`; its handler digest also pins the
`growth-content-post-read-v1` model projection. Earlier publication and adapter identities remain
available to accepted work.

The installed Growth adapters declare the `effect-status-v1` model projection for reviewed writes.
The product's separate status observation authorizes only the confirmed state and review reference,
not the private returned business content. Native receipts remain available for exact reconciliation;
model-visible and recoverable operation history uses the projection. An adapter without a declared
projection does not expose a reviewed write to the model. Growth staging transfers also receive a
short-lived, actor-bound access observation; expired or inactive transfer details are not reused.

Canonical content reads apply a trusted projection to `content.posts.get` and `content.posts.list`.
The model receives draft text and fields needed to revise it, plus safe media references; account IDs,
publishing-job states, errors, provider IDs and arbitrary metadata are omitted. The complete operation
output and access digest remain in native custody. Older selected-content reads use the same reduced
context view while their source revision remains bound to the full current record. The model-result
boundary also applies this projection to retained accepted bindings that expose the same exact
canonical Growth read handlers, even when their pinned adapter predates the projection declaration;
their authority, execution identity and native receipt remain unchanged.

Managed organisation setup publishes defaults, manifest and capability policy revision `11`
through its authenticated provisioning
boundary. Agents stores the publication and validates it against installed
handlers. Ordinary repair preserves customised settings, disabled features,
model selections and revoked tenants. The operator's explicit
`upgrade-defaults` action applies the managed revision to eligible defaults for
future turns. Accepted turns retain their original composition.

The Growth API also synchronizes its current signed publication before bootstrap, management and
new-turn commands. This updates the owning product's capability policy without selecting those
capabilities or replacing a custom definition. Current feature reads and submissions publish a
runtime successor when the existing definition pins an earlier runtime. The successor retains its
configuration, model and resource/specialist pins; unpublished draft content and its revision remain
unchanged. Earlier accepted tasks retain their immutable composition. Native conflicts keep their
specific public code and message through the Growth proxy.

Revision9 makes native knowledge, skills and actor-scoped memory available only after explicit
configuration. Growth owners/admins import text/Markdown sources and portable or curated skills
from each feature's **Knowledge & skills** dialog. Import, exact content review and selection are
separate actions. Visible inventories and previews recheck current access and resource state;
failed reads clear cached content, while background updates preserve unsaved selection and its
original configuration revision. Sources and immutable skill packages carry the mapped product tenant, feature
agent and verified service/actor provenance. They never acquire standalone Agents accounts or
memberships. Each published configuration pins its reviewed resources; current deselection,
withdrawal, disabled installation and origin access still fence accepted tasks and their evidence.
The product-managed assistant updates its commissioned specialist versions and approved source
ceilings in a new immutable version after specialist configuration changes. Custom coordinators
retain their explicit bindings. Product memory uses a separate verified actor namespace and exact
human acceptance. Sandbox, workflows, enquiries and external connections remain unavailable to
Growth. See [the integration reference](growth-integration.md#knowledge-and-skills) for the native
resource commands and ownership checks.

## Agency integration

The second installed destination exposes only
`agency.workspace_agents.read`, under the shared product namespace `agencies`.
It reads actual `workspace_agents` metadata and excludes configuration and
conversation bodies. An Agency-owned mapping and exact grant are required in
addition to current workspace membership and `AGENT_ROLES`.

[Agency capability configuration](../../agency/docs/agent-capabilities.md) defines the separate
client-scoped ingress, staff portal assistant, managed model setup, reviewed personal memory and
current-origin checks. The browser session stays in Agency. The shared service creates no
standalone Agents account or membership. Each conversation, binding, memory and observation
retains its explicit client scope. Voice and additional business operations remain unavailable
through this initial configuration.

Configuring transport alone grants no access. Agency's authenticated setup path publishes the
installed metadata manifest, records the exact binding under the verified staff/client mapping,
and issues an explicit resource allowlist. Current client status, staff role and assignment are
checked again at the owning product. Revoked grants and explicit disabled setup are preserved.
The service exposes readiness until model configuration, compatible schema and destination
authority are available. The shared renderer uses the same activity, duration and modal protocol.

## Capture and evaluation

Growth exposes `GET /api/agents/tasks/:taskId/export` for the initiating user's
currently authorized task. The BFF uses the signed `tasks.export` service command;
the shared exporter applies current task/resource and evidence checks. Oversized
captures fail explicitly rather than silently truncating evidence.

The native capture contains actual accepted configuration, effective composition,
product bindings, model routes, operations and evidence coverage. The Harbor
Growth adapter consumes this capture, checks optional composition/model/manifest
pins, and writes ATIF only from supported native records. Missing or withheld
records do not become invented results or a quality pass. Each preset or custom
composition can use an independently prepared purpose suite. Growth still lacks
the standalone server-native trial reservation/revocation contract.

Implementation checks use deterministic model responses and controlled product
identities where stated. They do not establish model quality or live provider
compatibility. Evaluation and grading runs remain owner-run.

## Release identity and recovery

New business publications use harness `product-capabilities-v15` and Restate workflow
`AgentsBusinessRunV25`. Schemas099–102 add recursive lineage, durable context/checkpoints,
product memory namespaces and explicit client-scoped context/publication records. Schema070
introduced generic product review projections; schema071 introduced Growth publications and
managed markers. The setup command applies
only recognized preceding schema digests under its database lock. Unknown digests
remain rejected.

Install matching product handlers, schemas and service configuration before
publishing a new default revision or admitting new work. Route or drain already accepted work on
its pinned compatible handler. Never rewrite its release or replay an older journal through V25.

Rollback stops new admissions and selects an installed compatible configuration
for future turns. Revoke destination grants or disable service trust to stop
additional product access. Preserve accepted snapshots, original receipts and
uncertain outcomes. Do not rewrite a task's release or reverse additive tables
while accepted work depends on them. No production deployment is implied.
