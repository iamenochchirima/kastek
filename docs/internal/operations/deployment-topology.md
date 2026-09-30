---
id: deployment-topology
title: Railway Deployment Topology
sidebar_position: 6
owner: platform-ops
last_reviewed: 2026-09-29
---

# Railway Deployment Topology

This document is the current deployment reference for the KasiTek backend services on Railway.
It describes the service boundaries, source directories, builders, commands, health checks, and
network exposure for the Production environment. Staging uses the same service topology with
staging databases, credentials, domains, and environment values.

## Deployment rules

- Use the `main` branch for both environments.
- Enable automatic deployment in Staging.
- Disable automatic deployment in Production.
- Deploy and verify the candidate in Staging before manually deploying the same commit to
  Production.
- Keep Production and Staging databases, credentials, domains, queues, and telemetry destinations
  separate.
- Use Railway private networking for backend-to-backend calls.
- Use public domains only for browser-facing APIs or externally accessed protocols.
- Do not create a Railway service for a migration command, local bridge, or process that is already
  embedded in another service.

## Required application services

The following are the long-running Production services. Existing Core and Tenants services should
be configured or reused rather than duplicated inside the same Railway environment.

| Service | Root directory | Builder | Dockerfile path | Build command | Pre-deploy command | Start command | Health and port | Exposure |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Core API | `/server` | Railpack | Not applicable | `mkdir -p bin && cargo build --release -p kasitek-core && cp target/release/server bin/server` | Manual Prisma migration before deployment; see below | `./bin/server` | `/health`, `PORT=4000` | Public |
| Tenants API | `/server` | Railpack | Not applicable | `mkdir -p bin && cargo build --release -p kasitek-tenants && cp target/release/kasitek-tenants bin/kasitek-tenants` | Not applicable; the process currently runs tenant SQLx migrations at startup | `./bin/kasitek-tenants` | `/health`, `TENANT_SERVER_PORT` or Railway `PORT` (default `8090`) | Public |
| Agents API | `/agents` | Dockerfile | `Dockerfile` | Leave blank; the Dockerfile builds the image | Manual one-shot migration before deployment; see below | `node dist/http/server.js` | `/health/ready`, `4100` | Private |
| Agents Worker | `/agents` | Dockerfile | `Dockerfile` | Leave blank; the Dockerfile builds the image | None; deploy Agents API first | `node dist/temporal/worker.js` | No HTTP health check | Private |
| MCP Gateway | `/agents` | Dockerfile | `Dockerfile` | Leave blank; the Dockerfile builds the image | None | `node dist/gateway/server.js` | `/health/ready`, `4200` | Public when external MCP clients are enabled |
| Analytics API | `/server` | Dockerfile | `kasitek-analytics/Dockerfile` | Leave blank; the Dockerfile builds the image | Manual one-shot migration before deployment; see below | `/usr/local/bin/analytics-api` | `/health/ready`, `4300` | Private |
| Analytics Worker | `/server` | Dockerfile | `kasitek-analytics/Dockerfile` | Leave blank; the Dockerfile builds the image | None; deploy Analytics API first | `/usr/local/bin/analytics-worker` | No HTTP health check | Private |

For the Analytics services, if Railway does not provide a Dockerfile path field, add this
service variable:

```text
RAILWAY_DOCKERFILE_PATH=kasitek-analytics/Dockerfile
```

The Analytics Dockerfile builds and packages the API, worker, and migration binaries. It is used
by both Analytics services; the Start Command selects the process that each service runs.

The Agents Dockerfile is directly under `/agents`, so it does not need
`RAILWAY_DOCKERFILE_PATH`.

## Shared Railway variables

Use Railway shared variables for values that are identical for every service in one environment.
The current Production shared set is:

