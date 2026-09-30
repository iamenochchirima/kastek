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

## Analytics

Labs owns the Analytics API, worker, schema, migrations, and service-owned build configuration in
[`services/analytics`](services/analytics/README.md). Growth-owned product publishers remain in
their product repositories; hosted deployment and database cutover are separate work.

## Shared Rust crates

Labs owns the cross-product Rust crates in [`crates/`](crates/): Analytics producer and reporting
contracts, application configuration helpers, cryptographic utilities, and observability. The
source move establishes a single destination owner; versioning and consumption from Growth and
Agency are tracked separately. Growth's copies remain until consumers can use an approved
distribution path.

Run a narrow local compile check for the shared libraries from the repository root:

```sh
cargo check --locked -p analytics-producer -p analytics-reporting -p config -p crypto-utils --lib
```

From the repository root, check the service package with:

```sh
cargo check -p kasitek-analytics --bins
```

## Website

The standalone Next.js website lives in [`apps/labs-site`](apps/labs-site/README.md).
Its quote-request, waitlist, and chat integrations retain their existing upstream API contracts.
Hosting, domains, and deployed environments remain separate cutover work.
