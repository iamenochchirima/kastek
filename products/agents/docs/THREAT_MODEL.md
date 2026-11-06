# Agents threat model

Owner: Agents engineering. Last reviewed: 2026-11-04.

This reference covers the current management API, shared business harness, dedicated database,
private content store, website widget, identity provider, and model boundary. It
describes current controls and does not certify a production deployment.

## Identity and admission

OIDC uses an independent Agents client, authorization code flow, PKCE, state,
nonce, verified claims, and one-use login transactions. Issuer and subject identify
an account. Email equality does not merge identities. Product sessions use opaque
cookies and stored token hashes. Current membership and resource scope govern
management access. Browser mutations enforce their origin boundary.

Execution grants bind product, organization, resource, principal, immutable
version, operations, knowledge, limits, and expiry. Operation admission rechecks
current authority. A prepared context or previously valid grant is not permanent
permission. Continuation must remain within the original task's authority ceiling.
Implemented continuation paths require their own runtime acceptance; the presence
of a resume endpoint alone is not evidence of successful durable recovery.

## External MCP clients

The standalone Agents MCP endpoint is opt-in and uses OAuth resource discovery,
Streamable HTTP, PKCE, account consent, and organization-scoped grants. Listing a
tool is not permission to call it: every invocation checks its current scope,
connection, organization membership, and the owning operation's authorization.
Configuration changes, knowledge review, and website activation produce
short-lived reviews bound to the proposed revision; the external model cannot
approve them. MCP identifiers returned as references are scoped to their OAuth
connection and organization, and those references do not authorize an operation.

The response projection rejects known reflections of the active MCP bearer token.
Host and present Origin headers are checked against explicit deployment
allowlists; browser origins must be configured exactly, with no wildcard. A
non-browser client that omits Origin still has to use an allowed Host. Revoking a
connection blocks later requests but cannot recall data already returned to an
external client. Growth's MCP server remains separately owned and does not share
Agents identities, grants, or business operations. OAuth authorization is limited
per socket peer and per registered client; forwarded IP headers are not trusted.
Expired requests, codes and refresh records are removed in bounded batches. The
consent screen treats the client-supplied name as unverified and shows its client
ID and callback host before granting access; this identifies the requested target
but does not prove domain ownership.

Website access binds deployment, allowed origin, visitor session, version, and
approved public knowledge. Website agents cannot enable personal memory, memory tools, or
generic personal connection bindings. Only enabled, reviewed server-curated instruction packages
with the exact shipped digest are permitted as website skills. Private and repository packages
remain operator-only. Booking access requires a separate current service policy. An origin check does not replace the visitor's scoped session.

## Target channels and customer inbox

Website Inbox assignment, takeover, human replies and return to automation are implemented.
Organization membership, assignee permissions, revision checks, deduplicated commands and durable
ownership generations fence admission and canonical automated delivery. Human-owned visitor input
is recorded without automatic model admission. Late model results cannot become customer messages.
Tasks with a customer-channel binding require an Agents visitor or channel-customer principal at
admission and on current authority checks. This guard does not classify arbitrary staff-authored
content or replace source and recipient authorization for outbound product actions.
WhatsApp, Facebook, and Instagram remain unavailable. Google Calendar appointments use explicit
organization service sharing, an owner-pinned policy, and exact customer confirmation. The
standalone Booking creation offering and live Google OAuth acceptance remain unavailable.

The website implementation uses verified channel ingress, trusted tenant and agent bindings, deduplicated
events, and scoped customer conversations. Staff access and assignment require product permission.
Takeover changes conversation ownership before further automated replies or actions can be
admitted. Pending sends must recheck ownership. In-flight operations report their actual outcomes;
uncertainty requires reconciliation. Staff replies need channel authority, and returning control
to automation must be explicit. A channel identity does not grant access to private customer
records or permit cross-channel identity merging. Each future provider requires its own integration
and end-to-end acceptance before its channel is offered.

## Context, memory, and tools

