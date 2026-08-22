# KasiTek Analytics

Standalone customer-facing analytics service foundation.

The A-01 package provides two processes from one Rust crate:

- `analytics-api`: health endpoints and the future ingestion/reporting boundary.
- `analytics-worker`: durable worker process reserved for future projections, reconciliation, and
  replay loops.

Analytics requires its own database URL. It must not reuse Core, Tenant Platform, or Agent Platform
database credentials.

## Local configuration

Copy `.env.example` to `.env` and set `ANALYTICS_DATABASE_URL` to a dedicated local analytics
database. The service loads this file when started from the repository stack script or with Cargo.

```bash
cp .env.example .env
cargo run --bin analytics-api
cargo run --bin analytics-worker
```

The API listens on `ANALYTICS_API_PORT` (default `4300`). Check:

```bash
curl http://127.0.0.1:4300/health/live
curl http://127.0.0.1:4300/health/ready
```

The process can start while PostgreSQL is unavailable because its pool is lazy. Readiness returns
`503` until the database responds. The worker currently starts and waits for shutdown; projection,
ingestion, and reconciliation loops belong to later execution packages.

## A-01 boundary

This package does not yet create analytics facts, event schemas, source outboxes, ingestion routes,
scope registries, projections, Redis caches, reporting APIs, or customer dashboards. The migration
directory documents the boundary; the first analytics schema migrations are part of A-02.
