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
- [ ] Implement the complete product mutation-to-reporting `--full` E2E after A-04 through A-12;
  authoritative domain mutation instrumentation is owned by A-13 vertical slices.
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
- [x] Connect signed ES256 grant transport verification to the reporting HTTP boundary; the
  reporting API independently verifies the key, issuer, audience, lifetime, and persisted grant.

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
- [x] Connect the A-06 tables to the authenticated Analytics batch boundary and source receipts
  in A-09; source publisher clients still consume the shared response contract in later vertical
  slices.

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
- [x] Attach the shared authenticated batch HTTP transport; authoritative domain mutations remain
  owned by the later vertical-slice packages.

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
- [x] Attach the authenticated batch HTTP transport; authoritative Agent mutation instrumentation
  remains a later vertical-slice responsibility.

## A-09 — authenticated ingestion, cursors, reconciliation, and replay controls

- [x] Add a private batch-ingestion endpoint shared by Core, Agent Platform, and Tenant Platform.
- [x] Derive source service and producer identity from deployment credentials; reject payload source
  impersonation and ambiguous credential configuration.
- [x] Enforce bounded request, batch, and record sizes with strict envelope identity checks.
- [x] Validate the repository-owned envelope, registered event contracts, typed observations, and
  scope-definition fields before writing facts.
- [x] Enforce producer category and scope-kind permissions from the Analytics producer registry.
- [x] Keep raw payloads out of quarantine and reject prohibited customer content before persistence.
- [x] Verify canonical payload hashes and return per-record accepted, duplicate, rejected, and
  retryable acknowledgements.
- [x] Insert immutable events and observations idempotently; identity conflicts are quarantined and
  never silently selected.
- [x] Add immutable scope-definition receipts and atomically update the reporting-scope read model,
  including parent-before-child readiness and controlled reparent rejection.
- [x] Update highest-received, highest-contiguous, and merged known-gap cursor state in the same
  transaction as each accepted or duplicate record.
- [x] Update provider observation source health in the same transaction as the observation fact.
- [x] Add authenticated producer reconciliation summaries and persist mismatch, gap, count, and
  unresolved-quarantine evidence in `analytics_reconciliation_run`.
- [x] Admit replay batches only through a running, source-matched approved backfill job and mark
  accepted facts as backfilled without changing source identity.
- [x] Add unit tests for credential identity and cursor gaps plus PostgreSQL end-to-end coverage for
  acceptance, duplicate handling, identity conflict quarantine, cursor state, and reconciliation.
- [x] Connect Core, Agent Platform, and Tenant Platform lease publishers to the authenticated HTTP
  endpoint and process accepted, duplicate, retryable, and rejected acknowledgements in their
  source outboxes.
- [x] Add worker-scheduled reconciliation and quarantine-repair work queues without retaining raw
  rejected payloads; source services claim only their authenticated work.
- [x] Add explicit versioned quarantine repair context through the authenticated ingestion boundary;
  corrected records release only the matching leased failure after full validation.
- [x] Add resumable worker orchestration for projection rebuild and fact-replay backfill jobs with
  leases, checkpoints, retry state, and producer claim support for source reconstruction jobs.
- [x] Add PostgreSQL end-to-end coverage for maintenance scheduling, producer claims, reconciliation
  completion, quarantine repair release, and projection-rebuild completion.

## A-10 — projection queue, contributions, rollups, generations, and rebuilds

- [x] Add a PostgreSQL-backed, coalescing dirty-window queue written in the same transaction as
  accepted immutable events and provider observations.
- [x] Add bounded `FOR UPDATE SKIP LOCKED` projection leasing with ownership, expiry, attempts,
  retry backoff, stale-lease recovery, priority, and safe error fields.
- [x] Add generation-scoped mergeable contributions and hourly rollups with scope, source scope,
  dimensions, coverage, and source high-watermark metadata.
- [x] Add a worker projection consumer that maps registered event sources and observations into
  deterministic contribution rows and recomputes each affected window before committing its
  checkpoint and rollup rows.
- [x] Add a rebuild request boundary that captures existing source windows into a shadow generation
  and promotes it only after all generation-tagged work completes.
- [x] Keep the active checkpoint generation stable while a rebuild is incomplete or failed; new
  work remains retryable and derived rows never become immutable source data.
- [x] Add domain-specific typed projection builders, ancestor contribution rollups, timezone
  calendar buckets, reconciliation-driven repairs, and full parity/coverage validation.

## A-11 — reporting boundary and query planner (slices 1–2)

- [x] Add short-lived ES256 bearer-grant verification with legacy-key and key-ID rotation support.
- [x] Bind each verified grant to the persisted grant row, service identity issuer, revocation
  state, scope hierarchy, permission set, metric restrictions, and transaction-local RLS context.
- [x] Add a security-definer descendant expansion function so `all` grants do not require the
  Analytics application role to own the scope tables.
- [x] Add the permission-filtered `GET /v1/metrics/catalog` route from the canonical registry.
- [x] Add bounded `POST /v1/reports/query` request validation for scope, range, timezone, interval,
  metrics, metric sets, dimensions, filters, descendant access, and result point limits.
