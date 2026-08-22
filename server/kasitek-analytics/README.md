# KasiTek Analytics

Standalone customer-facing analytics service foundation.

The A-01 through A-09 packages provide three process commands from one Rust crate:

- `analytics-api`: health endpoints, authenticated batch ingestion, and source reconciliation.
- `analytics-worker`: durable worker process reserved for projection, replay, and scheduled quality
  loops.
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

## Ingestion and reconciliation

A-09 adds one private batch boundary for Core, Agent Platform, and Tenant Platform. The API accepts
only a registered producer credential; the credential derives `source_service` and `producer_id`,
while database producer permissions still control record categories and reporting-scope kinds.
Payload source claims are cross-checked and cannot impersonate another source. Each record is
validated, privacy-checked, hash-checked, and committed independently, returning `accepted`,
`duplicate`, `rejected`, or `retryable` acknowledgement status.

```text
POST /internal/ingest/v1/batch
POST /internal/reconciliation/v1/summary
```

The source cursor records highest received, highest contiguous, and known missing ranges. The
reconciliation endpoint accepts an authenticated producer summary without connecting to the
producer database. Scope definitions update the current reporting-scope read model and also create
immutable source receipts. Replays keep the original producer, stream, sequence, identity, and
payload hash; approved backfill jobs are required when a batch carries `backfill_job_id`.

## Source publishers

Core, Tenant Platform, and Agent Platform publish from their own operational databases. Each
publisher is independently startable and remains disabled until its source-specific ingestion token
is configured:

```bash
KASITEK_PROCESS=analytics-publisher cargo run --manifest-path server/kasitek-core/Cargo.toml
KASITEK_PROCESS=analytics-publisher cargo run --manifest-path server/kasitek-tenants/Cargo.toml
pnpm --dir agents run dev:analytics-publisher
```

Set `ANALYTICS_INGESTION_URL` to the Analytics origin and configure
`ANALYTICS_CORE_INGESTION_TOKEN`, `ANALYTICS_TENANT_INGESTION_TOKEN`, or
`ANALYTICS_AGENT_INGESTION_TOKEN` in the corresponding source environment. The publisher claims a
bounded leased batch, posts it to the private ingestion endpoint, marks accepted and identical
duplicate records delivered, retries transport and transient acknowledgements with capped jitter,
and quarantines permanent record or batch rejections. Expired leases are reclaimed automatically.

Run the bounded local foundation E2E against a disposable loopback database:

```bash
ANALYTICS_E2E_DATABASE_URL=postgres://analytics:analytics_dev_password@127.0.0.1:5432/kasitek_analytics_e2e \
  ./scripts/test-analytics-e2e.sh
```

The command intentionally does not run against the normal development database. `--full` remains
reserved for the product mutation-to-reporting suite that depends on later contract, fact,
projection, and reporting packages.

The API can start while PostgreSQL is unavailable because its pool is lazy. Readiness returns
`503` until the database responds. Redis is an optional, non-authoritative reporting response cache;
authorization, projection generation, freshness, and fallback responses come from PostgreSQL. The
worker currently starts
and waits for shutdown; projection, replay scheduling, and quality loops belong to later execution
packages.

## Rollout controls

A-12 adds the internal, server-side rollout boundary at `/internal/rollouts/v1/controls` and
`/internal/rollouts/v1/evaluate`. Both endpoints require an ingestion credential whose producer ID
is listed in `ANALYTICS_ROLLOUT_ADMIN_PRODUCERS`; an empty list denies every caller. The registry
supports scoped rules and separate operational kill switches. Customer-facing controls default to
denied, and every mutation is recorded in the immutable Analytics audit chain. Evaluation may use
an optional bounded Redis cache, but PostgreSQL remains authoritative through the monotonic
registry revision and control expiry checks.

If the local PostgreSQL client is older than the server, set
`ANALYTICS_PG_DUMP_BIN` and `ANALYTICS_PG_RESTORE_BIN` to matching `pg_dump` and `pg_restore`
executables before running the recovery scripts.

## Current boundary

A-01 through A-12 provide the service, dedicated storage, registries, scope authorization, immutable
facts, source controls, quarantine, authenticated ingestion, source cursors, reconciliation
summaries, projection metadata, reporting, caching, and the audited rollout boundary. Authoritative
product mutation instrumentation and the complete mutation-to-reporting E2E remain owned by the
later A-13 vertical slices; source publisher clients and customer dashboards belong to later
execution packages.
