# Incident and operations centre

Owner: Platform engineering. Reviewed: 2026-10-23.

Labs Operations stores monitor schedules, safe observations, incident episodes, rule revisions,
maintenance windows, notification intent, and administrative audit metadata. Its API and worker
run separately under `services/operations` and use a dedicated PostgreSQL database. The admin
calls the API through its existing BFF. Collection continues when no browser is open.

Products own signal calculation, customer permissions, and recovery. Analytics owns event
projections. Operations never runs customer commands, joins product databases, reconciles
customer receipts, or reads prompts, messages, credentials, or provider payloads.

## Independent administrator access

With `OPS_BACKEND_URL` configured, the admin uses the Operations `/auth/session` endpoint and
its opaque `labs_admin_session` cookie. Authentication uses the dedicated Keycloak `labs-admin`
client. A verified issuer and subject must match an active `operations.admin_principals` grant.
Name, email, product membership, and an existing customer session grant no administrator access.

The API checks the current grant revision on every request. Role or active-state changes revoke
existing sessions. Sessions have a 30-minute inactivity deadline and an 8-hour absolute deadline.
Provider refresh occurs within 60 seconds. Failed refresh invalidates the session. Local logout
revokes the session before provider logout. Verified backchannel logout rejects replayed tokens.
A Growth outage does not prevent Operations login or incident access. An identity-provider outage
still prevents new login and eventually invalidates sessions when refresh becomes due.

The BFF binds each product assertion to the current administrator, destination, capability,
HTTP method, exact path and query, and request-body digest. Growth accepts only an explicitly
mapped current `AdminUser` with a matching role. Operations never creates a customer session.
A legacy Growth session is not an outage fallback for the Operations login mode.

| Operation | Required permission |
| --- | --- |
| Read incidents, rules, maintenance, monitors, and status | `admin:read` |
| Acknowledge, assign, or resolve an incident | `admin:operate` |
| Change rules or maintenance | `admin:write` and role `admin`, `owner`, or `superadmin` |
| Read federated operational audit | `admin:security` |
| Read or mark personal notifications | Current eligible recipient; no general write grant |

Mutations require the configured admin origin. Incident and policy mutations use operation IDs,
expected revisions, and reasons. Repeated identical commands return stored results. Conflicting
reuse or concurrent edits fail. Incident assignment accepts active operators. Acknowledgement,
notification read state, and observed recovery are separate states.

## Collection and source coverage

`OPS_SOURCES_JSON` configures one fleet endpoint per Growth, Agents, Agency, and Analytics source.
The worker requests only `/internal/operations/signals` on those fixed origins. Each destination
has an independent observer key and request-bound `signals:read` authority. The worker has no
human admin assertion key, identity-client secret, session encryption key, or customer cookie.
Notification publishing has a separate credential limited to Growth's fixed delivery bridge.

Collection uses transactional leases, increasing fencing tokens, and a shared capacity limit of
four requests across workers. A lease lasts 30 seconds. HTTP requests time out after 8 seconds,
refuse redirects, and accept at most 64 KiB. A snapshot has at most 100 signals and 20 evidence
references per signal. Product reads use read-only transactions and two-second query deadlines.
Polling defaults to 60 seconds with 10% jitter. Inventory intervals accept 10 to 3,600 seconds.

`source.available` records HTTP collection availability. `source.read_ready` separately records
whether the product completed its read-only database transaction. An individual failed query
remains unknown even when that transaction succeeds. Coverage distinguishes complete, partial,
and unknown evidence. Measurement states distinguish available, unknown, unsupported,
not_configured, and no_activity. Missing instrumentation never becomes zero failures.

Publication and projection signals use eligible pending work. Agents dispatch excludes valid
waits through its owning scheduler's eligibility rules. Evaluation resources remain excluded by
the owning source. Unsupported Agency provider and failure measurements remain disabled facts.
Customer references are bounded evidence, never telemetry dimensions or identity joins.

Workers record heartbeats from their actual loops. Source inventory uses
`OPS_EXPECTED_WORKERS=name@instance`; each worker uses `OPS_WORKER_INSTANCE` and
`OPS_HEARTBEATS_ENABLED=1`. A missing first heartbeat is unknown. The source supplies the
heartbeat cadence in `expectedIntervalSeconds` rather than borrowing the rate denominator.

## Rule and incident semantics

These defaults support development investigation. They are not production SLOs.

| Signal | Breach threshold | Consecutive breaches | Severity |
| --- | --- | --- | --- |
| `source.available`, `source.read_ready` | Below 1 | 3 | Critical |
| `publication.overdue_seconds`, `projection.overdue_seconds`, `webhook.overdue_seconds` | Above 300 seconds | 2 | Warning |
| `publication.quarantined`, `ingress.quarantined`, `webhook.failed` | Above 0 | 2 | Warning |
| `execution.dispatch_overdue_seconds` | Above 120 seconds | 2 | Warning |
| `execution.failure_rate_bps` | At least 2,000 basis points with at least 20 eligible attempts | 2 | Critical |
| `recovery.pending_age_seconds` | Above 900 seconds | 2 | Warning |
| `worker.<name>.<instance>.age_seconds` | Above three source-reported heartbeat intervals | 2 | Warning |
| `monitor.stale` | Above the greater of 180 seconds and three polling intervals | 2 | Critical |

Recovery requires two fresh healthy observations by default. Rule edits record a new revision,
actor, and reason. Counters reset when a rule revision changes. Unknown, incomplete, stale, or
insufficient-sample evidence cannot recover an incident. Source snapshots older than 180 seconds
or more than 30 seconds ahead are rejected. Duplicate and out-of-order observations cannot
advance counters. Unknown observations break consecutive breach and recovery sequences.

