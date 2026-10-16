# KasiTek Analytics

Standalone customer-facing analytics service. Its TypeScript implementation under `src/` is the
only runtime in this checkout. The original Rust service and shared crates remain recoverable from
Labs commit `4eb66ad`.
The native Node processes are:

- `start`: API, health endpoints, authenticated ingestion/reconciliation, reporting and rollout routes.
- `start:worker`: durable projections, replay and maintenance loops.
- `migrate`: one-time forward migration release command.
- `registry:check` / `registry:write`: validate or regenerate the TypeScript metric bindings.

Analytics requires its own database URL. It must not reuse Core, Tenant Platform, or Agent Platform
database credentials.

## Local configuration

Local development uses native PostgreSQL and optional native Redis. Create a dedicated
`kasitek_analytics` database and `analytics` database role; never point this service at Core's
`DATABASE_URL`. Redis is non-authoritative. Copy `.env.example` to `.env` in this directory.
Node.js 24.15.0 and pnpm 10.30.1 are pinned at the repository root.

```bash
cp services/analytics/.env.example services/analytics/.env
corepack pnpm install --frozen-lockfile
corepack pnpm build:analytics
corepack pnpm migrate:analytics
```

After migrations complete, run the API and worker as separate native processes:

```bash
corepack pnpm start:analytics
corepack pnpm start:analytics-worker
```

The migration command is a one-time release job, not a long-running service. The API and worker
never run migrations themselves. The release job takes the PostgreSQL advisory lock and must
complete before those processes start. `scripts/local-storage.sh` only checks that native
PostgreSQL is reachable. `scripts/backup.sh` creates a custom-format dump with a checksum and
metadata; `scripts/restore.sh` requires explicit confirmation and stopped services.

## Native hosted runtime candidate

For a native Railpack service sourced from this Labs repository, use repository root `/`, build
with `corepack pnpm build:analytics`, and start the API with
`corepack pnpm start:analytics`. Set the API health check to `/health/ready`. Start a separate
worker service with `corepack pnpm start:analytics-worker`; run
`corepack pnpm migrate:analytics` as a one-shot release command before starting either process.
The API binds to `ANALYTICS_API_HOST` (default `0.0.0.0`) and reads Railway's `PORT` when
`ANALYTICS_API_PORT` is unset (local default `4300`). Both services need the dedicated
`ANALYTICS_DATABASE_URL`; the worker also needs
the producer and reporting credentials described in `.env.example`.

These are candidate settings only. The current production Railway API and worker still point at
the retired Rust binaries; no hosted settings or deployments were changed.

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

Validate the checked-in TypeScript key bindings:

```bash
corepack pnpm --filter @kasitek/analytics registry:check
```

After an approved registry change, regenerate them with:

