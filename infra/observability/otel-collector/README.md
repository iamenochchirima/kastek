# OpenTelemetry Collector

This directory contains the provider-neutral Collector boundary for KasiTek. It receives logs,
traces, and metrics over OTLP, applies bounded processing, and currently writes received telemetry
to the debug exporter. The debug exporter is for local and staging verification only; it is not a
durable production destination.

## Local run

Start the Collector from the repository root:

```bash
docker compose -f infra/observability/otel-collector/compose.yaml up --build
```

Compose uses `config.local.yaml` by default. Select another checked-in profile explicitly when
needed, for example `OTEL_COLLECTOR_CONFIG=config.staging.yaml` for a staging verification run.
The generic `config.yaml` is the minimal shared baseline used by the image and hosted-service
instructions.

The local endpoints are:

| Purpose | Endpoint |
| --- | --- |
| OTLP gRPC | `http://127.0.0.1:4317` |
| OTLP HTTP/protobuf | `http://127.0.0.1:4318` |
| Health | `http://127.0.0.1:13133/` |

Application services should use the standard OpenTelemetry variables for local export. The exact
SDK setup is added by each service's instrumentation change:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=kasitek-core
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=local
```

Do not put provider credentials in local configuration. Stop the Collector with `Ctrl-C` when the
test is complete.

## Railway deployment shape

Create one persistent `otel-collector` service in each Railway environment that needs the
Collector. Keep it in the same Railway project and environment as the application services, but
do not attach a public domain.

For this monorepo service:

1. Add a new service from the KasiTek GitHub repository.
2. Set the service root directory to `/infra/observability/otel-collector`.
3. Let Railway use the checked-in `railway.json`, which selects the pinned `Dockerfile`, health
   check, and restart policy.
4. Configure resource limits appropriate to the environment; sizing is not encoded in this
   provider-neutral service definition.
5. Set the Collector service's Custom Start Command to
   `/otelcol-contrib --config=/etc/otelcol/config.staging.yaml`. The image contains the checked-in
   profiles; select the profile explicitly per Railway environment. Keep the production template
   undeployed until a durable destination is approved.
6. Set each application service's OTLP endpoint to the Collector's private address, for example:

   ```text
   OTEL_EXPORTER_OTLP_ENDPOINT=http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   ```

7. Keep staging and production Collector services and variables separate.

Railway services in the same environment can communicate through private DNS. The Collector
should listen on OTLP ports `4317` and `4318` internally; those ports do not need public domains.

## Configuration policy

- Pin the Collector image version and update it deliberately.
- Keep `debug` as the local/staging verification exporter until a durable backend is approved.
- Add a future backend exporter in environment-specific configuration, not in application code.
- Do not add backend credentials, tenant data, message bodies, authorization material, or raw
  provider responses to this directory.
- Keep the Collector optional to application availability: an application must continue serving
  requests and health checks when export is disabled or the Collector is unavailable.

## Validation

Validate the configuration through the pinned image before changing the service:

```bash
docker build -t kasitek-otel-collector:local infra/observability/otel-collector
docker run --rm kasitek-otel-collector:local validate --config=/etc/otelcol/config.yaml
```

The full implementation must also send representative logs, traces, and metrics from at least one
Rust service and one Agents process, then verify the debug output and context fields. The
production template documents the generic OTLP exporter queue/retry settings that become
applicable after a durable backend is approved.
