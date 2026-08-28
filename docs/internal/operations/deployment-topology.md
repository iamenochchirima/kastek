---
id: deployment-topology
title: Railway Deployment Topology
sidebar_position: 6
owner: platform-ops
last_reviewed: 2026-08-28
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
| Core API | `/server` | Railpack | Not applicable | `mkdir -p bin && cargo build --release -p kasitek-core && cp target/release/server bin/server` | Not currently packaged | `./bin/server` | `/health`, Railway `PORT` (default `4000`) | Public |
| Tenants API | `/server` | Railpack | Not applicable | `mkdir -p bin && cargo build --release -p kasitek-tenants && cp target/release/kasitek-tenants bin/kasitek-tenants` | Not applicable; the process currently runs tenant SQLx migrations at startup | `./bin/kasitek-tenants` | `/health`, `TENANT_SERVER_PORT` or Railway `PORT` (default `8090`) | Public |
| Agents API | `/agents` | Dockerfile | `Dockerfile` | Leave blank; the Dockerfile builds the image | `node dist/db/migrate.js` | `node dist/http/server.js` | `/health/ready`, `4100` | Private |
| Agents Worker | `/agents` | Dockerfile | `Dockerfile` | Leave blank; the Dockerfile builds the image | None; deploy Agents API first | `node dist/temporal/worker.js` | No HTTP health check | Private |
| MCP Gateway | `/agents` | Dockerfile | `Dockerfile` | Leave blank; the Dockerfile builds the image | None | `node dist/gateway/server.js` | `/health/ready`, `4200` | Public when external MCP clients are enabled |
| Analytics API | `/server` | Dockerfile | `kasitek-analytics/Dockerfile` | Leave blank; the Dockerfile builds the image | `/usr/local/bin/analytics-migrate` | `/usr/local/bin/analytics-api` | `/health/ready`, `4300` | Private |
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

## Migration behavior

Migrations are release steps, not long-running services.

### Agents

The Agents API image contains the compiled migration file. Configure the Agents API's Railway
pre-deploy command as:

```text
node dist/db/migrate.js
```

Railway runs it in a temporary container before starting the API. Do not use `pnpm run migrate`
in the production image: that script references the source tree and the development `tsx`
dependency, which are not included in the runtime image.

### Analytics

The Analytics API image contains the migration binary. Configure the Analytics API's Railway
pre-deploy command as:

```text
/usr/local/bin/analytics-migrate
```

The Analytics API and worker must not start serving or processing data until the migration has
completed successfully. The migration binary uses the Analytics database and must never receive a
Core, Tenants, or Agents database URL.

### Core

Core has SQL files and an existing manual database setup process, but no dedicated production
migration binary or Railway pre-deploy command is currently packaged. Treat Core schema changes as
a release blocker until the controlled migration procedure is recorded for the affected release.

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

## OpenTelemetry Collector

Create one private Collector service per Railway environment when a durable telemetry backend is
configured.

| Service | Root directory | Builder | Start command | Health and port | Exposure |
| --- | --- | --- | --- | --- | --- |
| OTel Collector | `/infra/observability/otel-collector` | Dockerfile | `/otelcol-contrib --config=/etc/otelcol/config.production.template.yaml` | `/`, `13133` | Private |

The Production Collector template requires `OTEL_BACKEND_ENDPOINT` and `OTEL_BACKEND_AUTH`.
Until Axiom or another durable backend is configured, do not run the Production Collector and do
not claim that Production telemetry has durable retention. The staging Collector profile is for
verification and is not a Production logging destination.

Application services use the Collector's private address after it is available:

```text
OTEL_EXPORTER_OTLP_ENDPOINT=http://${{otel-collector.RAILWAY_PRIVATE_DOMAIN}}:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_DEPLOYMENT_ENVIRONMENT=production
OTEL_SERVICE_NAME=<unique service name>
```

## Not Railway services

The following are dependencies, tools, or deployment steps rather than application services:

- Agents and Analytics database migrations; use pre-deploy commands.
- `analytics-registry`; run it as a validation command, not a server.
- MCP stdio; it is a local bridge.
- Core's individual embedded workers.
- Tenants' embedded workers.
- Temporal when using Temporal Cloud.
- Redis while Analytics Redis remains optional and non-authoritative.
- Vercel frontend deployments; those are configured separately from Railway.

## Production deployment order

1. Confirm Production variables, secrets, databases, and domains are correct.
2. Deploy `agents-api`; confirm its pre-deploy migration succeeds and `/health/ready` is healthy.
3. Deploy `agents-worker`.
4. Deploy `agents-gateway` and configure its public MCP domain if required.
5. Deploy `analytics-api`; confirm its pre-deploy migration succeeds and `/health/ready` is healthy.
6. Deploy `analytics-worker`.
7. Update Core's private Agents and Analytics URLs, then deploy Core.
8. Update Tenants' production variables, then deploy Tenants.
9. Run production smoke checks using the release ID and commit SHA.
10. Configure the OTel Collector only after its durable backend is ready.

Record the deployed commit, platform release ID, migration results, service revisions, health
checks, and rollback target in the release record defined by
[Feature and Platform Release Process](./release-process.md).