```bash
corepack pnpm --filter @kasitek/analytics registry:write
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

The `scope` module contains the reusable hierarchy and grant rules. The `authorization` module
encodes the validated scope set into PostgreSQL context without storing bearer tokens.

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

Core and Tenant publishers periodically send bounded summaries for their own outbox streams. A
summary contains only the source domain, stream and scope binding, highest source sequence,
highest delivered sequence, and authoritative outbox count. The publisher never sends envelopes or
payloads during reconciliation. `ANALYTICS_RECONCILIATION_INTERVAL_MS` controls the interval
(default 60 seconds), and `ANALYTICS_RECONCILIATION_MAX_STREAMS` bounds streams per pass (default
100, maximum 500). A mismatch is recorded by Analytics and can enqueue its existing repair work;
the source publisher remains responsible only for reporting the summary.

## Source publishers

Core, Tenant Platform, and Agent Platform own their publishers and operational databases. Each
product configures its own `ANALYTICS_INGESTION_URL` and source-specific ingestion token. The
Analytics service does not build publisher implementations from another product checkout. The
publisher claims a
bounded leased batch, posts it to the private ingestion endpoint, marks accepted and identical
duplicate records delivered, retries transport and transient acknowledgements with capped jitter,
and quarantines permanent record or batch rejections. Expired leases are reclaimed automatically,
including deferred worker jobs whose lease is intentionally cleared before their next attempt.
The same publisher process periodically submits the bounded reconciliation summaries described
above; reconciliation failure does not mutate or delete source outbox facts.

The cross-service producer-to-report check is `tests/shared-producer.integration.test.ts`. Set
`ANALYTICS_TEST_DATABASE_URL` to a local PostgreSQL connection that can create disposable test
databases. The fixture creates and drops a dedicated database for each run. Set `GROWTH_CORE_DIST`,
`AGENCY_TENANT_DIST`, and `AGENT_PLATFORM_ROOT` to exercise each real producer; the Agents root must
have a current `dist/analytics/index.js` from its TypeScript build. Without a service path, that
producer uses a synthetic contract fixture.

```bash
ANALYTICS_TEST_DATABASE_URL=postgresql://localhost/postgres \
GROWTH_CORE_DIST=/path/to/kasitek-growth/api/dist \
AGENCY_TENANT_DIST=/path/to/kasitek-agency/api/dist \
AGENT_PLATFORM_ROOT=/path/to/kasitek-agents \
corepack pnpm exec tsx --test tests/shared-producer.integration.test.ts
```

The API can start while PostgreSQL is unavailable because its pool is lazy. Readiness returns
`503` until the database responds and the base migration is applied. Redis is an optional,
non-authoritative reporting response cache; authorization, projection generation, freshness, and
fallback responses come from PostgreSQL. The TypeScript worker runs durable projection and
maintenance work, including replay, repair and backfill jobs. It cancels queued projection work
when the target scope or its root is deleted; immutable source facts remain, and database triggers
continue to block derived writes for deleted scopes.

## Rollout controls

A-12 adds the internal, server-side rollout boundary at `/internal/rollouts/v1/controls`,
`/internal/rollouts/v1/evaluate`, and the authenticated maintenance endpoint
`/internal/rollouts/v1/expire`. All endpoints require an ingestion credential whose producer ID is
listed in `ANALYTICS_ROLLOUT_ADMIN_PRODUCERS`; an empty list denies every caller. The registry
supports scoped rules and separate operational kill switches. Customer-facing controls default to
denied, and every mutation or automatic expiry closure is recorded in the immutable Analytics
audit chain. Expiry closure is transactional and idempotent, and advances the same monotonic
registry revision used by decision-cache invalidation. Evaluation may use an optional bounded Redis
cache, but PostgreSQL remains authoritative through the registry revision and control expiry
checks.

Rollout process metrics are exposed through `/internal/metrics` with the existing bearer
protection. They report evaluation, default/denied decisions, cache outcomes, and expiry closures
using only fixed service/process labels; customer, tenant, scope, control-key, and cohort values
are not metric labels.

If the local PostgreSQL client is older than the server, set
`ANALYTICS_PG_DUMP_BIN` and `ANALYTICS_PG_RESTORE_BIN` to matching `pg_dump` and `pg_restore`
executables before running the recovery scripts.

## Agent runtime collection

A-13 slices 1–9 connect Agent Platform definition, installation and version lifecycle, terminal run, model-call, tool, approval, effect, schedule configuration, and readiness evaluation facts to the existing transactional outbox. Readiness coverage is completed by a bounded periodic sweep in the Agent API process: due installations are claimed through PostgreSQL leases, evaluated with the same projection as the readiness route, and recorded through the same deduplicating sidecar.
Installation lifecycle facts cover creation and real active, paused, and disabled transitions, including execution mode, creation profile, audience, and installation scope. They are written with the installation mutation and are not emitted for unchanged status writes.
Version lifecycle facts cover version creation, publication, retirement, and rollback without copying instructions, configuration, policy, or checksums. Release mutations emit the affected version transitions in the same transaction as the authoritative version update.
Definition lifecycle facts cover definition creation, metadata changes, archive/restore, and deletion with bounded ownership, profile, audience, action, and status fields. Names, slugs, descriptions, prompts, configuration, policy, checksums, and credentials remain outside Analytics; deletion is recorded before dependent data is removed.
Completed and failed runs publish the registered `agent.run.completed@1` and `agent.run.failed@1`
contracts in the same transaction as the run and attempt state change. Facts include stable agent
references, organization scope, trigger, execution mode, creation profile, audience, deployment
surface, duration, outcome, or bounded failure class. Prompts, responses, raw errors, credentials,
and other prohibited content remain in the Agent operational store and are not copied to Analytics.

Completed and failed model calls publish `agent.model_call.completed@1` and
`agent.model_call.failed@1` in the same transaction as the `model_calls` row. These facts contain
provider, model, funding source, token counts, estimated cost, latency, finish reason, and bounded
failure class; credentials, prompts, responses, and raw error messages remain operational-only.

Tool invocation, approval, and external-effect lifecycle facts use separate versioned contracts.
They include safe agent, run, capability, action, status, risk, reconciliation, and bounded failure
references. Tool arguments, outputs, approval resource snapshots, provider receipts, and raw errors
remain operational-only. Lifecycle facts are written in the same transaction as their authoritative
repository mutation, including the atomic approval-consumption/effect-start boundary.

Schedule facts cover hosted schedule creation and actual active/paused/disabled transitions. They
include schedule and agent references, status transition, timezone, next-run metadata, and actor
type, but never copy schedule input or the expression. There is no authoritative schedule executor
in Agent Platform yet, so dispatch, missed-run, delay, and schedule-to-run facts are intentionally
not claimed by this contract.

Conditional Agent conversation collection now covers conversation creation, opening, archive and
restore state, message creation, and delivery-state transitions across generic conversations,
platform chat, channel ingestion, Agent replies, and customer-service human replies. Facts retain
only bounded references, conversation kind, channel, direction, responder type, delivery state,
and response timing; transcript content, titles, previews, external customer identifiers, and
provider message identifiers remain operational-only. Personal, test, customer, and external
conversation kinds stay distinct, and customer handoff remains a separate conditional contract
for customer-service agents.

Core Inbox collection covers the existing WhatsApp path and the main Meta Inbox paths. Core emits
bounded conversation-open and message lifecycle facts from transactional WhatsApp, Facebook, and
Instagram mutations, including inbound customer messages, workspace human replies, direct Agent
delivery where Core has explicit attribution, retries, delivery/read/failure transitions, and Meta
delivery backfills. Response timing is measured only for an outbound human or Agent message
following a customer message. The contracts exclude message content, customer identifiers,
provider message IDs, credentials, and raw provider payloads. Core-owned assignment/resolution,
Meta deletion mutations, historical coverage, reconciliation, projections, reporting, and
end-to-end mutation-to-reporting evidence remain pending Core Inbox slices. WhatsApp conversation
and explicit message deletion now emit bounded lifecycle facts; bulk message cleanup is represented
by the conversation deletion fact rather than an unbounded per-message fan-out.

The common path applies to personal, customer-service, system-hosted, hosted, and
external-connected runs. Customer handoff is a separate conditional lifecycle contract already
emitted by the handoff repository and scoped to customer-service handoff-enabled agents; it is not
inferred for ordinary Agents. Readiness snapshots are emitted after a successful readiness-route
evaluation, contain only bounded statuses, blocker codes, and counts, and are coalesced while the
evaluated state is unchanged. The route remains operational when this best-effort sidecar cannot
write the outbox. A periodic authoritative readiness evaluator is still needed for coverage when
no one opens the readiness route.

## Current boundary

A-01 through A-12 provide the service, dedicated storage, registries, scope authorization, immutable
facts, source controls, quarantine, authenticated ingestion, source cursors, reconciliation
summaries, projection metadata, reporting, caching, and the audited rollout boundary. A-13 has
started with transactional Agent runtime facts, and the first M2 conditional Agent conversation
slice now has live collection and isolation evidence. Core Inbox ownership, full mutation-to-
reporting E2E, rollout control-management UI, source publisher clients, and customer dashboards
belong to later execution packages.
