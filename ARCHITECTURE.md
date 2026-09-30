---
owner: engineering
last_reviewed: 2026-10-01
---

# Current repository architecture

This document maps the code currently present in Growth and the product repositories that now own
the extracted services.

## Current component map

| Path / owner | Source or behavior | Role in the split |
| --- | --- | --- |
| `client/apps/client/` | Main Next.js client, including campaigns, contacts, inbox, content, calendar, bookings, analytics, workspace, billing, and Kāsiai. | Contains Growth routes, the app shell, and product-side Agent integrations. |
| `client/packages/` | Shared database package. | Used by the Growth client. |
| [`kasitek-agents`](https://github.com/Kasitek-Labs/kasitek-agents) | Agent API, gateway, workers, runtime, migrations, management UI, and Temporal integration. | Agent Platform source owner; Growth consumes its API. |
| `server/kasitek-core/` | Rust Core service. | Core API and its service-owned modules. |
| [`kasitek-labs`](https://github.com/Kasitek-Labs/kasitek-labs) | Labs website, Analytics API and worker, contracts, migrations, reporting, OpenTelemetry Collector, shared Rust crates, and central Admin UI. | Labs owns these implementations; Growth consumes private Rust crates and retains product publishers and outboxes. Admin calls Growth Core and Agency over HTTP. Deployment cutover is separate work. |
| `server/crates/actions`, `execution`, `types` | Growth-owned Rust support libraries. | Used by Growth Core. |
| `scripts/`, `.github/workflows/` | Growth local development and verification automation. | Service-specific automation belongs with its owning service. |
| `docs/` | User and internal technical documentation. | Documents current repository behavior and interfaces. |
| [`kasitek-agency`](https://github.com/Kasitek-Labs/kasitek-agency) | Tenant API, migrations, portal, portal-only API client, and tenant-owned configuration. | Agency owns this white-label product source. |

The Agency tenant API, migrations, analytics publisher, and portal are not present in this
checkout. Agency source lives in `Kasitek-Labs/kasitek-agency`. The central Admin UI lives in
`Kasitek-Labs/kasitek-labs` and calls Growth Core and the Agency API over HTTP. Agent runtime and
management UI source live in `Kasitek-Labs/kasitek-agents`; Growth retains the Kāsiai API client,
Core bridge, and customer Agent activity data.

## Runtime and dependency notes

- The Growth client is a pnpm workspace under `client/`.
- Rust services are members of `server/Cargo.toml`.
- Agent workflows use Temporal in the Agents repository; Growth does not build or launch them.
- Local service startup, environment requirements, ports, and verification commands are recorded
  in [Local Development](docs/internal/development/local-development.md). Treat that file as the
  command source instead of copying its setup details into new docs.
- Service-to-service calls, data ownership, authentication boundaries, deployment ownership, and
  the final split between product repositories need to be verified for the specific change. This
  setup does not infer those contracts from directory names.

## Change boundaries

1. Work in the code that currently owns the behavior. Do not move it merely because its eventual
   product boundary is expected to change.
2. A component extraction needs an approved issue that names the source and destination, callers,
   data or identity boundary, deployment path, and verification needed to avoid breaking the
   current product.
3. When code and documentation disagree, inspect the implementation and its callers. Do not
   silently treat an older architecture document as proof of current behavior.
4. Record settled domain vocabulary in [`CONTEXT.md`](CONTEXT.md).
