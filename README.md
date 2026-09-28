# KasiTek Growth

This repository is being refocused as the standalone KasiTek Growth product. The checkout is
still a monorepo and contains code for other product areas. Their ownership and extraction will
be handled through separately approved work. Do not assume those moves have happened or move
components as part of routine setup.

## Start here

- [Current repository architecture](ARCHITECTURE.md)
- [Growth feature map](docs/features/README.md)
- [Project coding standards](CODING_STANDARDS.md)
- [Issue tracker and work flow](docs/agents/issue-tracker.md)
- [Domain context](CONTEXT.md), intentionally empty until project terms are agreed
- [Local development and verification](docs/internal/development/local-development.md)
- [Release process](docs/internal/operations/release-process.md)

## Local development

The client workspace uses Node.js and pnpm versions recorded in `client/package.json` and
`.nvmrc`. Rust services use the toolchain in `server/rust-toolchain.toml`. PostgreSQL and Redis
are needed by services that use them. Local Temporal is needed only for Agent Platform workflow
work.

For a local client and Core API stack, start with:

```sh
./scripts/run_local_stack.sh core client
```

The [local development guide](docs/internal/development/local-development.md) has environment
setup, service groups, ports, migrations, and focused verification commands. Start only the
services required for your task.

## Work and decisions

- Specs and implementation work belong in the [issue tracker](docs/agents/issue-tracker.md).
- Former active plans are preserved in [`docs/plans/parked/`](docs/plans/parked/README.md). They
  are reference material, not a work queue.
- Product-level architecture decisions belong in [`docs/adr/`](docs/adr/README.md).
- Agent-specific ADRs already under `agents/docs/adr/` remain there.
