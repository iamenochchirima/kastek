---
id: local-development
title: Local Development
sidebar_position: 2
owner: engineering
last_reviewed: 2026-10-24
---

# Local Development

This page describes the supported local development paths for the KasiTek monorepo. Start only
the services needed for the change; the complete stack is useful for integration work but is not
required for ordinary UI or library changes.

Paths and commands on this page are relative to `products/growth/` unless stated otherwise.
Install dependencies from the repository root with `pnpm install --frozen-lockfile`. Root
`pnpm dev:growth` and `pnpm dev:growth-api` also start the frontend and API directly.

## Toolchain

Use the versions pinned by the repository where they exist:

- Node.js: root `.nvmrc`
- pnpm: root `package.json` `packageManager`
- PostgreSQL and Redis for services that require them

Check the installed versions before debugging application failures. A mismatched toolchain can
look like a code or dependency problem.

## Core build output

Core uses native TypeScript under `api/src`. Build its production
JavaScript with:

```bash
pnpm --dir api build
```

The compiler writes `api/dist`. Growth no longer carries a Rust
Core build directory. The prior Rust source remains recoverable from Git history.
For standalone Core setup, use [`api/.env.example`](../../../api/.env.example)
as the non-secret baseline. OIDC client values are listed separately in
[`api/.env.identity.example`](../../../api/.env.identity.example);
the root dotenv vault remains the source for local credentials.

## Environment files

The local stack uses the root dotenv-vault as the merged source of truth. The working copies are
generated into service-specific dotenv files and must not be committed with secrets.

```bash
./scripts/sync_dotenv_vaults.sh login   # one-time bootstrap
./scripts/sync_dotenv_vaults.sh pull
./scripts/sync_dotenv_vaults.sh status
```

After changing a local environment file, push the intended change to the vault only when that is
part of the task:

```bash
./scripts/sync_dotenv_vaults.sh push
```

Never paste credentials into a plan, issue, log, test fixture, or documentation page.

## Shared login

Growth login requires the native shared Keycloak service. From the repository root, start it
before Core and the client:

```bash
cd infra/identity
./identity.sh start
```

The first setup requires explicit `./identity.sh install` and secret configuration described in
root `infra/identity/README.md`. No Docker. Identity PostgreSQL is a separate local cluster on
port 55432; Growth's existing database is unchanged. Stop identity with `./identity.sh stop` when
it is not needed.

Set the Core OIDC variables from [the shared login contract](../architecture/shared-login.md).
Use `http://localhost:3000/api/auth/callback` through the same-origin frontend proxy. The account console owns
email/password, Google, passkeys, optional two-factor authentication and recovery. The development
email inbox is `http://localhost:8025/`; set Core `LOCAL_MAILPIT_URL` for organization invitations.

## Starting services

The launcher uses the native Node.js 24 Core. See
[TypeScript Core commands and worker modes](typescript-core.md). Stop any Core
process already using port 4000 before starting it.

The launcher opens requested Growth processes in their own terminals. It does not start the moved
Analytics, Agency, or Agent services. Their source and local commands are under root
`services/analytics/`, `products/agency/` and `products/agents/`. Growth retains its product
publishers and consumer integrations.

```bash
./scripts/run_local_stack.sh core client
./scripts/run_local_stack.sh internal-docs  # Internal docs at http://localhost:3006
./scripts/run_local_stack.sh --help
```

This launcher does not start the tenant API or portal. Their source and local commands are in the
`products/agency/README.md`.

The default no-argument invocation starts Growth-owned Core, client apps, and internal docs. The
moved services and their migrations are maintained in their owning product packages.

For focused work, manual commands are also supported:

```bash
./scripts/dev_core_watch.sh
pnpm --dir web run dev
```

## Growth frontend build

Growth uses React 19 with Vite and React Router framework mode. Development runs on port 3000.
The production build prerenders `/` and emits the private application shell separately.
React Router client loaders replace Next server components; Core still owns authorization,
cookies, data, and mutations. Route declarations are in `web/src/routes.ts`.

From the repository root, build the shared packages and Growth services with:

```bash
pnpm build:growth
```

To run the built frontend against an existing Core process:

```bash
CORE_API_BASE_URL=http://localhost:4000 FRONTEND_URL=http://localhost:3000 pnpm --dir products/growth/web start -- --hostname 127.0.0.1 --port 3000
```

The frontend serves `web/build/client` through `web/scripts/serve.mjs`. Its `/api/*` reverse
proxy preserves browser cookies, multiple Set-Cookie headers, uploads, and streaming responses.
Use this server for production-path checks; `vite preview` is not the production server.
Do not put API secrets or signing keys in `VITE_*` variables. Those values enter the browser bundle.
`VITE_META_APP_ID` and `VITE_META_EMBEDDED_SIGNUP_CONFIG_ID` are public build-time identifiers
for WhatsApp embedded signup. Set them before building when that flow is required.

See the [frontend release runbook](../operations/growth-frontend-release.md) for proxy configuration,
SEO, PWA updates, validation, and rollback. The root `dev:growth` command continues to use the
`client` workspace package; other products retain their own frontend frameworks.

The central Admin UI is under root `apps/admin-site/`. Run `pnpm dev:admin` from the repository root.

## Local service ports

| Service | Default port | Liveness or readiness check |
| --- | ---: | --- |
| Core API | 4000 | `/health` (liveness; PostgreSQL is checked before the server listens) |
| Client | 3000 | browser application |

The launcher is the authoritative list for local service names and ports. If an individual
service changes its port, update the launcher and this table together.

## Local OpenTelemetry export

The Collector is under root `infra/observability/`. Use its
[local-run instructions](https://github.com/Kasitek-Labs/kastek/blob/main/infra/observability/otel-collector/README.md).
It accepts OTLP over gRPC on `4317`, OTLP over HTTP/protobuf on `4318`, and exposes its health
endpoint on `13133`. The debug exporter is for local inspection only; it is not durable storage.
When a local Collector is running, point a Growth producer at it with:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_DEPLOYMENT_ENVIRONMENT=local
export OTEL_SERVICE_NAME=kasitek-core
```

For Core also set `KASITEK_VERSION`, `KASITEK_RELEASE_ID`, and `KASITEK_COMMIT_SHA`
when testing release identity. The application continues with stdout logging when these
variables are absent or `OTEL_SDK_DISABLED=true`. For Collector operation, see the
[Labs Collector runbook](https://github.com/Kasitek-Labs/kastek/blob/main/docs/labs/otel-collector-runbook.md).

## Verification before opening a pull request

- Run the narrowest relevant test or type check.
- Run the service build when changing deployment or integration boundaries.
- Exercise the changed user or API path locally.
- Confirm logs contain no credentials or unnecessary personal data.
- Record any required migration, environment, analytics, logging, or documentation change in the
  release record.

For release work, follow the internal [Feature and Platform Release Process](../operations/release-process.md).

## Growth agent setup worker

New organisations queue four managed agents and their model automatically. Configure the explicit
model profile and independent provisioning keypair in [Growth integration](../../../../agents/docs/growth-integration.md#automatically-provision-organisation-defaults).
When API background workers are disabled, start a dedicated API process with
`KASITEK_PROCESS=growth-agent-setup-worker`. Run `pnpm --filter @kasitek/growth-core agents:setup status`
to inspect setup counts, attempts, pending age and duration; use its bounded `backfill 100` command
for organisations created before this worker was enabled. No model inference or evaluations run
as part of setup.
