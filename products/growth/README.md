# KasiTek Growth

This repository contains the standalone KasiTek Growth product. The Labs, Agency, and Agent
Platform repositories own their extracted services and applications; see [Current repository
architecture](ARCHITECTURE.md) for the ownership map.

## Start here

- [Current repository architecture](ARCHITECTURE.md)
- [Growth feature map](docs/features/README.md)
- [Project coding standards](CODING_STANDARDS.md)
- [Domain context](CONTEXT.md), intentionally empty until project terms are agreed
- [Local development and verification](docs/internal/development/local-development.md)
- [Release process](docs/internal/operations/release-process.md)

## Local development

Core and the client use Node.js 24, pinned in `.nvmrc`, and their package manifests pin pnpm.
Core runs natively as TypeScript. PostgreSQL and Redis
are needed by services that use them. Agent Platform services are developed from the
`Kasitek-Labs/kasitek-agents` repository, not from this Growth checkout.

For a local client and Core API stack, start with:

```sh
./scripts/run_local_stack.sh core client
```

The [local development guide](docs/internal/development/local-development.md) has environment
setup, service groups, ports, migrations, and focused verification commands. Start only the
services required for your task.

## Work and decisions

- Historical plans are preserved in [`docs/plans/parked/`](docs/plans/parked/README.md). They are
  reference material, not a work queue.
- Product-level architecture decisions belong in [`docs/adr/`](docs/adr/README.md).
- Agent-specific ADRs and implementation decisions are owned with the Agent service in
  `Kasitek-Labs/kasitek-agents`.
- Growth retains the Kāsiai Agent API client and Core's authenticated Agent bridge as product-side
  integrations.
