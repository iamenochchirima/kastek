# Agents threat model

This reference covers the standalone API, business harness, dedicated database,
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

Website access binds deployment, allowed origin, visitor session, version, and
approved public knowledge. Website agents cannot enable personal memory, skills,
or memory tools. An origin check does not replace the visitor's scoped session.

## Context, memory, and tools

The harness builds bounded context from authorized history, knowledge, approved
personal memory, pinned skills, and recorded operation results. Retrieved text and
tool results are data. They cannot grant tools, credentials, or resource access.
Skills are reviewed, immutable instructions subordinate to trusted policy.

Every tool call passes server validation against the selected configuration.
The current tools search or read approved knowledge, read personal memory, or
propose a candidate, delegate scoped research, or request isolated analysis. The model cannot directly dispatch external report writes. Memory
acceptance, correction, and forgetting require authenticated management actions.
No prompt instruction substitutes for those checks.

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

Provider credentials remain outside model arguments, context, UI responses, and
ordinary diagnostic logs. Model output is checked for valid protocol, bounds,
termination, and usage. The approved profile disables reasoning and fallback.
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
connected native/MCP tools are restricted reads. Local fixtures verify transport
controls. Public repository reads use anonymous native GitHub and DeepWiki endpoints;
keyed Stash and GitHub checks remain separate from that public acceptance.

## Connected action and automation authority

Connection secrets use AES-256-GCM with an external keyring and authenticated
organization/connection/revision context. Missing keys and failed decryption deny
access. Neither credentials nor user-selected network headers/URLs enter model
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
ReportDeliveryHTTP. No arbitrary provider or OAuth flow is claimed. Production key custody/rotation, destination provisioning, durable
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
private; persisted write intents and cleanup tombstones cover interrupted PUTs.
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
