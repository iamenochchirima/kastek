---
owner: engineering
last_reviewed: 2026-09-29
---

# Current repository architecture

This document describes the applications, services, and shared code present in this repository.

## Current component map

| Path / owner | Source or behavior | Role in the split |
| --- | --- | --- |
| `client/apps/client/` | Main Next.js client, including campaigns, contacts, inbox, content, calendar, bookings, analytics, workspace, billing, and Kāsiai. | Contains Growth routes, the app shell, and product-side Agent integrations. |
| `client/apps/admin/` | Next.js admin application with agency, lead, outreach, quotation, invoice, operations, analytics, and access routes. | Contains the Growth Admin provisioning client for Agency. |
| `client/apps/labs/` | Separate Next.js app package. | Product UI package. |
| `client/packages/` | Shared database package. | Used by the client applications in this repository. |
| `Kasitek-Labs/kasitek-agents` | Agent API, gateway, workers, runtime, migrations, management UI, and Temporal integration. | Agent Platform source owner; Growth consumes its API. |
| `server/kasitek-core/` | Rust Core service. | Core API and its service-owned modules. |
| `server/kasitek-analytics/` | Rust Analytics API, workers, migrations, and reporting code. | Analytics service source. |
| `server/crates/` | Rust crates used by server workspace members. | Includes shared configuration, observability, security, and analytics packages. |
| `scripts/`, `infra/` | Local development, verification, and infrastructure support. | Includes service-specific scripts and infrastructure definitions. |
| `docs/` | User and internal technical documentation. | Documents current repository behavior and interfaces. |

The Agency tenant API, migrations, analytics publisher, and portal are not present in this
checkout. Agency source lives in `Kasitek-Labs/kasitek-agency`; Growth Admin retains the
provisioning client in `client/apps/admin/`. Agent runtime and management UI source live in
`Kasitek-Labs/kasitek-agents`; Growth retains the Kāsiai API client, Core bridge, and customer
Agent activity data.

## Runtime and dependency notes

- The frontend is a pnpm workspace under `client/`.
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
