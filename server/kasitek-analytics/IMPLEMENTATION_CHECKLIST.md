# Analytics implementation checklist

Canonical product and execution decisions live in the repository-root analytics plans. This scoped
checklist records implementation evidence for the current package only.

## Phase 0

- [x] Product Sections 1–12 approved.
- [x] Execution Sections E1–E10 approved.
- [x] Standalone service boundary confirmed.
- [x] Dedicated `ANALYTICS_DATABASE_URL` boundary confirmed.
- [x] Core, Agent Platform, and Tenant Platform remain operational when Analytics is unavailable.
- [ ] Named human owners recorded for Analytics, source lanes, reporting, infrastructure,
  security, and privacy.

## A-01 — service foundation

- [x] Add Analytics workspace crate and shared library.
- [x] Add independent API and worker binaries.
- [x] Add validated configuration and dedicated database URL requirement.
- [x] Add liveness and dependency-aware readiness endpoints.
- [x] Add shared service/process/health contracts.
- [x] Add migration boundary documentation without A-02 schema tables.
- [x] Add local startup documentation and environment example.
- [x] Add focused configuration and health tests.
- [x] Wire both processes into `scripts/run_local_stack.sh`.
- [x] Run focused Rust formatting, build, test, and lint verification.
- [x] Run workspace verification.
- [x] Commit A-01 and local-stack integration.

## A-02 — storage, migration, and recovery foundation

- [x] Add dedicated PostgreSQL and Redis local infrastructure with separate ports and volumes.
- [x] Add the `ANALYTICS_REDIS_URL` configuration boundary without making cache availability a
  PostgreSQL readiness requirement.
- [x] Add an explicit migration-release binary separate from API and worker startup.
- [x] Add a stable PostgreSQL advisory lock held on the migration connection.
- [x] Add the initial `analytics` schema namespace migration without product tables.
- [x] Add one reusable image with API, worker, and migration-release commands.
- [x] Add health-gated Compose deployment shape for PostgreSQL, Redis, migration, API, and worker.
- [x] Add guarded custom-format backup, checksum, metadata, and restore scripts.
- [x] Add native local migration support and keep Docker storage as an explicit integration option.
- [x] Keep the default local stack on the Analytics API only; worker and migration are explicit.
- [x] Run package tests, Clippy, workspace check, shell syntax, Compose config, and diff checks.
- [x] Run native PostgreSQL migration, backup, and restore against isolated Analytics databases.
- [ ] Run Redis integration; native Redis is not installed here and cache remains non-authoritative.

## A-03 — CI, E2E, observability, and runbooks

- [x] Add a checked-in CI workflow for Analytics formatting, tests, Clippy, workspace compilation,
  shell validation, and the optional Compose deployment shape.
- [x] Add a bounded local/CI foundation E2E command using an explicitly supplied loopback database.
- [x] Verify migration, liveness, migration-gated readiness, metrics authentication, and
  process-only metric labels in the foundation E2E.
- [x] Add authenticated internal Prometheus-compatible process metrics without customer labels.
- [x] Add shared request logging to the Analytics API.
- [x] Add versioned runbook skeletons for service availability, database recovery, pipeline backlog,
  Redis degradation, and isolation incidents.
- [ ] Implement the complete product mutation-to-reporting `--full` E2E after A-04 through A-11.
- [ ] Add domain pipeline metrics, OpenTelemetry exporters, alert rules, and tested recovery drills
  after their owning data paths exist.

## A-04 — contracts and metric registries

- [x] Add a repository-owned JSON Schema 2020-12 contract registry with stable major-version
  identities, owners, categories, privacy classes, and examples.
- [x] Add a separate CloudEvents-compatible envelope contract and validated envelope example.
- [x] Validate event schemas, examples, prohibited fields, source metadata, duplicate identities,
  and registry indexing before service startup.
- [x] Add YAML metric, dimension, and metric-set registries with a JSON Schema source contract.
- [x] Add typed metric semantics for population, exclusions, ratios, deduplication, aggregation,
  scope, permissions, privacy, exactness, freshness, coverage, availability, and effective period.
- [x] Validate source contracts, dimensions, metric-set references, ratio dependencies, coverage
  sources, and dependency cycles.