The harness builds bounded context from authorized history, knowledge, approved
personal memory, pinned skills, and recorded operation results. Retrieved text and
tool results are data. They cannot grant tools, credentials, or resource access.
Skills are reviewed, immutable instructions subordinate to trusted policy. Import and review never
execute package code. `skills.run` selects only an exact reviewed Python entry from an activated,
pinned package under a separately authorized `python-analysis-v1` sandbox. Script source need not
enter model context. The complete package is staged read-only; only its selected-script directory
and package root are added for bundled imports inside the isolated guest. Python uses `-I -S -B`.
Host execution, injected credentials, network access and dependency installation remain unavailable.
Package and script digests persist in immutable operation provenance. Generated artifacts retain a
skill dependency, so package withdrawal blocks later use. Current authority is rechecked before
launch and output publication. The original operation deadline and root budget bound allocation;
existing finalization and the independent reaper retain cleanup responsibility.

Every tool call passes server validation against the selected configuration.
The current tools search or read approved knowledge, read personal memory, or
propose a candidate, delegate bounded specialist work, or request isolated analysis. The model cannot directly dispatch external report writes. Memory
acceptance, correction, and forgetting require authenticated management actions.
No prompt instruction substitutes for those checks.

Ordinary agent replies and supported recipient surfaces pass through a shared exact-value
projection for known execution identifiers, tool-result identifiers and issued product
references. Product adapters may declare which result selectors become opaque, conversation-,
principal-, tenant- and resource-scoped references. The runtime resolves them only at declared
tool input fields. A reference is a selector, not authorization: the destination product checks
current membership, operation grants and resource state on every call. The projection preserves
display names, public handles and approved business references. It is a known-value backstop,
not general secret detection; technical exports, binary artifacts and arbitrary transformed values
have separate or limited coverage.

Personal memory uses organization, agent, and verified-account namespaces.
Current membership is checked on each request. Candidate content is excluded
from retrieval. Revision checks prevent stale overwrites, and operation keys
prevent duplicate mutations. Forgetting suppresses known earlier content so a
replayed write cannot restore it. Source-history deletion invalidates linked
memory and blocks new proposals from that deleted source.

Namespace generations and expiry checks guard later model admission. Invalidation
before an operation is admitted prevents that claim. Invalidation after admission
cannot undo transmitted context or a provider result. Compaction output is a
summary, never authority or evidence that an external effect succeeded.

The model dispatcher resolves provider credentials outside model arguments and checks
the prepared request and completed response for the active credential before the
response is released. The check covers the exact value and common JSON-escaped,
URL-encoded, Base64, and Base64URL forms. Connected-tool execution applies the same
known-value check to its active credential before retaining a response. These checks
are a reflection backstop, not general data-loss prevention: unknown credentials,
other secrets, and arbitrary transformations can still pass. Model output is checked
for valid protocol, bounds, termination, and usage. The approved profile disables
reasoning and fallback.
Conservative serialized-byte accounting, output reserves, root quotas, operation
counts, deadlines, and concurrency bounds limit resource use.

## Private content

Context snapshots and memory revisions are private PostgreSQL records. Large
artifacts use scoped PostgreSQL metadata and signed S3-compatible requests to a
private bucket. Downloads recheck authorization and content integrity. Object
keys and provider paths are not public authorization handles. Storage has bounded
request time and content size. Missing storage remains unavailable.

Forgetting and source-history deletion prevent future use. Historical revisions,
already transmitted provider content, runtime journals, and backups may retain
content. Physical erasure and production retention require an explicit operational
policy; a tombstone does not establish erasure.

## Execution and operations

Atomic admission and stable operation receipts limit duplicate logical work.
Restate and PostgreSQL do not share an external provider transaction. A started
model operation without a result remains uncertain and is not blindly repeated.
Usage settles once; uncertainty consumes reserved usage conservatively.
Cancellation is intent until relevant operation outcomes are known.

The worker defaults to loopback. A non-loopback unsigned development worker
requires explicit `AGENTS_ALLOW_UNSIGNED_WORKER=1`. Production requires
`RESTATE_REQUEST_IDENTITY_KEYS` regardless of that development override. The
public SDK checks request signatures before discovery and invocation dispatch.
HTTP2 fixture checks cover valid signatures and unsigned, wrong-key, expired,
and wrong-path denial. Cluster signing, rotation, and deployed network access
remain production verification work.

Local Restate ingress and administration ports bind to loopback. Its development
setup does not configure production ingress authentication or TLS. The worker
must remain private, including when Docker development requires non-loopback
binding. The admin API must not be exposed publicly.

