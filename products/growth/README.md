# KasiTek Growth

This directory contains the KasiTek Growth product inside the KasiTek monorepo. Growth owns
`web/`, `api/`, `database/`, product scripts and documentation. See the
[repository architecture](../../ARCHITECTURE.md) for the other product and platform owners.

## Start here

- [Current repository architecture](ARCHITECTURE.md)
- [Growth feature map](docs/features/README.md)
- [Project coding standards](CODING_STANDARDS.md)
- [Domain context](CONTEXT.md), intentionally empty until project terms are agreed
- [Local development and verification](docs/internal/development/local-development.md)
- [Release process](docs/internal/operations/release-process.md)

## Local development

Use the root Node.js 24/pnpm workspace and lockfile. Core runs natively as TypeScript.
PostgreSQL and Redis are needed by services that use them. Agent Platform services live under
`products/agents/` and keep their own database and authorization boundary.

For a local client and Core API stack, run from the repository root:

```sh
pnpm dev:growth-api
# In a second terminal:
pnpm dev:growth
```

The [local development guide](docs/internal/development/local-development.md) has environment
setup, service groups, ports, migrations, and focused verification commands. Start only the
services required for your task.

## Work and decisions

- Historical plans are preserved in [`docs/plans/parked/`](docs/plans/parked/README.md). They are
  reference material, not a work queue.
- Product-level architecture decisions belong in [`docs/adr/`](docs/adr/README.md).
- Agent-specific ADRs and implementation decisions are owned in `../agents/docs/`.
- Growth retains the Kāsiai Agent API client and Core's authenticated Agent bridge as product-side
  integrations.
