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
propose a candidate. They do not execute external business writes. Memory
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

Destination writes, in-task approval waits, outbound MCP, delegation, temporary
sandboxes, automation, and Lina execution remain disabled. These controls do not
claim isolation or effect guarantees for those future capabilities.