- [x] Compute a deterministic registry SHA-256 artifact and generate Rust and TypeScript key
  bindings from it.
- [x] Add a registry CLI and CI check that fails when schemas, definitions, or generated bindings
  are stale or invalid.
- [ ] Add historical-version compatibility fixtures when the first v2 contract or metric is
  introduced; the initial registry has no prior major-version baseline to compare.

## A-05 — scope hierarchy, grants, service identities, and RLS

- [x] Add a versioned scope-kind registry for Core organizations, tenant workspaces, and tenant
  clients.
- [x] Add reporting scopes with stable internal IDs, external source references, root/parent
  ownership, reporting timezone, status, and immutable hierarchy identity.
- [x] Add a transitive scope-ancestor closure maintained atomically by database triggers.
- [x] Add Analytics service identities and producer permissions for source services, namespaces,
  record categories, contract namespaces, and permitted scope kinds.
- [x] Add the source-owned assignment read model without making Analytics authoritative for roles or
  memberships.
- [x] Add short-lived reporting-grant metadata, exact/none/all/explicit descendant modes, policy
  version, permission restrictions, expiry, and revocation fields.
- [x] Add Rust hierarchy, permission, root-boundary, expiry, and descendant authorization rules.
- [x] Add transaction-local PostgreSQL authorization context helpers and RLS policies for all
  scope-bearing A-05 control tables.
- [x] Run the A-05 migration against isolated native PostgreSQL and verify trigger-created closure
  rows and RLS filtering with forced-RLS integration SQL.
- [ ] Connect signed ES256 grant transport verification to the future reporting/ingestion HTTP
  boundary; A-05 validates the claims and database context after that boundary supplies them.

## A-06 — immutable facts, observations, quarantine, manifests, cursors, and audit

- [x] Add append-only normalized analytics events with source identity, sequence, scope, timing,
  subject, safe attributes, and canonical payload hash.
- [x] Add append-only provider metric observations with reporting windows, revisions, dimensions,
  source evidence, and provider synchronization identity.
- [x] Keep current source availability state and durable received/contiguous/gap cursors separate
  from immutable historical records.
- [x] Add privacy-safe ingestion quarantine with identity/hash immutability and controlled release
  metadata; raw payloads and credentials are excluded.
- [x] Add historical source manifests with capabilities, cadence, reliable coverage, heartbeats,
  checkpoints, and safe failure state.
- [x] Add coverage checkpoints, reconciliation runs, quality issues, resumable backfill jobs, and
  projection checkpoint/generation metadata.
- [x] Validate producer identity, permitted scope kind, scope/root binding, source sequence, and
  immutable record boundaries in PostgreSQL triggers.
- [x] Add scope-aware RLS policies to A-06 customer-data and control read models.
- [x] Add hash-chained privacy-safe audit records and checkpoint metadata without storing report
  values, message content, prompts, credentials, tokens, or raw payloads.
- [x] Add reusable Rust record identity, canonical JSON hashing, scope binding, and observation
  window validation helpers.
- [x] Run native A-06 migration and disposable SQL verification for every control table, immutable
  mutation rejection, broken audit-chain rejection, and forced-RLS sibling isolation.
- [ ] Connect the A-06 tables to authenticated batch ingestion, source outboxes, and producer
  publishers in A-07 through A-09.

## A-07 — Rust producer library, Core outbox, and Tenant outbox

- [x] Add the shared `analytics-producer` Rust crate to the server workspace.
- [x] Build versioned event, provider-observation, and scope-definition envelopes with source,
  scope, subject, timing, correlation, and idempotency metadata.
- [x] Canonicalize payload JSON and compute the shared SHA-256 payload hash before the source
  transaction commits.
- [x] Reject malformed versioned contracts and prohibited message bodies, prompts, contact values,
  credentials, tokens, and unrestricted provider payloads in the producer helper.
- [x] Add Core's independent `analytics_outbox` SQL inventory and Tenant Platform's SQLx migration;
  both use database-generated monotonic source sequences and immutable envelope content.
- [x] Add transactional enqueue helpers with identical-identity duplicate acknowledgement and
  conflicting-payload detection.
