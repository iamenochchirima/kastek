# KasiTek Labs

Shared infrastructure and platform services owned outside the Growth, Agents, and Agency
products.

## OpenTelemetry Collector

The Collector image, local profiles, and staging profile live in
[`infra/observability/otel-collector`](infra/observability/otel-collector/README.md). Railway's
service declaration is the named `otel-collector` partial in [`.railway/railway.ts`](.railway/railway.ts).
The operational notes are in [`docs/otel-collector-runbook.md`](docs/otel-collector-runbook.md).

Run it locally from the repository root:

```sh
docker compose -f infra/observability/otel-collector/compose.yaml up --build
```
