# KasiTek Growth

This repository is being refocused as the standalone KasiTek Growth product. It still contains
some non-Growth service source whose extraction is tracked in GitHub Issues. Perform only the
moves named by those issues; this overview does not authorize additional extractions.

## Start here

- [Current repository architecture](ARCHITECTURE.md)
- [Growth feature map](docs/features/README.md)
- [Project coding standards](CODING_STANDARDS.md)
- [GitHub Issues](https://github.com/Kasitek-Labs/kasitek-growth/issues) and [Growth Project](https://github.com/orgs/Kasitek-Labs/projects/1)
- [Domain context](CONTEXT.md), intentionally empty until project terms are agreed
- [Local development and verification](docs/internal/development/local-development.md)
- [Release process](docs/internal/operations/release-process.md)

## Local development

The client workspace uses Node.js and pnpm versions recorded in `client/package.json` and
`.nvmrc`. Rust services use the toolchain in `server/rust-toolchain.toml`. PostgreSQL and Redis
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

- Specs and implementation work belong in [GitHub Issues](https://github.com/Kasitek-Labs/kasitek-growth/issues).
- Former active plans are preserved in [`docs/plans/parked/`](docs/plans/parked/README.md). They
  are reference material, not a work queue.
- Product-level architecture decisions belong in [`docs/adr/`](docs/adr/README.md).
- Agent-specific ADRs and implementation decisions are owned with the Agent service in
  `Kasitek-Labs/kasitek-agents`.
- Growth retains the Kāsiai Agent API client and Core's authenticated Agent bridge as product-side
  integrations.
