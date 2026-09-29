---
id: local-development
title: Local Development
sidebar_position: 2
owner: engineering
last_reviewed: 2026-09-29
---

# Local Development

This page describes the supported local development paths for the KasiTek monorepo. Start only
the services needed for the change; the complete stack is useful for integration work but is not
required for ordinary UI or library changes.

## Toolchain

Use the versions pinned by the repository where they exist:

- Node.js: `.nvmrc`
- pnpm: `package.json` `packageManager`
- Rust: `server/rust-toolchain.toml`
- PostgreSQL and Redis for services that require them
- Temporal for Agent Platform workflows; local Temporal Server is optional

Check the installed versions before debugging application failures. A mismatched toolchain can
look like a code or dependency problem.

## Rust build output

All Rust services are members of the `server` workspace and share `server/target`. The development
profile keeps incremental compilation enabled for local iteration but stores reduced debug
information. Remove accumulated development artifacts when needed:

```bash
cargo clean --manifest-path server/Cargo.toml --profile dev
```

The target directory is disposable and is not part of the runtime or release artifact.

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

## Starting services

The launcher opens each requested process in its own terminal. It uses local defaults for
Analytics and can start a local Temporal Server when `TEMPORAL_MODE=local` is set.

```bash
./scripts/run_local_stack.sh core client
./scripts/run_local_stack.sh tenants       # Tenant API + tenant portal only
./scripts/run_local_stack.sh agents-api agents-worker agent-gateway
./scripts/run_local_stack.sh analytics-api analytics-worker
./scripts/run_local_stack.sh internal-docs  # Internal docs at http://localhost:3006
./scripts/run_local_stack.sh --help
```

The `tenants` group starts `tenant-api` on port `8090` and `tenant-portal` on port `3010`. It
does not start Core, Agents, Analytics, the direct client, Admin, Labs, or Temporal. Use
`tenant-api` or `tenant-portal` when only one tenant process is needed. The launcher loads the
Tenant API environment from `server/kasitek-tenants/.env` and the portal environment from
`client/apps/tenant-portal/.env` and `.env.local`; the portal defaults its server-side proxy to
`http://127.0.0.1:8090`. When `tenant-api` is selected, the launcher requires a loopback Tenant
PostgreSQL URL. It uses `KASITEK_LOCAL_TENANT_DATABASE_URL` when set; otherwise it derives
`kasitek_tenants` from the local `AGENTS_DATABASE_URL` and creates that database if it is absent.
The generic `DATABASE_URL` is never used as the Tenant database fallback.

The default no-argument invocation starts the core, tenant, Analytics API, Agent API and worker,
Agent gateway, client apps, internal docs, and local Temporal when local mode is enabled. Start
migrations as a separate release-like step before services that need the database:

```bash
./scripts/run_local_stack.sh analytics-migrate
pnpm --dir agents run migrate
```

For focused work, manual commands are also supported:

```bash
./scripts/dev_core_watch.sh
pnpm --dir agents run dev:api
pnpm --dir agents run dev:worker
pnpm --dir agents run dev:gateway
pnpm --dir client run dev
pnpm --dir client run dev:admin
pnpm --dir client --filter tenant-portal dev
```

## Local service ports

| Service | Default port | Liveness or readiness check |
| --- | ---: | --- |
| Core API | 4000 | `/health/live`, `/health/ready` where enabled |
| Tenant Platform | 8090 | service health endpoint |
| Analytics API | 4300 | `/health/live`, `/health/ready` |
| Agent API | 4100 | `/health/live`, `/health/ready` |
| Agent gateway | 4200 | `/health`, `/health/ready` |
| Client | 3000 | browser application |
| Admin | 3001 | browser application |
| Labs | 3007 | browser application |
| Temporal | 7233 | Temporal service endpoint |

The launcher is the authoritative list for local service names and ports. If an individual
service changes its port, update the launcher and this table together.

## Local OpenTelemetry export

The Collector is owned by the Labs repository. Start it from a separate Labs checkout using the
[Collector local-run instructions](https://github.com/Kasitek-Labs/kasitek-labs/blob/main/infra/observability/otel-collector/README.md).
It accepts OTLP over gRPC on `4317`, OTLP over HTTP/protobuf on `4318`, and exposes its health
endpoint on `13133`. The debug exporter is for local inspection only; it is not durable storage.
When a local Collector is running, point a Growth producer at it with:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_DEPLOYMENT_ENVIRONMENT=local
export OTEL_SERVICE_NAME=kasitek-agents
```

For the Rust services also set `KASITEK_VERSION`, `KASITEK_RELEASE_ID`, and `KASITEK_COMMIT_SHA`
when testing release identity. The application continues with stdout logging when these
variables are absent or `OTEL_SDK_DISABLED=true`. For Collector operation, see the
[Labs Collector runbook](https://github.com/Kasitek-Labs/kasitek-labs/blob/main/docs/otel-collector-runbook.md).

## Verification before opening a pull request

- Run the narrowest relevant test or type check.
- Run the service build when changing deployment or integration boundaries.
- Exercise the changed user or API path locally.
- Confirm logs contain no credentials or unnecessary personal data.
- Record any required migration, environment, analytics, logging, or documentation change in the
  release record.

For release work, follow the internal [Feature and Platform Release Process](../operations/release-process.md).
