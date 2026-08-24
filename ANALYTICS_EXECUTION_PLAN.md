# Customer Analytics Execution Plan and Checklist

**Related product plan:** [ANALYTICS_PLAN.md](ANALYTICS_PLAN.md)

**Status:** E1–E10 and Product Sections 1–12 are approved. Planning is complete; implementation is
in progress by slice. Phase 0 ownership and architecture-decision prerequisites remain tracked
below.

**Scope:** This document governs customer-facing analytics for KasiTek organizations, white-label
tenant workspaces, and tenant clients, including feature dashboards, per-agent analytics, main
overviews, insights, exports, alerts, scheduled reports, and agent-readable analytics. Tenant
clients are independently administered customer boundaries within tenant workspaces. KasiTek
internal cross-customer analytics, infrastructure observability, billing, security, and audited
support drilldown will use a separate execution plan. The two systems may consume approved shared
facts, but they will have separate projections, APIs, permissions, retention rules, and dashboards.

**Process:** Review one execution section in chat, approve or revise it, record the approved
decision here, and continue. No implementation begins until all required execution sections and
their dependencies are approved.

## Execution planning checklist

- [x] E1. Execution architecture and data boundaries — approved
- [x] E2. Physical data model, event schema registry, and migration strategy — approved
- [x] E3. Collection SDKs, transactional outboxes, ingestion, replay, and reconciliation — approved
- [x] E4. Metric registry, semantic definitions, and reporting API contracts — approved
- [x] E5. Freshness, coverage, availability, backfill, and data-quality rules — approved
- [x] E6. Reporting-scope isolation, privacy, retention, deletion, and audit rules — approved
- [x] E7. Core, Agent, and Tenant feature instrumentation sequence and ownership map — approved
- [x] E8. Projection, rollup, caching, and scale-out strategy — approved
- [x] E9. Testing, performance targets, monitoring, and operational runbooks — approved
- [x] E10. Deployment phases, feature flags, acceptance criteria, and implementation backlog — approved

## E1 — Execution architecture and data boundaries

**Status:** Approved

### Architecture pattern

KasiTek customer analytics should use a domain-owned, event-driven collection architecture with a
central customer-analytics reporting boundary:

1. A domain operation changes its authoritative operational record.
2. The same database transaction writes a durable outbox event.
3. An ingestion worker delivers and validates the event at least once.
4. The analytics store deduplicates the event and records an immutable fact or provider
   observation.
5. Projection workers build queryable facts, dimensions, checkpoints, and time-based rollups.
6. The semantic metric registry applies one approved formula to every customer-facing consumer.
7. Reporting-scope APIs serve feature dashboards, per-agent analytics, KasiTek and tenant
   overviews, tenant-client reporting, insights, exports, reports, alerts, and authorized agents.

The approved baseline uses the standalone analytics service, PostgreSQL analytics storage,
PostgreSQL source outboxes, authenticated HTTP ingestion, and independent analytics workers. Event
producers depend on contracts rather than a transport or storage product. Kafka-compatible
transport, columnar storage, and external pipeline products are excluded from the baseline and
require a separate measured architecture decision under E8 and E9.

### Standards and conventions

- Use a CloudEvents-compatible envelope for portable event identity, type, source, subject, time,
  correlation, and content metadata.
- Validate feature-specific event attributes using versioned JSON Schema 2020-12 contracts.
- Use transactional outboxes so operational changes and their emitted facts commit atomically.
- Use at-least-once delivery with idempotent consumers; do not depend on end-to-end exactly-once
  delivery.
- Use OpenTelemetry for traces, logs, request/service metrics, and infrastructure observability.
  Business facts such as bookings, consent, campaign outcomes, and agent outcomes remain in the
  analytics data system.
- Keep high-cardinality business identifiers out of infrastructure metric dimensions.

Reference specifications:

- CloudEvents: https://cloudevents.io/
- JSON Schema: https://json-schema.org/specification
- Transactional outbox reference: https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html
- OpenTelemetry signals: https://opentelemetry.io/docs/concepts/signals/

### Ownership boundaries

Feature domains own operational meaning and fact emission:

- Inbox owns conversation, message, assignment, response, resolution, and customer-takeover facts.
- Contacts owns identity, audience membership, consent, exclusion, and suppression facts.
- Campaigns owns targeting, eligibility evaluation, campaign lifecycle, recipient transitions,
  retries, delivery, and campaign attribution facts.
- Content owns post, variant, media, publishing lifecycle, and provider-content references.
- Agent Platform owns definitions, versions, installations, runs, model calls, tools, effects,
  schedules, handoffs, runtime state, and declared outcome facts.
- Calls owns normalized call, call-leg, provider transition, handler, duration, and outcome facts.
- Bookings owns availability, booking lifecycle, scheduling, attendance, reminder, and outcome facts.
- Connections owns capability, credential, webhook, provider-sync, and health-history facts.
- Tenant Platform owns tenant workspace, tenant client, white-label user and role, lead,
  tenant-owned conversation, workspace-agent, domain, branding-readiness, and tenant-usage facts.

Customer analytics owns:

- Contract validation and schema compatibility checks
- Idempotent ingestion and duplicate handling
- Immutable historical facts and provider observations
- Projection checkpoints, reconciliation state, and replay
- Reporting-scope dimensions, hierarchical rollups, metric definitions, denominators, and attribution
  projections
- Freshness, coverage, availability, and data-quality metadata
- Reporting-scope customer APIs for KasiTek organizations, tenant workspaces, and tenant clients

Customer analytics does not become the source of truth for active campaigns, current bookings,
conversation ownership, current consent, Agent runtime state, connection credentials, or provider
operations.

### Consumer-plane boundary

Customer analytics and KasiTek internal analytics are separate consumer planes:

- Customer analytics is always bound to an authorized reporting scope and exists to provide KasiTek organization
  users, tenant workspace users, and tenant-client users with authorized visuals, comparisons,
  funnels, trends, alerts, reports, and insights.
- KasiTek internal product analytics may consume approved shared facts but uses separate
  cross-workspace aggregate projections and internal-only APIs.
- OpenTelemetry and infrastructure monitoring remain separate from business analytics.
- Billing, entitlement enforcement, security events, and audit records remain separate controlled
  systems even when their approved aggregates later inform internal analytics.
- Internal customer-scope drilldown requires dedicated authorization and an audit trail; it is not
  achieved by bypassing customer reporting-scope boundaries.
- Failure or maintenance of internal analytics must not prevent customer product operations or
  customer-facing analytics ingestion.

The internal execution plan will define platform-wide adoption, reliability, agent/runtime,
provider, infrastructure, billing, security, and support-access projections after this customer
execution plan is complete.

### Physical service boundary

Core, Agent Platform, Tenant Platform, and customer analytics are independently deployable services
with separate operational ownership. Core, Agent Platform, and Tenant Platform keep their own
databases and outboxes. All three export approved facts only through the standalone
customer-analytics ingestion API. Only the analytics service connects to the analytics database,
and analytics consumers must not perform direct cross-database joins between operational services.

Cross-service records use stable external references for reporting scope, organization, tenant
workspace, tenant client, customer/contact, conversation, campaign, content post, booking, call,
connection, agent definition/version, installation, and run. References do not imply database
foreign keys across service boundaries.

### Reporting-scope model

Every customer-facing analytics record belongs to one independently authorized reporting scope.
The initial scope kinds are `core_organization`, `tenant_workspace`, and `tenant_client`.

Tenant clients are child scopes of one tenant workspace and have their own owners, administrators,
members, reporting configuration, exports, reports, alerts, and feature resources. The hierarchy
describes ownership and aggregation; it never grants access automatically. Tenant Platform remains
authoritative for tenant workspace and tenant-client roles and assignments. Core remains
authoritative for KasiTek organization membership.

Record each fact once at its narrowest owning scope. Build authorized parent totals from child
projections instead of duplicating one fact into every ancestor scope.

### Analytics record categories

Use separate semantics for these record types:

#### Immutable events

Discrete actions and transitions such as `campaign.launched`,
`campaign.recipient.delivered`, `booking.status_changed`, `conversation.assigned`,
`contact.consent_changed`, and `agent.outcome_recorded`.

#### Provider metric observations

Timestamped measurements for a defined reporting window, such as content reach, impressions,
engagement, video views, provider cost, connection quality, or another provider-reported value.
Later observations may revise the value for the same window without rewriting the observation
history.

#### Projections and rollups

Rebuildable hourly, daily, and entity-level summaries derived from events, observations, and
authoritative operational records. Rollups are disposable projections, not independent sources of
truth.

### Common event identity

Every emitted fact should include:

- Globally unique event ID
- Source service and source domain
- Event type and schema version
- Reporting-scope kind and external scope ID
- Root reporting-scope reference and parent reference where applicable
- Primary entity type and entity ID
- Source record ID and idempotency key
- Occurred-at and ingested-at timestamps
- Actor type and actor ID where applicable
- Correlation ID and causation ID
- Safe optional entity references
- Validated versioned attributes

The analytics store enforces uniqueness using source plus event ID and preserves the original
occurred-at time separately from ingestion time.

### Reporting boundary

Feature dashboards, the main Overview, insights, exports, reports, alerts, and agents consume
customer reporting APIs rather than analytics tables or operational table scans. Every domain
report uses a shared outer response contract containing:

- Schema version
- Requested range, interval, and reporting-scope timezone
- Metric values and units
- Documented denominators for rates
- Time series and supported breakdowns
- Generated-at and latest-source timestamps
- Freshness and coverage
- Availability state and missing-source reasons
- Exact versus estimated calculation state

The first domain routes should remain explicit, such as `/api/analytics/campaigns`,
`/api/analytics/inbox`, and `/api/analytics/agents`. Do not introduce an unrestricted analytics
query language in the first implementation.

### Availability contract

Every metric or source reports one of these states:

- `available`
- `partial`
- `stale`
- `not_configured`
- `unsupported`
- `permission_denied`
- `sync_failed`
- `not_instrumented`
- `no_data`

`no_data` means the source was available but recorded no matching activity. It is distinct from
zero, unavailable, unsupported, and not yet instrumented. Coverage includes the first reliable
timestamp, latest reliable timestamp, expected refresh interval, missing providers or connections,
and whether historical data was backfilled.

### Privacy and access boundary

- Keep raw message bodies, prompts, responses, phone numbers, email addresses, credentials,
  provider tokens, and unnecessary PII outside analytics facts.
- Use stable internal references or approved pseudonymous identifiers for grouping.
- Enforce reporting-scope isolation in ingestion, storage, projection, reporting, caching, and
  export. Parent-child relationships do not bypass explicit authorization.
- Agents receive analytics through authorized reporting tools with installation/resource grants;
  they do not receive raw event-store or database access.
- Retention and deletion policy will be finalized in E6 before implementation.

### E1 approval checklist

- [x] Approve customer-facing analytics as the scope of this execution plan.
- [x] Approve a separate later execution plan for KasiTek internal analytics and observability.
- [x] Approve domain-owned fact emission and central customer-analytics reporting ownership.
- [x] Approve CloudEvents-compatible envelopes and JSON Schema contracts.
- [x] Approve transactional outboxes with at-least-once, idempotent ingestion.
- [x] Approve separate event, provider-observation, and rollup semantics.
- [x] Approve PostgreSQL-first implementation with replaceable transport and storage.
- [x] Approve the Core/Agent Platform database boundary and prohibition on reporting-time
  cross-database joins.
- [x] Approve reporting APIs as the only analytics interface for UI, exports, alerts, and agents.
- [x] Approve explicit availability, freshness, coverage, and estimation states.
- [x] Approve the privacy and reporting-scope isolation boundary pending E6 details.
- [x] Approve Core organizations, tenant workspaces, and tenant clients as customer reporting
  scopes.
- [x] Approve Tenant Platform as a first-class analytics producer.
- [x] Approve tenant clients as independently administered analytics boundaries.
- [x] Approve explicit grants rather than implicit parent-scope access.

## E2 — Physical data model, event schema registry, and migration strategy

**Status:** Approved

### Database deployment boundary

Customer analytics uses a dedicated logical PostgreSQL database configured through
`ANALYTICS_DATABASE_URL`. It does not place analytics tables in the Core or Agent Platform
operational databases.

The Core, Agent Platform, Tenant Platform, and customer-analytics databases may run on the same
PostgreSQL server as an infrastructure-placement choice. Customer analytics still uses its own
database, connection pool, migration history, backup policy, health checks, and credentials.
Moving that database to a dedicated PostgreSQL server requires a database migration and an
`ANALYTICS_DATABASE_URL` change, not a service extraction or application redesign.

Do not introduce Kafka, ClickHouse, or another analytics product until measured ingestion volume,
storage cost, or reporting latency requires it. The logical boundary, event contracts, and
reporting APIs must allow those components to change without changing domain producers or UI
consumers.

### Operational outbox placement

Every producing service owns an analytics outbox in its operational database:

- Core-owned domains write to the Core analytics outbox in the same transaction as the business
  change.
- Agent Platform writes to an Agent Platform analytics outbox in the same transaction as its
  business change.
- Tenant Platform writes tenant workspace and tenant-client facts to its own analytics outbox in
  the same transaction as its business change.
- Publishers deliver outbox records to the customer-analytics ingestion boundary.
- Analytics ingestion failure never rolls back an already committed domain operation.
- Reporting and projections never join directly to either operational database.

E3 below defines publisher leases, retries, replay, reconciliation, quarantine handling, and
delivery health.

### Reporting-scope registry

#### `analytics_reporting_scope`

Stores the customer boundary used by ingestion, projections, reports, caches, exports, and
authorization. Required fields include an internal generated scope ID, scope kind, owning source
service, external source ID, root scope ID, parent scope ID where applicable, status, IANA reporting
timezone, and created and updated timestamps.

The first scope kinds are `core_organization`, `tenant_workspace`, and `tenant_client`. Use a
versioned scope-kind registry rather than a closed database enum so later tenant divisions or
service workspaces can be added through an approved contract. Enforce uniqueness on owning source,
scope kind, and external source ID.

#### `analytics_scope_ancestor`

Stores the transitive scope hierarchy as ancestor scope, descendant scope, and depth. This closure
table supports bounded, indexed descendant rollups and explicit descendant grants without assuming
that the hierarchy will always remain two levels deep. Update scope and closure records atomically.
Hierarchy membership enables aggregation only; authorization remains an independent decision.

#### `analytics_producer`

Registers each service allowed to publish analytics records, including producer identity, source
namespace, active or revoked status, permitted record categories, permitted contract namespaces,
permitted scope kinds, credential/key metadata, and created and updated timestamps. Authentication
derives source identity from this registry; payloads cannot select another producer identity.

### Shared physical tables

The customer-analytics database begins with these shared append-oriented tables:

#### `analytics_event`

Stores immutable product actions and lifecycle transitions. Required columns include an internal
monotonic storage ID, source service, event ID, event type, schema version, reporting scope ID, root
scope ID, subject type and ID, occurred-at and ingested-at timestamps, origin, and validated
attributes. Optional columns include source record, actor, correlation, causation, idempotency, and
safe entity references.

Enforce uniqueness on source service plus event ID. Preserve event occurrence time separately from
ingestion time. Records are appended rather than updated to represent later business changes.

#### `analytics_metric_observation`

Stores append-only measurements received from providers. Required fields include observation
identity, source, reporting scope ID, root scope ID, provider, metric key, numeric value, unit,
reporting-window start and end, observed-at and ingested-at timestamps, and synchronization run. It
may include safe provider-account references, subject references, dimensions, and source evidence.

A later provider response may revise a reporting window by appending a newer observation. It does
not overwrite the observation history.

#### `analytics_source_state`

Stores the current collection state for a reporting scope, source, provider connection, and metric
scope. It records availability, reliable coverage range, latest source timestamp, last successful
sync, expected refresh interval, next attempt, and safe failure codes. Reporting uses this table to
distinguish zero from missing, stale, unsupported, or failed data.

#### `analytics_projection_checkpoint`

Stores independent progress for each projection name and version, including shard or reporting
scope, last processed storage ID, processing status, lease state, rebuild state, and update time.
This permits replay and projection rebuilding without rewriting source facts.

#### `analytics_ingestion_failure`

Records rejected input identity, source, payload hash, schema version, safe validation or processing
error codes, attempt count, and timestamps. It must not store raw customer content or credentials.
Restricted diagnostic quarantine, if required, will be governed by E6.

Domain projections and rollups are added separately for campaigns, content, inbox, conversations,
customers, agents, calls, bookings, and connections. Do not use a universal metric-key/value table
as the only representation of derived metrics; explicit domain projections preserve meaning,
constraints, and query performance.

### Identifier and reference rules

- Store cross-service scope and entity identifiers as text because Core and Tenant Platform use
  CUID-style identifiers while Agent Platform uses UUIDs.
- Use internal generated 64-bit sequence IDs for efficient ingestion ordering, checkpointing, and
  range processing.
- Require reporting scope ID and root scope ID for every customer-facing event, observation,
  projection, cache, export, and reporting record. Reject records that cannot be assigned safely to
  one registered reporting scope.
- Do not create database foreign keys to records in another service database.
- Represent cross-domain relationships as typed stable references and validate their permitted
  shapes at ingestion.
- Uniqueness of an event is source service plus event ID; an event ID is not assumed globally
  unique without its source.

### Event contract registry

Create one repository-owned contract registry organized by record category and domain, for example:

```text
analytics/contracts/
  events/<domain>/<event>/v1.schema.json
  observations/<provider>/<metric>/v1.schema.json
  examples/
```

JSON Schema 2020-12 is authoritative for data attributes. The CloudEvents-compatible envelope is a
separate shared contract. Each contract includes ownership, classification, examples, required
references, allowed dimensions, and prohibited sensitive fields.

Use stable event names independent of implementation language. Keep the major schema version as
explicit metadata rather than silently changing an existing contract. Adding an optional field
with unchanged meaning may remain within a version. Removing or renaming a field, making an
optional field required, changing its type, or changing its business meaning requires a new major
version.

CI must validate schemas and examples, reject duplicate contract identities, check backward
compatibility within a major version, and enforce privacy classifications. Rust and TypeScript
producers and consumers validate against the same contracts rather than maintaining independent
business definitions.

### Time and reporting boundaries

- Store source, occurrence, observation, ingestion, and processing timestamps in UTC.
- Store one IANA reporting timezone on each root reporting scope and permit an explicitly configured
  child-scope override.
- Resolve hourly, daily, weekly, and monthly reporting boundaries using the effective reporting-scope
  timezone, not the browser timezone.