Fresh schema setup refuses an incompatible existing database. Dedicated runtime
credentials must remain separate from other products. Production roles, backups,
disaster recovery, secret storage, redaction inspection, alerts, and signup-email
delivery remain deployment gates. Structured stdout has bounded errors; no OTLP
exporter or durable log retention is currently configured.

## Delegation and generated analysis

Only published same-organization business specialist versions can be delegated.
The child receives a bounded brief, selected knowledge/read tools and a subdivided
root allocation. Personal memory, credentials, history, sandbox access and further
delegation are not inherited. A child checks current root authority before dispatch.
Stable slots and operation identities prevent duplicate logical children; one root
reservation bounds the whole tree. Waiting parents release provider capacity.

Coordinator execution permissions and delegated permissions are separate. A parent
can consume evidence from an actually joined, authorized child without gaining the
child's provider tools. Guessed tool aliases and direct evidence minting remain
subject to the parent's own tool list. Revoking the source connection blocks reuse
of child-derived citations and artifacts. A continuation checkpoint preserves only
validated execution metadata as trusted control state; child prose and model
summaries cannot rewrite those facts or expand authority.

Generated Python runs inside pinned rootless gVisor with network disabled, a
read-only root and bounded scratch. No host worker, Docker socket, model key,
provider credential or database connection is exposed inside the guest. Systemd
user cgroups enforce CPU, memory, no-swap and host task limits. Guest limits and
bounded export handling complement those controls. There is no host execution
fallback. Local containment tests do not establish production multi-tenant certification.

Allocation and command records distinguish unknown execution from confirmed
failure. Reconnect never reruns an unknown command. Exports pass path/link/type/
size/count checks before private publication. Task artifact APIs require the root
initiating account, current membership and source availability; ordinary management
artifact reads cannot bypass those checks. Downloads are private attachments.

An independent reaper stops expired or cancelled resources after worker loss.
Root settlement waits for dependent work and cleanup accounting; a cancellation
request is not evidence that compute already stopped. Receipts and exported
artifact references survive destruction for the permitted replay window.

Lina execution remains unavailable. Report writes require exact approval;
general native/MCP effects require exact review by default, including nominal read operations.
Explicit owner read attestation applies only to its selected immutable operation policy. Local fixtures verify transport
controls. Public repository reads use anonymous native GitHub and DeepWiki endpoints;
keyed Stash and GitHub checks remain separate from that public acceptance.

## Calendar and booking authority

Google OAuth uses the configured issuer/client, PKCE, nonce, state, and verified token claims.
The connector encrypts tokens and one-use authorization attempts. Refresh runs outside database
locks under a lease; changed identity, scopes, policy, or uncertain refresh requires reconnection.
A private calendar becomes customer-service eligible only after explicit organization sharing.

Published booking authority pins the current owner, calendar, connection policy revision, and
policy digest. Customer session and channel ownership fence every proposal, approval, and send.
A staff Inbox takeover prevents a previously approved automated booking from starting a new
insertion. The customer, rather than a different workspace member or visitor, confirms the exact
request digest. Confirmation does not override withdrawn policy, membership, or source access.

Local calendar reservations and a single-send claim fence competing inserts. Provider acceptance
with a lost acknowledgement remains uncertain. **Check status** rechecks current authority and
uses only a leased provider GET for the deterministic event. It never repeats insertion, renews
the original operation deadline, or turns the original uncertain task into a successful task.
Active claims return `BOOKING_IN_PROGRESS`. Public projections omit task IDs, Google event IDs,
and account credentials. Unresolved state must not produce a model-invented booking confirmation. Uncertain outcomes request
Inbox handoff only for the current automated ownership generation. Staff status reads require exact
conversation/task links and current staff scope. Staff reconciliation cannot approve a customer
request or repeat insertion; unrelated conversations cannot borrow a booking identifier.

The controlled tests use owned disposable PostgreSQL databases, isolated Restate, independent
worker processes, and local provider/OIDC fixtures. Live Google consent and production operation
require separate acceptance.

## Connected action and automation authority

