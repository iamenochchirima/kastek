# KasiTek Labs

Shared infrastructure and platform services owned outside the Growth, Agents, and Agency
products.

## OpenTelemetry Collector

The Collector image, local profiles, staging profile, and Railway service configuration live in
[`infra/observability/otel-collector`](infra/observability/otel-collector/README.md).

Run it locally from the repository root:

```sh
docker compose -f infra/observability/otel-collector/compose.yaml up --build
```