- Return the applied timezone and reporting range in every reporting response.
- Define the default and migration behavior for existing Core organizations and tenant workspaces
  before implementation; do not infer timezone repeatedly from individual records.

### Indexing and growth rules

Begin with indexes supporting root-scope-and-time and reporting-scope-and-time access, hierarchy
closure, event type, subject, provider metric windows, availability state, and projection
checkpoints. Use a BRIN time index when append volume makes it beneficial. Do not create blanket GIN
indexes over all JSON attributes; add expression or dimension indexes only for approved frequent
queries.

Do not introduce table partitioning solely in anticipation of growth. Record table size, ingest
rate, retention, scan volume, and query latency, then introduce time partitioning or columnar
storage at thresholds defined in E8 and E9. The use of immutable facts, textual external
references, checkpoints, and reporting APIs must make that change possible without changing event
producers.

### Additive migration and historical backfill

- Create analytics storage and source outboxes through independent, versioned migrations for each
  database.
- Avoid destructive rewrites of operational tables during initial analytics rollout.
- Start event emission behind controlled rollout flags while existing product flows remain
  authoritative.
- Generate deterministic source and event identities for backfilled records so repeated backfills
  are idempotent.
- Mark each fact as live, backfilled, replayed, or migration baseline.
- Reconstruct historical transitions only when existing records provide reliable timestamped
  evidence.
- When only current state exists, emit a migration baseline rather than fabricating earlier state
  transitions.
- Record reliable coverage start, backfill limitations, and estimation state for each source.
- Keep existing reporting paths active until the new projections pass parity and quality checks.

Migration of the analytics database to another PostgreSQL server must require data transfer,
checkpoint verification, configuration change, and service redeployment—not changes to domain
schemas or UI reporting contracts.

### E2 approval checklist

- [x] Approve a dedicated logical customer-analytics PostgreSQL database.
- [x] Approve optional shared PostgreSQL server placement while retaining independent database and
  connection boundaries.
- [x] Approve `ANALYTICS_DATABASE_URL` as the deployment portability boundary.
- [x] Approve source-owned Core, Agent Platform, and Tenant Platform outboxes.
- [x] Approve a reporting-scope registry for Core organizations, tenant workspaces, and tenant
  clients.
- [x] Approve a closure table for scalable scope hierarchy and descendant rollups.
- [x] Approve a producer registry with contract and scope-kind restrictions.
- [x] Approve separate shared tables for events, provider observations, source state, projection
  checkpoints, and ingestion failures.
- [x] Approve domain-specific projections instead of one unrestricted metric-key/value model.
- [x] Approve textual cross-service identifiers and internal 64-bit processing sequence IDs.
- [x] Approve the repository-owned JSON Schema contract registry and major-version rules.
- [x] Approve UTC storage with reporting-scope-timezone boundaries.
- [x] Approve measured indexing, partitioning, and future storage scale-out decisions.
- [x] Approve truthful, deterministic, additive backfill and migration rules.

## E3 — Collection, transactional outboxes, ingestion, replay, and reconciliation

**Status:** Approved

### Standalone analytics subsystem

Build customer analytics as a standalone service from the first implementation. Do not embed its
ingestion, projections, workers, database repositories, or reporting queries in Core, Agent
Platform, or Tenant Platform.

The repository boundary is:

```text
server/kasitek-analytics/
├── Analytics API
├── Analytics worker
├── Contract validation
├── Ingestion and quarantine
├── Reconciliation and replay
├── Projection builders
└── Reporting APIs
```

The service produces two independently deployable processes from the same codebase:

- `analytics-api` owns authenticated ingestion, health/readiness endpoints, and reporting APIs.
- `analytics-worker` owns projection building, source reconciliation, replay jobs, provider metric
  processing, and scheduled data-quality work.

Both processes use `ANALYTICS_DATABASE_URL`; no Core, Agent Platform, or Tenant Platform process
receives analytics database credentials. The analytics database may share a PostgreSQL server with
other logical databases, but the service and database ownership boundaries remain independent.

The standalone service boundary is part of the baseline architecture. There is no planned
in-process Core ingestion mode to extract later.

### One ingestion path

Core, Agent Platform, and Tenant Platform publish through the same private batch-ingestion API. No
producer writes directly to analytics tables.

```text
Core transaction ───────▶ Core outbox ───────┐
Agent transaction ──────▶ Agent outbox ──────┼──▶ authenticated batch HTTP
Tenant transaction ─────▶ Tenant outbox ─────┘                 │
                                                               ▼
                                                    `server/kasitek-analytics`
                                                         Analytics API
                                                               │
                                                       Analytics database
                                                               │
                                                        Analytics worker
                                                               │
                                                Projections and reporting APIs
```

The private endpoint accepts registered producer credentials only. The authenticated credential
determines the source service and allowed record categories. A submitted envelope cannot override
its authenticated source identity. The endpoint is not exposed to browsers or public API clients.

Core and Tenant Platform remain available when the analytics service or database is unavailable.
Agent runs and deliveries also continue. Source outboxes retain facts until the analytics service
recovers; customer analytics reports expose stale or unavailable state rather than affecting
product operations.

### Contract-aware producer libraries

Provide one shared Rust producer library for Core and Tenant Platform and a TypeScript producer
library for Agent Platform. Both use the repository-owned JSON Schema contracts from E2 and expose
typed helpers for scope definitions, events, and provider observations.

Producer helpers must:

- Accept the caller's existing database transaction.
- Construct the CloudEvents-compatible envelope and validated attributes.
- Require reporting-scope kind and external ID, source domain, event or observation identity,
  schema version, subject, occurrence time, and idempotency information.
- Add correlation, causation, actor, and safe typed references where available.
- Reject malformed contracts and prohibited fields before the domain transaction commits.
- Insert an immutable envelope into the source analytics outbox.

Feature code must not perform fire-and-forget analytics HTTP calls. An operational change and its
outbox fact commit atomically or roll back together.

Core realtime Redis events and public webhook deliveries remain separate transport concerns and
are not analytics sources. Agent Platform `agent_events` remains its internal runtime and activity
timeline. Tenant Platform `workspace_usage_events` remains a usage and limits source rather than a
general analytics event store. Only explicitly approved facts are written to source analytics
outboxes; the analytics system does not automatically export runtime, audit, or usage ledgers.

### Source outbox model

Core, Agent Platform, and Tenant Platform each own an `analytics_outbox` table through their
existing independent migration systems. Each row contains:

- Immutable outbox ID, record identity, source service, source domain, reporting-scope reference,
  record category, contract name, schema version, envelope, and payload hash
- Monotonic 64-bit source sequence generated by the source database
- Mutable delivery status, attempt count, next-attempt time, lease owner, lease expiry, last safe
  error code, delivered time, and quarantined time
- Created and updated timestamps

Enforce uniqueness for source plus event or observation identity. Index claimable work by status
and next-attempt time, and index source sequence for reconciliation and range replay. Keep envelope
content immutable after insertion; corrections are new facts.

Delivery states are `pending`, `leased`, `delivered`, and `quarantined`. A stale lease returns to
claimable work automatically. Delivered and quarantined retention will be defined in E6; workers
must not immediately delete them because reconciliation and controlled replay require evidence.

### Publisher behavior

Core, Agent, and Tenant publishers run as independently scalable worker processes using the
repository's established `FOR UPDATE SKIP LOCKED` claiming pattern.

- Claim bounded configurable batches with a short renewable lease.
- Send one authenticated batch request to the analytics API.
- Process a result for each record rather than treating the whole batch as one outcome.
- Mark only accepted or identical duplicate records as delivered.
- Retry transport, timeout, service-unavailable, and database-unavailable responses.
- Apply exponential backoff with jitter and a configured upper bound.
- Reclaim expired leases after worker crashes.
- Keep retrying transient failures at the capped interval; do not permanently disable analytics
  publication after a fixed attempt count.
- Alert on oldest-pending age, repeated attempts, backlog growth, and source-sequence gaps.
- Use circuit breaking and bounded concurrency so an analytics outage cannot exhaust source
  database connections or application resources.

One invalid record must not block unrelated records. Batch size, lease duration, request timeout,
concurrency, and retry bounds are configuration with tested safe defaults, not feature-level
settings.

### Ingestion transaction

For each submitted record, the Analytics API:

1. Authenticates the producer and derives its source identity.
2. Enforces request, batch, and record-size limits.
3. Validates the envelope and resolves the exact contract version.
4. Resolves a valid registered reporting scope and verifies that the producer may publish its
   scope kind.
5. Applies privacy classification and prohibited-field rules.
6. Verifies the canonical payload hash and source sequence.
7. Inserts the immutable event or observation idempotently.
8. Updates the durable ingestion cursor and source health in the same analytics transaction.
9. Returns a per-record acknowledgement.

Acknowledgement outcomes are:

- `accepted`: the record was committed.
- `duplicate`: the same source identity and canonical payload were already committed.
- `rejected`: a permanent contract, authorization, scope, identity, or privacy failure was
  quarantined.
- `retryable`: the record was not committed because of a transient service or storage failure.

The same source and event ID with the same hash is a safe duplicate. The same identity with a
different hash is an identity conflict: reject and quarantine it, emit an operational alert, and
never select one payload silently.

### Scope-definition ingestion

Add `scope_definition` as a controlled ingestion record category. Core publishes organization scope
definitions; Tenant Platform publishes tenant workspace, tenant-client, parent relationship,
status, and timezone definitions. Scope definitions are versioned, idempotent, and ordered through
the same source outbox as domain facts.

The Analytics API validates that a producer owns the declared scope kind and external identifier,
then updates `analytics_reporting_scope` and `analytics_scope_ancestor` atomically. A child scope
definition requires a valid authorized parent. Reparenting is a controlled migration operation,
not an ordinary event update.

If a domain fact arrives before its scope definition because of concurrent or delayed delivery,
return retryable `scope_not_ready`; do not discard it or quarantine it as permanently invalid.

Do not write raw message bodies, prompts, responses, phone numbers, emails, credentials, provider
tokens, or unrestricted provider payloads to ingestion logs, failures, or quarantine. E6 will
define any tightly controlled diagnostic payload retention.

### Ordering, cursors, and late records

Preserve source sequence, occurred-at time, observed-at time, and ingested-at time. HTTP arrival
order is not treated as business order.

Maintain a durable ingestion cursor per authenticated source stream with the highest received
sequence, highest contiguous sequence, known gaps, latest acceptance time, and latest
reconciliation time. Projections use deterministic ordering and must tolerate delayed and
out-of-order facts. When a late fact changes a previously projected time window, enqueue that
window for recomputation rather than mutating the source fact.

### Provider metric collection

Provider synchronization jobs normalize external metrics into approved observation contracts and
send them through the same source outbox and ingestion API. A successful source transaction stores
its provider cursor or synchronization checkpoint together with the normalized observations it
queues.

Each observation includes provider, connection reference, metric key, unit, reporting window,
observed-at time, synchronization run, allowed dimensions, and safe source evidence. Provider
revisions append newer observations for the same reporting window. Raw provider responses and
credentials remain in their controlled operational boundary.

### Reconciliation and replay

The Analytics worker performs generic source reconciliation by comparing:

- The producer's highest outbox sequence
- The producer's highest delivered sequence
- The analytics service's highest received and highest contiguous sequences
- Detected missing ranges and unresolved quarantined records

Each producer exposes an authenticated reconciliation summary; the analytics service does not
query source databases directly. Domain-specific count and checksum reconciliation is added with
feature instrumentation in E7.

Authorized, audited controls support replay by exact identity, source-sequence range,
reporting-scope-and-time range, or approved backfill job. Replay preserves the original event
identity and relies on idempotent ingestion to prevent double counting. Quarantine release requires
the record to pass the current approved contract or an explicit versioned repair transformation;
operators cannot edit immutable stored facts directly.

### Operational visibility

The standalone subsystem exposes health and readiness separately:

- Liveness verifies that the process is running.
- API readiness verifies ingestion dependencies and reports reporting availability.
- Worker readiness verifies database access, leases, and projection dependencies.

Operational telemetry includes accepted, duplicate, rejected, retryable, and quarantined counts;
ingestion latency; oldest outbox age; backlog size; attempts; source gaps; reconciliation lag;
projection lag; worker lease recovery; and reporting freshness. These are infrastructure and
pipeline-health signals, not customer business metrics.

### Required E3 verification

Implementation is not complete until automated integration tests prove:

- Rolling back a domain transaction also removes its outbox fact.
- Committing a domain transaction durably preserves its outbox fact.
- Worker crashes and expired leases do not lose records.
- Lost acknowledgements result in harmless identical duplicates.
- Conflicting duplicate identities are quarantined.
- Invalid records do not block valid records in the same batch.
- Analytics outages do not block Core, Agent Platform, or Tenant Platform operations.
- Backlogs drain after analytics service recovery.
- Out-of-order and late records are detected and projected correctly.
- One producer or reporting scope cannot impersonate another.
- Tenant-client facts cannot be attached to another tenant workspace.
- Parent-scope relationships do not grant reporting access without an explicit authorization grant.
- Range replay and backfill remain idempotent.
- Provider revisions remain append-only and historically visible.
- Reconciliation detects and repairs missing source-sequence ranges.

### Baseline technology decision

The approved baseline uses authenticated HTTP, transactional PostgreSQL outboxes, a standalone
analytics service, a dedicated PostgreSQL analytics database, and PostgreSQL-backed projection
workers. Kafka, ClickHouse, and external pipeline products are not hidden implementation tasks or
informal future promises. They are excluded from this baseline and require a separate measured
architecture decision if the capacity thresholds defined in E8 and E9 are exceeded.

### E3 approval checklist

- [x] Approve `server/kasitek-analytics/` as a standalone subsystem from the first implementation.
- [x] Approve independent Analytics API and Analytics worker deployment processes.
- [x] Approve exclusive analytics database ownership by the analytics service.
- [x] Approve one authenticated batch-ingestion path for Core, Agent Platform, and Tenant Platform.
- [x] Approve a transaction-aware shared Rust producer for Core and Tenant Platform and a
  TypeScript producer for Agent Platform.
- [x] Approve separate source outboxes and explicit allow-listed analytics facts.
- [x] Approve scope-definition ingestion and retryable handling when a scope is not ready.
- [x] Approve leased batch publishing, per-record acknowledgements, bounded retries, and automatic
  stale-lease recovery.
- [x] Approve contract validation, privacy enforcement, deduplication, and quarantine at ingestion.
- [x] Approve monotonic source sequences, durable ingestion cursors, gap detection, and late-data
  handling.
- [x] Approve provider observations through the same durable ingestion pipeline.
- [x] Approve authenticated reconciliation, idempotent replay, and audited quarantine repair.
- [x] Approve operational health, backlog, latency, gap, and projection-lag telemetry.
- [x] Approve Kafka, ClickHouse, and external pipeline products as excluded from the baseline unless
  measured thresholds require a new architecture decision.

## E4 — Metric registry, semantic definitions, and reporting API contracts

**Status:** Approved

### Semantic-layer boundary

Analytics events and provider observations record what happened. The metric registry defines how
those facts become customer-facing numbers. Reporting APIs are the only customer-facing path for
calculating and returning those numbers.

Do not calculate business metrics independently in browsers, Core, Agent Platform, Tenant
Platform, exports, alerts, scheduled reports, or agent tools. Every consumer uses the same
registered metric identity and version through the Analytics reporting boundary.

### Repository-owned metric registry

Keep the versioned metric registry with the standalone analytics service:

```text
server/kasitek-analytics/
└── metrics/
    ├── registry.schema.json
    ├── domains/
    │   ├── inbox/
    │   ├── campaigns/
    │   ├── content/
    │   ├── agents/
    │   ├── calls/
    │   ├── bookings/
    │   ├── contacts/
    │   └── connections/
    ├── dimensions/
    └── metric-sets/
```

Definitions use human-readable YAML validated against a repository-owned JSON Schema and compiled
into a deterministic registry artifact during the build. Reporting processes load the compiled
artifact; customers cannot edit formulas or submit executable expressions at runtime.

Metric identities are stable and domain-qualified, with a major version, for example:

- `campaign.recipients.delivered@1`
- `campaign.delivery_rate@1`
- `conversation.first_response_time@1`
- `agent.runs.completed@1`
- `booking.completion_rate@1`
- `contact.consent.opt_out_rate@1`

Each definition declares:

- Stable key, major version, domain, owning team, technical description, and lifecycle state
- Value type, unit, precision, and currency behavior where applicable
- Source facts, observations, projections, and metric dependencies
- Formula or a restricted typed projection implementation reference
- Numerator, denominator, eligible population, and exclusions for ratios and rates
- Time semantics, including event-time, reporting-window, snapshot, or current-state behavior
- Default aggregation, temporal aggregation, supported intervals, and comparison behavior
- Supported reporting-scope kinds and descendant aggregation strategy
- Safe filters and breakdown dimensions, including distinct-entity deduplication behavior
- Required permissions, privacy classification, and applicability conditions
- Exact or estimated status plus freshness, coverage, and availability requirements
- Effective period, deprecation state, and replacement identity where applicable

Metric lifecycle states are `draft`, `active`, `deprecated`, and `retired`. A breaking formula,
denominator, population, unit, or aggregation change creates a new major metric version. Label and
description corrections may remain compatible. Dashboards and reports retain their selected major
version until they are explicitly migrated; the registry must not silently rewrite historical
meaning.

### Calculation and aggregation rules

The registry and projection engine enforce these rules:

- Aggregate the numerator and denominator of a rate before division. Never average child-scope or
  time-bucket percentages.
- Do not sum distinct counts across scopes unless the underlying populations are guaranteed to be
  disjoint. Otherwise use a deduplicating projection at the requested scope.
- Do not sum snapshots or current-state gauges across time.
- Store durations in an approved base unit and retain the count and distribution information
  needed for weighted averages and percentiles.
- Do not combine monetary values across currencies without an approved, versioned conversion
  method. Return currency groups or an unavailable state instead.
- Select provider observations according to their reporting window, observation time, source, and
  revision semantics. Do not add cumulative provider snapshots together.
- Calculate comparisons with the same metric version, population, timezone, and aggregation rules
  as the primary period.
- Distinguish missing, unsupported, uninstrumented, stale, partially covered, backfilling, and
  inapplicable data. Zero means the metric was available and the measured value was zero.
- Apply conditional Agent metrics from the product plan. Conversation, workflow, schedule,
  external-operation, and customer-handoff metrics appear only when the agent has the applicable
  deployment or capability.

### Controlled dimension registry

Register dimensions separately from metrics. Initial dimensions include channel, provider,
connection, campaign, content post and variant, media and content type, template, agent definition,
agent version, agent installation, conversation channel, responder type, outcome, status, booking
service, consent source, consent purpose, and other approved domain references.