Connection secrets use AES-256-GCM with an external keyring and authenticated
organization/connection/revision context. Missing keys and failed decryption deny
access. Neither credentials nor owner-selected authentication headers enter model
context, tool arguments, sandbox, browser responses or diagnostic logs. Only a
configured destination and resource can receive a report; redirects fail closed.

Exact report approval is distinct from execution authorization. Artifact integrity,
recursive source availability, memory generation/expiry, current membership,
connection revision/expiry and task scope are locked and checked before dispatch
claim. Connection rotation invalidates unclaimed packets. Revocation before claim
blocks network writes; revocation after claim permits only receipt reconciliation.
Durability alone cannot prove provider acceptance. An absent/unavailable receipt
stays uncertain, with no automatic repeat POST.

Automation bearer keys are hashed and scoped to one automation. Event data is
untrusted bounded input, never authority. Occurrence uniqueness and shared
admission transactions prevent duplicate tasks and quota reservations. An accepted
automation retains a distinct principal and immutable authorization snapshot;
current owner membership, revocation and snapshot expiry still govern every claim.
Personal memory and owner history are excluded. A designated reviewer needs current
membership and exact packet identity, independently of execution ownership. Reviewer downloads are limited to the prepared report artifact; other root inputs remain owner-only.

The local persistent HTTP receiver establishes idempotency/status behavior for
ReportDeliveryHTTP. Report delivery does not implement arbitrary provider OAuth. Production key custody/rotation, destination provisioning, durable
receiver storage, ingress rate limiting and operational monitoring remain release
work for their selected deployment.

## Imported and connected evidence

Every upload and public page starts as a private candidate. Only current
organization owners approve revisions or publish source visibility. A revision's
importer and current owners can inspect it; the original source importer cannot
inspect another account's refresh candidate. Delayed publication rechecks job,
source generation, membership, deadline and cancellation under the organization
lock. Partial indexes are never published.

Parsing, tokenization and embedding run in a pinned no-network gVisor profile.
Host credentials and writable host mounts are absent. Raw/text/stage bodies stay
private in PostgreSQL; persisted write intents and cleanup tombstones cover interrupted writes. Raw inputs and stage receipts are deleted after the durable replay window.
Physical cleanup is independent of S3 availability. Object cleanup has a separate
lane so a storage outage cannot hold physical allocation capacity indefinitely.

Public acquisition pins and validates DNS/IP destinations, TLS hosts, HTTPS port,
redirect authorization and byte/time bounds. The model cannot encode private
facts into paths, queries, headers or subdomains: connected reads accept only
owner-selected public identifiers and server-issued revision/file handles. Stash
receives only explicitly approved private item IDs and bounded offsets. Anonymous
public connections store no credential and transmit no Authorization header.
There is no arbitrary model URL or free-text external search tool.

Hostile MCP schemas are validated in a bounded child process before SDK schema
registration. Trusted local policy classifies effects. Remote annotations cannot
enable writes. Per-send durable admission covers all setup/read messages; local
cancellation does not claim remote cancellation. Unknown started reads retain
explicit uncertainty rather than issuing another physical request.

Evidence manifests are separate from model text. All influencing dependencies
survive truncation, compaction, joins, history and artifacts. A specialist brief carries
its immutable parent input dependencies even when the specialist cannot retrieve those
sources directly. Withdrawal blocks reuse of both the brief and derived child output. Current policy and
content hashes gate future context, review and dispatch. Exact approval cannot
restore withdrawn access. An already claimed effect remains reconcilable after
revocation; a historical receipt does not authorize another send or content read.
Citation validation establishes supplied provenance, not factual correctness.

## Delegated product assertions and evaluation channels

Embedded product admission verifies an installed issuer/key, a registered product tenant mapping,
short assertion lifetime, exact input digest, principal, version and grant ceiling. Tenant and grant
revocation are rechecked before execution. The initial adapter rejects richer product resources
without their own authorization contracts; it does not translate product users into Agents members.

Evaluation website sessions require a current operator-owned trial and its exact published version
and allowed origin. Public visitor ingress derives the trial binding from persistence. Knowing a
trial UUID cannot authorize a visitor or an operator export. Normal Inbox permissions continue to
control staff assignment, takeover and replies. Revocation expires the visitor session and fences
new work. Audit metadata and currently readable customer content are separate access decisions.
