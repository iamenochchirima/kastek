---
id: otel-collector
title: OpenTelemetry Collector
sidebar_position: 7
owner: platform-ops
last_reviewed: 2026-08-26
---

# OpenTelemetry Collector Runbook

This runbook covers the provider-neutral Collector boundary. It does not cover Axiom or another
backend's datasets, dashboards, retention, or access controls.

## Profiles

| Profile | Exporter | Use |
| --- | --- | --- |
| `config.local.yaml` | detailed `debug` | Local signal and field verification |
| `config.staging.yaml` | `debug` | Staging receipt and correlation smoke tests |
| `config.production.template.yaml` | generic `otlp_http` with queue/retry | Template only; requires an approved durable destination |

The debug exporter is not durable. Do not claim production log retention or incident visibility
from a debug-exporter deployment.

## Start and verify locally

```bash
docker compose -f infra/observability/otel-collector/compose.yaml up --build
curl --fail http://127.0.0.1:13133/
```

The Collector listens on OTLP gRPC `4317`, OTLP HTTP/protobuf `4318`, and health `13133`. Start
the application after the Collector and set:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_DEPLOYMENT_ENVIRONMENT=local
```

Send one safe request, one worker operation, one expected error, and one metric. Confirm the
Collector output includes `service.name`, environment, release identity, trace/span IDs, and
correlation ID. Do not use real credentials, customer content, or provider payloads for this test.

Validate profiles before changing them:

```bash
PORT=13133 otelcol validate --config=infra/observability/otel-collector/config.yaml
PORT=13133 otelcol validate --config=infra/observability/otel-collector/config.local.yaml
PORT=13133 otelcol validate --config=infra/observability/otel-collector/config.staging.yaml
```

## Hosted deployment

Run one Collector service per Railway environment. Keep it in the same project and environment
as the applications, expose no public domain, and use private service DNS. The application endpoint
should be equivalent to:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Use a separate staging Collector and staging variables. Never copy production endpoint or
authentication values into staging. The current hosted shape is documented in the
[Collector README](https://github.com/iamenochchirima/kasitek/blob/main/infra/observability/otel-collector/README.md).

## Collector unavailable or restarting

1. Check `GET /` on port `13133`.
2. Check the service logs for receiver bind failures, memory-limiter drops, or exporter errors.
3. Check application stdout. Services must continue serving liveness endpoints and processing
   work when export is disabled or the Collector is unavailable.
4. Confirm the SDK endpoint, protocol, private DNS name, and timeout variables.
5. Restart the Collector after correcting configuration. Re-run the safe request and verify new
   signals arrive.
6. Record the approximate telemetry-loss window. Application queues and SDK batches are bounded;
   this system does not promise recovery of data dropped during an outage.

Do not repeatedly restart application services as a substitute for fixing a Collector or network
failure. Do not make user requests wait for telemetry export.

## Redaction and leakage response

Application loggers redact authorization material, cookies, tokens, passwords, prompts, and message
content. The Collector also deletes prohibited attributes as a second boundary. If sensitive data
is observed:

1. Disable export with `OTEL_SDK_DISABLED=true` or remove the application OTLP endpoint.
2. Preserve only the minimum safe diagnostic information needed to identify the affected release.
3. Restrict access to the destination and follow the destination's deletion procedure once it is
   approved and configured.
4. Fix the emitting field and add a regression test before re-enabling export.
5. Record the incident and review whether the release must be rolled back.

## Graceful shutdown

Rust entrypoints flush providers through `ShutdownGuard`. Agents API, gateway, worker, Discord,
publisher, migration, and one-shot maintenance entrypoints call `shutdownTelemetry()` on orderly
exit. A shutdown timeout or Collector outage must not hang process termination indefinitely.

## Production gate

The production template must remain undeployed until a durable backend, retention policy, access
policy, alert ownership, and release evidence are approved. When that decision is made, configure
only the generic OTLP variables and keep the backend-specific details in the Collector environment
configuration.