Each dimension declares its type, source, compatible metrics, filter and grouping support,
cardinality class, privacy classification, stable key behavior, and required permission. Display
labels remain separate from stable keys.

Reporting scope is an authorization boundary, not a normal metric dimension. Descendant-scope
comparison requires an explicit scope grant and `analytics:compare_children`. High-cardinality
entity identifiers are available only through approved, bounded breakdowns or paginated drilldown
routes; a reporting request cannot group by arbitrary event attributes.

### Metric sets and dashboard definitions

Named, versioned metric sets define standard reports such as:

- `overview.summary@1`
- `campaign.performance@1`
- `content.performance@1`
- `inbox.performance@1`
- `agent.performance@1`
- `booking.performance@1`
- `contact.audience_health@1`

Feature dashboards use metric sets by default. Configurable dashboards may select registered
metrics and approved dimensions, but cannot define formulas, SQL, source tables, or arbitrary
attributes.

Dashboard configuration is separate from metric results. A tenant or Core dashboard stores its
own scope, title, widget layout, metric identities, date preset, breakdowns, visibility, and
branding configuration. Analytics returns the actual values. A saved dashboard never stores
placeholder metric values as if they were observations.

### Scope-aware reporting API

The Analytics API owns these baseline customer-reporting routes:

```text
GET  /v1/metrics/catalog
POST /v1/reports/query
```

The catalog returns only metrics, metric sets, dimensions, intervals, and capabilities available
to the authorized principal for the selected reporting scope. It is the source for dashboard
configuration and agent-readable metric discovery.

The query route accepts one authorized reporting scope, an end-exclusive date range, an effective
IANA timezone, a requested or automatic interval, registered metric identities or one registered
metric set, approved filters and breakdowns, optional comparison, optional descendant inclusion,
and bounded result sizes. Exact request limits are set and load-tested in E9.

The route does not accept SQL, arbitrary expressions, user-defined formulas, source table names,
or unregistered fields. Invalid combinations fail before query execution.

Core and Tenant Platform remain responsible for customer authentication, current membership,
roles, and assignments. Their gateways issue the short-lived signed reporting authorization from
E1 and may proxy browser requests. Analytics independently validates the authorization, requested
scope, descendant rule, metric permissions, and expiry. It never trusts a browser-supplied scope
identifier by itself.

Authorized agents use the same reporting contracts with agent-specific, time-limited scope and
metric grants. They do not receive analytics database access, a raw query interface, or a separate
interpretation of a metric.

### Reporting response contract

Every successful response identifies the effective scope, requested and effective range,
interval, timezone, generation time, and data-as-of time. Each returned metric includes:

- Metric identity, version, unit, and typed value
- Numerator and denominator for rates and ratios
- Time series and approved breakdowns when requested
- Server-calculated comparison values
- Availability, coverage, freshness, and applicable warnings
- Exact or estimated calculation status
- Metric-registry and projection versions used

Decimal and monetary values use strings to preserve precision. Integer counts are range-checked
for the published client contract. Unavailable values are `null` only when accompanied by an
explicit availability state. Supported states are:

- `available`
- `partial`
- `stale`
- `unsupported`
- `not_instrumented`
- `not_applicable`
- `backfilling`
- `unavailable`

A valid multi-metric report may succeed with per-metric partial or unavailable states. Missing
source data does not turn into zero and does not fail unrelated metrics. Invalid syntax,
unauthorized scopes, prohibited metrics or dimensions, oversized requests, unsupported
combinations, rate limits, and service outages use explicit API errors.

### Registry validation and compatibility

Continuous integration rejects duplicate identities, invalid definitions, metric dependency
cycles, incompatible units, undocumented rate denominators, unsupported dimensions, unsafe
descendant aggregation, missing ownership or permissions, breaking changes without a new major
version, and metric sets that reference unknown or retired metrics.

Golden fixtures provide known facts and expected results for important formulas, boundaries,
late-data behavior, descendant aggregation, and availability states. The build generates typed
Rust and TypeScript metric identities from the validated registry so producers, projection code,
reporting handlers, clients, and tests do not maintain handwritten copies.

### Existing reporting migration boundary

Later implementation sections must:

- Replace browser-side Social calculations with Content and Campaign analytics reports.
- Replace the Agent analytics page with date-aware registered analytics metrics.
- Keep the Agent operations summary only for current runtime and queue health where appropriate.
- Replace Core workspace-reporting scans with the Analytics reporting boundary.
- Replace Tenant Portal placeholder zeros with real metric results and explicit availability.
- Keep Core public API request metrics, Prometheus metrics, billing usage, infrastructure
  observability, and security telemetry outside customer business analytics.

Legacy reporting remains only until E10 parity and rollout acceptance are complete. New
customer-facing reporting must not add another independent metric calculation path.

### E4 approval checklist

- [x] Approve the repository-owned, YAML-authored, JSON-Schema-validated metric registry.
- [x] Approve stable domain-qualified metric identities and explicit major-version migration.
- [x] Approve documented formulas, denominators, populations, time semantics, and applicability.
- [x] Approve safe rate, distinct-count, snapshot, duration, currency, and provider-observation
  aggregation rules.
- [x] Approve the controlled dimension registry and bounded high-cardinality drilldowns.
- [x] Approve reporting scope as an authorization boundary rather than a normal dimension.
- [x] Approve named metric sets and separate saved-dashboard configuration.
- [x] Approve the permission-filtered metric catalog and controlled report-query endpoint.
- [x] Approve one reporting contract for dashboards, exports, alerts, scheduled reports, and
  authorized agents.
- [x] Approve explicit availability, coverage, freshness, exactness, and partial-result metadata.
- [x] Approve build-time registry validation, golden formula fixtures, and generated typed keys.
- [x] Approve migration away from browser calculations, direct operational scans, and Tenant
  placeholder values.

## E5 — Freshness, coverage, availability, backfill, and data-quality rules

**Status:** Approved

### Separate collection and completeness clocks

A source-level `lastSyncedAt` field is not proof that every reporting window or metric is current.
Track these times independently by reporting scope, producer, domain, source or provider
connection, and metric dependency:

- `latestOccurredAt`: newest business event received
- `latestObservedAt`: newest provider observation received
- `latestIngestedAt`: newest fact accepted by Analytics
- `latestProjectedAt`: newest fact incorporated into a reporting projection
- `completeThrough`: latest reporting time verified as complete
- `dataAsOf`: latest data included in a particular result
- `lastReconciledAt`: last successful authoritative comparison

`completeThrough` is the reporting completeness boundary. A request extending beyond it remains
provisional or partial even when newer individual events are present. A historical period already
verified as complete remains available when current collection later becomes stale.

### Source manifests and checkpoints

Silence does not prove that zero events occurred. Each producer periodically publishes a safe,
versioned source manifest or checkpoint through the authenticated ingestion boundary. It contains:

- Reporting scope, producer, domain, and enabled source or provider connection
- Supported event contracts, provider observations, metrics, and dimensions
- Expected refresh cadence and reliable coverage start
- Highest authoritative source sequence
- Approved count or checksum checkpoints where the domain supports them
- Last successful and last attempted collection times
- Safe failure code and next expected attempt
- Disabled, unsupported, awaiting-instrumentation, or active state

Manifests contain no credentials, message content, customer identifiers, or raw provider payloads.
A periodic heartbeat or authoritative checkpoint proves that a healthy source observed a no-event
period. Without that evidence, Analytics reports unknown or degraded coverage rather than zero.

### Freshness classes

Every metric dependency selects a freshness class in the E4 registry. These baseline customer-data
thresholds apply unless a stricter metric or provider contract overrides them:

| Class | Expected update | Stale after |
| --- | ---: | ---: |
| Continuous | 5 minutes | 15 minutes |
| Near realtime | 15 minutes | 1 hour |
| Hourly | 2 hours | 6 hours |
| Daily | 36 hours | 72 hours |
| Provider window | Contract-specific | Contract-specific |

Provider-window metrics must declare when the provider normally makes a window available, when it
normally finalizes it, and how long revisions remain possible. They cannot silently inherit a
generic threshold that does not match the provider contract. E9 will turn these data thresholds
into measured service objectives and alerts.

### Coverage model

Calculate and retain these coverage layers independently:

- **Instrumentation coverage:** eligible entities emitting the required contracts
- **Source coverage:** expected producers and provider connections that reported successfully
- **Transport coverage:** source sequences received without unresolved gaps
- **Temporal coverage:** requested buckets inside reliable coverage ranges
- **Projection coverage:** accepted facts processed by the required projection version
- **Reconciliation coverage:** periods verified against authoritative counts or checksums
- **Dimension coverage:** included records containing the requested breakdown dimension

A coverage percentage is returned only when Analytics knows the expected denominator. Otherwise,
coverage is `unknown`, never an assumed 100%. Responses retain included and expected source,
entity, bucket, and descendant counts plus `completeThrough`. E6 controls whether the principal may
see the identities behind missing contributions.

### Availability-state evaluation

Apply the E4 states deterministically:

- `available`: required sources are fresh and the requested range is complete.
- `partial`: some required sources, scopes, buckets, records, or dimensions are missing.
- `stale`: previously reliable data exists but its freshness threshold has expired.
- `unsupported`: the provider or feature cannot supply the metric.
- `not_instrumented`: the feature could supply the metric but collection is not implemented or
  enabled.
- `not_applicable`: the metric does not apply to the scope, feature, deployment, or agent
  capability.
- `backfilling`: historical reconstruction is active and the requested range is not complete.
- `unavailable`: the calculation cannot currently produce a trustworthy result.

Availability uses the requested range and each metric dependency rather than one global service
status. One report can contain available and degraded metrics together. Dashboards, exports,
alerts, scheduled reports, generated insights, and authorized agents use the same evaluation.

### Parent and descendant coverage

Parent rollups cannot hide unhealthy descendants. When descendants are requested:

- The expected authorized descendants form the coverage population.
- Missing, stale, unsupported, uninstrumented, or backfilling children affect coverage.
- A required incomplete child makes the parent result partial.
- Numerators and denominators include only verified contributing data.
- Responses may expose excluded contribution counts without exposing unauthorized child
  identities.
- Rebuilding one child does not make unrelated child projections unavailable.

Cross-scope references never count the same fact twice. Scope ownership and rollup deduplication
remain governed by E1, E2, and E4.

### Late and revised data

Each source contract declares an allowed lateness window. Facts received inside the window
recompute affected open buckets. A valid fact received after completion creates a tracked revision
and recomputes only the affected reporting windows. Provider revisions append new observations and
follow the same rule.

Revised results update `dataAsOf`, projection generation, and revision metadata. Comparisons use
compatible metric and projection versions. Produced exports and scheduled-report artifacts retain
the generation and availability metadata used when they were created. Immutable source facts are
never edited, and valid late data is never silently ignored.

### Managed backfills and projection rebuilds

Backfills are managed Analytics jobs, not informal scripts. Supported methods are deterministic
reconstruction from authoritative operational records, replay of immutable analytics facts,
approved provider-history imports, and projection rebuilds from stored facts.

Each backfill job records scope, domain, source, requested range, contract and projection versions,
method, limitations, status, checkpoint, scanned and accepted counts, rejections, remaining work,
coverage before and after, requesting actor, authorization, timestamps, and safe failures.

Job states are `queued`, `running`, `paused`, `failed`, `completed`, and `cancelled`. Jobs are
bounded, resumable, idempotent, and independently executable per scope. Backfilled facts retain
their original business time and are marked as backfilled rather than live-collected.

Projection rebuilds write a separate generation. Analytics validates its checkpoints, counts,
quality findings, and query compatibility before atomically promoting it. A failed or cancelled
rebuild leaves the current reporting generation unchanged; customers never see a half-rebuilt
projection.

### Data-quality checks and issue lifecycle

Continuously check:

- Contract validity, duplicate identity, and conflicting payload hashes
- Missing source sequences and unresolved quarantine
- Invalid scope, hierarchy, or entity references
- Impossible, unexpectedly old, or future timestamps
- Invalid lifecycle transitions
- Prohibited negative values, unit mismatches, and currency mismatches
- Impossible numerator and denominator relationships and funnel inconsistencies
- Missing required attribution or dimension values
- Projection divergence from source counts or checksums
- Provider windows that stop advancing
- Reconciliation mismatches
- Unexpected volume spikes or drops after sufficient baseline data exists

Quality issues use `info`, `warning`, `error`, or `critical` severity and `open`, `acknowledged`,
`resolved`, or `suppressed` state. Suppression requires a reason, actor, audit record, and expiry; it
cannot permanently conceal a failing source. Safe customer-facing reasons remain separate from
restricted operational diagnostics.

### Analytics quality records

Extend the E2 storage model with:

- `analytics_source_manifest`
- `analytics_coverage_checkpoint`
- `analytics_reconciliation_run`
- `analytics_quality_issue`
- `analytics_backfill_job`
- `analytics_projection_generation`

`analytics_source_state` remains the current summarized collection state. The additional records
preserve historical manifests, checks, reconciliation evidence, quality incidents, backfill
progress, and projection promotion history.

### Customer-facing disclosure rules

Healthy reports show a concise updated time. Degraded reports show a short `Partial`, `Stale`, or
`Backfilling` status and a safe reason. Available metrics remain visible when unrelated metrics are
degraded. Missing data never renders as zero.

Exports and scheduled reports include data-as-of, coverage, availability, metric version, and
projection generation metadata. Business alerts do not evaluate incomplete data unless their
definition explicitly permits partial coverage. Generated insights and agents must state material
limitations and cannot present unavailable metrics as facts.

### Required E5 verification

Implementation is not complete until automated tests prove:

- A verified no-event period can be distinguished from stopped collection.
- Source-sequence gaps lower coverage and cannot produce apparently complete totals.
- Stale sources cannot produce apparently current results.
- Historical complete ranges remain usable during a current outage.
- Provider revisions and late events recompute only affected windows.
- Parent rollups expose incomplete descendant coverage without leaking unauthorized identities.
- Unknown coverage never becomes 100%.
- Backfills are resumable, idempotent, and independently scoped.
- Projection generations promote atomically and failed rebuilds preserve the active generation.
- Dashboards, exports, alerts, scheduled reports, insights, and agents receive identical
  availability decisions.
- Tenant-client isolation applies to source health, quality issues, backfills, and coverage
  metadata.

### E5 approval checklist

- [x] Approve separate occurred, observed, ingested, projected, complete-through, data-as-of, and
  reconciled clocks.
- [x] Approve producer source manifests and heartbeats so silence is not treated as zero.
- [x] Approve baseline freshness classes with explicit provider-window overrides.
- [x] Approve independent instrumentation, source, transport, temporal, projection,
  reconciliation, and dimension coverage.
- [x] Approve known-denominator-only coverage percentages.
- [x] Approve deterministic availability states shared by every analytics consumer.
- [x] Approve partial parent rollups when required descendants are incomplete.
- [x] Approve source-specific lateness windows and tracked historical revisions.
- [x] Approve managed, resumable, idempotent backfills and atomic projection generations.
- [x] Approve persistent quality checks, issue severity, lifecycle, and expiring suppression.
- [x] Approve customer-facing limitations for dashboards, exports, alerts, insights, and agents.
- [x] Approve the required E5 completeness, revision, backfill, and isolation tests.

## E6 — Reporting-scope isolation, privacy, retention, deletion, and audit rules

**Status:** Approved

### Reporting authorization path

Browsers do not call Analytics directly. A browser calls Core or Tenant Platform, which
authenticates the current session, resolves current roles and assignments, issues a short-lived
reporting grant, and calls the Analytics API. Core and Tenant Platform remain authoritative for
customer users, roles, memberships, assignments, status, and revocation.

Analytics validates the signed reporting grant independently. A browser-provided scope ID, root
scope ID, organization header, tenant slug, client ID, cookie, or role name is never sufficient
authorization.

### Signed reporting grants

Reuse the existing ES256 delegation foundation with Analytics-specific audiences, separate Core,
Tenant Platform, and Agent issuers, key IDs, rotating public keys, and strict issuer, audience, and
validity checks.

Every grant contains issuer, audience, subject, key ID, token ID, issued-at, not-before, expiry,
principal type and ID, exact reporting scope and root scope, permissions, descendant mode,
explicit descendants where applicable, metric or metric-set restrictions, sensitive-dimension
restrictions, authorization-policy version, and correlation information. Agent grants also contain
installation, run, and invocation references.

Interactive and agent reporting grants expire after no more than 120 seconds. Gateways issue them
server-to-server for each operation and do not return them to browser JavaScript. Reporting reads
may reuse a grant during its short validity; unlike one-time action delegations, an ordinary read
does not consume the token after one request.

### Descendant authorization

Supported descendant modes are:

- `none`: authorize only the exact selected scope.
- `all`: authorize all current descendants, available only through an authoritative owner or
  administrator policy.
- `explicit`: authorize only the signed bounded set of descendant scope IDs.

A parent scope never grants descendant access automatically. Analytics verifies the signed rule
against `analytics_scope_ancestor`. Large descendant comparisons use bounded explicit batches; no
customer grant permits an unrestricted root-level query.

### Default customer role policies

Core organization `OWNER` and `ADMIN` roles receive read, export, report and alert management, and
authorized Agent-detail access for their organization. `MEMBER` receives read access and the Agent
analytics already visible through product policy, but no export or report and alert administration
by default.

Tenant workspace `owner` and `admin` roles receive workspace reporting, all current client
descendants, comparison, export, report and alert management, and authorized Agent drilldown.
`account_manager` receives assigned tenant-client scopes with approved read and export access.
`support` receives assigned client read and approved Agent-detail access. `viewer` receives
read-only access to explicitly assigned scopes.

Add a source-owned `tenant_client_assignments` model before account managers, support users, or
viewers receive descendant Analytics grants. Their existing broad workspace-route access is not
authorization for cross-client analytics.

Tenant-client `owner` and `admin` roles receive read, export, report and alert management, and
authorized Agent analytics for their own client. Client `member` or `viewer` roles receive
read-only client analytics. A tenant-client session cannot authorize its parent workspace or a
sibling client.

Role-to-permission policies are versioned in Core and Tenant Platform. Analytics receives resolved
permissions rather than trusting raw role names.

### Agent reporting authorization

Authorized agents receive only `analytics:read`, metrics marked `agentReadable`, one exact scope,
a bounded date range, and approved aggregate dimensions. Agents cannot export, manage reports or
alerts, compare arbitrary descendants, access individual customer records, or use unrestricted
drilldowns.

The baseline customer permissions are:

```text
analytics:read
analytics:export
analytics:manage_reports
analytics:manage_alerts
analytics:compare_children
analytics:read_agent_details
```

Metric definitions and dimensions may require narrower additional permissions but cannot bypass
the baseline controls.

### Revocation and background execution

Core or Tenant Platform resolves authorization before every customer operation. Removed members,
changed roles, removed assignments, suspended scopes, and suspended Agent installations stop
receiving new grants immediately. A captured internal grant remains useful for at most 120 seconds.

Scheduled reports and alerts do not store permanent user grants. They reauthorize their owner and
scope at execution and pause when the owner, role, assignment, or scope is no longer valid. Export
downloads also require fresh authorization.

### Database roles and row isolation

Use separate PostgreSQL roles:

- `analytics_ingest` for authenticated immutable ingestion
- `analytics_worker` for projections, reconciliation, backfill, and generation promotion
- `analytics_reporter` for customer-facing reporting projections
- `analytics_operator` for tightly controlled audited operations

The reporting role cannot read raw payloads, quarantine content, credentials, or restricted
diagnostics. Every customer-facing projection, cache, dashboard, report, export, alert, and quality
summary has non-null scope and root-scope IDs.

Enable PostgreSQL row-level security on customer-facing tables as defense in depth. The API sets
the exact authorized scope in each reporting transaction. Repository queries also require explicit
scope predicates; RLS does not replace application authorization. Workers use separate credentials
and connection pools.

### Cache and artifact isolation

Cache identities include scope, authorized descendant set or policy fingerprint, permissions,
range, timezone, interval, filters, breakdowns, metric versions, projection generation, and
availability generation. Results cannot cross grants merely because their visible query fields
match.

Exports, scheduled-report artifacts, alerts, and saved dashboards retain an owning reporting
scope. Moving an artifact to another scope requires recreation and fresh authorization.

### Privacy classification and prohibited data

Analytics contracts classify data as:

- `aggregate`: non-identifying counts, rates, durations, and monetary totals
- `pseudonymous`: approved opaque customer and domain-entity references
- `sensitive`: explicitly approved restricted dimensions or diagnostics
- `prohibited`: content or secrets that ingestion must reject

The baseline accepts aggregate and approved pseudonymous fields. Sensitive fields require an
explicit contract, permission, retention rule, and reporting use.

Prohibited data includes message bodies, prompts, model responses, call audio, transcripts,
emails, phone numbers, names, exact addresses, IP addresses, user agents, credentials, tokens,
authorization headers, payment details, knowledge documents, attachments, raw provider payloads,
and unrestricted metadata JSON. Contract validation rejects these fields before ingestion;
quarantine and logs do not copy them.

### Pseudonymous references and small groups

Sources derive stable, scope-bound opaque subject references using a versioned keyed derivation.
Analytics can correlate the same subject inside the approved scope where required without being
able to reverse the reference into an email or phone number. Cross-scope identity linking requires
a separately approved attribution contract. Record key versions so rotation and erasure remain
deterministic.

Suppress aggregate breakdown cells representing fewer than five customer subjects when a
dimension could expose personal behavior. Apply complementary suppression where subtraction could
reveal a hidden cell. Individual operational workflows remain in the owning feature service with
their own permissions; Analytics does not become a customer-record browser.

### Baseline retention

| Data | Retention |
| --- | ---: |
| Immutable analytics events | 25 months |
| Provider observations | 25 months |
| Hourly projections | 13 months |
| Daily and monthly aggregates | 7 years |
| Source manifests and detailed reconciliation | 13 months |
| Quarantine diagnostics | 30 days |
| Detailed backfill execution logs | 90 days |
| Backfill, deletion, hold, export, and control audit summaries | 7 years |
| Successful reporting-access logs | 1 year |
| Denied or suspicious access records | 2 years |
| Generated export files | 24 hours |
| Encrypted database backups | 35 days |

Retain registry definitions and calculation versions in repository history so retained reports
remain interpretable. A policy may shorten retention. Extending it requires an explicit policy
change, privacy and storage review, and audit record; feature code cannot choose arbitrary
retention.

### Legal holds

A legal hold preserves otherwise expiring data for an exact scope, subject, entity type, and time
range. It requires an authorized compliance operator, two-person approval, a documented reason,
explicit scope, creation and review times, expiry or periodic review, and immutable audit.

A hold does not grant reporting access. Expired holds resume normal retention; indefinite informal
holds are prohibited.

### Subject erasure

An authoritative producer submits a versioned `subject_erasure_requested` command using the opaque
subject reference. Analytics validates ownership, creates an audited job, blocks new facts for the
subject using a non-identifying tombstone, removes subject-linked facts and dimensions, rebuilds
affected projections, invalidates derived artifacts, records holds and exceptions, and returns a
durable acknowledgement.

Operational content remains the responsibility of its owning service and follows that service's
deletion workflow.

### Reporting-scope deletion

Organization, tenant-workspace, and tenant-client deletion uses this coordinated lifecycle:

```text
active
→ deletion_requested
→ analytics_purge_running
→ analytics_purge_verified
→ deleted
```

An operational service must not delete the scope and its outbox before Analytics receives and
acknowledges the deletion request. Analytics removes facts, observations, projections, caches,
dashboard and report configuration, alerts, schedules, exports, quality details, and pseudonymous
references. It retains only the minimum non-identifying deletion audit and scope tombstone needed
to reject delayed or replayed data.

Tenant-client deletion removes only that client's owned data and rebuilds parent projections
without it. Active databases are purged by the job; encrypted backups expire within 35 days. A
restored backup cannot serve reports until the deletion ledger and tombstones have been reapplied.

### Exports and scheduled delivery

Exports are asynchronous, encrypted, scope-bound, and generated from E4 reports. Generation
requires `analytics:export`; download requires fresh authorization. Files expire after 24 hours,
and creation, completion, download, failure, and expiry are audited.

Analytics does not receive recipient email addresses. Core or Tenant Platform resolves recipients
and performs delivery. Protected reports use short-lived authenticated downloads rather than
permanent public links or unprotected email attachments.

### Analytics audit records

Maintain append-only audit records for reporting access, authorization denials, exports and
downloads, dashboard/report/alert changes, scheduled execution, Agent analytics access, metric and
dimension policy changes, backfill, replay, reconciliation, projection promotion, retention,
holds, deletion, and support or operator access.

Audit entries contain principal and type, scope, permission, metric keys, request and filter hashes,
outcome, correlation ID, policy version, and timestamp. They never contain report values, message
content, prompts, customer identifiers, credentials, tokens, or raw payloads.

Control records are append-only and hash-chained with periodically signed checkpoints. Successful
high-volume reads may use partitioned access logs but still follow retention and scope rules.

### No global customer-data bypass

The customer Analytics API has no platform-admin permission that reads every customer. KasiTek
internal cross-customer analytics uses its separate plan. Customer support access requires an
explicit, expiring, audited scope grant through the existing support-access foundation.

### Required E6 verification

Implementation is not complete until automated tests prove:

- Browser-supplied scope identifiers cannot grant access.
- Core members cannot access another organization.
- Tenant clients cannot access siblings or parent workspaces.
- Workspace staff cannot access unassigned clients.
- Owner and administrator descendant grants contain only current descendants.
- Role or assignment removal prevents new grants immediately.
- Agent grants cannot export or use prohibited metrics and dimensions.
- RLS blocks cross-scope reads when an application predicate is missing.
- Caches, exports, alerts, and scheduled reports cannot cross authorization boundaries.
- Small-group suppression resists subtraction.
- Prohibited data is rejected before ingestion and excluded from quarantine.
- Subject erasure rebuilds affected projections.
- Client deletion preserves sibling data and rebuilds parent results.
- Backup restoration reapplies deletion records before reporting.
- Legal holds preserve data without granting access.
- Scheduled work stops when authorization is revoked.
- Audit records contain no report values or sensitive payloads.

### E6 approval checklist

- [x] Approve server-to-server, short-lived signed reporting grants.
- [x] Approve exact-scope and explicit descendant authorization.
- [x] Approve the default Core, tenant-workspace, tenant-client, and Agent permission policies.
- [x] Approve `tenant_client_assignments` before staff receive assigned-client analytics.
- [x] Approve per-operation reauthorization for exports, alerts, and scheduled reports.
- [x] Approve separate database roles, scoped repositories, and reporting-table RLS.
- [x] Approve authorization-aware caches and derived artifacts.
- [x] Approve aggregate, pseudonymous, sensitive, and prohibited privacy classes.
- [x] Approve scope-bound pseudonymous subjects and minimum-five small-group suppression.
- [x] Approve the explicit baseline retention schedule and controlled extensions.
- [x] Approve two-person, scoped, expiring legal holds.
- [x] Approve coordinated subject erasure and reporting-scope deletion workflows.
- [x] Approve 35-day backup expiry and deletion-ledger replay before restored reporting.
- [x] Approve protected, 24-hour exports and source-owned recipient delivery.
- [x] Approve append-only, privacy-safe, tamper-evident Analytics audit records.
- [x] Approve no global customer-data bypass in the customer Analytics API.
- [x] Approve the required E6 authorization, isolation, privacy, and deletion tests.

## E7 — Core, Agent, and Tenant feature instrumentation sequence and ownership map

**Status:** Approved

### Product-contract gates

Before implementation begins, finish and approve Contacts and Audience Section 8 in
`ANALYTICS_PLAN.md`, then plan and approve Connections and Platform Health Section 9 and
Cross-feature Attribution Section 10. E7 fixes their implementation position and ownership but
does not silently treat unfinished field contracts as approved.

### Parallel producer lanes

Execute three producer lanes in parallel: Core, Agent Platform, and Tenant Platform. Respect the
dependencies inside each lane and the cross-domain gates below. Dashboard order does not determine
instrumentation order.

Current readiness is:

| Domain | Existing foundation | Primary gaps |
| --- | --- | --- |
| Agents | Lifecycle, runs, events, tools, effects, schedules, and conversations | Analytics outbox, declared outcomes, consistent usage and cost, dispatch history, customer-specific handoff |
| Inbox | Conversations, messages, delivery fields, and message events | Required scope ownership, responder attribution, assignment and resolution history, response timing, customer handoff |
| Campaigns | Campaigns, recipients, delivery timestamps, send events, and counters | Lifecycle facts, eligibility decisions, retry and batch details, normalized failures, cost, attribution |
| Content | Posts, variants, publish jobs, external IDs, and delivery snapshots | Lifecycle history, provider observations and sync runs, safe dimensions, attribution |
| Contacts | Canonical customers, WhatsApp contacts, and list membership | Consent history, purpose, evidence, suppression and guard decisions, membership history |
| Calls | Canonical calls, legs, provider status, and timing | Handler and Agent references, transition history, outcomes, cost, attribution |
| Bookings | Services and current booking state | Lifecycle history, actor and source, attribution, availability, reminders, outcomes |
| Connections | Current connection, credential, webhook, and health state | Health and capability history, sync runs, incidents, coverage evidence |
| Tenant Platform | Workspaces, clients, users, roles, leads, conversations, Agents, and usage | Analytics outbox, assignments, lifecycle history, safe facts, manifests, reconciliation |
| Attribution | Isolated references in some domains | Typed edges, confidence, windows, deduplication, outcome ownership |

### Complete vertical-slice rule

Every participating domain delivers:

1. Operational schema additions
2. A domain command, worker, or webhook transaction
3. Transactional analytics outbox emission
4. Versioned contract and privacy classification
5. Source manifest and reconciliation checkpoint
6. Historical backfill with an honest reliable-coverage boundary
7. Analytics projection and registered metrics
8. Reporting API results
9. Isolation, replay, late-data, and formula tests
10. Legacy parity before old calculations are removed

Event emission alone does not complete a domain. Do not use generic database-change capture or
table triggers to invent business meaning. The owning domain command knows whether a mutation means
campaign launched, booking cancelled, or handoff claimed and writes that semantic outbox fact in
the same transaction.

### Core lane: scope and ownership

First publish Core organization scope definitions, add an authoritative organization reporting
timezone, resolve nullable organization ownership for analytics-eligible records, establish
scope-bound pseudonymous customer references, and add Core's outbox, publisher, source manifests,
and reconciliation endpoint. Unowned legacy records cannot appear as valid customer analytics.

#### Execution slice 4 — Source reconciliation summaries

- [x] Add a shared Rust producer query that reports bounded source-stream summaries without
  reading or transmitting envelopes, content, customer identifiers, or provider payloads.
- [x] Post authenticated reconciliation summaries to the existing Analytics endpoint with the
  producer-derived identity, explicit scope binding, source watermarks, and authoritative count.
- [x] Run reconciliation from both Core and Tenant publishers with configurable interval and
  stream bounds; keep source outbox facts unchanged when Analytics is unavailable.
- [x] Cover the authenticated reconciliation wire contract and preserve the existing source
  outbox lease/delivery path.
- [x] Add the versioned, privacy-safe source-manifest contract, stream-scoped manifest identity,
  Core/Tenant transactional enqueue helpers, authenticated Analytics persistence, duplicate handling,
  and reconciliation counting.
- [ ] Add source-manifest heartbeat scheduling and domain-specific checksums only after the
  corresponding domain-owned schedules and authoritative source counters exist.

### Core lane: Connections foundation

Connections owns created, connected, disconnected, revoked, and needs-attention transitions;
credential and webhook health without secrets; capability enablement; provider synchronization
attempts and outcomes; rate limits; incidents; and reliable provider coverage windows.

Inbox, Campaign, Content, and Calls depend on this collection evidence. Final customer-facing
Connection metrics remain gated on Product Section 9 approval.

#### Execution slice 1 — connection lifecycle and health facts

- [x] Register versioned, privacy-safe lifecycle and health-check contracts with bounded provider
  and state fields; exclude account identifiers, display fields, metadata, credentials, tokens,
  provider payloads, and raw errors.
- [x] Register lifecycle and health-check count metrics with provider, lifecycle, status, credential,
  health, and webhook dimensions; keep coverage partial until all authoritative connection paths
  and historical backfill are complete.
- [x] Emit connection-created and status-transition facts from Core synchronization, explicit
  status commands, and direct Twilio connection creation without producing facts for unchanged
  reads or idempotent upserts.
- [x] Emit bounded health-check facts in the same transaction as Core's ExternalConnection health
  state update, preserving the operational error only in Core.
- [x] Add transactional producer/privacy coverage for both connection contracts.
- [ ] Add historical backfill, projections, and reporting results in subsequent Connections slices.

#### Execution slice 2 — capability enablement history

- [x] Register a versioned capability lifecycle contract with a stable logical identity of
  connection plus capability; exclude provider account data, credentials, tokens, metadata, and
  provider payloads.
- [x] Register capability transition metrics and connect them to the shared provider, capability,
  and lifecycle dimensions and the overview metric set.
- [x] Compare Core's capability projection before and after its delete/rebuild operation so only
  newly observed or enabled-state-changed capabilities emit facts.
- [x] Emit capability facts in the same Core transaction as the capability projection rebuild.
- [x] Cover the capability contract with transactional producer and privacy tests.
- [x] Add an organization-scoped source manifest heartbeat from successful synchronization, with
  the current authoritative connection population as a bounded source checkpoint; leave reliable
  historical coverage unset until backfill and reconciliation establish it.

#### Execution slice 3 — provider synchronization outcomes

- [x] Register `connection.sync_attempt@1` with an attempt reference, stable connection reference,
  provider, operation, succeeded/failed outcome, bounded failure class, duration, and event time;
  exclude provider payloads, credentials, account identifiers, and raw errors.
- [x] Register `connection.sync_attempts@1` with provider, operation, outcome, and failure-class
  dimensions and add it to the overview metric set without claiming complete provider coverage.
- [x] Instrument the authoritative WhatsApp connection refresh and social identity refresh paths,
  including bounded failures, while leaving existing health-check facts separate.
- [x] Emit synchronization outcomes through the Core transactional outbox without rebuilding the
  full connection projection for each attempt; use Core's deterministic ExternalConnection
  reference mapping.
- [x] Add producer/privacy coverage and bounded error-classification tests, and regenerate the
  Rust and TypeScript registry bindings.
- [ ] Add historical backfill, projections, reporting, and full mutation-to-reporting E2E in later
  Connections slices.

#### Execution slice 4 — rate-limit and incident evidence

- [x] Preserve provider HTTP 429 responses as a stable Core rate-limited error instead of
  collapsing them into a generic provider rejection; do not export the provider response body.
- [x] Register `connection.rate_limit@1` and `connection.rate_limit_encounters@1` with provider,
  operation, bounded scope, and optional bounded retry metadata; coverage remains partial.
- [x] Emit a rate-limit fact beside the failed synchronization outcome in the same Core outbox
  transaction for instrumented connection refresh operations.
- [x] Register `connection.incident.lifecycle@1` and `connection.incidents@1` for customer-visible
  connection health openings and recoveries with bounded severity and reason codes.
- [x] Emit incident facts transactionally with `ExternalConnection` health state transitions and
  suppress duplicates while a connection remains in the same health state.
- [x] Add producer/privacy fixture coverage, registry bindings, 429 mapping coverage, and health
  incident boundary tests.
- [ ] Add historical backfill, projections, reporting, and full mutation-to-reporting E2E in later
  Connections slices.

#### Execution slice 5 — source manifest and coverage evidence

- [x] Publish `source.manifest@1` for the organization-scoped Core Connections stream from the
  successful synchronization transaction, coalesced to one immutable manifest per observed
  refresh window; do not claim an independent scheduler yet.
- [x] Declare the actual Connections contracts, metrics, and dimensions already registered in
  Analytics; keep the manifest provider-neutral because it describes the organization source.
- [x] Include the authoritative current `ExternalConnection` population as an approved source
  checkpoint, while leaving reliable historical coverage and transport sequence evidence unset.
- [x] Preserve transactional durability, privacy exclusions, and same-window idempotent
  coalescing in focused Core tests.
- [ ] Add historical event backfill, temporal coverage checkpoints, reporting results, and full
  mutation-to-reporting E2E after the Connections projection boundary exists.

#### Execution slice 6 — typed Connections projection boundary

- [x] Route the registered Connections event metrics through a dedicated `connections.v1` typed
  projection builder instead of allowing an unsupported-domain fallback.
- [x] Validate the domain-specific event fields required for lifecycle, health, capability, sync,
  rate-limit, and incident metrics before writing typed contributions.
- [x] Map the registered Connections dimensions from bounded event attributes and keep internal
  connection references out of customer-facing dimension JSON.
- [x] Preserve partial/observed coverage semantics in projection contributions; a projection pass
  does not convert partial instrumentation into reliable historical coverage.
