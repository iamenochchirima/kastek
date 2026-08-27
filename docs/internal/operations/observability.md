---
id: observability
title: Observability
sidebar_position: 5
owner: platform-ops
last_reviewed: 2026-08-27
---

# Observability

Every deployed service must make it possible to answer three questions: is it available, is it
behaving correctly, and what changed when the behavior changed?

## Architecture and current status

Server-side services emit portable OpenTelemetry logs, traces, and metrics over OTLP HTTP. The
repository-owned Collector at `infra/observability/otel-collector/` is the boundary between
application code and a future telemetry backend:

```text
Core / Tenants / Analytics / Agents
              │ OTLP HTTP
              ▼
     OpenTelemetry Collector
       ├─ debug exporter (local/staging verification)
       └─ generic OTLP exporter (production template, backend decision pending)
```

The Rust services initialize the shared `server/crates/observability` crate. Agents initializes
the Node SDK before Fastify, PostgreSQL, Temporal, and gateway modules. HTTP instrumentation,
Pino correlation, PostgreSQL/HTTP auto-instrumentation, provider spans, Temporal activity spans,
background-worker spans, and graceful shutdown are enabled in the current server-side slice.
Internal HTTP calls use the shared W3C propagator and construct/inject request headers inside the
provider span, so downstream requests are children of the dependency operation rather than
siblings of it. Temporal carries only bounded trace and correlation headers through its payload
converter. The activity interceptor decodes those string payloads before restoring the async
context; contract tests cover the provider-child HTTP injection and Temporal activity boundary.

The debug exporter is not durable storage. Production observability is not complete until a
durable destination, retention, access policy, resource owner, and alerting policy are approved
and configured. Selecting Axiom or another backend is a separate change.

## Service identity

| Process | `service.name` |
| --- | --- |
| Core API and Core workers | `kasitek-core` |
| Tenants API and workers | `kasitek-tenants` |
| Analytics API | `kasitek-analytics-api` |
| Analytics worker | `kasitek-analytics-worker` |
| Analytics migration job | `kasitek-analytics-migrate` |
| Agents API | `kasitek-agents` unless `OTEL_SERVICE_NAME` or `KASITEK_SERVICE_NAME` overrides it |
| Agents worker | `kasitek-agents` unless overridden |
| Agents gateway | `kasitek-agents` unless overridden |

Every process attaches `service.version`, `deployment.environment.name`, `kasitek.release_id`,
`kasitek.commit_sha`, and `kasitek.artifact_digest` when supplied. Application values are
authoritative; the Collector redaction processor must not replace them.

## Configuration

