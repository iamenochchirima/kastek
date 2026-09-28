# OpenTelemetry Collector

Labs owns this Collector image, its configuration, and its deployment source. The service receives
logs, traces, and metrics over OTLP, applies bounded processing, and currently writes received
telemetry to the debug exporter. The debug exporter supports local and staging verification only;
it is not a durable production destination.

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

| Purpose            | Endpoint                  |
| ------------------ | ------------------------- |
| OTLP gRPC          | `http://127.0.0.1:4317`   |
| OTLP HTTP/protobuf | `http://127.0.0.1:4318`   |
| Health             | `http://127.0.0.1:13133/` |

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

## Railway staging service

The named `otel-collector` partial in `.railway/railway.ts` declares one Railway service from
`Kasitek-Labs/kasitek-labs`, rooted at `infra/observability/otel-collector`. It uses the checked-in
Dockerfile, health check, restart policy, and staging config. The declaration does not add a public
domain or TCP proxy.

Pull requests that change `.railway/` get a read-only plan comment from the `Railway IaC plan`
workflow. Set the repository Actions secret `RAILWAY_TOKEN` to a Railway project token scoped to
the `staging` environment. The workflow does not apply changes.

Before applying the partial:

1. Confirm the linked Railway project and environment are isolated staging. Check their current
   IDs and names with `railway status --json` and `railway environment list --json`. A project
   label alone does not prove the environment is safe to change.
2. Link the CLI to the confirmed project and environment, then run
   `railway config plan --file .railway/railway.ts`.
3. Inspect the plan. It must affect only the `otel-collector` service in the confirmed staging
   environment. Stop if it proposes changes to another service, a production environment, or
   project-wide settings.
4. Apply only after the target and plan are confirmed. Set resource limits appropriate to the
   environment; sizing is intentionally not encoded in this provider-neutral service declaration.
5. Keep the production Collector source, configuration, and application endpoints unchanged.
   Do not deploy the production template until its destination, retention, and access controls are
   approved.
6. After staging verification, configure a staging application service to use the Collector's
   private address, for example:

   ```text
   OTEL_EXPORTER_OTLP_ENDPOINT=http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   ```

7. Keep staging and production Collector services and variables separate. Keep OTLP ports `4317`
   and `4318` private; do not add public domains or TCP proxies.

Railway's TypeScript IaC is generally available. CI typechecks `.railway/railway.ts`, but does not
apply it. Before a staging change, run `railway config plan` against the isolated `staging`
environment and check that it proposes only the intended Collector change.

## Staging rollback

Before changing a staging producer endpoint, record the previous endpoint and the running Growth
Collector deployment/config revision. Do not record secret values. If staging export or health
checks fail, restore the producer's previous OTLP endpoint and redeploy that producer if needed.
Keep the Growth Collector available until the separate Growth cleanup issue is complete. This
rollback changes staging only; leave production untouched.

## Configuration policy

- Pin the Collector image version and update it deliberately.
- Keep `debug` as the local/staging verification exporter until a durable backend is approved.
- The `attributes/redact` processor removes matching telemetry attributes only. It does not inspect
  or redact `LogRecord.body`, free-form strings, span names, or event names. Producers must not
  export prompts, message bodies, credentials, or raw provider responses in those fields. Treat
  this Collector as a transport and attribute filter, not a general-purpose privacy scrubber.
- Add a future backend exporter in environment-specific configuration, not in application code.
- Do not add backend credentials, tenant data, authorization material, or raw provider responses
  to this directory.
- Keep the Collector optional to application availability: an application must continue serving
  requests and health checks when export is disabled or the Collector is unavailable.

## Validation

From the repository root, validate every profile through the pinned image:

```bash
docker build -t kasitek-otel-collector:local infra/observability/otel-collector
for config in config.yaml config.local.yaml config.staging.yaml config.production.template.yaml; do
  docker run --rm \
    -e PORT=13133 \
    -e OTEL_BACKEND_ENDPOINT=http://127.0.0.1:4318 \
    -e OTEL_BACKEND_AUTH=local-placeholder \
    kasitek-otel-collector:local \
    validate --config="/etc/otelcol/$config"
done
```

With the local Compose service running, send one test record for each signal:

```bash
python3 scripts/verify_otel_collector.py --endpoint http://127.0.0.1:4318
```

Confirm the Collector output contains `kasitek-otel-smoke` and the log, metric, and span markers.
Growth and Agents CI continue to test their own telemetry SDKs and their behavior when export is
disabled. The production template documents generic OTLP queue and retry settings. Do not deploy
it until a durable destination is approved.

Railway IaC reference: [Infrastructure as Code](https://docs.railway.com/infrastructure-as-code).
