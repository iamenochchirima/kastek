# KasiTek Labs

Shared infrastructure and platform services owned outside the Growth, Agents, and Agency
products.

## OpenTelemetry Collector

The Collector image, local profiles, and staging profile live in
[`infra/observability/otel-collector`](infra/observability/otel-collector/README.md). Railway's
service declaration is the named `otel-collector` partial in [`.railway/railway.ts`](.railway/railway.ts).
The operational notes are in [`docs/otel-collector-runbook.md`](docs/otel-collector-runbook.md).

The Collector is optional during local development. Core and Analytics keep working when
telemetry is disabled or the Collector is unavailable. Do not start the container-based local
profile as part of this TypeScript migration.

## Analytics

Labs owns the Analytics API, worker, schema, migrations, and service-owned build configuration in
[`services/analytics`](services/analytics/README.md). Growth-owned product publishers remain in
their product repositories; hosted deployment and database cutover are separate work.

## Shared TypeScript packages

The cross-product packages live in [`packages/contracts`](packages/contracts) and
[`packages/server-support`](packages/server-support). They hold Analytics contracts, producer and
reporting clients, configuration helpers, cryptography, JSON handling, and telemetry. Services keep
product permissions and database transactions in their owning repositories; cross-service behavior
still uses HTTP and event interfaces.

Growth and Agency currently install checksummed local package tarballs while the migration is in
progress. GitHub Packages publication and authenticated clean installs are still pending. The
publisher is `pnpm publish:shared`; its requirements and safety checks are in the
[server-support README](packages/server-support/README.md). The original Rust implementation remains
recoverable from Labs commit `4eb66ad`.

Check the shared packages and Analytics TypeScript service from the repository root:

```sh
corepack pnpm build:shared
corepack pnpm test:shared
corepack pnpm --filter @kasitek/analytics typecheck
corepack pnpm --filter @kasitek/analytics build
```

## Website

The standalone Next.js website lives in [`apps/labs-site`](apps/labs-site/README.md).
Its quote-request, waitlist, and chat integrations retain their existing upstream API contracts.
Hosting, domains, and deployed environments remain separate cutover work.

## Admin UI

The standalone admin application lives in [`apps/admin-site`](apps/admin-site/README.md). It
uses Growth Core and Agency HTTP APIs; hosting cutover remains separate work.
