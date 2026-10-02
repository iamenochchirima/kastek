---
id: local-development
title: Local Development
sidebar_position: 2
owner: engineering
last_reviewed: 2026-10-02
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

## Shared login

Growth login requires the native Labs Keycloak service. Start it from the Labs repository before
starting Core and the client:

```bash
cd ../kasitek-labs/infra/identity
./identity.sh start
```

The first setup requires explicit `./identity.sh install` and secret configuration described in
Labs' `infra/identity/README.md`. No Docker. Identity PostgreSQL is a separate local cluster on
port 55432; Growth's existing database is unchanged. Stop identity with `./identity.sh stop` when
it is not needed.

Set the Core OIDC variables from [the shared login contract](../architecture/shared-login.md).
Use `http://localhost:3000/api/auth/callback` through the Next proxy. The account console owns
email/password, Google, passkeys, optional two-factor authentication and recovery. The development
email inbox is `http://localhost:8025/`; set Core `LOCAL_MAILPIT_URL` for organization invitations.

## Starting services

The additive Node.js replacement has separate
[TypeScript Core commands and worker modes](typescript-core.md). The current
launcher continues to use Rust until the migration cutover is verified.

The launcher opens requested Growth processes in their own terminals. It does not start the moved
Analytics, Agency, or Agent services. Analytics source and local commands are in the
[Labs Analytics service](https://github.com/Kasitek-Labs/kasitek-labs/tree/main/services/analytics).
Agency and Agent service source and local commands are in their owning repositories. Growth retains
product publishers and consumer integrations; reconnecting their delivery paths is separate work.

```bash
./scripts/run_local_stack.sh core client
./scripts/run_local_stack.sh internal-docs  # Internal docs at http://localhost:3006
./scripts/run_local_stack.sh --help
```

This launcher does not start the tenant API or portal. Their source and local commands are in the
Agency repository's README.

The default no-argument invocation starts Growth-owned Core, client apps, and internal docs. The
moved services and their migrations are maintained in their owner repositories.

For focused work, manual commands are also supported:

```bash
./scripts/dev_core_watch.sh
pnpm --dir client run dev
```

The central Admin UI is maintained in the Labs repository. See the
[Admin app guide](https://github.com/Kasitek-Labs/kasitek-labs/tree/main/apps/admin-site) for its
standalone local setup.

## Local service ports

| Service | Default port | Liveness or readiness check |
| --- | ---: | --- |
| Core API | 4000 | `/health/live`, `/health/ready` where enabled |
| Client | 3000 | browser application |

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
export OTEL_SERVICE_NAME=kasitek-core
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
