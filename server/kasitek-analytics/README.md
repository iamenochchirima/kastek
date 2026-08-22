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

Metrics are internal-only and require the `ANALYTICS_METRICS_TOKEN` bearer token. Scrape them from
`/internal/metrics`; an unset token denies the endpoint. The metrics foundation contains only
process and dependency counters, with no customer or tenant identifiers.

```bash
curl -H "Authorization: Bearer $ANALYTICS_METRICS_TOKEN" \
  http://127.0.0.1:4300/internal/metrics
```

## Contracts and metric registry

The JSON Schema 2020-12 event contracts and CloudEvents-compatible envelope live under
`contracts/`. YAML metric, dimension, and metric-set definitions live under `metrics/`; the
registry loader validates their schemas, examples, references, privacy metadata, formulas,
dependencies, and deterministic artifact hash before any service process starts.

Validate the checked-in generated Rust and TypeScript key bindings:

```bash
cargo run --bin analytics-registry -- --check
```

After an approved registry change, regenerate them with:

```bash
cargo run --bin analytics-registry -- --write
```

The generated bindings are build artifacts, not independent definitions. Producer, projection,
reporting, and dashboard work must reference the registered identities rather than adding local
formulas or dimensions.

## Scope authorization

A-05 adds the Analytics-side authorization boundary for `core_organization`, `tenant_workspace`,
and `tenant_client` scopes. Scope hierarchy supports aggregation but never grants access by itself.
Every report operation must use a short-lived grant with an exact scope, an explicit descendant
mode, permissions, policy version, and expiry. Core and Tenant Platform remain authoritative for
users, roles, and assignments; Analytics stores their validated read model.

The migration also provides PostgreSQL authorization context functions and row-level policies for
scope-bearing control tables. Application authorization must validate the grant before setting the
transaction-local context; RLS is defense in depth, not a replacement for grant validation.

The Rust `scope` module contains the reusable hierarchy and grant rules. The `authorization`
module encodes the validated scope set into the PostgreSQL context without storing bearer tokens.

## Facts and collection controls

A-06 adds the append-only `analytics_event` and `analytics_metric_observation` stores. Events keep
business occurrence time separate from ingestion time; provider revisions append a newer
observation rather than replacing the previous value. Source state and cursors are mutable
summaries, while manifests, coverage checkpoints, reconciliation runs, projection generations,
and audit records preserve historical evidence.

Quarantine stores only record identity, hashes, safe error codes, and lifecycle metadata. It does
not store message bodies, prompts, credentials, tokens, or unrestricted provider responses. Scope
references and producer permissions are validated by database triggers, scope-bearing tables use
the A-05 authorization context and RLS, immutable tables reject updates/deletes, and audit records
are hash-chained with checkpoint metadata.

Run the native A-06 verification against a disposable database after applying migrations:

```bash
psql "$ANALYTICS_DATABASE_URL" -f scripts/test-a06-native.sql
```

The script exercises every A-06 control table, immutable-record protection, audit-chain rejection,
and forced-RLS sibling isolation, then rolls its fixture back.

Run the bounded local foundation E2E against a disposable loopback database:

```bash
ANALYTICS_E2E_DATABASE_URL=postgres://analytics:analytics_dev_password@127.0.0.1:5432/kasitek_analytics_e2e \
  ./scripts/test-analytics-e2e.sh
```

The command intentionally does not run against the normal development database. `--full` remains
reserved for the product mutation-to-reporting suite that depends on later contract, fact,
projection, and reporting packages.

The API can start while PostgreSQL is unavailable because its pool is lazy. Readiness returns
`503` until the database responds. Redis is a non-authoritative cache boundary and is optional to
the A-02 process configuration; cache behavior is implemented later. The worker currently starts
and waits for shutdown; projection, ingestion, and reconciliation loops belong to later execution
packages.

If the local PostgreSQL client is older than the server, set
`ANALYTICS_PG_DUMP_BIN` and `ANALYTICS_PG_RESTORE_BIN` to matching `pg_dump` and `pg_restore`
executables before running the recovery scripts.

## Current boundary

A-01 through A-06 provide the service, dedicated storage, registries, scope authorization, immutable
facts, source controls, quarantine, projection metadata, and audit foundation. Source outboxes,
authenticated ingestion routes, projections, reporting APIs, Redis caches, and customer dashboards
belong to later execution packages.