- [x] Read only promoted projection generations and registered rollups; distinct metrics deduplicate
  generation-scoped contribution keys at the requested scope and breakdown.
- [x] Return per-metric availability, coverage, freshness, registry, generation, and source-as-of
  metadata instead of treating missing or stale data as zero.
- [x] Add unit, route-authentication, and native PostgreSQL tests for signed reporting and query
  isolation; the PostgreSQL fixture rolls back after the test.
- [x] Add equal-duration `previous_period` responses using the same metric, dimension, filter, and
  descendant authorization boundary as the current period.
- [x] Add optional native Redis response caching after authorization, with generation and registry
  invalidation, grant-complete cache keys, bounded TTL, stale-entry rejection, and PostgreSQL
  fallback when Redis is disabled or unavailable.
- [x] Add unit coverage for comparison validation, cache hits, expiry, Redis failure behavior, and
  authorization-isolated cache keys.
- [x] Add a native PostgreSQL comparison fixture covering current and previous promoted rollup
  values; the fixture rolls back after the test.
- [ ] Add the complete product mutation-to-reporting E2E.

## A-12 — audited rollout registry and operational controls (slices 1–3)

- [x] Add the Analytics-owned current rollout registry with forward-only migration, explicit
  control keys, rollout/kill-switch separation, expiry, removal, revision, and audit metadata.
- [x] Support global, producer-service, domain, reporting-scope, and stable percentage-cohort
  targets with deterministic specificity precedence.
- [x] Default customer reporting, UI, exports, alerts, schedules, and agent-readable access to
  denied; keep operational controls available unless an explicit kill switch is active.
- [x] Add server-side evaluation and mutation endpoints; browser state is never an authorization
  source.
- [x] Require an authenticated, explicitly allowlisted producer identity for internal rollout
  operations; an empty allowlist denies the endpoints.
- [x] Append every mutation to the existing immutable audit chain with actor, previous value,
  reason, issue reference, target, revision, expiry, removal, and request hash.
- [x] Add unit and native PostgreSQL coverage for normalization, default policy, precedence,
  stable cohort assignment, expiry, authentication, revisioning, rollback, and audit continuity.
- [x] Add a monotonic PostgreSQL registry revision incremented in the same transaction as each
  control mutation; cached decisions include that revision in their key.
- [x] Add an optional bounded Redis decision cache with control-expiry-aware TTLs, malformed-entry
  rejection, and database fallback when Redis is disabled or unavailable.
- [x] Keep cache reads behind server-side producer authentication and database revision lookup;
  Redis never authorizes a caller or becomes the source of truth.
- [x] Add deterministic cache tests for hits, revision separation, control expiry, and disabled
  cache behavior.
- [x] Add transactional, idempotent expiry-closure maintenance that marks expired controls removed,
  advances the registry revision, and appends an audit record for every closed control.
- [x] Add fixed-cardinality process metrics for rollout decisions, defaulted/denied decisions,
  cache outcomes, and expired-control closures; metrics contain no customer or tenant labels.
- [ ] Add control-management UI in a later slice; expired entries fail closed during evaluation
  even before maintenance runs.

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
- A-09: migrations `20260822030000_analytics_ingestion_receipts.sql` and
  `20260822040000_analytics_source_validation_fix.sql` applied successfully to the local Analytics
  PostgreSQL database.
- A-09: `cargo fmt --all`, strict Analytics Clippy, Analytics package binary tests, and
  `cargo check --workspace` passed; the package contains credential, cursor, envelope, and
  registry validation coverage.
- A-09: 30 Analytics library tests passed with the unrelated handoff-contract registry-count test
  excluded; that existing test currently expects six contracts while the user's uncommitted
  handoff contract changes make the registry contain seven.
- A-09: `cargo test -p kasitek-analytics --test ingestion_postgres -- --nocapture` passed against
  the local native Analytics PostgreSQL database, covering accepted events and observations,
  immutable scope receipts, identical duplicates, identity-conflict quarantine, cursor/source
  health state, and authenticated reconciliation evidence.
- A-09: migration `20260822060000_analytics_maintenance_work.sql` applied successfully to the local
  native Analytics PostgreSQL database; it adds durable reconciliation, quarantine-release, and
  leased backfill work controls without storing rejected raw payloads.
- A-09: `cargo test -p kasitek-analytics --test maintenance_postgres -- --nocapture` passed against
  the local native Analytics PostgreSQL database, covering producer work claims, reconciliation
  completion, versioned quarantine repair release, and projection rebuild completion.
- Publisher transport: shared Rust wire-contract tests passed, including authenticated request
  headers, bounded batch shape, per-record acknowledgement matching, transient HTTP failure
  classification, and malformed-ack retry behavior.
- Publisher transport: `pnpm exec tsc --noEmit` and focused Agent analytics tests passed, including
  the authenticated TypeScript batch request contract.
- Publisher workers: Core, Tenant Platform, and Agent Platform now expose independent local worker
  commands; source outboxes remain durable and unaffected when the Analytics API is unavailable.
