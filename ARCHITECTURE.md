---
owner: engineering
last_reviewed: 2026-09-29
---

# Current repository architecture

This document describes the applications, services, and shared code present in this repository.

## Current component map

| Path | What is present in this checkout | Role here |
| --- | --- | --- |
| `client/apps/client/` | Main Next.js client, including campaigns, contacts, inbox, content, calendar, bookings, analytics, workspace, billing, and agent-facing routes. | Contains user-facing product routes and the shared app shell. |
| `client/apps/admin/` | Next.js admin application with agency, lead, outreach, quotation, invoice, operations, analytics, and access routes. | Contains the Growth Admin provisioning client for Agency. |
| `client/apps/labs/` | Separate Next.js app package. | Product UI package. |
| `client/packages/` | Shared client packages, including database and API-client packages. | Used by the client applications in this repository. |
| `agents/` | TypeScript Agent Platform API, gateway, workers, runtime, migrations, tests, and Temporal integration. | Agent Platform service source. |
| `server/kasitek-core/` | Rust Core service. | Core API and its service-owned modules. |
| `server/kasitek-analytics/` | Rust Analytics API, workers, migrations, and reporting code. | Analytics service source. |
| `server/crates/` | Rust crates used by server workspace members. | Includes shared configuration, observability, security, and analytics packages. |
| `scripts/`, `infra/` | Local development, verification, and infrastructure support. | Includes service-specific scripts and infrastructure definitions. |
| `docs/` | User and internal technical documentation. | Documents current repository behavior and interfaces. |

The Agency tenant API, migrations, analytics publisher, and portal are not present in this
checkout. Agency source lives in `Kasitek-Labs/kasitek-agency`; Growth Admin retains the
provisioning client in `client/apps/admin/`.

## Runtime and dependency notes

- The frontend is a pnpm workspace under `client/`.
- Rust services are members of `server/Cargo.toml`.
- Agent workflows use Temporal code under `agents/src/temporal/`.
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