```text
NODE_ENV=production
LOG_LEVEL=info
OTEL_DEPLOYMENT_ENVIRONMENT=production
OTEL_EXPORTER_OTLP_ENDPOINT=http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

Keep database URLs, service ports, provider credentials, signing keys, and other service-specific
settings on the service that consumes them. Reference a database service's private URL using its
actual exported variable, for example:

```text
DATABASE_URL=${{core-db.DATABASE_URL}}
AGENTS_DATABASE_URL=${{agents-db.DATABASE_URL}}
ANALYTICS_DATABASE_URL=${{analytics-db.DATABASE_URL}}
KASITEK_TENANTS_DATABASE_URL=${{tenents-db.DATABASE_URL}}
```

Do not use `DATABASE_PRIVATE_URL` for these Railway Postgres services; this project exposes the
private connection as `DATABASE_URL`. Do not put private signing keys in shared variables merely
because more than one process needs related public configuration. Move any existing shared private
key into service-scoped variables during the next key rotation.

`OTEL_SERVICE_NAME` remains service-specific so telemetry can distinguish API, worker, gateway,
and migration processes. The shared OTLP endpoint is the transport boundary; it is not a durable
telemetry destination by itself.

## Migration behavior

Migrations are release steps, not long-running services.

The current Railway project does not expose a pre-deploy command field for these services. Run a
migration as a one-shot deployment by temporarily changing the service's Start Command to the
migration command, deploying once, verifying a successful exit, and restoring the normal Start
Command immediately. Never leave a migration command as the long-running service command.

### Agents

The Agents image contains the compiled migration file. For a one-shot deployment, temporarily use:

```text
node dist/db/migrate.js
```

The migration process must receive `AGENTS_MIGRATION_DATABASE_URL` for a separately controlled
DDL-capable migration role. `AGENTS_DATABASE_URL` remains the restricted application connection.
Set the migration variable only for the one-shot migration deployment, verify the migration, then
remove it before restoring the API start command. Never grant the runtime role `SUPERUSER` or
`BYPASSRLS` as a migration workaround.

After the command exits successfully, restore `node dist/http/server.js`. Do not use
`pnpm run migrate` in the production image: that script references the source tree and the
development `tsx` dependency, which are not included in the runtime image.

The migrated Agents API image reconciles the protected KasiAi definition during startup, before it
opens the API listener. It publishes an idempotent source-defined version, rolls it out to every
active protected installation, and fails startup if any installation remains stale. Therefore a
healthy `/health/ready` response is also evidence that the protected system agent is current.

For operator recovery or a separately controlled one-shot release, use the compiled command from
the migrated Agents API image:

```text
node dist/system/release-kasiai.js --rollout
```

Record the released agent version and release-gate result. The one-shot command is a recovery and
audit tool; normal production deployments use the API startup release gate.

### Analytics

The Analytics image contains the migration binary. For a one-shot deployment, temporarily use:

```text
/usr/local/bin/analytics-migrate
```

After the command exits successfully, restore `/usr/local/bin/analytics-api` on the API or
`/usr/local/bin/analytics-worker` on the worker. The migration binary uses the Analytics database
and must never receive a Core, Tenants, or Agents database URL.

### Core

Core's operational schema, including the Core-owned Analytics outbox, is owned by the client Prisma
migration chain. The Rust process does not run these migrations automatically. Before a new Core
database is used, open a temporary Railway SSH tunnel and run the migrations from the repository
root in a second terminal:

```text
railway connect core-db --environment production --tunnel-only --ssh --port 15432
railway run --project <project-id> --environment production --service core --no-local -- sh -c 'url=$(printf "%s" "$DATABASE_URL" | sed "s/@[^/]*:5432/@127.0.0.1:15432/"); DIRECT_URL="$url" pnpm --dir client/packages/database exec prisma migrate deploy'
```

Verify `No pending migrations to apply` before deploying or restarting Core. Existing databases must
follow the baseline procedure in
[Client database migration baseline](../architecture/client-database-migration-baseline.md),
including backup and schema review before `migrate resolve`.

The migration chain includes `analytics_outbox`, so a Core deployment must not be considered ready
until the migration command reports success. Do not apply the standalone files under
`server/kasitek-core/sql/` as a substitute for the Prisma migration history; those files remain the
source-service SQL inventory and are useful for isolated SQL verification.

### Tenants

The Tenants process currently runs its embedded SQLx migrations after connecting to its database.
Deploy only one migration-capable Tenants process at a time when applying schema changes.

## MCP deployment

The hosted MCP server is the `MCP Gateway` service. Its public endpoint is:

```text
https://<production-gateway-domain>/mcp
```

The gateway forwards authenticated requests to the private Agents API using:

```text
AGENT_PLATFORM_URL=http://${{agents-api.RAILWAY_PRIVATE_DOMAIN}}:4100
AGENT_GATEWAY_SHARED_SECRET=<same secret in Agents API and Gateway>
```

The `agents/src/gateway/stdio.ts` process is a local command-launched bridge for clients that
require stdio. It is not a hosted Railway service.

## Optional services

Deploy these only when the related capability is enabled and has an operational owner.

| Service | Root directory | Builder | Start command | Required when |
| --- | --- | --- | --- | --- |
| Discord Gateway | `/agents` | Dockerfile | `node dist/discord/server.js` | Discord gateway polling is enabled with `DISCORD_GATEWAY_ENABLED=true` |
| Agents Analytics Publisher | `/agents` | Dockerfile | `node dist/analytics/publisher-worker.js` | Agents analytics ingestion is enabled and independently scaled |
| Core Analytics Publisher | `/server` | Railpack | `./bin/server` | Core analytics ingestion is enabled; set `KASITEK_PROCESS=analytics-publisher` |
| Tenants Analytics Publisher | `/server` | Railpack | `./bin/kasitek-tenants` | Tenant analytics ingestion is enabled; set `KASITEK_PROCESS=analytics-publisher` |

Core's normal API process already starts the WhatsApp, social, campaign, webhook, and billing
workers. Tenants also has embedded worker behavior. Do not split these processes into separate
Railway services until independent scaling, isolation, or reliability evidence justifies it.

## OpenTelemetry Collector ownership

Labs owns the Collector source and service definition in
[`kasitek-labs/infra/observability/otel-collector`](https://github.com/Kasitek-Labs/kasitek-labs/tree/main/infra/observability/otel-collector).
The source move does not change or verify any hosted deployment. Deployment cutover, the running
artifact, and the active endpoint remain separate follow-up work.

Growth producers retain their OTLP exporter configuration. Do not change hosted endpoints as part
of this repository move:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_DEPLOYMENT_ENVIRONMENT=production
OTEL_SERVICE_NAME=<unique service name>
```