- [x] Verify generation processing, replay idempotence, rollups, dimension mapping, and builder
  identity against a PostgreSQL fixture covering all six Connections metrics.
- [x] Materialize one Analytics-owned source coverage checkpoint in the same transaction as each
  accepted manifest, linked by immutable `source_manifest_id`; duplicate delivery creates no second
  checkpoint.
- [x] Preserve the source boundary honestly: the checkpoint reports the approved current population
  and refresh window, while `complete_through` and reliable historical coverage remain unset.
- [x] Add the full Core Connections mutation-boundary transport E2E: the ignored PostgreSQL fixture
  invokes all six transactional Core Connections fact producers plus the source manifest, publishes
  through the authenticated shared transport, and verifies Core delivery state, Analytics manifest
  persistence, event contracts, and privacy boundaries. This is transport coverage only; it does not
  claim projection or historical completeness.
- [ ] Add historical event backfill, reporting availability results, and full mutation-to-reporting
  E2E in the next Connections slices.

#### Execution slice 7 — source-manifest coverage checkpoint receipt

- [x] Insert a source-layer checkpoint after the manifest row is accepted and before the ingestion
  transaction commits; a checkpoint failure rolls the manifest back and returns a retryable result.
- [x] Carry only bounded scope, refresh-window, count, coverage-state, and manifest-reference data;
  do not copy connection references, provider payloads, checkpoint hashes, or credentials.
- [x] Derive `available`, `stale`, `unknown`, and `unavailable` from manifest state and safe failure
  evidence without turning a current source population into a historical completeness claim.
- [x] Verify accepted manifests, duplicate delivery, privacy exclusions, and incomplete-history
  semantics in the PostgreSQL ingestion fixture.
- [x] Persist reconciliation-layer checkpoints only for scope-bound streams with an actual stored
  event or observation window; empty streams do not receive fabricated temporal coverage.
- [x] Link reconciliation checkpoints directly to their immutable reconciliation run and make
  retries idempotent.
- [x] Add a Core Connections source-reconstruction worker that reads only the immutable,
  privacy-filtered Core Connections event history in `analytics_outbox`, preserves original event
  envelopes and business time, uses deterministic backfill sequences, and excludes manifests from
  event reconstruction; it does not read Analytics storage or mutable connection projections.
- [x] Verify native Core worker-to-Analytics source reconstruction through authenticated job claim,
  backfill ingestion, job completion, backfilled event persistence, and an `available` temporal
  checkpoint with the requested `complete_through` boundary.
- [x] Verify one authorized Connections lifecycle report from reconstructed fact through typed
  projection, required-source validation, temporal coverage, and provider/lifecycle dimensions.
- [x] Verify all six registered Connections metrics report as available after the same temporal
  backfill boundary, with each metric's required source and one aggregate series present.
- [ ] Expose the approved customer-facing Connections analytics surfaces after Product Section 9
  approval and the remaining UI scope is implemented.

#### Execution slice 8 — reconciliation coverage evidence

- [x] Add an optional immutable `reconciliation_run_id` evidence link to coverage checkpoints with a
  unique partial index so one reconciliation run can produce at most one checkpoint.
- [x] Persist complete reconciliation as `available` and mismatched reconciliation as `partial`,
  preserving expected, included, and excluded counts without copying raw source data.
- [x] Derive the checkpoint window from stored event business time and observation reporting windows;
  do not use reconciliation execution time as a fake data window.
- [x] Preserve the historical boundary: `complete_through` is set only for a complete reconciliation
  and does not establish reliable coverage before the earliest known fact.
- [x] Verify complete, mismatch, duplicate-run, privacy, and empty-stream behavior in PostgreSQL.

#### Execution slice 9 — source-history backfill coverage

- [x] Add an optional unique `backfill_job_id` evidence link to coverage checkpoints.
- [x] Persist a temporal checkpoint in the same ingestion transaction when an authenticated
  source-reconstruction or provider-history backfill reaches its finite completion boundary.
- [x] Bind checkpoint producer and source service to the authenticated producer identity; derive
  domain, scope, requested window, and counts from the authorized backfill job.
- [x] Set `complete_through` only when the completed job has no rejected records; preserve a
  `partial` checkpoint when rejected records are recorded.
- [x] Exclude `fact_replay` and `projection_rebuild` from temporal source-completeness evidence.
- [x] Allow an exact duplicate retry of a final record after job completion without requiring the
  now-completed job to authorize a second count or checkpoint.
- [x] Verify completion counts, temporal window, producer provenance, privacy, duplicate retry, and
  replay exclusion in PostgreSQL.
- [x] Add the safe source-side rejected-record completion boundary in execution slice 12; records
  rejected before job authorization remain outside the count until identity evidence is durable.

#### Execution slice 10 — reporting availability evidence

- [x] Load temporal and reconciliation coverage by registered metric domain and authorized scope;
  source-manifest coverage remains separate from temporal report completeness.
- [x] Require a requested range to be inside an `available` checkpoint with a `complete_through`
  boundary before reporting temporal coverage as `available`.
- [x] Surface active queued, running, and paused source-history backfills as `backfilling` for
  overlapping metric domains and ranges.
- [x] Aggregate authorized scope evidence conservatively: missing child evidence prevents an
  apparently complete parent result and produces `partial` coverage.
- [x] Include evidence layer, evidence window, and `complete_through` in each metric's reporting
  coverage metadata.
- [x] Verify available, partial, backfilling, missing-scope, and incomplete-boundary behavior in
  unit and PostgreSQL reporting tests.
- [x] Add richer rejected-record completion evidence in execution slice 12 before exports, alerts,
  and customer surfaces consume all coverage metadata.

#### Execution slice 11 — projection and dimension coverage

- [x] Derive projection-layer state from the authorized promoted generation checkpoint: idle is
  `available`, active rebuild/processing is `partial`, failed processing is `unavailable`, and no
  generation is `unknown`.
- [x] Keep projection-layer state separate from temporal completeness; a processed projection does
  not claim that the source range is historically complete.
- [x] Evaluate requested breakdown values from the authorized report points and mark missing values
  as `partial` without exposing unauthorized dimension identities.
- [x] Return projection state, dimension state, and missing-dimension point counts in coverage
  metadata alongside the temporal evidence window.
- [x] Verify idle, rebuilding, missing-generation, no-breakdown, and missing-dimension behavior in
  unit and PostgreSQL reporting tests.

#### Execution slice 12 — required-source evidence and rejected backfill completion

- [x] Read each metric's registered `coverage.required_sources` and expose it in the metric
  coverage response; do not infer source completeness from a metric's display value.
- [x] Validate projection-row coverage metadata against the registered required-source set and
  return `available`, `partial`, or `unknown` evidence when metadata is consistent, incomplete,
  or absent. Keep this source-evidence state separate from projection checkpoint state and
  downgrade an otherwise available report to `partial` when the metadata is contradictory.
- [x] Count a permanent source-backfill rejection only after the authenticated backfill job has
  been locked and authorized, writing the failure receipt and rejected count in one transaction.
- [x] Do not consume a backfill record for retryable storage/scope failures; retain the retryable
  acknowledgement and avoid overstating completion.
- [x] Produce a partial temporal checkpoint with `included_count`, `excluded_count`, and no
  `complete_through` when the final authorized source-reconstruction record is rejected.
- [x] Preserve exact-duplicate retry behavior after job completion and keep `fact_replay` and
  `projection_rebuild` outside source temporal-completeness evidence.
- [x] Sanitize malformed stream, identity, sequence, schema, domain, and payload fields before
  writing quarantine evidence; raw malformed values and payloads are not copied into the failure
  table.
- [x] Require the authenticated producer ID and locked source-service backfill job before counting
  a structural rejection; producer mismatches and unauthorized jobs remain uncounted.
- [x] Verify registered-source matching, missing/mismatched projection metadata, rejected counts,
  partial coverage, and completion-boundary behavior in unit and PostgreSQL tests.
- [x] Extend the counted-rejection boundary to structurally invalid records only after the
  authenticated job is locked; malformed values use a deterministic digest identity and never
  become trusted source identifiers.

### Core lane: Inbox

Inbox owns conversation opened, reopened, assigned, unassigned, resolved, closed, and archived
facts; message accepted, sent, delivered, read, failed, retried, edited, and deleted facts;
responder attribution; response and resolution timing; and safe connection, customer, Agent, run,
outcome, and attribution references. Message content and customer identifiers remain excluded.

### Core lane: Contacts and Campaigns

Implement Contacts and Campaign instrumentation together because Campaign eligibility depends on
canonical consent.

Contacts owns consent and suppression history, list-membership history, purpose, channel, provider,
evidence, source method, actor, effective time, and the guard state used by outbound messaging.

Campaigns owns lifecycle, audience snapshots, per-recipient eligibility and suppression decisions,
attempts, retries, batches, provider transitions, normalized failure reasons, timing, pricing,
cost, and outcome references. Current Campaign counters remain operational projections rather than
the historical source. This stage requires Product Section 8 approval.

### Core lane: Content

Content owns post and variant lifecycle, per-platform publish history, approved content dimensions,
and provider metric observations with sync runs, coverage windows, revisions, rate-limit state, and
unsupported state. It also emits safe tracked-link, conversation, campaign, booking, and Agent
references.

Begin provider observations with Meta and Instagram when their collectors return verified data.
Other providers report `unsupported` or `not_instrumented`, never zero.

### Core lane: Calls

Calls owns canonical call and leg lifecycle, ringing through terminal transitions, human/Agent/
automation handler attribution, Agent and run references, normalized outcome, duration,
time-to-answer, failure, provider, connection, cost, and approved cross-feature references. Raw
payloads, phone numbers, recordings, and transcripts stay operational.

### Core lane: Bookings

Bookings owns availability checks, created, confirmed, rescheduled, completed, cancelled, and
no-show transitions; original and changed schedule times; actor and source; service, channel,
location and resource references; attribution; and reminder facts when reminders exist. Add
lifecycle history before claiming reliable historical coverage from mutable current rows.

### Agent Platform lane: common lifecycle

All Agent categories emit definition, version, installation, deployment, pause, resume, archive,
and deletion facts; complete run lifecycle; model calls, usage, latency, provider, model, and
approved cost; tools and effects; approvals and external waits; errors; and retries. These common
facts do not depend on customer-handoff capability.

### Agent Platform lane: declared outcomes

Each Agent version or workflow declares versioned supported outcomes. Agent Platform validates and
emits `agent.outcome_recorded` with success, failure, reason, duration, and typed entity references.
Run completion is not automatically a successful business outcome.

### Agent Platform lane: workflows and schedules

Emit workflow and node identity/version, objective status, expected versus actual schedule
dispatch, missed, delayed and duplicate dispatch, node timing, routes, retries, waits, effects, and
terminal outcomes.

### Agent Platform lane: conditional conversations

Only conversational deployments emit conversation volume, response timing, channel and delivery,
customer-conversation references, and Agent versus human responder attribution. Personal KasiAi,
test, customer, and externally connected conversations remain distinct categories.

#### Execution slice 1 — Agent conversation and message facts

- [x] Register bounded conversation lifecycle and message lifecycle contracts without titles,
  previews, identifiers for external customers, provider message IDs, or transcript content.
- [x] Register lifecycle, message, delivery-state, responder, channel, and response-time metrics
  with tenant-compatible scope and dimension bindings.
- [x] Emit conversation creation, open, archive, restore, delete, message creation, and delivery
  status facts from the Agent Platform's transactional mutation paths.
- [x] Cover generic conversations, private platform chats, channel-ingested messages, agent replies,
  and customer-service human replies through the same analytics helper.
- [x] Keep personal, test, customer, and external conversation kinds distinct in every fact.
- [x] Measure response time only for outbound Agent or human messages following a customer message.
- [x] Verify producer privacy and organization isolation with unit and live database tests.

### Core Inbox lane

Core Inbox remains the owner of customer conversations stored in Core. It must not reuse Agent
Platform conversation contracts or infer handoff from an ordinary message. Assignment, resolution,
and customer takeover facts remain pending until Core has authoritative commands and history for
those transitions.

#### Execution slice 1 — WhatsApp conversation and message facts

- [x] Register Core-owned conversation lifecycle and message lifecycle contracts with internal
  conversation/message references only; exclude content, customer identifiers, provider IDs,
  credentials, and unrestricted provider payloads.
- [x] Register lifecycle, direction, responder, channel, delivery-state, and response-time metrics
  with the existing scope-compatible dimensions.
- [x] Emit new WhatsApp conversation facts when Core creates an Inbox conversation.
- [x] Emit inbound customer message acceptance and outbound human/Agent message creation facts in
  the same transaction as the Core message and conversation mutations.
- [x] Emit queued, sent, delivered, read, and failed WhatsApp delivery transitions transactionally
  with the authoritative message status update where the current Core code has that transition.
- [x] Measure response time only for outbound human or Agent messages following a customer message.
- [x] Preserve Agent-vs-human attribution for Core's direct Agent delivery path and workspace Inbox
  queue path without treating every Core `bot` row as an Agent response.

#### Execution slice 2 — Meta Inbox conversation and message facts

- [x] Add Meta Inbox conversation-open and inbound customer message facts from the webhook
  insertion paths, using the same bounded Core contracts and organization scope.
- [x] Add Meta human outbound creation, provider send success/failure, retry, delivery, read, and
  delivery-backfill facts from the authoritative Core mutations and webhook receipt paths.
- [x] Preserve Meta channel and message-type dimensions while keeping content, customer
  identifiers, provider IDs, credentials, and raw provider payloads out of analytics attributes.
- [x] Emit a Meta-specific `source.manifest@1` checkpoint from successful Core message mutation
  transactions, with the current organization-scoped Meta message population and declared
  contracts, metrics, and dimensions.
- [x] Keep the Meta source checkpoint event-driven, immutable, same-window idempotent, and
  explicitly non-historical: `reliable_coverage_start` and temporal completion remain unset until
  an authenticated source reconstruction or approved provider-history import completes.
- [x] Include the authorized reporting scope's external organization ID in leased source-history
  work so Core can reconstruct only the requested organization without querying Analytics storage.
- [x] Add the authenticated Core-side transport contract for claiming this work and submitting
  bounded reconstructed batches, with deterministic record-identity sequences and live-cursor
  isolation.
- [x] Add a bounded Core Meta source-reconstruction worker that reads organization-scoped
  conversations/messages by their authoritative timestamps, derives responder markers without
  retaining provider payloads, and runs independently from live outbox delivery.
- [x] Add historical source-reconstruction coverage with an honest temporal completion boundary
  for Meta Inbox.
- [x] Keep historical Meta facts out of live transport reconciliation counts and windows while
  preserving their separate temporal evidence.
- [x] Preserve Meta message dimensions in typed projections and carry source-coverage metadata
  into rollups used by reporting.
- [x] Add an authenticated ingestion-to-projection-to-reporting PostgreSQL E2E fixture covering
  scoped grants, temporal evidence, and message-dimension breakdowns.
- [x] Add the full Core mutation-to-source-outbox-to-publisher-to-Analytics system E2E; the
  ignored PostgreSQL fixture starts the real Analytics API, invokes the transactional Core Inbox
  producer boundary, publishes through the shared authenticated transport, and verifies Core
  delivery state plus the persisted Analytics facts. The broader product mutation-to-reporting
  gate remains shared work across the later vertical slices.

#### Execution slice 3 — Core Inbox deletion facts

- [x] Emit a bounded WhatsApp conversation deletion fact in the same transaction as the
  organization-scoped conversation and message removal.
- [x] Emit an explicit WhatsApp message deletion fact with direction, responder attribution, and
  message type, without retaining content, customer identifiers, or provider IDs.
- [x] Keep bulk message cleanup represented by the conversation deletion fact rather than creating
  an unbounded per-message analytics fan-out.
- [x] Audit Core's current Meta Inbox mutation paths for an authoritative conversation or message
  deletion command; none exists, so no Meta deletion fact is emitted or inferred from webhook absence.
- [ ] Add Meta deletion facts if Core introduces an authoritative Meta conversation or message
  deletion mutation; do not infer deletion from webhook absence or provider payloads.

- [ ] Complete the remaining Core Inbox-owned conversation and message facts; do not make Agent
  Platform the owner of Core Inbox conversations.

### Core Campaigns lane

Campaign delivery analytics remains a Core Campaigns responsibility. Campaign recipient rows and
provider send/webhook transitions remain operationally authoritative; Analytics receives only
stable campaign/recipient references, bounded channel/provider values, event time, and normalized
recipient outcomes.

#### Execution slice 1 — recipient sent and delivered facts

- [x] Reuse the registered `campaign.recipient.sent@1` and
  `campaign.recipient.delivered@1` contracts and their existing delivery metrics.
- [x] Add a transactional Core Campaigns producer with an organization-scoped campaigns stream,
  stable campaign-recipient event identities, and no contact values, message content, credentials,
  tokens, or unrestricted provider payloads.
- [x] Emit the sent fact in the same transaction as the authoritative provider-send success
  transition, including the existing-send recovery path.
- [x] Emit the delivered fact in the same transaction as the authoritative WhatsApp delivery
  webhook transition; repeated unchanged delivery statuses do not emit another fact.
- [x] Add Core producer privacy and rollback coverage against the local Analytics outbox migration.
- [x] Add the authenticated Core outbox-to-publisher-to-Analytics ingestion E2E, including stable
  identity deduplication and sent/delivered event privacy checks.
- [x] Verify the registered sent, delivered, and delivery-rate metrics through the signed reporting
  fixture, including distinct-recipient and numerator/denominator aggregation paths.
- [x] Add campaign source manifests, historical reconstruction, and reliable coverage boundaries.
- [x] Add transactional campaign retry and complete provider-outcome facts; numeric cost and
  complete mutation-to-reporting coverage remain before claiming complete Campaign performance
  coverage. Suppression and eligibility facts are covered in slice 5.
- [x] Add one ignored combined mutation-to-publisher-to-projection-to-reporting E2E for Campaign
  delivery, including manifest and pricing assertions; runtime requires the disposable Core and
  Analytics URLs recorded in `blockers.md`.

#### Execution slice 2 — recipient read facts

- [x] Add `campaign.recipient.read@1` with the existing bounded campaign, recipient, channel,
  provider, event-time, and fixed `read` status shape.
- [x] Register `campaign.recipients.read@1`, add it to the overview metric set, and regenerate
  the Rust/TypeScript registry bindings.
- [x] Emit the read fact in the same transaction as Core's authoritative WhatsApp `READ` status
  transition; repeated unchanged statuses remain deduplicated.
