# OpenTelemetry Collector runbook

Labs owns the Collector image, configuration, local service definition, and Collector-specific
validation. This runbook covers local operation only. Hosted deployment and producer cutover are
separate work and are not performed by the repository ownership move.

## Profiles

| Profile | Exporter | Use |
| --- | --- | --- |
| `config.local.yaml` | `debug` | Local signal inspection |
| `config.staging.yaml` | `debug` | Staging profile validation only |
| `config.production.template.yaml` | `otlp_http` | Template only; requires an approved durable destination |

The debug exporter is not durable storage. Do not infer a running hosted Collector, retained
telemetry, or production incident visibility from these checked-in profiles.

## Start and validate locally

From the Labs repository root:

```bash
docker compose -f infra/observability/otel-collector/compose.yaml up --build
curl --fail http://127.0.0.1:13133/
```

The Collector listens on OTLP gRPC `4317`, OTLP HTTP/protobuf `4318`, and health `13133`. Validate
configuration with the pinned image and the commands in the
[Collector README](../infra/observability/otel-collector/README.md). Do not use real credentials,
customer content, prompts, or provider payloads in smoke checks.

Producer services may use the standard variables when an authorized local Collector is running:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_DEPLOYMENT_ENVIRONMENT=local
```

Stop the local Collector with `Ctrl-C` when finished.

## Collector unavailable

Applications must continue serving requests and health checks when telemetry export is disabled or
the Collector is unavailable. They must not wait for telemetry export as part of user work. Check
the local Collector health endpoint and logs, then verify the producer endpoint and protocol. Do
not repeatedly restart application services as a substitute for correcting a Collector or network
configuration.

## Redaction and shutdown

The Collector's attribute processor is not a general-purpose scrubber for free-form log bodies,
span names, or event names. Producers must not export credentials, tokens, prompts, message bodies,
or raw provider responses. If sensitive data is observed, disable producer export, preserve only
minimal safe diagnostic evidence, correct the emitting field, and add a focused regression check
before re-enabling export.

Producer shutdown hooks should flush telemetry with a bounded timeout. Collector unavailability
must not hang application termination.

## Hosted deployment

Hosted setup, endpoint changes, and production cutover are deferred. Do not apply Railway
configuration or change hosted producer variables as part of the source move. Before any later
deployment, confirm the target environment and plan, the durable destination and access policy,
and the rollback path. The current source and staging declaration are documented in the
[Collector README](../infra/observability/otel-collector/README.md).
