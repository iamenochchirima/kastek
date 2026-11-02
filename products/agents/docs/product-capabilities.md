# Product capabilities

Owner: Agents engineering. Last reviewed: 2026-10-23.

Business agents use the same model/tool loop. `tool-directed@3` accepts installed
product capabilities alongside native and connected tools. Instructions, selected
capabilities and current authority determine an agent's available work. A preset
name does not select a separate execution engine or grant access.

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

## Authority and execution

A product binding identifies origin product and tenant, destination product and
tenant, mapping reference, policy revision, operation and immutable digests.
Origin and destination tenant IDs are separate. Matching strings establish no
cross-product access.

The shared runtime checks these independent authorities:

1. The accepted task, current execution grant and selected binding.
2. An installed originating-product authorizer, including current product access.
3. Destination authorization for the exact operation, mapped actor and resources.

A destination mapping cannot replace the originating product's authorization.
An origin without its installed authorizer remains unavailable. Model-visible
tools include only currently available selected bindings. Destination permission
denials remove that tool from availability; transport/integrity failures remain
errors. Execution rechecks authority before each operation.

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

Reviewed effects use opaque product-owned review references. The destination
owns the payload, exact approval, expiry, one-use decision and authoritative
receipt. Shared execution waits durably and reconciles an uncertain operation
before another effect attempt. A saved receipt, not model text, establishes a
completed write.

## Growth configuration

Growth owns `products/growth/api/src/agents/manifest.ts`. Its four presets are
Growth assistant, Research, Content and Campaigns. Assistant and Content share the
reviewed draft operation; all four share permitted read operations.

The manifest exposes workspace context/help, bounded content discovery/read,
WhatsApp campaign discovery/read, explicit-range analytics and reviewed content
DRAFT creation. Domain handlers retain Growth membership, feature permissions,
account scope and existing business rules. Campaign launch, publishing and
scheduling are not installed effects. Missing analytics infrastructure makes the
report operation unavailable.

Managed organisation setup publishes defaults revision `2`, manifest revision
`2` and capability policy revision `2` through its authenticated provisioning
boundary. Agents stores the publication and validates it against installed
handlers. Ordinary repair preserves customised settings, disabled features,
model selections and revoked tenants. The operator's explicit
`upgrade-defaults` action applies the managed revision to eligible defaults for
future turns. Accepted turns retain their original composition.

The first Growth policy explicitly disables product bindings for knowledge,
skills, personal memory, delegation, sandbox, workflows and external connections.
The standalone harness already supports independently configured capabilities in
these areas; Growth lacks their required product custody/principal authority.
Changing a flag alone cannot make those authorities available.

## Agency boundary

The second installed destination exposes only
`agency.workspace_agents.read`, under the shared product namespace `agencies`.
It reads actual `workspace_agents` metadata and excludes configuration and
conversation bodies. An Agency-owned mapping and exact grant are required in
addition to current workspace membership and `AGENT_ROLES`.

[Agency capability configuration](../../agency/docs/agent-capabilities.md)
defines service trust, destination mapping, resource allowlists and source
revalidation. Configuring `AGENCY_PRODUCT_API_URL` and the worker signing key
installs transport only. It does not publish a capability, issue a mapping,
provision defaults or launch Agency UI, voice or workspace execution.

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

New admissions use harness `product-capabilities-v11` and Restate workflow
`AgentsBusinessRunV21`. Schema070 generalizes product review projections;
schema071 stores trusted Growth publications and managed configuration markers;
schema072 changes the default release for new tasks. The setup command applies
only recognized preceding schema digests under its database lock. Unknown digests
remain rejected.

Install matching product handlers, schemas and service configuration before
publishing the new default revision or admitting new work. Retain V20 and its
`growth-products-v10` worker for already accepted V20 work. Route or drain each
accepted task on its pinned worker; never replay its journal through V21.

Rollback stops new admissions and selects an installed compatible configuration
for future turns. Revoke destination grants or disable service trust to stop
additional product access. Preserve accepted snapshots, original receipts and
uncertain outcomes. Do not rewrite a task's release or reverse additive tables
while accepted work depends on them. No production deployment is implied.