- [x] Extend Core privacy/rollback, authenticated publisher, and reporting coverage for the read
  fact and distinct-recipient aggregation.
- [x] Add read-delay timing through the shared Campaign timing contract and weighted-average
  reporting path in execution slice 6.

#### Execution slice 3 — recipient failure facts

- [x] Add and register `campaign.recipient.failed@1` with bounded `failure_class`; blocked outcomes
  remain a separate later fact and are not counted as failures.
- [x] Emit failure facts transactionally for provider-send failures, entitlement failures, and
  WhatsApp provider `FAILED` webhook transitions.
- [x] Extend Core privacy/rollback, authenticated publisher, and reporting coverage for failure
  facts and the `failure_class` breakdown.

#### Execution slice 4 — recipient blocked facts

- [x] Add and register `campaign.recipient.blocked@1` with a separate bounded `block_class`; blocked
  outcomes are not included in failure metrics.
- [x] Emit blocked facts transactionally for Core provider-send failures and Meta webhook failures;
  known Meta block signals are normalized to `BLOCKED` before the operational transition is saved.
- [x] Extend Core privacy/rollback, authenticated publisher, and reporting coverage for blocked facts
  and the `block_class` breakdown.

#### Execution slice 5 — suppression, eligibility, and unsubscribe facts

- [x] Add and register `campaign.recipient.suppressed@1` with bounded
  `suppression_class` values for manual exclusion, opt-in, contact exclusion, cooldown, and
  policy guards.
- [x] Add and register `campaign.recipient.unsubscribed@1` with bounded unsubscribe sources;
  the event contains only stable campaign/recipient references and aggregate-safe dimensions.
- [x] Emit manual-exclusion facts transactionally when campaign creation persists skipped
  recipients.
- [x] Emit eligibility-guard suppression facts transactionally at the authoritative send boundary
  when opt-in, contact exclusion, or cooldown state prevents delivery.
- [x] Emit keyword-unsubscribe facts transactionally with the WhatsApp contact and pending
  recipient unsubscribe transitions.
- [x] Add suppression/unsubscribe metrics, dimensions, overview registration, Core rollback/privacy
  coverage, authenticated publisher coverage, and signed reporting breakdowns.
- [ ] Add retry, timing, numeric cost, attribution, source manifests, historical reconstruction, and the
  combined mutation-to-publisher-to-projection-to-reporting E2E in later Campaign slices.

#### Execution slice 6 — timing facts and numeric event aggregation

- [x] Add and register `campaign.recipient.timing@1` with bounded timing kinds and a non-negative
  duration in milliseconds; no contact, message, or provider payload data is included.
- [x] Emit send-to-delivered, send-to-read, and delivered-to-read timing facts transactionally
  with authoritative WhatsApp delivery/read transitions when the required timestamps exist.
- [x] Add `campaign.delivery_delay_ms` with weighted-average aggregation and a timing-kind
  breakdown to the overview metric set.
- [x] Fix the shared projection/reporting path so event metrics declared as weighted averages use
  the numeric field named by their formula instead of treating every event as value `1`.
- [x] Add Core rollback/privacy, authenticated publisher, projection, and signed reporting
  coverage for timing facts and numeric duration output.
- [ ] Add retry, numeric cost, attribution, source manifests, historical reconstruction, and the combined
  mutation-to-publisher-to-projection-to-reporting E2E in later Campaign slices.

#### Execution slice 7 — retry attempts

- [x] Add durable `attemptCount` and `lastAttemptAt` fields to Core Campaign recipients with a
  forward-only database migration and matching Prisma model fields.
- [x] Increment the attempt count when a queued recipient is claimed for provider delivery.
- [x] Enable the existing `retry_failed` campaign action only for inactive campaigns, transition
  failed recipients back to `QUEUED`, resume the campaign, and publish the operational update.
- [x] Add transactional `campaign.recipient.retry@1` facts with bounded reason and attempt number;
  delivery outcomes remain separate facts for each status transition.
- [x] Add retry count reporting, retry-reason compatibility, rollback/privacy coverage, and the
  authenticated publisher/reporting fixture coverage.
- [ ] Add provider retry policy, numeric cost, attribution, source manifests, historical reconstruction,
  and the combined mutation-to-publisher-to-projection-to-reporting E2E in later slices.

#### Execution slice 8 — source manifest and historical reconstruction

- [x] Publish a source manifest after a successful campaign recipient population snapshot with a
  bounded current count and explicit non-historical coverage state.
- [x] Route authenticated Campaign source-history jobs to a Core worker that reads immutable Core
  Campaign analytics outbox events, preserves original envelopes and business time, assigns
  deterministic backfill sequences, and excludes manifest records.
- [x] Keep reconstructed Campaign facts separate from live reconciliation counts and source
  manifests.
- [ ] Add native Campaign backfill/reconciliation fixture; the combined mutation-to-publisher-to-
  projection-to-reporting E2E is covered above. Numeric currency cost and cross-feature attribution remain separate
  contracts. Billable/category/model/type metadata is covered by the provider pricing slice below.

#### Execution slice 9 — provider pricing metadata

- [x] Register `campaign.recipient.pricing@1` with billable state and bounded provider pricing
  category, model, and type; no provider payload, customer contact value, or currency amount is
  copied into the analytics event.
- [x] Parse WhatsApp status pricing metadata at the Core webhook boundary and persist the available
  fields on the operational send event when a matching campaign send exists.
- [x] Emit the pricing fact transactionally with the pricing-field update, deduplicate by campaign
  recipient, and expose a filterable pricing-record count metric with billable/category/model/type
  dimensions.
- [x] Regenerate registry bindings and verify registry validation plus Core/Analytics library
  compilation.
- [ ] Add an authoritative numeric cost source and cross-feature attribution after their source
  ledgers and ownership boundaries exist; see `blockers.md`.

### Agent Platform lane: customer handoff

Customer-takeover analytics applies only to a customer-facing Agent whose workflow has the
customer-handoff capability and for which the customer or an authorized workspace user requested
takeover.

Add dedicated request, reason, queue entry, claim, human response, resolution, release, expiry, and
return-to-Agent history. The generic `awaiting_human` workflow state does not classify every human
wait as customer takeover.

#### Execution slice 2 — dedicated customer handoff

- [x] Reuse the existing customer-service handoff repository boundary; ordinary personal, test, and
  non-handoff Agents remain outside this contract.
- [x] Align every repository-emitted handoff action and status with the versioned Analytics schema,
  including first human response and bounded resolution codes.
- [x] Keep release, expiry, and cancellation explanations out of Analytics; emit only bounded
  resolution codes and preserve operational detail in the Agent Platform audit history.
- [x] Add the customer-handoff lifecycle metric and bounded channel, state, reason, priority, actor,
  and resolution dimensions to the Agent reporting set.
- [x] Project handoff agent references from safe event attributes when the handoff subject is not an
  Agent-definition subject.
- [x] Verify ingestion, typed projection, temporal coverage, authorization, and customer-facing
  reporting with the native PostgreSQL handoff E2E.

### Tenant Platform lane: scope and authorization

First publish workspace and tenant-client scopes, add workspace timezone and an optional client
override, add `tenant_client_assignments`, and add Tenant's outbox, publisher, source manifests,
and reconciliation endpoint. Emit workspace/client hierarchy and status changes.

#### Execution slice 1 — workspace/client scope and lead creation facts

- [x] Publish a tenant workspace scope definition during workspace provisioning and a child tenant
  client scope definition during client creation through the Tenant transactional outbox.
- [x] Register the tenant scope-definition identity and keep the scope payload limited to hierarchy,
  timezone, status, and monotonic source version fields.
- [x] Register `tenant.lead.lifecycle@1` and `tenant.leads.lifecycle_events@1` with bounded source,
  status, action, and score-band dimensions; names, contact values, company, and notes remain
  outside Analytics.
- [x] Emit the lead-created fact in the same Tenant database transaction as the authoritative lead
  insert, scoped to the tenant client and compatible with workspace/client reporting.
- [x] Route Tenant lead events through a typed `tenants.v1` projection builder and regenerate the
  registry bindings.
- [x] Add workspace timezone/client override persistence, client activation/suspension/deletion
  lifecycle facts, and scope status transitions.
- [x] Add `tenant_client_assignments` and assignment lifecycle facts with append-only history,
  bounded roles, soft unassignment, and same-transaction Analytics facts.
- [x] Add Tenant lead status-history commands and lifecycle facts before claiming qualified or
  converted lead analytics; attribution and historical reconstruction remain later slices.
- [ ] Add Tenant source manifests, historical reconstruction, and mutation-to-reporting E2E after
  the authoritative Tenant history boundaries exist.

#### Execution slice 2 — client lifecycle and reporting timezone

- [x] Persist a workspace reporting timezone and optional tenant-client override with a safe UTC
  default; publish the effective timezone in scope definitions.
- [x] Add the Tenant client status command for active, suspended, and archived/deleted states;
  persist the operational state and publish scope status plus an aggregate-safe lifecycle fact in
  the same transaction.
- [x] Register `tenant.client.lifecycle@1`, `tenant.clients.lifecycle_events@1`, and the bounded
  client lifecycle action dimension through the typed Tenant projection builder.
- [x] Regenerate registry bindings and verify Tenant/Analytics compilation and registry validation.
- [x] Add assignment records and lead status history before claiming assigned-client or qualified /
  converted lead analytics.

#### Execution slice 3 — lead status history

- [x] Add append-only Tenant lead status history with bounded target statuses, reason codes, actor
  type, and source-owned actor references; the current lead row remains the operational projection.
- [x] Add tenant-user and tenant-client-user status commands that authorize their own scope and
  write the history row, current status, and aggregate-safe Analytics fact in one transaction.
- [x] Extend `tenant.lead.lifecycle@1` with status-change facts and add reason/actor dimensions;
  raw lead fields and free-form notes remain excluded.
- [x] Verify bounded status/reason helpers, registry validation, and Tenant/Analytics compilation.
- [x] Add tenant-client assignments with authoritative active/revoked state, append-only history,
  bounded role changes, management routes, and typed projection support.
- [ ] Add Tenant source manifests, historical reconstruction, and mutation-to-reporting E2E after
  the remaining Tenant source boundaries exist.

#### Execution slice 4 — client assignments

- [x] Add an operational `tenant_client_assignments` table keyed by workspace, client, and staff
  user, with bounded assignment roles and soft revocation.
- [x] Add append-only assignment history for assigned, unassigned, and role-changed actions.
- [x] Add authenticated management routes for listing, assigning, changing roles, and revoking
  client assignments; enforce workspace, client, and active staff-user boundaries.
- [x] Emit `tenant.client.assignment@1` facts transactionally with assignment state and history;
  Analytics receives stable identifiers and bounded roles only.
- [x] Register assignment metrics/dimensions and route the contract through the typed Tenant
  projection builder.
- [x] Verify formatting, registry validation, Tenant tests, and Tenant/Analytics compilation.
- [ ] Add Tenant manifests, source reconstruction, and full mutation-to-reporting E2E.

### Tenant Platform lane: client administration

Tenant Platform owns client creation, activation, suspension, deletion workflow, client-user
invitation and lifecycle, role and assignment changes, and domain and branding-readiness facts.
These are tenant-specific contracts rather than renamed Core organization events.

### Tenant Platform lane: leads

Add controlled lead lifecycle commands and status history before reporting qualified or converted
totals. Emit actor, source, safe score version and change reason, conversation, campaign, content,
Call, Agent, booking, qualification, and conversion references. Names, emails, phone numbers,
companies, and notes remain outside Analytics.

### Tenant Platform lane: conversations, Agents, and usage

Tenant conversations reuse shared meanings for safe conversation/message lifecycle, direction,
delivery, responder attribution, timing, and outcome references without content or customer
identifiers.

Instrument real workspace/client Agent ownership and lifecycle where the operational model supports
it. `workspace_usage_events` remains a billing and limit source; approved quantities may emit
analytics facts, but the table does not become the general event store. Future Tenant services use
the same vertical-slice checklist only after their authoritative behavior exists.

### Cross-feature attribution lane

Build attribution only after participating domains emit stable typed references. The Analytics
attribution projection owns source and outcome references, model and version, direct or assisted
relationship, window, confidence, evidence category, deduplication, and recalculation after late
data or deletion. Source domains do not calculate competing attribution totals. This lane requires
Product Section 10 approval.

### Delivery milestones

#### M0 — Producer readiness

Complete scopes and timezones, assignments, all three outboxes and publishers, contract validation,
manifests, reconciliation, privacy rejection, and ownership cleanup.

#### M1 — Three reference slices

Deliver Agent common runtime analytics, the reliable existing Core Campaign delivery funnel, and
Tenant workspace/client plus lead-creation analytics. This exercises both producer libraries and
all reporting-scope kinds. Consent and guard metrics remain `not_instrumented` until their approved
stage.

#### M2 — Customer interaction

Deliver Core Inbox, conditional Agent conversation analytics, Tenant conversations, and dedicated
customer-handoff collection.

#### M3 — Marketing integrity

Deliver Contacts consent, Campaign eligibility and guards, complete Campaign performance, and the
required Connections health evidence.

#### M4 — Content performance

Deliver Content lifecycle, provider collectors, coverage, and revisions.

#### M5 — Calls, Bookings, and Tenant completeness

Deliver Calls, Bookings, Tenant lead lifecycle, and Tenant Agent and usage facts.

#### M6 — Attribution and parity

Deliver cross-feature attribution, historical backfills, reliable coverage boundaries, legacy
metric parity, and readiness to remove browser and operational-table calculations.

Milestones define dependency order, not one large branch. Each domain ships through small,
independently verifiable changes behind domain and reporting-scope rollout controls.

### E7 completion rule

A domain is instrumented only when it has live transactional collection, reconciliation, honest
historical coverage, registered metrics, customer reporting, privacy and isolation tests, backfill
or an explicit unsupported range, legacy parity where applicable, and named source-domain and
Analytics owners.

### E7 approval checklist

- [x] Approve completion of Product Sections 8–10 as implementation gates.
- [x] Approve parallel Core, Agent Platform, and Tenant Platform producer lanes.
- [x] Approve complete vertical slices rather than event-only instrumentation.
- [x] Approve domain-owned semantic outbox writes rather than generic change capture.
- [x] Approve Core scope, ownership, timezone, and Connections prerequisites.
- [x] Approve the Inbox, Contacts/Campaigns, Content, Calls, and Bookings ownership map.
- [x] Approve common and conditional Agent analytics with dedicated customer handoff.
- [x] Approve Tenant scope, assignment, administration, lead, conversation, Agent, and usage lanes.
- [x] Approve Analytics-owned cross-feature attribution projections after stable source references.
- [x] Approve M0–M6 as the dependency-ordered delivery milestones.
- [x] Approve per-domain reconciliation, backfill, reporting, parity, ownership, and test completion.

## E8 — Projection, rollup, caching, and scale-out strategy

**Status:** Approved

### Projection layers

Use five explicit layers:

```text
Immutable events and observations
  ↓
Typed domain fact projections
  ↓
Leaf-scope time buckets
  ↓
Ancestor contribution rollups
  ↓
Reporting responses and caches
```

Immutable facts remain the replay source and are not scanned for ordinary dashboard queries.
Typed domain projections preserve conversation, campaign, content, Agent, Call, Booking, consent,
connection, and attribution meaning instead of collapsing every result into one unrestricted
metric-key/value table.

Leaf buckets are built at each fact's narrowest owning scope. They retain mergeable count, sum,
minimum, maximum, numerator, denominator, distribution buckets, currency-specific values,
distinct-entity evidence where supported, coverage, source checkpoint, and projection and metric
versions. Display values such as rates are calculated after the required rollup.

### PostgreSQL-backed projection work

The standalone Analytics worker owns an `analytics_projection_work` queue. Each item records
projection and version, source and target scope, time window, generation, minimum and maximum
source sequence, priority, lease, attempts, and safe failure information.

Ingestion inserts or coalesces dirty-window work in the same Analytics transaction that accepts a
fact. Repeated facts for one projection, scope, and window become one work item. Workers claim
bounded batches using `FOR UPDATE SKIP LOCKED`, short leases, retry backoff, and stale-lease
recovery.

Priority order is:

1. Live continuous and near-realtime windows
2. Late-event and provider revisions
3. Parent contribution rollups
4. Reconciliation repairs
5. Historical backfills
6. Full projection rebuilds

Use independent concurrency by projection family and per-scope fairness so one high-volume scope or
rebuild cannot starve current customer reports. A stable scope hash may assign work internally but
does not enter event or API contracts.

### Deterministic projection transaction

A projection transaction claims a dirty window, reads immutable facts through its captured source
sequence, recalculates the whole window deterministically, upserts typed rows, updates the
checkpoint, bumps the scope/domain generation, enqueues affected ancestor contribution work, and
completes the queue item. Projection rows and checkpoints commit together.

Processing is idempotent and safe after crashes. A periodic sweeper compares facts, dirty windows,
and checkpoints to recover work that was not enqueued or completed correctly.

### Time buckets and timezone revisions

Store source timestamps in UTC. Keep recent UTC hourly buckets for flexible reporting and retain
scope-timezone daily and monthly buckets for long-term reports. Every calendar bucket records its
UTC start and end, IANA timezone, and timezone-policy revision, including daylight-saving days with
23 or 25 hours.

A reporting-scope timezone change applies from its effective time and does not silently reinterpret
older calendar buckets. Reinterpreting history requires an explicit rebuild. Within hourly
retention, an approved presentation-time timezone can be recomputed from hourly buckets; older
periods use the authoritative historical scope timezone.

### Mergeable metric components

Rates store and roll up numerator and denominator before division. Durations retain count, sum,
minimum, maximum, and versioned fixed histogram buckets. Percentiles derived from those histograms
are marked estimated; exact percentiles require a registered bounded drilldown and cannot perform
an unrestricted fact scan.

Distinct child counts are never added. A distinct metric must prove disjoint populations, provide a
target-scope deduplication projection, declare parent rollup unsupported, or use an explicitly
approved estimated algorithm. No approximate distinct-count extension is part of the baseline.

Currency components remain grouped by currency unless an approved conversion metric version
exists. Provider observations are selected by reporting window, revision, and observation time;
cumulative provider snapshots are never summed.

### Hierarchical contribution rollups

Store every fact only at its narrowest owning scope. Parent rollups use contribution rows keyed by
target scope, source scope, projection, bucket, dimensions, and generation.

A workspace-owned fact uses the workspace as both target and source. A client contribution to a
workspace uses the workspace as target and client as source. An independent client report uses the
client as both target and source. Parent queries sum each active source contribution once.