Use standard OpenTelemetry variables. The endpoint is the private Collector endpoint, never a
public browser or provider endpoint:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=kasitek-core
OTEL_DEPLOYMENT_ENVIRONMENT=staging
OTEL_TRACES_SAMPLER=parentbased_always_on
OTEL_EXPORTER_OTLP_TIMEOUT=5000
KASITEK_VERSION=0.1.0
KASITEK_RELEASE_ID=platform-v0.1.0
KASITEK_COMMIT_SHA=<immutable-commit>
```

Local and staging verification profiles use `parentbased_always_on` so the debug Collector can
inspect the complete smoke trace. The production template also receives all application traces
and applies a provider-neutral tail-sampling policy: error traces are retained and 20% of other
traces are retained. If a deployment cannot support this boundary, its sampling decision must be
recorded explicitly in the release record; a ratio sampler must not be described as preserving all
errors.

Set `OTEL_SDK_DISABLED=true` or remove the OTLP endpoint to disable export. Services retain their
structured stdout fallback for both legacy Rust `log!` records and instrumented `tracing!` events,
and must continue to answer liveness checks when the Collector is unavailable.

## Minimum release metadata

Logs, metrics, health responses, and deployment records should identify:

- service and process;
- environment;
- platform release version;
- source commit or artifact digest;
- request or correlation ID where a request exists;
- operation, route, job, or event type;
- outcome and bounded error code.

## Logging rules

- Use structured logs for application and worker events.
- Log lifecycle transitions, retries, provider calls, migration results, and terminal failures.
- Use stable event names and bounded error codes so alerts and searches do not depend on prose.
- Propagate a correlation ID across HTTP, jobs, provider callbacks, and internal calls.
- Redact credentials, tokens, authorization headers, message bodies, prompts, and unnecessary
  personal data.
- Treat logs as operational data with an owner, retention period, access control, and deletion
  process.

## Stable operational events

New and modified operational paths use a bounded `event` field with a dot-separated, stable name.
The minimum event vocabulary is:

| Boundary | Event names |
| --- | --- |
| Process lifecycle | `service.startup`, `service.startup.failed`, `service.shutdown`, `service.shutdown.failed` |
| HTTP | `http.request.completed`, `http.request.failed` |
| Dependencies/providers | `provider.call.completed`, `provider.call.failed`, `dependency.unavailable` |
| Retries | `operation.retry.scheduled`, `operation.retry.exhausted` |
| Migrations | `migration.started`, `migration.completed`, `migration.failed` |
| Queues/workers | `queue.item.claimed`, `queue.item.completed`, `queue.item.failed`, `queue.item.ignored`, `queue.claim.failed`, `worker.started`, `worker.disabled`, `worker.failed` |
| Terminal failures | `operation.failed`, `operation.terminal.failure` |

Event names are identifiers, not user-facing prose. The existing legacy Rust `log!` inventory is
migrated incrementally; new code must use this vocabulary and the legacy inventory must not be
expanded without an event field or an explicit `not applicable` decision in its release record.

Agents uses Pino with `trace_id`, `span_id`, `trace_flags`, and `correlation_id` fields. Its
operational logger accepts lowercase dot-separated event names and normalizes invalid event
values to `operation.invalid.event` while retaining only a bounded diagnostic value. Rust `log`
records are bridged into the tracing subscriber when OTLP is enabled. Core and Tenant source
backfill workers, Core operational workers, the Analytics outbox publisher, and Analytics
projection processing now emit stable lifecycle/result events and shared operation metrics.
Request summaries omit query strings and network addresses; credentials, authorization material,
cookies, tokens, prompts, and message content are redacted in the application logger and Collector
processor. Rust legacy `log!` messages are bounded and redacted before they reach stdout or the
OpenTelemetry bridge. New and touched provider paths record bounded status/error metadata rather
than raw response bodies or webhook payloads.

Use low-cardinality attributes for metrics and spans. Keep request IDs, customer identifiers,
provider payloads, and message text in bounded body fields only when there is a documented support
need; do not make them metric labels.

## Metrics and health

At minimum, monitor request or job count, error count, latency, in-flight work, queue age, retry
count, dependency failures, and resource saturation for each service that handles traffic or
background work. Health endpoints must distinguish process liveness from dependency readiness.

The current shared instrumentation provides `http.server.request.count`,
`http.server.request.duration`, `http.server.request.error.count`, and
`http.server.request.in_flight` for Rust HTTP services. Agents provides
`kasitek.operation.count`, `kasitek.operation.error.count`,
`kasitek.operation.duration`, `kasitek.operation.in_flight`,
`kasitek.operation.retry.count`, `kasitek.dependency.failure.count`, and
`kasitek.queue.age` for instrumented application, provider, worker, and outbox boundaries. Core
worker batch loops, Core/Tenant source backfill processing, Analytics outbox publication, and
Analytics projection processing use the shared operation boundary; source queues that do not
return an enqueue timestamp cannot emit a meaningful queue-age measurement yet.
Collector internal metrics cover Collector health and processing. Queue age, retry, and
dependency metrics are emitted only at boundaries that own those concepts; resource saturation is
owned by the Collector/host platform rather than application request labels.

The minimum metric contract is therefore:

| Signal | Required boundary | Metric |
| --- | --- | --- |
| Throughput | HTTP, worker, provider, migration, queue | `*.count` with bounded outcome |
| Errors | Every fallible boundary | `*.error.count` or an equivalent `outcome=error` series |
| Latency | Every timed boundary | `*.duration` in seconds |
| In-flight | HTTP and long-running work | `*.in_flight` |
| Queue age | Queue owner only | `kasitek.queue.age` in seconds |
| Retries | Retry owner only | `kasitek.operation.retry.count` |
| Dependency failures | Provider/dependency boundary | `kasitek.dependency.failure.count` |
| Resource saturation | Collector/host platform | Collector internal and platform resource metrics |

Identifiers such as request IDs, run IDs, and customer IDs must not become metric attributes.

## Access, retention, and deletion baseline

Until a backend is selected, these are platform requirements rather than provider configuration:

- telemetry is operational data and is never exposed through public application endpoints;
- read access is limited to the release owner, platform-ops incident responders, and explicitly
  approved engineering support personnel;
- staging and production destinations, credentials, and access policies are separate;
- retention and deletion must be configurable by signal and environment, with staging shorter than
  production and deletion requests auditable by an operator;
- no telemetry backend may become the source of truth for authorization, tenant identity, or
  business records.

The concrete retention durations, identity-provider roles, and deletion API are provider-specific
decisions and must be recorded before durable export is enabled.

Analytics metrics are not a replacement for service health metrics. Product analytics describes
user outcomes; operational telemetry describes system behavior. A feature can require both.

## Release evidence

For a feature release, link the relevant dashboard or query, alert, log search, and runbook in the
release record. If a new failure mode has no owner or response procedure, the release is not
operationally complete; record the gap explicitly and assign follow-up work.

The remaining work is environmental: run the end-to-end local and staging checks, configure an
isolated hosted Collector, and approve a durable backend. Track that evidence in the
[OpenTelemetry infrastructure plan](https://github.com/iamenochchirima/kasitek/blob/main/docs/plans/active/OPENTELEMETRY_INFRASTRUCTURE_PLAN.md) and
its [execution checklist](https://github.com/iamenochchirima/kasitek/blob/main/docs/plans/active/OPENTELEMETRY_INFRASTRUCTURE_CHECKLIST.md) and
[release record](https://github.com/iamenochchirima/kasitek/blob/main/docs/plans/active/OPENTELEMETRY_INFRASTRUCTURE_RELEASE_RECORD.md).
