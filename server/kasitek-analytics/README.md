# KasiTek Analytics

Standalone customer-facing analytics service foundation.

The A-01 and A-02 packages provide three process commands from one Rust crate:

- `analytics-api`: health endpoints and the future ingestion/reporting boundary.
- `analytics-worker`: durable worker process reserved for future projections, reconciliation, and
  replay loops.
- `analytics-migrate`: release job for forward-only migrations.

Analytics requires its own database URL. It must not reuse Core, Tenant Platform, or Agent Platform
database credentials.

## Local configuration

Normal local development uses native PostgreSQL and, when installed, native Redis. Create a
dedicated `kasitek_analytics` database and `analytics` database role; never point this service at
Core's `DATABASE_URL`. Redis is non-authoritative and can be omitted until cache code is enabled.
Copy `.env.example` to `.env`; the service loads it from the repository stack script or Cargo.

```bash
cp .env.example .env
cargo run --bin analytics-migrate
```

Start the normal local stack with only the Analytics API. Run the worker explicitly when testing
worker behavior:

```bash
./scripts/run_local_stack.sh analytics-api
./scripts/run_local_stack.sh analytics-worker
```

The migration command is a one-time release job, not a long-running local service. The optional
Docker Compose definition is retained for isolated integration and deployment-shape testing:

```bash
docker compose -f compose.yaml up --build
```

The API and worker never run migrations themselves. The release job takes the PostgreSQL advisory
lock and must complete before those processes are deployed. `scripts/backup.sh` creates a custom
format PostgreSQL dump with a checksum and metadata; `scripts/restore.sh` requires explicit
confirmation and stopped services.

The API listens on `ANALYTICS_API_PORT` (default `4300`). Check:

```bash
curl http://127.0.0.1:4300/health/live
curl http://127.0.0.1:4300/health/ready
```

The API can start while PostgreSQL is unavailable because its pool is lazy. Readiness returns
`503` until the database responds. Redis is a non-authoritative cache boundary and is optional to
the A-02 process configuration; cache behavior is implemented later. The worker currently starts
and waits for shutdown; projection, ingestion, and reconciliation loops belong to later execution
packages.

## A-01 boundary

This package does not yet create analytics facts, event schemas, source outboxes, ingestion routes,
scope registries, projections, Redis caches, reporting APIs, or customer dashboards. A-02 creates
only the dedicated `analytics` PostgreSQL schema namespace; product tables belong to later packages.
