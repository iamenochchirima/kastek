# Current repository architecture

This document describes code and integrations that remain in this checkout during the repository
split. Presence in Growth does not make a component Growth-owned.

## Product direction

This repository is being separated into standalone product repositories. The source-split issues
identify what moves and what Growth-side integration code remains. Do not retain a second service
implementation as a fallback when an integration is temporarily disconnected.

## Current component map

| Path | What is present in this checkout | Boundary status |
| --- | --- | --- |
| `client/apps/client/` | Main Next.js client, including campaigns, contacts, inbox, content, calendar, bookings, analytics, workspace, billing, and agent-facing routes. | Growth-facing routes and agent-facing routes coexist. Final ownership is not fully mapped. |
| `client/apps/admin/` | Next.js admin application with agency, lead, outreach, quotation, invoice, operations, analytics, and access routes. | Present in the repo. Long-term product/repo ownership is not recorded here. |
| `client/apps/labs/` | Separate Next.js app package. | Present in the repo. Product boundary is not recorded here. |
| `client/packages/` | Shared client packages, including database and API-client packages. | Consumers and extraction constraints must be checked before moving a package. |
| `agents/` | TypeScript Agent Platform API, gateway, workers, runtime, migrations, tests, and Temporal integration. | The owner intends Agents to be a separate product. Its code remains here until a separately approved extraction. |
| `server/kasitek-core/` | Rust Core service. | Service boundary exists in code; final product/repository ownership is not decided here. |
| `server/kasitek-analytics/` | Rust Analytics API, workers, migrations, and reporting code. | Present in the shared Rust workspace. Future product boundary is not recorded here. |
| `server/crates/` | Rust crates shared by server workspace members. | Check dependencies and ownership before extraction. |
| `scripts/`, `infra/` | Local development, verification, and infrastructure support. | Some scripts may span several services; check their consumers before moving them. |
| `docs/` | User, internal, and temporary planning documents. | Existing documents have not been reconciled by this setup. Use the new entry points linked from the root README and `AGENTS.md`. |

Agency PR #5 moves the API and portal source into `Kasitek-Labs/kasitek-agency` under
`server/kasitek-tenants/` and `client/apps/tenant-portal/`. Growth retains the Admin-side
provisioning client in `client/apps/admin/` for later integration work; it does not retain the
Agency service or portal implementation.

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
4. Record only settled domain vocabulary in [`CONTEXT.md`](CONTEXT.md). It is intentionally empty
   at the owner's direction.