- [x] Add bounded `FOR UPDATE SKIP LOCKED` leasing, attempt counts, short leases, stale-lease
  recovery, deterministic capped retry jitter, and per-record delivery state transitions.
- [x] Add Core and Tenant producer modules that accept the caller's existing SQLx transaction.
- [x] Run shared Rust unit tests and PostgreSQL outbox integration using a temporary table so no
  test rows remain in the Core database.
- [x] Apply the Core outbox SQL migration locally and validate the Tenant migration transactionally
  in an isolated schema; the configured Tenant development endpoint was unavailable.
- [ ] Attach authenticated batch HTTP transport and real authoritative domain mutations in the
  ingestion/vertical-slice packages that follow A-07.

## A-08 — TypeScript producer library, Agent outbox, and publisher foundation

- [x] Add the Agent Platform TypeScript producer and publisher modules under `agents/src/analytics`.
- [x] Use the generated Analytics contract bindings for registered Agent contract identity checks,
  while keeping the producer boundary extensible for newly registered observation and scope facts.
- [x] Build CloudEvents-compatible event, provider-observation, and scope-definition records with
  Agent source identity, scope, subject, timing, correlation, and idempotency metadata.
- [x] Canonicalize JSON payloads, hash them with SHA-256, and reject malformed JSON, invalid dates,
  invalid windows, and prohibited content before any database operation.
- [x] Add Agent migration `065_analytics_outbox.sql` with a database-generated source sequence,
  immutable envelope content, duplicate identity protection, claim indexes, and delivery states.
- [x] Accept the caller's existing `pg.PoolClient` for transactional enqueue and report inserted,
  identical duplicate, and conflicting duplicate outcomes.
- [x] Add bounded `SKIP LOCKED` leasing, stale-lease recovery, deterministic capped retry jitter,
  lease ownership checks, and accepted/retryable/quarantined delivery transitions.
- [x] Run TypeScript checks, focused producer/migration tests, and the PostgreSQL outbox integration
  test against the local Agent database without leaving persistent test rows.
- [ ] Attach authenticated batch HTTP transport and authoritative Agent mutation instrumentation
  after the shared Analytics ingestion boundary and vertical-slice contracts are ready.

## Verification evidence

- `cargo fmt --manifest-path server/kasitek-analytics/Cargo.toml -- --check`
- `cargo test --manifest-path server/kasitek-analytics/Cargo.toml` — 5 tests passed.
- `cargo clippy --manifest-path server/kasitek-analytics/Cargo.toml --all-targets --all-features -- -D warnings`
- `cargo check --workspace` — passed.
- API smoke test — `/health/live` returned `200`; `/health/ready` returned `503` with an unavailable
  PostgreSQL endpoint.
- Worker smoke test — process started and remained alive until the test timeout.
- `bash -n scripts/run_local_stack.sh` and `git diff --check` — passed.
- A-02: `cargo test --manifest-path server/kasitek-analytics/Cargo.toml` — 7 tests passed.
- A-02: `cargo clippy --manifest-path server/kasitek-analytics/Cargo.toml --all-targets --all-features -- -D warnings` — passed.
- A-02: `cargo check --workspace` — passed.
- A-02: `docker compose -f server/kasitek-analytics/compose.yaml config --quiet` — passed.
- A-02: migration release against an unavailable endpoint failed fast with `DatabaseConnectTimeout`.
- A-02: container runtime integration is pending because the local Docker daemon is unavailable.
- A-02: native `kasitek_analytics` migration completed on local PostgreSQL 18.
- A-02: native backup and restore completed into isolated `kasitek_analytics_restore_e2e`;
  checksum, schema, and successful migration verification passed.
- A-03: `cargo test --manifest-path server/kasitek-analytics/Cargo.toml` — 10 tests passed.
- A-03: `cargo fmt --manifest-path server/kasitek-analytics/Cargo.toml -- --check` — passed.
- A-03: `bash -n scripts/run_local_stack.sh scripts/test-analytics-e2e.sh server/kasitek-analytics/scripts/*.sh` — passed.
- A-03: `.github/workflows/analytics.yml` adds static and PostgreSQL/Redis service E2E jobs.
- A-03: `scripts/test-analytics-e2e.sh` passed against isolated native
  `kasitek_analytics_e2e` with correlation ID `analytics-e2e-20260822T123735Z-753418`.