This supports independent client projections, separate workspace-owned facts, rebuilding one
client without rebuilding siblings, exact incomplete-child coverage, authorized client comparison,
and no duplication from parent references. Reparenting invalidates and rebuilds old and new
ancestor contributions without rewriting source facts.

Cross-scope references do not change fact ownership. Attribution edges have one owning scope,
source identity, outcome identity, model/version, and deduplication identity. Parent rollups include
the owned result once. Cross-scope distinct-customer metrics remain unsupported without a separate
approved privacy-safe identity contract.

### Projection generations

Maintain active generation pointers by projection/version, reporting scope, source contribution,
and range where necessary.

A rebuild captures a source watermark, creates a shadow generation, rebuilds through the watermark,
catches up later accepted facts, validates counts, checksums, coverage and query parity, builds
ancestor contributions, and atomically promotes the generation. Retain the previous generation for
a bounded rollback window.

Failed validation leaves the active generation unchanged. A child generation promotes
independently, and the parent switches that child's contribution atomically rather than exposing a
mixed partial rebuild.

### Typed projection schema and indexes

Projection tables use non-null scope/root scope, source scope where applicable, bucket boundaries,
timezone revision, projection/version, generation, typed dimensions, mergeable components, source
checkpoint, coverage, and revision state.

Primary access paths are scope plus bucket, scope/dimension/bucket, target/source/bucket, and
projection/generation/bucket. Use BRIN time indexes on large append-only tables only when measured
plans benefit. Do not add blanket JSON GIN indexes; frequently filtered dimensions graduate into
typed indexed columns.

### Registered reporting query planner

The E4 engine compiles metrics into allow-listed projection queries. It groups compatible metrics
into shared scans, reads only active generations, authorizes before construction, accepts only
registered filters and breakdowns, computes rates and comparisons server-side, and applies E5
coverage and availability.

Interactive queries have bounded metrics, points, dimensions, ranges, and execution time. Larger
requests become asynchronous exports. E9 fixes the exact limits and latency objectives.

### Analytics-owned Redis cache

Use a distributed reporting cache from the baseline through `ANALYTICS_REDIS_URL`. Analytics may
share physical Redis infrastructure but uses separate credentials, namespace, ownership,
monitoring, and eviction policy.

Redis is not authoritative. Its failure falls back to PostgreSQL with bounded concurrency and does
not affect projections. Use a small in-process L1 cache, Redis L2 for authorized aggregate reports,
and short single-flight locks against cache stampedes. Do not cache unrestricted drilldowns or
sensitive diagnostics, and do not use shared CDN or public browser caching.

### Cache identity and invalidation

A canonical cache key includes scope/root scope, descendant-policy fingerprint, permissions and
sensitive-dimension fingerprint, metric and projection versions, active generations, scope/domain
epochs, range, timezone, interval, filters, breakdowns, comparison, limits, registry revision, and
availability-policy revision.

Each projection update increments its scope/domain epoch; ancestor contribution changes increment
ancestor epochs; registry deployments increment the registry revision. Old cache values then become
unreachable without global flushes.

Maintain a bounded scope-to-key index for deletion. Erasure rotates the privacy epoch, removes
indexed entries, and invalidates exports and reports. Cache TTL cannot pass the earliest metric
freshness boundary and is only a safety bound. Do not serve an old response merely because the
reporting database is unavailable; return the explicit service error.

### Workload isolation and replicas

Analytics API and worker use separate roles, pools, statement timeouts, and concurrency limits.
Protect ingestion and live projections from report queries, backfills, exports, hot tenants, and
cache-miss storms. Exports and rebuilds use separate low-priority pools.

A reporting replica may serve reads only when replica lag is included in `dataAsOf` and freshness.
Ingestion, checkpoints, generation promotion, and authorization-critical state always use the
primary.

### PostgreSQL partitioning threshold

Introduce time partitioning only when at least one condition is measured:

- An append table exceeds 100 million retained rows.
- A table or its dominant indexes exceed 100 GB.
- Retention deletion or vacuum regularly exceeds 30 minutes.
- Query plans cannot prune acceptable time ranges.
- Representative benchmarks prove at least a two-times improvement without unacceptable write
  overhead.

Partition changes require replay, retention, backup, migration, and query-plan tests.

### Reporting replica threshold

Add a reporting replica when, for seven consecutive days after query and index tuning, reporting
uses more than 30% of primary CPU or query time, reporting contention breaks ingestion or
projection freshness, or uncached report latency misses E9 because of read contention. Replica lag
must remain visible and bounds the newest reportable data.

### Kafka-compatible transport review threshold

Keep transactional outboxes and authenticated HTTP unless production measurements show one or
more:

- More than 5,000 accepted records per second sustained for one hour
- More than 20,000 records per second during repeated 15-minute peaks
- Backlogs exceed E9 freshness after safe horizontal scaling
- More than 24 hours of buffered outage recovery cannot drain in the agreed recovery window
- Multiple independent consumers require ordered distribution that HTTP would duplicate unsafely

A transport change preserves producer contracts and identities.

### Columnar-store review threshold

Keep PostgreSQL unless measurements show one or more:

- More than 500 million retained analytic facts
- More than 1 TB of active facts and projections
- Representative uncached reports repeatedly miss E9 after indexing, partitioning,
  preaggregation, and replica tuning
- Analytic scans sustain more than 70% of provisioned read capacity
- PostgreSQL cost materially exceeds a tested columnar alternative at the same reliability target

A ClickHouse or equivalent decision requires an architecture record, replay or dual-write plan,
parity validation, erasure and retention support, backup recovery, and rollback. Public metric and
reporting contracts do not change.

### Required E8 verification

Implementation is not complete until tests prove deterministic window replay, atomic checkpoint
updates, crash recovery, dirty-window coalescing, live-work priority, component-based rates, safe
distinct behavior, independent client rebuilds, one-time parent contribution, correct reparenting,
safe generation rollback, authorization-complete cache keys, erasure invalidation, Redis fallback,
bounded report plans, timezone/DST correctness, and contract-preserving measured scale decisions.

### E8 approval checklist

- [x] Approve immutable, typed-domain, leaf-bucket, ancestor-contribution, and reporting layers.
- [x] Approve PostgreSQL dirty-window queues with leases, priorities, coalescing, and fairness.
- [x] Approve deterministic full-window recomputation with atomic checkpoints and epochs.
- [x] Approve UTC hourly and scope-timezone calendar rollups with timezone revisions.
- [x] Approve mergeable rate, duration, distribution, distinct, currency, and provider components.
- [x] Approve narrowest-scope facts and per-source ancestor contributions.
- [x] Approve independent scope generations, shadow rebuilds, validation, and atomic promotion.
- [x] Approve typed projection schemas and measured indexes.
- [x] Approve registered, bounded reporting query planning.
- [x] Approve Analytics-owned Redis L1/L2 caching without authoritative state.
- [x] Approve scope, authorization, version, generation, and epoch-complete cache identities.
- [x] Approve separate workload pools and lag-aware reporting replicas.
- [x] Approve measured partitioning, replica, Kafka, and columnar-store review thresholds.
- [x] Approve the required projection, hierarchy, cache, rebuild, and scale verification.

## E9 — Testing, performance targets, monitoring, and operational runbooks

**Status:** Approved

### Verification strategy

Analytics must be verified at the contract, component, database, producer, reporting, and complete
system boundaries. Passing unit tests alone is not sufficient because the critical guarantees span
separate services, databases, queues, scope hierarchies, caches, and recovery operations.

Use the repository's existing test conventions where they fit:

- Rust unit and integration tests for the Analytics API, workers, authorization, projections, and
  reporting code
- Disposable local PostgreSQL integration databases, following the guarded Core test pattern
- Vitest producer and contract tests in the Agent Platform
- SQL and Rust integration tests for Core and Tenant Platform transactional outboxes
- Versioned deterministic fixtures for provider observations, metric results, and report responses
- A repository-owned load suite for repeatable ingestion, projection, and reporting benchmarks

Development and CI test data must be synthetic or sanitized. Production customer data must not be
copied into developer or CI environments. Tests that depend on time use a controllable clock and
explicit scope timezones.

### Contract and registry tests

Every pull request that changes analytics contracts or metrics must verify:

- Every envelope and payload example validates against its declared JSON Schema version.
- Existing producer fixtures continue to validate after backward-compatible schema changes.
- Breaking schema changes require a new version and supported overlap period.
- Generated Rust and TypeScript event names, field names, enum values, and schema hashes match the
  canonical registry.
- Metric definitions reference existing facts, dimensions, components, and availability rules.
- Metric dependency graphs contain no cycles.
- Units, currencies, denominators, privacy classes, supported intervals, and allowed dimensions are
  declared.
- Agent-readable metrics are explicitly marked; registration never makes a metric agent-readable
  by default.
- Removed or superseded definitions remain resolvable for retained historical reports.

### Component and database tests

Unit and property-based tests must cover canonical hashing, idempotency, formula evaluation,
component merging, histograms, bounded distinct strategies, timezone and daylight-saving changes,
availability precedence, hierarchy authorization, pseudonymization, grant validation, and
authorization-complete cache fingerprints.

PostgreSQL integration tests must cover:

- Operational mutation and outbox insertion committing or rolling back together
- Outbox leasing, retry, expiration, and concurrent publishers
- Duplicate delivery, conflicting duplicate identities, source sequence gaps, quarantine, replay,
  and reconciliation
- Late and revised provider observations without mutation of prior observations
- Dirty-window coalescing, worker leasing, crash recovery, checkpoint atomicity, and live-work
  priority
- Deterministic projection rebuilds and atomic shadow-generation promotion or rollback
- Independent tenant-client rebuilds and correct ancestor contribution replacement
- Scope reparenting without duplicate parent contribution
- Retention, deletion, legal hold, audit, and cache invalidation behavior
- Row-level security under both allowed and deliberately defective application queries

Property and fuzz inputs must include reordered, duplicated, delayed, missing, malformed, and
conflicting records, deep scope trees, attempted cycles, timezone transitions, and worker failure
at transaction boundaries.

### Producer and end-to-end verification

Core, Agent Platform, and Tenant Platform each own contract tests proving that every instrumented
authoritative mutation emits the expected event in the same transaction and excludes prohibited
content. Reconciliation tests compare source records, outbox records, accepted manifests, facts,
and projected components for the same bounded period.

The complete system test must exercise:

`product mutation -> source outbox -> publisher -> Analytics API -> immutable fact -> projection -> reporting API -> cache`

It must cover at least one real instrumented flow from each producer, one provider observation,
one late revision, duplicate delivery, a sequence gap followed by reconciliation, a projection
rebuild, a cached and uncached report, an export, agent-readable analytics, and an unauthorized
cross-scope request.

### Local development end-to-end test

Developers must have a self-contained local end-to-end command; analytics correctness must not be
testable only in CI or staging. Implement a root command backed by a checked-in test environment,
for example `./scripts/test-analytics-e2e.sh`, that:

1. Builds or starts Core, Agent Platform, Tenant Platform, Analytics API, and Analytics workers.
2. Starts isolated PostgreSQL databases, Analytics Redis, and the Agent Platform's required local
   workflow dependencies using a unique test project and ports.
3. Applies all migrations and contract registries from an empty state.
4. Creates deterministic Core organization, tenant workspace, tenant-client, user, agent, and
   reporting-grant fixtures through supported APIs or test bootstrap boundaries.
5. Executes real domain mutations through the service APIs rather than inserting final analytics
   facts directly.
6. Waits on bounded readiness and projection checkpoints; it must never use arbitrary sleeps as a
   correctness condition.
7. Verifies ingestion manifests, projected metrics, coverage metadata, cache behavior, hierarchy
   rollups, and denial of cross-scope access.
8. Prints the failed stage, correlation ID, and relevant service logs on failure.
9. Stops its processes and removes only its named test containers, volumes, databases, and fixture
   scopes. A documented `--keep` option may preserve the environment for debugging.

The default development run is a bounded smoke suite suitable before a pull request. A `--full`
mode runs replay, reconciliation, rebuild, retention, export, Agent Platform recovery, and larger
fixture scenarios. The command must refuse non-loopback databases unless an explicit CI-only
override is present, following the existing Core database-test safety convention.

### Reporting-scope isolation matrix

Automated tests must prove all of the following through reporting, cache, export, alerts, scheduled
reports, replay, and agent-readable paths:

- One tenant client cannot read another tenant client's analytics.
- A tenant-client administrator cannot read workspace-wide analytics without a separate grant.
- Tenant staff can read only assigned clients and authorized workspace aggregates.
- Core organizations cannot read tenant scopes and tenant scopes cannot read Core organizations.
- Workspace principals can read only permitted descendants and approved aggregation modes.
- Revoked or expired roles and grants cease authorizing new reports immediately.
- A producer cannot publish unauthorized scope kinds or attach a client to the wrong workspace.
- Hierarchy cycles, invalid parent changes, and replay attempts that alter scope ownership fail.
- Cache hits, asynchronous jobs, exports, and worker service identities do not bypass current
  authorization.

Any isolation failure blocks deployment and is treated as a security defect, not a test exception.

### Continuous integration and release gates

Add checked-in CI because the repository does not currently contain a shared workflow that
enforces these analytics guarantees.

Every analytics-related pull request runs:

- Formatting, linting, type checking, compilation, and unit tests for affected workspaces
- Contract, compatibility, generated-code, and metric-registry validation
- Migrations against empty and supported prior-version PostgreSQL schemas
- PostgreSQL and Redis integration tests
- Reporting-scope isolation tests
- Deterministic projection and report fixtures
- The bounded local end-to-end smoke suite in CI mode

Nightly verification adds full producer-to-reporting tests, bounded property and fuzz tests,
replay, reconciliation, backfill, retention, deletion, provider fixtures, and performance smoke
tests. Pre-production release verification adds the representative load suite, process and
dependency failure tests, backup restoration, projection rebuild and rollback, and cross-version
producer compatibility.

Automatic retries must not hide nondeterministic failures. A temporarily quarantined test requires
an owner, documented reason, issue, expiry date, and a release decision if it protects a mandatory
guarantee.

### Performance benchmark profiles

Every benchmark result records the software revisions, schemas, metric-registry version, dataset,
instance resources, worker concurrency, PostgreSQL and Redis configuration, cache state, and query
mix. Hardware-specific results cannot be compared without this context.

The release baseline contains at least 10 million retained facts, 1,000 active scopes, a workspace
with 1,000 tenant clients, 100 concurrent reporting users, and 1,000 accepted records per second.
It must meet:

| Operation | Target |
| --- | ---: |
| Accept and commit a 100-record ingestion batch | p95 <= 300 ms; p99 <= 1 second |
| Serve a valid cached report | p95 <= 200 ms; p99 <= 500 ms |
| Serve a normal uncached report | p95 <= 1 second; p99 <= 2 seconds |
| Serve a large authorized parent-scope report | p95 <= 2 seconds; p99 <= 5 seconds |
| Continuous projection lag | p95 <= 2 minutes; p99 <= 5 minutes |
| Continuous source-outbox-to-report latency | p95 <= 3 minutes; p99 <= 10 minutes |
| Recover after one hour of blocked ingestion | Drain within 2 hours while live work remains prioritized |

A nonblocking growth profile uses at least 100 million facts, 10,000 scopes, 500 reporting users,
and 5,000 accepted records per second. Its measurements drive the approved E8 partition, replica,
transport, and columnar-store decisions; they do not silently change those thresholds.

Interactive requests are bounded to 25 metrics, two breakdown dimensions, 2,000 returned chart
points, 100 compared descendants or top values, and a 10-second hard execution timeout. Larger
work is rejected with a bounded error or routed to an authorized asynchronous export. The metric
registry and query planner choose a coarser valid interval rather than returning an unbounded
series.

### Service objectives and correctness gates

- Ingestion and customer reporting APIs each target 99.9% monthly availability, excluding valid
  client errors and declared provider unavailability.
- Continuous data meets its E5 freshness objective for at least 99% of measured scope-domain
  windows each month.
- Acknowledged duplicate records never change a result; conflicting duplicates are quarantined.
- Exact metrics have zero unexplained difference from deterministic golden calculations.
- Estimated metrics use a registered tolerance; no implementation invents a local tolerance.
- Reconciliation has no unexplained source sequence gap older than the applicable stale threshold.
- Security isolation, erasure, legal-hold, schema-compatibility, and deterministic-replay tests must
  pass completely; an error budget cannot excuse these failures.

Track monthly availability and freshness error budgets. Exhausting an error budget pauses wider
analytics rollout until the responsible failure is corrected or explicitly accepted by the
service owner. Provider outages remain visible through coverage and availability metadata rather
than being counted as a successful fresh result.

### Health and observability foundation

Extend the shared observability foundation with OpenTelemetry-compatible traces and metrics while
retaining structured logs. Analytics services expose separate internal endpoints:

- Liveness verifies that the process and runtime are responsive.
- Readiness verifies required PostgreSQL connectivity, completed migrations, registry load, and
  the process-specific worker or API prerequisites.
- Authenticated metrics expose infrastructure and pipeline measurements without customer data.

Redis is nonauthoritative, so a Redis outage degrades cache status but does not make the reporting
API unready while PostgreSQL can safely answer bounded requests. Producer APIs must remain ready
when Analytics is unavailable; their outbox backlog is reported separately.

Trace context and correlation IDs propagate from product mutations through outbox publication,
ingestion, projection, and reporting. Organization, workspace, tenant-client, user, conversation,
and other high-cardinality business identifiers must not be infrastructure metric labels. Approved
identifiers may appear in access-controlled structured logs and audit records.

### Operational dashboards

Provide internal operational dashboards for:

- Ingestion volume, latency, accepted, duplicate, rejected, conflicted, and quarantined records
- Producer outbox depth, oldest age, publisher retries, manifests, and sequence gaps
- Projection queue depth and age, freshness class, worker leases, failures, generations, and
  checkpoint lag
- Reporting latency, errors, timeouts, query shapes, cache hits, misses, evictions, and fallback
- Data coverage, stale and partial windows, provider availability, revisions, and reconciliation
- PostgreSQL growth, connections, CPU, I/O, locks, vacuum, partitions, indexes, and replica lag
- Redis memory, latency, connection failures, and evictions
- Authorization denials, suspicious access, exports, retention, erasure, and legal-hold jobs

Customer-facing data-quality indicators remain part of reporting responses and customer UI. These
operational dashboards are for service operation and do not replace the separate KasiTek internal
cross-customer analytics plan.

### Alert severity and ownership

- **P0:** suspected cross-scope exposure, authorization bypass, unrecoverable acknowledged data,
  missed deletion deadline, or failed disaster restoration.
