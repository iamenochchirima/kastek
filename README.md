# KasiTek

Growth, Agents, Agency, shared platform services and the Labs websites live in one Git repository.
Each product keeps its own database, authorization, environment and deployment lifecycle.
The GitHub repository is [`Kasitek-Labs/kastek`](https://github.com/Kasitek-Labs/kastek).
The unified development branch remains `rewrite`.

## Layout

| Location | Owns |
| --- | --- |
| `products/growth/` | Growth client, database package, Core API and workers |
| `products/agents/` | Agent API, gateway, workers, MCP bridge and management UI |
| `products/agency/` | Agency tenant API, portal and private React API client |
| `apps/labs-site/`, `apps/admin-site/` | Public website and central administration |
| `packages/contracts/`, `packages/server-support/` | Explicit shared TypeScript interfaces and implementation |
| `services/analytics/` | Analytics API, workers, contracts registry and migrations |
| `infra/identity/`, `infra/observability/` | Shared identity and telemetry configuration |
| `designs/` | Design previews, storyboards and source references, outside runtime builds |
| `docs/programs/` | Cross-product program records carried from the workspace |

## Local development

Use Node 24.15.0 and pnpm 10.30.1. From this repository root:

```sh
nvm use
pnpm install --frozen-lockfile
pnpm build:shared
pnpm verify:boundaries
```

Start one product with `pnpm dev:growth`, `pnpm dev:agents`, or `pnpm dev:agency`.
Their APIs use `pnpm dev:growth-api`, `pnpm dev:agents-api`, or `pnpm dev:agency-api`.
The Agents API development command runs its existing migration step, so configure an isolated
local database first. `pnpm dev:labs` and `pnpm dev:admin` start the standalone sites.
Each package retains its product-specific commands and environment template. Never copy a
production environment into a test run. Backend migrations and external dependencies remain
product-specific; a root install does not start databases, Temporal or Keycloak.

Build a product with `pnpm build:growth`, `pnpm build:agents`, or `pnpm build:agency`.
`pnpm build:analytics` and `pnpm build:sites` cover platform applications. Shared packages build
before consumers; internal dependencies use `workspace:*` rather than archived tarballs.

Growth documentation sites remain isolated Node 22 installs under
`products/growth/docs/internal-site/` and `products/growth/docs/public/`. Their own frozen lockfiles
and build commands still apply. Use `pnpm --ignore-workspace install --frozen-lockfile` and
`pnpm --ignore-workspace build` from each documentation site so pnpm does not select the
application workspace. Railway IaC under `.railway/` retains its npm lockfile and separate
install. These are deliberate exceptions to the application workspace.

Read [the current architecture](ARCHITECTURE.md), [the migration plan](MONOREPO_MIGRATION_PLAN.md),
[Growth setup](products/growth/docs/internal/development/local-development.md),
[Agents setup](products/agents/README.md), [Agency setup](products/agency/README.md), and
[the hosting cutover record](docs/operations/hosting-cutover.md).

## Migration and source recovery

Original source histories remain reachable through non-squashed import commits.
[Import provenance](docs/source-repositories/imports.json) identifies the source checkpoints.
Local working changes were preserved before import. Credential files, runtime databases and
build output are excluded from the source tree.

A local source migration does not establish that hosting has switched. Keep the old repositories
and deployment artifacts until the cutover record proves no provider or consumer needs them.