## Not Railway services

The following are dependencies, tools, or deployment steps rather than application services:

- Agents and Analytics database migrations; use one-shot deployments when no pre-deploy field is available.
- `analytics-registry`; run it as a validation command, not a server.
- MCP stdio; it is a local bridge.
- Core's individual embedded workers.
- Tenants' embedded workers.
- Temporal when using Temporal Cloud.
- Redis while Analytics Redis remains optional and non-authoritative.
- Vercel frontend deployments; those are configured separately from Railway.

## Production deployment order

1. Confirm Production shared variables, service-scoped variables, secrets, databases, and domains
   are correct.
2. Apply Agents and Analytics migrations as one-shot deployments; confirm each exits successfully.
   The Agents API startup release gate runs after the Agents migration and must complete before the
   API is considered healthy.
3. Apply the Core Prisma migration chain through the temporary database tunnel; confirm no pending
   migrations remain.
4. Deploy `agents-api`; confirm `/health/ready` is healthy and record the protected KasiAi version
   reported by the release-completion log.
5. Deploy `agents-worker`.
6. Deploy `MCP-Gateway` and configure its public MCP domain if required.
7. Deploy `analytics-api`; confirm `/health/ready` is healthy.
8. Deploy `analytics-worker`.
9. Update Core's private Agents and Analytics URLs, then deploy Core with `PORT=4000` and confirm
   `/health` is healthy.
10. Update Tenants' production variables, then deploy Tenants and confirm `/health` is healthy.
11. Confirm the Collector receives OTLP signals. Treat the debug profile as temporary until a
    durable backend is configured.
12. Run production smoke checks using the release ID and commit SHA.

Record the deployed commit, platform release ID, migration results, service revisions, health
checks, and rollback target in the release record defined by
[Feature and Platform Release Process](./release-process.md).