A fingerprint binds environment, owning source, rule, and group. A partial unique index permits
one active episode per fingerprint. A later breach opens a new episode linked to the prior one.
Transitions remain append-only. Active severity can escalate. Assignment and acknowledgement do
not change the observed condition. Manual resolution requires fresh healthy evidence.

The API independently checks collection progress every 15 seconds. It marks stale evidence unknown
and can open `monitor.stale` incidents while the worker is stopped. `/v1/status` distinguishes a
worker that never started, a stale heartbeat, a disabled collector, and healthy progress. Total
Operations or database loss requires a separately hosted uptime monitor before production.

## Notification and audit records

The Operations transaction records notification intent alongside the incident transition. Delivery
uses a stable identity for each transition and recipient. A retry sends the identical one-recipient
body even when another administrator's grant changes. Recipient outcomes persist independently.
Each worker pass makes at most four delivery requests. Pending intent survives process restart,
Growth unavailability, and a response lost after the destination commits.

Maintenance can target a source, rule, or all sources. It lasts at most seven days and requires a
reason. Observations and incidents continue during maintenance. Delivery waits until the window
expires. Superseded transitions are suppressed so a backlog does not replay every intermediate
notification. Revoked recipients are suppressed before delivery. Growth commits its receipt,
notification event, and recipients atomically. Its receipt rejects reuse with a different payload.

Audit queries federate pure product-owned projections, including Analytics, through human admin
authority. The worker cannot call those projections. Results contain normalized identifiers,
actors, timestamps, outcomes, and receipt references. Arbitrary event payloads and support content
are excluded. Independent source cursors preserve exhausted-source state. Page limits cap the
combined response at 100. Source failure remains explicit. Source clocks do not establish a global
chronological guarantee.

## Telemetry and retention

The API and worker initialize the existing OpenTelemetry SDK with service names
`kasitek-operations-api` and `kasitek-operations-worker`. Export requires an approved configured
OTLP endpoint. The implementation does not install a telemetry vendor or change the Collector.

| Instrument | Meaning |
| --- | --- |
| `kasitek.operations.collection.age` | Seconds since each enabled source completed collection |
| `kasitek.operations.measurement.coverage` | Signal counts by source and measurement state |
| `kasitek.operations.incidents.active` | Active episode counts by source, severity, and workflow state |
| `kasitek.operations.notification.pending`, `.oldest_age` | Pending transition intent count and oldest intent age |
| `kasitek.operations.worker.progress_age` | Age of observed worker progress |
| `kasitek.operations.collection.count` | Successful, failed, or fenced collection completions |
| `kasitek.operations.lease.contention` | Collection attempts deferred by held capacity |
| `kasitek.operations.delivery.count` | Delivered, suppressed, or failed recipient delivery outcomes |

Metrics have fixed source and state dimensions. No customer, actor, incident, operation, or raw
error value becomes a metric label. Collection logs use bounded codes plus service, environment,
and release identity. Request logs omit query strings. Credentials, reasons, and customer content
remain outside general telemetry.

Raw safe observations retain 30 days. Cleanup deletes at most 500 old records per table per pass.
Any incident's referenced evidence remains protected. Audit and command records retain 90 days.
Delivered notification intent and transitions from incidents resolved more than 90 days ago become
eligible for cleanup. Active incidents and pending delivery records remain protected. Incident
summaries and rule history remain stored. These are development defaults. Production retention,
notification destinations, and an external uptime service require separate owner decisions.

## Release record

Owner: Enoch. Risk: high. This change adds privileged durable state and independent admin identity.
Affected services are Labs admin, Operations API and worker, Growth, Agents, Agency, Analytics,
shared contracts, and the local Keycloak registration. The qualifying decision is
[ADR 0002](../labs/adr/0002-labs-operations-and-admin-identity.md).

Operations migrations are additive and record SHA-256 checksums under a serialized migration
lock. The migrator rejects a changed applied file. Product heartbeat migrations belong to their
existing runners. Growth also owns the notification receipt migration. There is no distributed
migration transaction across products.

Focused engineering checks cover leases, fencing, hysteresis, unknown evidence, recurrence,
maintenance, immutable recipient retries, permissions, concurrent edits, bounded HTTP parsing,
retention, and real SDK export to a disposable local OTLP receiver. Identity checks use a controlled
OIDC provider. These checks are not model, product-quality, load, or production durability evals.
The implementation commits identify source changes. Package `0.1.0` is not a deployed release ID.
The controlled development walkthrough verified Labs OIDC login while Growth was stopped, one
incident after three failed polls, acknowledgement, assignment with revision checks, same-ID
command replay, rejection of resolution during a breach, pending delivery through the outage,
and recovery after two successful polls. Audit remained source-owned. Browser checks covered
1,440-, 768-, and 390-pixel widths without recorded errors. Local incident proof is
`/tmp/kasitek-operations-incident.png`; the final handoff records the related runtime evidence.
These checks do not establish production availability or durability.

Rollout enables collection before rule evaluation, then notifications, through separate flags.
Rollback stops new work while retaining observations, incidents, audit, and pending delivery.
No connection-incident Analytics event is repurposed. Operations owns its durable lifecycle records
and OTLP metrics. New customer analytics events, public release communication, and Collector
transport changes are not applicable to this development block. Production rollout remains disabled.
The owner schedules a post-release review if a production release is approved.

See the [operator runbook](../labs/operations-centre-runbook.md) for configuration, startup,
incident handling, and rollback.
