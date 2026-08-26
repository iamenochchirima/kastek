---
id: observability
title: Observability
sidebar_position: 5
owner: platform-ops
last_reviewed: 2026-08-26
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
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.20
OTEL_EXPORTER_OTLP_TIMEOUT=5000
KASITEK_VERSION=0.1.0
KASITEK_RELEASE_ID=platform-v0.1.0
KASITEK_COMMIT_SHA=<immutable-commit>
```

Set `OTEL_SDK_DISABLED=true` or remove the OTLP endpoint to disable export. Services retain their
structured stdout fallback and must continue to answer liveness checks when the Collector is
unavailable.

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

Agents uses Pino with `trace_id`, `span_id`, `trace_flags`, and `correlation_id` fields. Rust
`log` records are bridged into the tracing subscriber when OTLP is enabled. Request summaries
omit query strings and network addresses; credentials, authorization material, cookies, tokens,
prompts, and message content are redacted in the application logger and Collector processor.

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
`kasitek.operation.count`, `kasitek.operation.duration`, and
`kasitek.operation.in_flight` for instrumented application, provider, and worker boundaries.
Collector internal metrics cover Collector health and processing; queue age, retry, dependency,
and resource-saturation metrics remain service-specific follow-up work.

Analytics metrics are not a replacement for service health metrics. Product analytics describes
user outcomes; operational telemetry describes system behavior. A feature can require both.

## Release evidence

For a feature release, link the relevant dashboard or query, alert, log search, and runbook in the
release record. If a new failure mode has no owner or response procedure, the release is not
operationally complete; record the gap explicitly and assign follow-up work.

The remaining work is environmental: run the end-to-end local and staging checks, configure an
isolated hosted Collector, and approve a durable backend. Track that evidence in the
[OpenTelemetry infrastructure plan](https://github.com/iamenochchirima/kasitek/blob/main/docs/plans/active/OPENTELEMETRY_INFRASTRUCTURE_PLAN.md) and
its [execution checklist](https://github.com/iamenochchirima/kasitek/blob/main/docs/plans/active/OPENTELEMETRY_INFRASTRUCTURE_CHECKLIST.md).
