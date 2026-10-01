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
contracts, application configuration helpers, cryptographic utilities, and observability. They are
private Git-sourced packages, pinned by consumers to the `rust-crates-v0.1.0` release tag. `publish = false`
prevents accidental publication to a public registry. Builds that consume them need read access to
this repository; service-to-service behavior still crosses the services' HTTP or event interfaces.

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

## Admin UI

The standalone admin application lives in [`apps/admin-site`](apps/admin-site/README.md). It
uses Growth Core and Agency HTTP APIs; hosting cutover remains separate work.