- A-10: migrations `20260822050000_analytics_projection_runtime.sql`,
  `20260822051000_analytics_projection_scope_trigger.sql`,
  `20260822052000_analytics_projection_generation_lifecycle.sql`, and
  `20260822053000_analytics_projection_shadow_pointer.sql` applied successfully to the local
  native Analytics PostgreSQL database.
- A-10: `cargo test -p kasitek-analytics --test projections_postgres -- --nocapture` passed the
  worker claim, generation promotion, contribution/rollup materialization, and shadow rebuild flow.
- A-10: `cargo check -p kasitek-analytics` and package formatting passed after the projection worker
  and ingestion transaction changes.
- A-10: migration `20260822070000_analytics_projection_builder_controls.sql` applied successfully;
  it adds typed builder/deduplication metadata, repair reasons, and removes the invalid ratio
  component constraint that prevented numerator-only or denominator-only contributions.
- A-10: `cargo test -p kasitek-analytics --test projections_postgres -- --nocapture` passed agent
  ancestor fan-out, timezone-aware buckets, daily rollups, campaign distinct-deduplication, and
  ratio numerator/denominator contribution coverage.
- A-10: `cargo test -p kasitek-analytics --test maintenance_postgres -- --nocapture` passed
  reconciliation mismatch repair-window requeue coverage.
- A-10: full `cargo test -p kasitek-analytics` (31 unit tests plus ingestion, maintenance, and
  projection PostgreSQL suites) and strict package Clippy passed.
- A-11 slice 1: `cargo fmt -p kasitek-analytics`, strict package Clippy, and full
  `cargo test -p kasitek-analytics` passed; the package now includes 36 unit tests and the
  reporting PostgreSQL suite.
- A-11 slice 1: native PostgreSQL reporting test passed with a signed ES256 grant, persisted grant
  binding, transaction-local RLS context, promoted-generation rollup reads, and contribution-level
  distinct deduplication; all fixture rows were rolled back.
- A-11 slice 1: migration `20260822080000_analytics_reporting_scope_expansion.sql` applied through
  the Analytics migration release binary.
- A-11 slice 2: `cargo test -p kasitek-analytics --lib -- --test-threads=1` — 40 unit tests passed,
  including previous-period validation, authorization-complete cache-key separation, cache hit and
  expiry behavior, and non-authoritative Redis failure fallback.
- A-11 slice 2: `cargo test -p kasitek-analytics --test reporting_postgres -- --nocapture` passed
  against native PostgreSQL; the signed reporting fixture returned current count `3` and previous
  period count `1`, with all fixture rows rolled back.
- A-11 slice 2: strict package Clippy, package formatting, `cargo check --workspace`, and
  `git diff --check` passed. Native Redis was not available for a live integration run; the cache
  failure and expiry paths are covered by deterministic backend tests.
- A-12 slice 1: migration `20260822090000_analytics_rollout_controls.sql` applied through the
  Analytics migration release binary against native PostgreSQL.
- A-12 slice 1: rollout unit tests passed, including customer default-deny, operational default-
  allow, kill-switch separation, target precedence, stable cohort hashing, request validation, and
  allowlisted producer authentication.
- A-12 slice 1: `cargo test -p kasitek-analytics --test rollout_postgres -- --nocapture` passed;
  the fixture covered global and reporting-scope overrides, expiry fallback, revisioning, audit
  hash-chain continuity, and rolled back all fixture rows.
- A-12 slice 2: migration `20260822091000_analytics_rollout_revision.sql` applied through the
  Analytics migration release binary; control mutations advance the monotonic registry revision
  transactionally.
- A-12 slice 2: 11 rollout-focused unit tests passed, covering Redis-shaped cache hits, revision
  key separation, decision expiry, disabled-cache fallback, policy behavior, and authentication.
- A-12 slice 2: native PostgreSQL rollout integration passed with registry revision assertions and
  all fixture rows rolled back; strict Analytics Clippy passed.
- A-12 slice 3: expiry closure is covered by the native PostgreSQL rollout fixture, including
  audit continuity, registry revision advancement, and idempotent repeated maintenance.
- A-12 slice 3: process metrics cover rollout evaluation, cache outcome, and expiry-closure
  counters with fixed service/process labels only; 51 Analytics unit tests and strict package
  Clippy passed.

## Explicitly deferred

- A-02 native Redis integration until a native Redis server is available; Redis is not yet used by
  the foundation runtime.
- A-03 complete product mutation-to-reporting E2E, domain OpenTelemetry exporters, alert rules, and
  tested recovery drills
- A-12 control-management UI remains deferred; evaluation is database-authoritative and expired
  entries fail closed before or after maintenance closure.
- A-04 historical compatibility fixtures until a second major contract or metric version exists
- Complete product mutation-to-reporting E2E until the source-domain vertical slices exist
- A-06 signed audit checkpoint production/verification until the controlled signing boundary exists
- A-07/A-08 authoritative domain mutation instrumentation until the applicable reference vertical
  slices exist
- Reporting UI and full product mutation-to-reporting E2E remain deferred; source reconstruction
  and provider-history backfill execution remains producer-owned behind the claim boundary.