- A-03: `scripts/test-analytics-e2e.sh --full` is intentionally gated until the product analytics
  contracts, facts, projections, and reporting packages exist.
- A-04: `cargo test --manifest-path server/kasitek-analytics/Cargo.toml` — 12 tests passed,
  including registry validation, semantic reference checks, deterministic hashing, and generated
  binding freshness.
- A-04: `cargo run --manifest-path server/kasitek-analytics/Cargo.toml --bin analytics-registry -- --check`
  — passed with registry SHA-256 `cd4003773c22369b17eef99c0b2599a135cd1fc304b50f52c40bd2f7a5e53e14`.
- A-04: Rust formatting, Clippy with `-D warnings`, workspace check, TypeScript `tsc --noEmit`,
  shell syntax, Compose config, and `git diff --check` — passed.
- A-05: `cargo test --manifest-path server/kasitek-analytics/Cargo.toml` — 22 tests passed,
  including the scope isolation and authorization matrix.
- A-05: native `analytics-migrate` completed against both the runtime and isolated E2E databases;
  migration `20260822010000` created the scope, identity, assignment, grant, closure, and RLS
  objects.
- A-05: forced-RLS SQL verification passed: a workspace plus one authorized client was visible,
  while the sibling client's closure row was hidden.
- A-06: `cargo test --manifest-path server/kasitek-analytics/Cargo.toml` — 25 tests passed,
  including canonical payload hashing, record identity, scope binding, and observation-window
  validation.
- A-06: native `analytics-migrate` completed against runtime and isolated E2E PostgreSQL databases;
  migration `20260822020000` created facts, observations, source controls, quarantine, manifests,
  coverage, reconciliation, quality, backfill, projection, and audit objects.
- A-06: `scripts/test-a06-native.sql` passed in the isolated database; it exercised all A-06 control
  tables, rejected an immutable event update and broken audit chain, and confirmed forced-RLS hides
  the sibling client's event and audit row. The transaction rolled back its fixtures.
- A-07: `cargo test -p analytics-producer` — 4 producer validation and retry-policy tests passed.
- A-07: PostgreSQL `outbox_postgres` integration passed against the local Core database using a
  temporary `analytics_outbox`; enqueue duplicate/conflict detection, lease claim, retry reclaim,
  and accepted delivery all passed without persistent fixtures.
- A-07: Core `sql/20260822030000_analytics_outbox.sql` applied successfully; the Tenant migration
  parsed and created its full table/trigger shape inside a rolled-back isolated schema because the
  configured Tenant endpoint was unavailable.
- A-07: Core transactional SQL smoke test passed: immutable envelope mutation was rejected, a row
  was leased and acknowledged delivered, and the transaction rolled back its fixture.
- A-08: `pnpm exec tsc --noEmit` passed in `agents`; focused Vitest producer, migration, and
  integration files passed with 16 tests.
- A-08: The Agent migration was applied to the local `kasitek_agents` database and the explicit
  PostgreSQL integration test passed transactional enqueue, duplicate/conflict detection, lease
  claim, retry reclaim, accepted delivery, and empty-backlog checks using temporary rows.

## Explicitly deferred

- A-02 native Redis integration until a native Redis server is available; Redis is not yet used by
  the foundation runtime.
- A-03 complete product mutation-to-reporting E2E, domain OpenTelemetry exporters, alert rules, and
  tested recovery drills
- A-04 historical compatibility fixtures until a second major contract or metric version exists
- A-05 signed ES256 transport verification until the reporting/ingestion HTTP grant boundary exists
- A-06 signed audit checkpoint production/verification until the controlled signing boundary exists
- A-07 authenticated publisher transport until the Analytics ingestion HTTP boundary exists
- A-08 authenticated publisher transport and authoritative Agent mutation instrumentation until the
  Analytics ingestion boundary and reference vertical slices exist
- Source outboxes, ingestion, authentication, projections, reporting, and UI