- **P1:** ingestion unavailable for five minutes, continuous data older than 15 minutes, oldest
  source outbox older than 15 minutes, unresolved continuous sequence gap older than 15 minutes,
  critical projection failure, reporting objective breach, or database capacity above 85%.
- **P2:** isolated provider staleness, elevated quarantine, partial coverage, degraded cache, or a
  noncritical reconciliation mismatch.

Alerts must be actionable, deduplicated by service and failure class, linked to a runbook, and
owned by a named service team. Provider outages affect coverage and freshness but do not count as
KasiTek ingestion unavailability. Security and privacy alerts never wait for an ordinary error
budget review.

### Recovery objectives and drills

- PostgreSQL point-in-time recovery target: RPO <= 5 minutes.
- Full analytics disaster recovery target: RTO <= 4 hours.
- Normal API or worker instance failover target: <= 15 minutes.
- Source services retain successfully delivered outbox envelopes for at least 35 days so restored
  analytics storage can be reconciled and replayed across the backup window.
- Run an isolated backup-restoration drill at least quarterly.

A restoration drill reapplies migrations and registries, verifies service identity and scope
isolation, restores deletion and legal-hold records, rebuilds or validates projections, reconciles
source manifests, and records measured RPO and RTO. Restoration is not successful merely because
PostgreSQL starts.

### Required operational runbooks

Maintain versioned runbooks for Analytics API or worker unavailability, source outbox backlog,
sequence gaps, reconciliation failure, quarantine growth, schema conflicts, projection lag or
corruption, shadow-generation validation and rollback, PostgreSQL failover and restoration, Redis
outage and cache stampede, provider staleness and revisions, tenant-isolation incidents, retention
or erasure failure, legal holds, metric-definition rollback, scope reparenting, key rotation, and
E8 capacity-threshold reviews.

Each runbook states detection, customer and data impact, prerequisites, safe commands or procedures,
verification, rollback, escalation, audit evidence, customer-status communication criteria, and
post-incident follow-up. Runbooks must never instruct operators to edit immutable facts in place.

### Required E9 verification

E9 is complete only when CI runs the mandatory pull-request gates, the local development end-to-end
command succeeds from a clean environment, the security matrix passes, representative performance
targets are measured, liveness/readiness/metrics behave under dependency failures, alerts link to
tested runbooks, and a recorded restoration drill meets the approved recovery objectives.

### E9 approval checklist

- [x] Approve layered contract, component, database, producer, property, recovery, and full-system tests.
- [x] Approve a self-contained local development end-to-end smoke command and `--full` mode.
- [x] Approve the mandatory reporting-scope isolation matrix as a deployment blocker.
- [x] Approve pull-request, nightly, and pre-production CI gates.
- [x] Approve representative release and nonblocking growth benchmark profiles.
- [x] Approve interactive report bounds and measurable latency, freshness, and recovery targets.
- [x] Approve 99.9% API availability and 99% continuous-window freshness objectives.
- [x] Approve OpenTelemetry-compatible traces and metrics plus dependency-aware health endpoints.
- [x] Approve operational pipeline, quality, storage, cache, and security dashboards.
- [x] Approve P0/P1/P2 alert classes, actionable ownership, and runbook links.
- [x] Approve RPO, RTO, outbox-retention, failover, and quarterly restoration requirements.
- [x] Approve the required versioned operational runbooks and completion evidence.

## Approved cross-cutting requirements for E9–E10

These requirements were approved before the detailed E9–E10 reviews and remain binding on their
implementation.

### E9 isolation and reliability requirements

Automated tests must prove that one tenant client cannot read another, client administrators cannot
read workspace-wide analytics without a separate grant, tenant staff cannot read unassigned
clients, authorized workspace principals can read only permitted descendants, revoked roles cease
authorizing new reports, and caches, exports, alerts, scheduled reports, replay, and agents preserve
the same scope boundaries.

Tests must also prove that a producer cannot publish unauthorized scope kinds, a tenant client
cannot be attached to the wrong workspace, hierarchy changes cannot create cycles, and replay does
not change scope ownership.

### E10 deployment ordering requirements

Deploy the foundation in this dependency order:

1. Standalone analytics service and database
2. Producer, reporting-scope, and hierarchy registries
3. Core organization and tenant workspace/client scope-definition publication
4. Core, Agent Platform, and Tenant Platform outboxes and publishers
5. Ingestion, quarantine, source cursors, and reconciliation
6. Domain instrumentation and provider observations
7. Scope-aware projections, metric registry, and reporting APIs
8. Core and Tenant Portal dashboard migrations behind controlled rollout flags
9. Parity, isolation, load, recovery, and acceptance verification before legacy reporting removal

## E10 — Deployment phases, feature flags, acceptance criteria, and implementation backlog

**Status:** Approved

### Product-plan gates

`ANALYTICS_PLAN.md` Sections 1–12 are approved. The following contracts remain binding dependency
gates during implementation:

- Section 8 gates Contacts, consent, audience, suppression, and Campaign guard instrumentation.
- Section 9 gates customer-facing Connections and platform-health analytics.
- Section 10 gates cross-feature attribution and final agent-readable data semantics.
- Section 11 gates the Core, tenant-workspace, and tenant-client Main Overview surfaces.
- Section 12 gates exports, alerts, and scheduled reports.

The product-plan completion gate is satisfied. Phase 0 still requires named owners and the listed
architecture decisions before foundation work begins, so implementation starts from one approved
scope and accountable ownership.

### Deployment topology and migration ownership

Build one Analytics image and deploy separate processes from it:

- Analytics API
- Analytics worker
- Migration release job

The API and worker must not apply migrations during startup. The release job acquires a PostgreSQL
advisory lock, verifies the expected prior schema, applies forward-only migrations, and records the
migration checksum and deployment identity. Migration failure stops the application rollout.

Use expand-and-contract changes:

1. Add compatible schemas, columns, indexes, and contract versions.
2. Deploy readers and writers compatible with old and new states.
3. Backfill through a resumable, audited job.
4. Validate counts, constraints, performance, and reconciliation.
5. Enforce the new invariant.
6. Remove obsolete structures only after cutover acceptance.

Application deployments must remain reversible without destructive database rollback. A faulty
production migration is corrected with a forward migration. Schema removal is a separate reviewed
release, never part of the release that changes writers.

### Rollout-control model

The Agent Platform's existing feature flags are Agent-specific and do not become the platform-wide
analytics rollout system. Add an Analytics-owned, audited rollout registry supporting global,
producer-service, domain, Core-organization, tenant-workspace, tenant-client, and stable percentage
cohort targeting.

Use separate controls for:

- `publish`: source publisher delivery
- `ingest`: source or domain acceptance
- `project`: projection processing
- `report`: reporting API availability
- `ui`: customer dashboard visibility
- `agent_read`: agent-readable analytics
- `export`: asynchronous exports
- `alerts`: customer analytics alerts
- `scheduled_reports`: scheduled delivery

Outbox capture is not a normal rollout flag. After an instrumented authoritative mutation begins
writing its transactional outbox record, capture remains enabled. During an incident, pause
publication, ingestion, projection, reporting, or UI instead of stopping capture and silently
creating historical gaps.

Rollout rules are:

- Evaluate authorization and rollout on the server; browser flags never authorize data access.
- Default customer visibility, exports, schedules, alerts, and agent access to denied.
- Record actor, reason, issue or incident reference, previous value, target, revision, creation,
  expiry, and removal for every change.
- Use stable scope hashing for percentage cohorts; the same scope does not move between cohorts.
- Fail expired grants and rollout entries closed.
- Keep operational kill switches separate from customer feature rollout.
- Cache decisions only for a bounded interval and invalidate them on revision changes.
- Keep Core, Agent Platform, and Tenant Platform APIs operational when Analytics is unavailable.

### Phase 0 — Close product and ownership dependencies

- Approve Product Sections 8–12.
- Assign named directly responsible owners for Analytics, each source-domain lane, frontend
  reporting, infrastructure, security, and privacy.
- Record architecture decisions for service authentication, deployment environment, telemetry
  backend, backups, secrets, and key rotation.
- Convert the approved backlog into tracked work with dependencies and acceptance evidence.

Exit only when the first implementation slice has no unresolved ownership, formula, privacy,
authorization, availability, or deployment decision.

### Phase 1 — Service and delivery foundation

- Scaffold `server/kasitek-analytics/` with API, worker, shared contracts, configuration, and
  migrations.
- Add one production image and separate API, worker, and migration deployment definitions.
- Provision dedicated Analytics PostgreSQL, Analytics Redis, secrets, service identities, backups,
  and restoration environment.
- Add CI, the E9 local end-to-end test, dependency-aware health, metrics, tracing, structured logs,
  and initial runbooks.

Exit when a clean environment can build, migrate, deploy, test, observe, back up, and restore the
empty analytics system without product facts.

### Phase 2 — Contracts, scopes, and durable storage

- Implement event-schema, producer, scope-kind, hierarchy, reporting-grant, and metric registries.
- Generate and verify Rust and TypeScript contract bindings.
- Implement service identity and producer authorization.
- Implement Core organizations, tenant workspaces, tenant clients, hierarchy closure,
  assignments, grants, and row-level security.
- Create immutable facts, provider observations, quarantine, manifests, cursors, checkpoints,
  deletion ledger, audit, and projection metadata.

Exit when compatibility tests and the complete E9 reporting-scope isolation matrix pass.

### Phase 3 — Producer capture and ingestion

Run three parallel producer lanes:

- Core Rust outbox and publisher
- Agent Platform TypeScript outbox and publisher
- Tenant Platform Rust outbox and publisher

Implement scope-definition publication, authenticated batch ingestion, idempotency, quarantine,
sequence tracking, manifests, reconciliation, replay, and backfill controls.

Exit when each producer completes a real authoritative-mutation-to-fact end-to-end flow and an
Analytics outage leaves producer APIs healthy with a recoverable outbox backlog.

### Phase 4 — Projection and reporting foundation

- Implement dirty-window queues, worker leases, leaf buckets, ancestor contributions,
  checkpoints, generations, shadow rebuilds, validation, and promotion.
- Implement registered metric evaluation, reporting authorization, bounded query planning,
  freshness, availability, coverage, and Analytics-owned Redis caching.
- Build the disabled reporting boundaries for exports and agent-readable results so their security
  can be tested before product rollout.

Exit when deterministic replay, hierarchy aggregation, cache isolation, rollback, bounded queries,
and E9 latency and recovery targets pass.

### Phase 5 — Reference vertical slices

Deliver E7 milestone M1:

- Common Agent runtime analytics
- The reliable existing Core Campaign delivery funnel
- Tenant workspace/client and lead-creation analytics

These slices exercise Core and Tenant Rust producers, the Agent TypeScript producer, and every
reporting-scope kind. Consent and Campaign guard data remains `not_instrumented` until its approved
product stage is complete.

Exit only after collection, reconciliation, reliable-coverage boundary, projection, reporting,
privacy, isolation, representative UI verification, and legacy parity are complete.

### Phase 6 — Remaining feature contracts

Deliver the remaining approved E7 milestones in dependency order:

- M2: Core Inbox, conversational Agents, Tenant conversations, and customer handoff
- M3: Contacts consent, Campaign guards and performance, and Connections evidence
- M4: Content lifecycle, provider collection, coverage, and revisions
- M5: Calls, Bookings, Tenant lead lifecycle, Tenant Agents, and usage
- M6: Cross-feature attribution, historical backfills, reliable coverage, and parity

Core, Agent, and Tenant lanes may execute concurrently when their prerequisites are complete. Each
domain remains a small, independently testable and releasable vertical slice.

### Phase 7 — Customer reporting surfaces

After their product contracts and domain slices are accepted, implement:

- Feature analytics pages
- Per-agent analytics
- Core Main Overview
- Tenant-workspace overview
- Tenant-client overview
- Exports
- Alerts
- Scheduled reports
- Agent-readable insights

Frontend surfaces consume registered reporting APIs and availability metadata. They do not compute
competing customer metrics from operational records. Every surface includes intentional desktop,
tablet, and mobile behavior plus concise loading, empty, partial, stale, and error states.

### Phase 8 — Cutover and cleanup

- Complete production shadow comparison for every migrated metric.
- Move controlled cohorts to Analytics-backed reporting.
- Disable legacy calculations only after full acceptance and a tested rollback.
- Preserve rollback through the approved observation period.
- Remove obsolete code, tables, and projections in separate reviewed changes.
- Produce the customer-analytics completion report.
- Start the separate KasiTek internal analytics execution plan using only approved shared facts.

### Customer rollout sequence

Every customer-facing domain or surface advances through:

1. Local development and CI
2. Staging
3. Named internal Core and tenant test scopes
4. A stable 5% customer cohort for at least 72 hours
5. A stable 25% cohort for at least 48 hours
6. A stable 50% cohort for at least 48 hours
7. 100%

Advancement is manual. It requires no P0 or unresolved P1 incident, E9 availability and freshness
objectives, no unexplained reconciliation gap, passing isolation tests, sufficient representative
transactions, approved metric parity, a successful rollback check, and honest coverage display.

Low-volume domains require deterministic fixtures and controlled representative transactions in
addition to elapsed time. A waiting period by itself is not acceptance.

### Parity and legacy-removal gates

For exact metrics, counts and sums match exactly; rates have matching numerator and denominator
components; and currency matches by currency and minor unit. Estimated metrics use only the
tolerance declared in the metric registry.

Before a domain reaches 100%:

- Complete at least seven consecutive full days of shadow comparison.
- Resolve every exact-metric mismatch.
- Meet the registered tolerance for estimated metrics.
- Verify the reliable historical-coverage boundary.

Before disabling a legacy calculation, Analytics remains at 100% for at least 14 consecutive days,
has no unresolved P0/P1 incident, and passes a rollback exercise. Remove legacy code only after 30
stable calendar days and through a separate reviewed change.

### Rollback behavior

- UI defect: disable the targeted `ui` entry.
- Reporting defect: disable `report` and restore the prior customer surface.
- Projection defect: atomically promote the previous validated generation.
- Publisher incident: pause publication while preserving outbox capture.
- Ingestion defect: reject or quarantine the affected producer or domain.
- Redis incident: bypass cache and use bounded PostgreSQL reporting.
- Metric-definition defect: restore the previous registry version and rebuild affected windows.
- Migration defect: deploy a forward corrective migration.

No rollback procedure deletes source outboxes, edits immutable facts, weakens authorization, or
presents unavailable data as zero.

### Acceptance levels

- **Foundation accepted:** service, infrastructure, migrations, contracts, security, CI, local
  end-to-end test, observability, backup, and recovery evidence pass.
- **Domain accepted:** authoritative collection, reconciliation, backfill boundary, metrics,
  reporting, privacy, isolation, parity, and named ownership pass.
- **Surface accepted:** responsive UI, authorization, coverage, freshness, loading, empty, partial,
  error, accessibility, and runtime verification pass.
- **Rollout accepted:** cohort objectives, rollback, monitoring, incident readiness, and
  customer-safe behavior pass.
- **Platform accepted:** all approved domains and surfaces are migrated, legacy removal is complete,
  documentation is current, and the internal analytics planning handoff is ready.

### Executable implementation backlog

| ID | Work package | Depends on |
| --- | --- | --- |
| A-01 | Analytics Rust workspace, API, worker, and validated configuration | Product plan completion |
| A-02 | PostgreSQL, Redis, migrations, backup, restoration, and deployment jobs | A-01 |
| A-03 | CI, local E2E, observability, alerts, and runbook skeletons | A-01, A-02 |
| A-04 | Contract and metric registries with generated Rust/TypeScript bindings | A-01 |
| A-05 | Scope hierarchy, assignments, grants, service identities, and RLS | A-02, A-04 |
| A-06 | Immutable facts, observations, quarantine, manifests, cursors, and audit | A-02, A-04, A-05 |
| A-07 | Rust producer library plus Core and Tenant outboxes and publishers | A-04, A-06 |
| A-08 | TypeScript producer library plus Agent outbox and publisher | A-04, A-06 |
| A-09 | Ingestion, sequence tracking, reconciliation, replay, and backfill | A-06–A-08 |
| A-10 | Projection queue, rollups, contributions, generations, and rebuilds | A-09 |
| A-11 | Reporting APIs, query planner, availability, coverage, and cache | A-05, A-10 |
| A-12 | Audited rollout registry and operational controls | A-05, A-11 |
| A-13 | M1 reference vertical slices | A-07–A-12 |
| A-14 | M2–M5 feature vertical slices | A-13 and applicable product contracts |
| A-15 | M6 attribution, historical coverage, and final parity | A-14, Product Section 10 |
| A-16 | Feature, per-agent, Core, and Tenant reporting surfaces | Accepted slices, Product Section 11 |
| A-17 | Exports, alerts, scheduled reports, and agent-readable access | A-11, Product Sections 10 and 12 |
| A-18 | Cohort rollout, cutover, rollback evidence, and legacy removal | Accepted surfaces and E9 gates |
| A-19 | Customer-analytics completion report and internal-plan handoff | A-18 |

Every work package is divided into reviewable changes and has a named directly responsible owner,
dependency status, migration impact, contract changes, tests, deployment order, rollback method,
observability, security/privacy review where applicable, and stored acceptance evidence. Work does
not begin when a required dependency is unresolved.

### Required E10 verification

Execution is complete only when all applicable product gates are approved, every backlog package
has accepted evidence, domain and surface rollouts meet their cohort gates, legacy calculations are
removed safely, production recovery and rollback are proven, and the final completion report maps
each approved metric and surface to its source, contract, projection, reporting API, owner, tests,
and operational runbook.

### E10 approval checklist

- [x] Approve Product Sections 8–12 as explicit implementation gates.
- [x] Approve separate Analytics API, worker, and migration-release deployments.
- [x] Approve advisory-locked forward migrations and expand-and-contract releases.
- [x] Approve an Analytics-owned audited rollout registry rather than Agent-specific flags.
- [x] Approve separate publish, ingest, project, report, UI, agent, export, alert, and schedule controls.
- [x] Approve durable outbox capture that is not silently disabled by rollout controls.
- [x] Approve Phases 0–8 and their objective exit gates.
- [x] Approve manual internal, 5%, 25%, 50%, and 100% rollout stages.
- [x] Approve exact parity, shadow, stability, rollback, and legacy-removal periods.
- [x] Approve the documented rollback behavior without immutable-fact mutation.
- [x] Approve foundation, domain, surface, rollout, and platform acceptance levels.
- [x] Approve backlog A-01–A-19 and named ownership plus evidence requirements.
