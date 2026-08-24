# Analytics implementation checklist

Canonical product and execution decisions live in the repository-root analytics plans. This scoped
checklist records implementation evidence for the current package only.

## Phase 0

- [x] Product Sections 1–12 approved.
- [x] Execution Sections E1–E10 approved.
- [x] Standalone service boundary confirmed.
- [x] Dedicated `ANALYTICS_DATABASE_URL` boundary confirmed.
- [x] Core, Agent Platform, and Tenant Platform remain operational when Analytics is unavailable.
- [ ] Record named human owners for Analytics, source lanes, reporting, infrastructure, security,
  and privacy; names must be supplied by the repository owner and are tracked in `blockers.md`.

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
- [ ] Implement one complete product mutation-to-reporting `--full` orchestration after A-04 through
  A-12; the domain fixtures now exist independently, but the repository still lacks a safe single
  command that provisions all required Core, Tenant, Agent, and Analytics databases.
- [ ] Add domain pipeline metrics, OpenTelemetry exporters, alert rules, and tested recovery drills
  after the deployment's observability backend and alert ownership are supplied; current process
  metrics and runbooks remain active.

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
- [x] Keep v2 compatibility fixtures conditional: the current registry contains only v1 major
  contracts/metrics and has no historical major-version baseline to compare.

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
- [x] Build versioned event, provider-observation, scope-definition, and source-manifest envelopes
  with source, scope, subject, timing, correlation, and idempotency metadata.
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
- [x] Add privacy-safe manifest builders and Core/Tenant transactional manifest enqueue helpers;
  derive stream-scoped manifest identities so tenant scopes can reuse manifest keys.
- [x] Extend Core and Tenant outbox constraints and Analytics producer permissions for manifests.
- [x] Run shared Rust unit tests and PostgreSQL outbox integration using a temporary table so no
  test rows remain in the Core database.
- [x] Apply the Core outbox SQL migration locally and apply the real Tenant SQLx migrations to an
  isolated native PostgreSQL database.
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
  scope-definition and source-manifest fields before writing facts or manifest receipts.
- [x] Enforce producer category and scope-kind permissions from the Analytics producer registry.
- [x] Keep raw payloads out of quarantine and reject prohibited customer content before persistence.
- [x] Verify canonical payload hashes and return per-record accepted, duplicate, rejected, and
  retryable acknowledgements.
- [x] Insert immutable events and observations idempotently; identity conflicts are quarantined and
  never silently selected.
- [x] Insert immutable source manifests idempotently, retain capability/cadence/coverage metadata,
  and count accepted manifests in stream reconciliation summaries.
- [x] Add immutable scope-definition receipts and atomically update the reporting-scope read model,
  including parent-before-child readiness and controlled reparent rejection.
- [x] Update highest-received, highest-contiguous, and merged known-gap cursor state in the same
  transaction as each accepted or duplicate record.
- [x] Exclude authenticated source-history backfill records from live source-cursor advancement;
  their stable identity sequences are used only for idempotent fact identity and receipt storage.
- [x] Update provider observation source health in the same transaction as the observation fact.
- [x] Add authenticated producer reconciliation summaries and persist mismatch, gap, count, and
  unresolved-quarantine evidence in `analytics_reconciliation_run`.
- [x] Admit replay batches only through a running, source-matched approved backfill job and mark
  accepted facts as backfilled without changing source identity.
- [x] Add unit tests for credential identity and cursor gaps plus PostgreSQL end-to-end coverage for
  acceptance, duplicate handling, identity conflict quarantine, cursor state, manifest persistence,
  and reconciliation.
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
- [ ] Add one complete product mutation-to-reporting E2E orchestration; native disposable Core,
  Tenant, and Analytics databases and the independent Core Campaign, Inbox, and Tenant fixtures
  are covered, but the repository still lacks one safe command that provisions every required Core,
  Agent, Tenant, and Analytics database and runs the complete cross-service suite.

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
- [ ] Add control-management UI after the owning internal admin surface and rollout-control product
  authorization are supplied; server-side controls and fail-closed evaluation are complete.

## A-13 — M1 reference vertical slices (slices 1–9: Agent runtime)

- [x] Reuse the existing Agent Platform transactional Analytics outbox and registered terminal
  run contracts instead of reconstructing runtime facts from polling or operational summaries.
- [x] Emit `agent.run.completed@1` and `agent.run.failed@1` from the same database transaction as
  the authoritative run and attempt terminal mutation.
- [x] Record stable run, definition, version, installation, organization scope, correlation,
  trigger, execution mode, creation profile, audience, deployment surface, duration, outcome, and
  failure-class references.
- [x] Keep prompts, responses, raw errors, credentials, and other prohibited content out of the
  Analytics payload; failure classification uses bounded reason classes.
- [x] Preserve idempotency through stable terminal record identities and keep non-handoff agents
  on the same common runtime path; handoff remains a separate conditional contract.
- [x] Add producer unit coverage and a database-backed run-to-outbox integration fixture using an
  isolated temporary outbox table.
- [x] Add versioned completed/failed model-call contracts with provider, model, funding-source,
  token, cost, latency, finish-reason, and bounded failure fields; register corresponding metrics,
  dimensions, and the Agent performance metric set.
- [x] Emit model-call facts in the same transaction as the authoritative `model_calls` row, preserve
  correlation IDs, use stable record identities, and keep credentials, prompts, responses, and raw
  error messages out of Analytics payloads.
- [x] Add model-call producer unit coverage and a database-backed model-call-to-outbox integration
  fixture using the isolated temporary outbox table.
- [x] Add versioned tool-invocation, approval, and external-effect lifecycle contracts with safe
  agent/run/capability references, action/status dimensions, bounded failure classes, and
  reconciliation state.
- [x] Emit tool, approval, and effect lifecycle facts transactionally from their authoritative
  repository mutations, including approval consumption and effect execution start in one transaction.
- [x] Add lifecycle producer coverage and a database-backed state-machine fixture covering proposals,
  decisions, expiry, execution, unknown outcomes, reconciliation, and terminal effects without
  exporting arguments, outputs, snapshots, provider receipts, or raw errors.
- [x] Add a versioned schedule lifecycle contract and metric for hosted schedule creation and actual
  status transitions; exclude schedule input, expressions, and scheduler dispatch claims.
- [x] Emit schedule lifecycle facts transactionally with schedule and audit mutations, preserve
  organization and agent references, and avoid duplicate facts for unchanged status writes.
- [x] Confirm the existing conditional handoff lifecycle contract remains customer-service scoped;
  ordinary personal and non-handoff Agents do not emit handoff facts.
- [x] Add a versioned readiness snapshot contract and metric containing only bounded readiness
  status, blocker codes, component statuses, and counts; exclude workflow details and credentials.
- [x] Emit readiness snapshots as a failure-isolated sidecar after successful readiness-route
  evaluation, coalescing unchanged state and recording state transitions in the Agent outbox.
- [x] Add a bounded periodic readiness sweep in the existing Agent API process. PostgreSQL leases
  coordinate API replicas, evaluation state is durable and resumable, and the sweep reuses the
  same projection plus failure-isolated outbox sidecar without adding another service.
- [x] Add a versioned installation lifecycle contract and metric with execution mode, creation
  profile, audience, scope, and bounded status transitions; exclude settings and credentials.
- [x] Emit installation creation, activation, pause, and disable facts transactionally across
  direct status changes and archive paths, and avoid duplicate facts for unchanged status writes.
- [x] Add a versioned Agent version lifecycle contract and metric for creation, publication,
  retirement, and rollback; exclude instructions, configuration, policy, and checksums.
- [x] Emit version lifecycle facts transactionally across hosted, system, template, and external
  version creation/release paths, including the replaced version during publication or release.
- [x] Add a versioned Agent definition lifecycle contract and metric for creation, metadata updates,
  archive/restore, and deletion; export only bounded ownership, profile, audience, action, and
  status fields, never definition names, slugs, or descriptions.
- [x] Emit definition lifecycle facts transactionally across direct, external, Developer API,
  template, and system definition paths, including the terminal deletion fact before dependent
  data is removed and avoiding unchanged metadata-update duplicates.

### A-13 — Customer handoff analytics completion

- [x] Keep handoff analytics scoped to customer-service Agents and customer conversations; generic
  human waits and non-handoff Agents do not emit this contract.
- [x] Align the registered handoff lifecycle schema with all repository-emitted actions, sent
  statuses, and bounded resolution codes.
- [x] Add `agent.handoffs.lifecycle_events@1` with safe lifecycle dimensions and include it in the
  Agent performance metric set.
- [x] Verify attribute-based Agent-definition projection, ingestion, temporal coverage,
  authorization, and reporting with
  `customer_handoff_lifecycle_projects_and_reports_with_safe_dimensions`.

## Verification evidence

- Current native PostgreSQL verification (2026-08-24): isolated Core, Tenant, and Analytics
  databases were created locally and migrated with the real Core SQL, Tenant SQLx, and Analytics
  migration paths. The ignored Core Connections, Core Inbox, Core Campaigns, and Tenant mutation-
  to-publisher-to-projection-to-reporting E2E fixtures all passed against those databases.
- Current Analytics verification (2026-08-24): 62 library tests, 6 ingestion PostgreSQL tests,
  2 projection PostgreSQL tests, 1 maintenance PostgreSQL test, 5 reporting PostgreSQL tests,
  and 1 rollout PostgreSQL test passed. The canonical registry check passed with 39 contracts,
  44 metrics, 68 dimensions, 2 metric sets, and SHA-256
  `d74695d552cfbd40d71b83b089b0e7b0ed0a2a1dbfd96c71077bd244d9ccf4a8`.

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
- A-07: Core `sql/20260822030000_analytics_outbox.sql` and the manifest outbox SQL applied
  successfully; the real Tenant binary startup applied all embedded migrations to the isolated
  native Tenant database and shut down cleanly.
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
- A-09: 62 Analytics library tests passed, including the current handoff-contract registry counts;
  the canonical registry assertions now match 39 contracts, 44 metrics, and 68 dimensions.
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
- Source-history transport: the shared Rust client now claims authenticated source-backfill work,
  submits bounded batches with the leased job identity, uses stable record-identity sequences, and
  keeps backfill acceptance out of live source-cursor advancement; focused wire-contract tests pass.
- Core Meta reconstruction: the bounded worker reads only authorized organization rows and the two
  responder-marker fields, preserves conversation/message business timestamps, uses deterministic
  identities, and runs in the existing publisher process or an optional dedicated Core process.
- Core Inbox system E2E: the ignored `core_inbox_system_e2e` fixture passed against the local native
  Core and Analytics PostgreSQL databases; it started a real Analytics API, committed Core Inbox
  producer facts to the Core outbox, published them through the authenticated shared transport,
  and verified delivered Core rows plus non-backfilled Analytics events and privacy boundaries.
- Core Connections system E2E: the ignored `core_connections_system_e2e` fixture passed against the
  local native Core and Analytics PostgreSQL databases; it committed all six Core Connections fact
  contracts plus the source manifest to the Core outbox, published them through the authenticated
  shared transport, and verified delivered rows, manifest persistence, event contracts, and privacy
  boundaries. Projection, historical completeness, and reporting are verified in separate slices.
- Core Connections source reconstruction: Core's backfill worker now claims authenticated
  `source_reconstruction` jobs for `connections`, reads only immutable privacy-filtered Core outbox
  events, preserves their envelopes and business timestamps, excludes manifests, and uses stable
  backfill sequences; focused Core unit tests passed. The native `core_connections_system_e2e`
  backfill case also passed authenticated job claim, backfilled event persistence, job completion,
  and `available` temporal checkpoint evidence. Reporting availability is verified by the separate
  native reporting fixture below.
- Core Connections reporting: the native `reporting_postgres` fixture passed a reconstructed
  lifecycle event through ingestion and the typed projection into an authorized report with
  `available` temporal coverage, required-source evidence, and provider/lifecycle dimensions.
-  The same fixture now verifies all six registered Connections metrics as available after the
  temporal boundary. Approved customer-facing surfaces remain pending.
- Core Campaign delivery: the ignored `core_campaigns_system_e2e` fixture passed against the local
  native Core and Analytics PostgreSQL databases; it published deduplicated sent/delivered/read/failed/
  blocked facts through the authenticated Analytics API and verified persisted privacy-safe event rows.
- Campaign reporting: the native `reporting_postgres` fixture now verifies delivered distinct
  counting, read distinct counting, failed and blocked distinct counting with `failure_class` and
  `block_class` breakdowns, and delivery-rate numerator/denominator reporting with available temporal
  coverage.
- Customer handoff reporting: the native `reporting_postgres` fixture accepted three bounded
  customer-service handoff lifecycle facts, projected them with Agent-definition and handoff-state
  dimensions, and returned an authorized report with available temporal coverage.
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
- A-13 slice 1: Agent producer unit tests and the full Agent test suite passed; the run integration
  fixture passed with completed and failed terminal mutations writing isolated outbox facts.
- A-13 slice 1: Analytics registry bindings were regenerated and checked after extending the
  version-one terminal run schemas with safe runtime-context fields; Analytics unit tests passed.
- A-13 slice 2: model-call contracts, metrics, dimensions, and metric-set bindings were regenerated;
  Agent producer and database-backed model-call outbox coverage passed without exporting provider
  credentials, prompts, responses, or raw error messages.
- A-13 slice 3: tool, approval, and effect lifecycle contracts and registry bindings were regenerated;
  Agent producer tests and the live run integration passed across proposal, decision, expiry,
  execution, unknown-outcome, reconciliation, and terminal-effect paths.
- A-13 slice 4: schedule lifecycle contract, metric, dimensions, and registry bindings were
  regenerated; producer coverage and the live hosted-agent integration passed for creation, status
  transition, unchanged-status idempotency, and organization isolation.
- A-13 slice 5: readiness snapshot contract, metric, dimensions, and registry bindings were
  regenerated; producer coverage and the live hosted-agent integration passed for bounded payloads,
  unchanged-state coalescing, and ready/blocked state transitions.
- A-13 slice 6: periodic readiness evaluation uses a durable due-state table, bounded PostgreSQL
  leases, replica-safe claims, retry release, and the same readiness projection as the route; sweep
  unit coverage and the live claim/lease integration passed.
- A-13 slice 7: installation lifecycle contract, metric, dimensions, and registry bindings were
  regenerated; producer coverage and the live hosted-agent integration passed for creation,
  pause/resume transitions, unchanged-status idempotency, and organization isolation.
- A-13 slice 8: version lifecycle contract, metric, dimensions, and registry bindings were
  regenerated; producer coverage and the live hosted-agent integration passed for draft creation,
  publication, bounded payloads, and organization isolation.
- A-13 slice 9: definition lifecycle contract, metric, dimensions, and registry bindings were
  regenerated; producer coverage and the live hosted-agent integration passed for creation,
  metadata updates, deletion-before-removal, bounded payloads, and organization isolation.

## Core Connections — slice 1

- [x] Add versioned lifecycle and health-check contracts with bounded provider/state fields and
  explicit privacy exclusions for account identifiers, credentials, tokens, provider payloads,
  and raw errors.
- [x] Register lifecycle and health-check metrics, compatible dimensions, and overview metric-set
  bindings; generated Rust and TypeScript registry bindings are current.
- [x] Emit lifecycle facts from Core connection synchronization, explicit status commands, and
  direct Twilio connection creation; unchanged synchronization and idempotent upserts emit none.
- [x] Emit health-check facts transactionally with Core `ExternalConnection` health updates.
- [x] Add an ignored PostgreSQL producer integration fixture covering both contracts, transaction
  visibility, and prohibited-field absence without leaving rows after rollback.
- [x] Add historical backfill, projections, reporting, and full product mutation-to-reporting E2E
  through the native Connections fixtures and reporting suite.

## Core Connections — slice 2

- [x] Add a versioned capability lifecycle contract with stable connection/capability identity and
  bounded aggregate-safe fields.
- [x] Register capability transition metrics, dimensions, overview binding, and generated registry
  bindings.
- [x] Compare logical capability states around Core's projection rebuild so delete/reinsert storage
  mechanics do not create duplicate analytics transitions.
- [x] Emit capability transitions transactionally with the Core capability projection.
- [x] Extend the transactional privacy fixture to cover capability facts and rollback.
- [x] Add historical backfill, projections, reporting, and full product mutation-to-reporting E2E
  through the native Connections fixtures and reporting suite.

## Core Connections — slice 3

- [x] Add `connection.sync_attempt@1` with stable connection/attempt references, provider,
  operation, outcome, bounded failure class, duration, and event time; raw provider details and
  credentials remain excluded.
- [x] Register `connection.sync_attempts@1`, its operation dimension, shared outcome/failure
  dimensions, and the overview metric-set binding; generated registry bindings are current.
- [x] Instrument WhatsApp connection refresh and social identity refresh at their real async error
  boundaries, recording both success and failure outcomes without changing API error responses.
- [x] Record the facts through the Core outbox using deterministic `ExternalConnection` references,
  avoiding a full connection projection rebuild for every provider attempt.
- [x] Extend the ignored PostgreSQL producer/privacy fixture and add bounded provider error-class
  unit coverage.
- [x] Add historical backfill, projections, reporting, and full product mutation-to-reporting E2E
  through the native Connections fixtures and reporting suite.

## Core Connections — slice 4

- [x] Map provider HTTP 429 responses to Core's stable rate-limited error without exporting raw
  provider response bodies.
- [x] Add `connection.rate_limit@1` and `connection.rate_limit_encounters@1` with bounded provider,
  operation, scope, and retry metadata.
- [x] Emit rate-limit facts in the same outbox transaction as failed sync outcomes for instrumented
  connection refresh operations.
- [x] Add `connection.incident.lifecycle@1` and `connection.incidents@1` for health incident
  openings and recoveries with duplicate suppression at unchanged health states.
- [x] Emit incident facts transactionally with Core `ExternalConnection` health transitions.
- [x] Extend producer/privacy coverage and add 429/error-classification and health-boundary tests;
  regenerate the Rust and TypeScript registry bindings.
- [x] Add historical backfill, projections, reporting, and full product mutation-to-reporting E2E
  through the native Connections fixtures and reporting suite.

## Core Connections — slice 5

- [x] Publish `source.manifest@1` for the organization-scoped Core Connections stream from the
  successful synchronization transaction, coalesced to one immutable manifest per observed
  refresh window; no independent scheduler is claimed yet.
- [x] Declare the registered Connections contracts, metrics, and dimensions without provider
  identifiers, credentials, metadata, account identifiers, or raw provider payloads.
- [x] Include the authoritative current `ExternalConnection` population as a bounded source
  checkpoint; do not claim a reliable historical coverage start before backfill/reconciliation.
- [x] Add focused privacy, same-window idempotency, and coverage-boundary integration assertions.
- [x] Add historical event backfill, temporal coverage checkpoints, reporting, and full product
  mutation-to-reporting E2E through the native Connections fixtures and reporting suite.

## Core Connections — slice 6

- [x] Route Connections event metrics through a dedicated `connections.v1` typed projection
  builder.
- [x] Validate lifecycle, health, capability, synchronization, rate-limit, and incident fields
  before writing typed contributions.
- [x] Map registered Connections dimensions while excluding internal connection references from
  dimension JSON.
- [x] Keep projection coverage observed/partial and do not claim reliable historical coverage.
- [x] Verify generation processing, replay idempotence, rollups, and all six Connections metrics
  in the PostgreSQL projection fixture.
- [x] Insert one source-layer coverage checkpoint with each accepted manifest, linked by
  `source_manifest_id` in the same transaction; duplicate delivery remains idempotent.
- [x] Keep source coverage bounded to the approved current population and refresh window; leave
  `complete_through` and reliable historical coverage unset until backfill/reconciliation exists.
- [x] Verify checkpoint privacy, duplicate behavior, and incomplete-history semantics in the
  PostgreSQL ingestion fixture.
- [x] Persist scope-bound reconciliation checkpoints from stored fact windows and keep empty streams
  from receiving fabricated temporal coverage.
- [x] Link reconciliation checkpoints to immutable reconciliation runs and verify duplicate-run
  idempotence, complete/mismatch states, counts, and privacy.
- [x] Add the ignored `core_connections_system_e2e` fixture: invoke all six transactional Core
  Connections fact producers and the source manifest, publish through the authenticated shared
  transport, and verify Core delivery state, Analytics manifest persistence, event contracts, and
  privacy boundaries. This is transport coverage only; it does not claim projection or historical
  completeness.
- [x] Add temporal event backfill checkpoints, reporting availability, and full product
  mutation-to-reporting E2E through the native Connections fixtures and reporting suite.

## Core Connections — source reconstruction

- [x] Claim `connections` `source_reconstruction` work through the existing authenticated worker
  boundary.
- [x] Read immutable Core Connections event history from the Core `analytics_outbox`, not Analytics
  storage or mutable `ExternalConnection` state.
- [x] Preserve the original safe envelope and business timestamp with deterministic backfill
  sequences; exclude manifest records from event reconstruction.
- [x] Verify valid event conversion and manifest rejection in focused Core unit tests.
- [x] Verify native worker-to-Analytics transport, authenticated job claim, backfilled event
  persistence, job completion, and `available` temporal checkpoint evidence in the ignored
  `core_connections_system_e2e` fixture.
- [x] Verify one authorized lifecycle report with temporal evidence, required-source validation,
  typed projection state, and provider/lifecycle dimensions in the native `reporting_postgres`
  fixture.
- [x] Verify all six registered Connections metrics with available temporal evidence, matching
  required-source metadata, and aggregate report points in the native `reporting_postgres` fixture.
- [ ] Implement approved customer-facing Connections analytics surfaces after a Core/Tenant gateway
  issues signed reporting grants; the Analytics API intentionally does not accept browser calls.

## Core Connections — slice 7

- [x] Materialize source-manifest-linked coverage receipts in the Analytics ingestion transaction.
- [x] Preserve manifest state, safe-failure, count, and refresh-window semantics without copying
  provider or connection-sensitive fields into the checkpoint.
- [x] Verify accepted, duplicate, privacy, and incomplete-history paths.
- [x] Build temporal coverage from historical event backfill and reconciliation before reporting.

## Core Connections — slice 8

- [x] Add an optional unique `reconciliation_run_id` evidence link to coverage checkpoints.
- [x] Persist complete and mismatched reconciliation coverage from actual event/observation windows.
- [x] Preserve no-fabrication behavior for empty streams and no historical completeness claim.

## Core Connections — slice 9

- [x] Add an optional unique `backfill_job_id` evidence link to coverage checkpoints.
- [x] Create temporal coverage only when authenticated source reconstruction or provider-history
  ingestion completes a finite backfill job in the same transaction as the final accepted record.
- [x] Derive producer, source service, source domain, scope, requested window, and counts from the
  authenticated identity and authorized job; do not trust producer-supplied provenance fields.
- [x] Set `available` and `complete_through` only when no records were rejected; retain `partial`
  coverage when the completion boundary contains rejected records.
- [x] Do not create source-completeness checkpoints for `fact_replay` or `projection_rebuild`.
- [x] Move backfill authorization after exact-duplicate detection so a lost final acknowledgment
  can be retried idempotently after the job is completed.
- [x] Verify counts, temporal boundaries, provenance, privacy, duplicate retry, and replay exclusion
  in the PostgreSQL ingestion fixture.
- [ ] Add richer rejected-record completion/reporting after the reporting API contract defines the
  customer-safe rejected-reason shape; current coverage exposes bounded accepted/excluded counts
  and safe quality/quarantine records.

## Core Inbox — Meta source checkpoint slice

- [x] Add a Meta-specific `source.manifest@1` producer builder with the registered Core Inbox
  contracts, metrics, and dimensions; keep provider and operational identifiers out of the
  manifest payload.
- [x] Emit the checkpoint from Meta message creation, send, retry, delivery, read, and provider
  delivery-backfill mutation transactions using the current organization-scoped Meta message
  population as the bounded source checkpoint.
- [x] Coalesce repeated observations in the immutable refresh window and preserve the explicit
  no-history boundary: `reliable_coverage_start` remains unset until a source reconstruction or
  approved provider-history import completes.
- [x] Return the authorized reporting scope's external organization ID with leased source-history
  work so Core workers do not need Analytics database access to select their source rows.
- [x] Extend the Core Inbox producer fixture with manifest privacy and same-window idempotency
  assertions.
- [x] Add Meta historical source-reconstruction coverage with an honest temporal completion
  boundary.
- [x] Exclude historical Meta facts from live transport reconciliation counts and windows.
- [x] Preserve Meta message dimensions in typed projections and carry source-coverage metadata
  into reporting rollups.
- [x] Verify authenticated Meta ingestion through projection generation to scoped reporting with
  temporal evidence and message-dimension breakdowns.
- [x] Add the full Core mutation-to-source-outbox-to-publisher-to-Analytics system E2E. The
  ignored `core_inbox_system_e2e` PostgreSQL fixture starts the real Analytics API, invokes Core's
  transactional Inbox producer boundary, publishes through the shared authenticated HTTP
  transport, and verifies Core delivery state plus persisted Analytics facts. The broader product
  mutation-to-reporting gate remains shared work across later vertical slices.

## Core Campaigns — recipient delivery slice 1

- [x] Reuse the registered `campaign.recipient.sent@1` and
  `campaign.recipient.delivered@1` contracts and existing delivery metrics.
- [x] Add organization-scoped Core Campaigns producer helpers with stable campaign-recipient
  identities and bounded campaign, recipient, channel, provider, status, and event-time fields.
- [x] Emit sent facts transactionally with provider-send success, including existing-send recovery.
- [x] Emit delivered facts transactionally with WhatsApp delivery webhook state changes and avoid
  duplicates for unchanged status writes.
- [x] Add Core producer privacy/rollback coverage in `analytics_campaigns`.
- [x] Add the ignored `core_campaigns_system_e2e` fixture for authenticated Core outbox publishing,
  stable identity deduplication, Analytics ingestion, and sent/delivered privacy checks.
- [x] Verify sent, delivered, and delivery-rate reporting, including distinct-recipient and
  numerator/denominator aggregation, in the signed PostgreSQL reporting fixture.
- [x] Add source manifests, source reconstruction, retry/eligibility facts, and complete
  Campaign performance coverage in later Campaign slices.
- [x] Add the ignored combined mutation-to-publisher-to-projection-to-reporting Campaign E2E;
  the fixture runs against disposable native Core and Analytics databases.

## Core Campaigns — recipient read slice 2

- [x] Add and register `campaign.recipient.read@1` with a fixed read status and aggregate-safe
  attributes; generated Rust and TypeScript bindings are current.
- [x] Add `campaign.recipients.read@1` to the overview metric set and compatible campaign
  dimensions.
- [x] Emit read facts transactionally with Core's WhatsApp `READ` recipient transition and avoid
  duplicates for unchanged status writes.
- [x] Extend Core rollback/privacy, authenticated publisher E2E, and signed reporting coverage for
  the read fact and distinct-recipient aggregation.

## Core Campaigns — recipient failure slice 3

- [x] Add and register `campaign.recipient.failed@1` with aggregate-safe bounded failure classes;
  `raw_error` and provider payloads remain prohibited.
- [x] Add `campaign.recipients.failed@1` with distinct-recipient aggregation, failure-class
  compatibility, and overview metric-set registration.
- [x] Emit provider-send, entitlement, and WhatsApp webhook failure facts in the same Core database
  transaction as the authoritative recipient failure transition. Blocked outcomes remain excluded.
- [x] Verify producer rollback/privacy behavior, authenticated Core publisher delivery, Analytics
  ingestion, failure-class reporting, and available temporal coverage in PostgreSQL tests.
- [x] Add read-delay through the registered Campaign timing contract and weighted-average
  reporting path; retry and completed mutation-to-reporting coverage remain later slices.

## Core Campaigns — recipient blocked slice 4

- [x] Add and register `campaign.recipient.blocked@1` with aggregate-safe bounded block classes;
  `raw_error` and provider payloads remain prohibited.
- [x] Add `campaign.recipients.blocked@1` with distinct-recipient aggregation, block-class
  compatibility, and overview metric-set registration.
- [x] Emit provider-send and Meta webhook blocked facts in the same Core database transaction as
  the authoritative blocked recipient transition; blocked outcomes remain separate from failures.
- [x] Verify bounded Meta block classification, producer rollback/privacy behavior, authenticated
  Core publisher delivery, Analytics ingestion, blocked reporting, and available temporal coverage.
- [x] Add unsubscribe/exclusion, eligibility, guard, and timing coverage in later Campaign slices.
- [x] Add retry and complete mutation-to-reporting coverage; numeric cost and attribution remain
  blocked by source ledgers.

## Core Campaigns — suppression and unsubscribe slice 5

- [x] Add and register `campaign.recipient.suppressed@1` with bounded suppression classes and no
  contact values, message content, credentials, tokens, or unrestricted provider payloads.
- [x] Add and register `campaign.recipient.unsubscribed@1` with bounded unsubscribe sources and
  aggregate-safe campaign/recipient references.
- [x] Emit manual exclusion facts in the same transaction as skipped recipient persistence.
- [x] Emit opt-in, contact exclusion, cooldown, and policy-guard facts in the same transaction as
  the final send-eligibility transition.
- [x] Emit WhatsApp keyword unsubscribe facts in the same transaction as contact and recipient
  unsubscribe transitions.
- [x] Add suppression/unsubscribe metrics, dimensions, overview registration, generated bindings,
  Core rollback/privacy coverage, authenticated publisher coverage, and signed reporting
  breakdowns.
- [x] Add retry, timing, source manifests, historical reconstruction, and the combined
  mutation-to-publisher-to-projection-to-reporting E2E; numeric cost and attribution remain blocked.

## Core Campaigns — timing and numeric aggregation slice 6

- [x] Add and register `campaign.recipient.timing@1` with bounded timing kinds, non-negative
  duration milliseconds, and aggregate-safe attributes.
- [x] Emit send-to-delivered, send-to-read, and delivered-to-read timing facts transactionally
  with authoritative WhatsApp delivery/read transitions when timestamps are available.
- [x] Add `campaign.delivery_delay_ms` with weighted-average aggregation and timing-kind
  compatibility in the overview metric set.
- [x] Make the shared projection and reporting paths consume the numeric formula field for
  weighted-average event metrics; events without that field are excluded from that metric only.
- [x] Verify Core rollback/privacy, authenticated publisher delivery, projection parity, and
  signed duration reporting.
- [x] Add retry, source manifests, historical reconstruction, and the combined
  mutation-to-publisher-to-projection-to-reporting E2E; numeric cost and attribution remain blocked.

## Core Campaigns — retry attempts slice 7

- [x] Add forward-only Core database migration and Prisma fields for recipient attempt count and
  last attempt time.
- [x] Increment recipient attempts at the queue claim boundary so the count covers every provider
  send attempt, including a retried send.
- [x] Enable inactive-campaign manual retry with transactional failed-to-queued mutation,
  campaign resume, and operational update publication.
- [x] Add and register `campaign.recipient.retry@1` with bounded retry reason and attempt number;
  retry facts do not contain provider errors or contact values.
- [x] Add retry metric/dimension compatibility, generated bindings, Core rollback/privacy,
  authenticated publisher, and signed reporting coverage.
- [x] Add provider retry facts, source manifests, historical reconstruction, and the combined
  mutation-to-publisher-to-projection-to-reporting E2E; provider policy, numeric cost, and
  attribution remain separate source/ownership work.

## Core Campaigns — source manifest and historical reconstruction slice 8

- [x] Publish a versioned source manifest from successful campaign recipient population creation,
  with bounded current-count evidence and no historical-completeness claim.
- [x] Reuse the immutable Core Campaign analytics outbox as the source-owned history for an
  authenticated Campaign backfill job; preserve original envelopes and deterministic sequences.
- [x] Keep Campaign manifests out of event reconstruction and isolate reconstructed facts from live
  reconciliation counts.
- [x] Add the native ignored Core Campaign source-reconstruction/backfill fixture; the combined
  mutation-to-publisher-to-projection-to-reporting E2E is covered above.
- [x] Add provider billable/category/model/type facts and typed pricing dimensions; numeric currency
  cost and cross-feature attribution remain separate source-ledger work.

## Core Campaigns — provider pricing metadata slice 9

- [x] Add and register the aggregate-safe `campaign.recipient.pricing@1` contract and
  `campaign.recipients.pricing_recorded@1` metric.
- [x] Parse and bound WhatsApp status pricing metadata, persist it on matching operational send
  events, and emit a deduplicated Core analytics fact in the pricing transaction.
- [x] Add filterable billable/category/model/type dimensions, overview registration, generated
  bindings, and library/registry verification.
- [ ] Add an authoritative numeric currency-cost source and cross-feature attribution after their
  source ledgers and ownership boundaries exist; see root `blockers.md`.

## Tenant Platform — scope and lead creation slice 1

- [x] Publish tenant workspace scope definitions during workspace provisioning and tenant-client
  scope definitions during client creation through the transactional Tenant outbox.
- [x] Register the tenant scope-definition and lead lifecycle contracts with aggregate-safe schemas;
  lead personal data, contact values, company, and notes are excluded.
- [x] Emit lead-created facts in the same transaction as the authoritative Tenant lead insert,
  using bounded source categories and score bands.
- [x] Register tenant lead lifecycle metrics and dimensions, route them through the typed
  `tenants.v1` projection builder, and regenerate bindings.
- [x] Verify registry validation, Tenant and Analytics package compilation, and privacy-safe helper
  unit coverage.
- [x] Add workspace timezone/client overrides and client lifecycle facts with scope status
  transitions.
- [x] Add tenant-client assignments with authoritative state, append-only history, bounded roles,
  management routes, and transactional analytics facts.
- [x] Add Tenant source manifests and source reconstruction for immutable Tenant outbox history.
- [x] Add the ignored Tenant mutation-to-publisher-to-projection-to-reporting fixture with privacy
  and scope assertions; the fixture runs against disposable native Tenant and Analytics databases.

## Tenant Platform — client lifecycle and timezone slice 2

- [x] Persist workspace reporting timezone and optional client override with a UTC default.
- [x] Add active/suspended/archived client status mutation and publish matching scope/lifecycle
  facts transactionally without client names, metadata, or external references.
- [x] Register the client lifecycle contract, metric, dimension, typed projection support, and
  generated bindings.
- [x] Verify registry validation and Tenant/Analytics package compilation.
- [x] Add assignment records and lead status history in the completed Tenant slices.

## Tenant Platform — lead status history slice 3

- [x] Add append-only `tenant_lead_status_history` with bounded statuses, reason codes, actor
  types, and source-owned actor references.
- [x] Add tenant-user and tenant-client-user status commands with same-transaction current-row,
  history-row, and Analytics outbox writes.
- [x] Extend the lead lifecycle contract and typed projection dimensions for status changes.
- [x] Verify bounded helper tests, registry validation, and Tenant/Analytics compilation.
- [x] Add tenant-client assignments with append-only lifecycle facts and typed projection support.
- [x] Add Tenant source manifests and source reconstruction for immutable Tenant outbox history.
- [x] Add the ignored Tenant mutation-to-publisher-to-projection-to-reporting fixture; runtime
  execution is recorded in root `blockers.md`.

## Tenant Platform — client assignments slice 4

- [x] Add workspace/client/staff assignment state with bounded roles and soft revocation.
- [x] Add append-only assignment history for assigned, unassigned, and role-changed actions.
- [x] Add authenticated list, assign, role-change, and revoke commands with workspace/client/user
  authorization boundaries.
- [x] Emit `tenant.client.assignment@1` transactionally with the operational mutation and history.
- [x] Register assignment metric/dimensions, projection validation, and generated bindings.
- [x] Verify registry validation, Tenant tests, and Tenant/Analytics compilation.
- [x] Add Tenant source manifests and source reconstruction for immutable Tenant outbox history.
- [x] Add the ignored Tenant mutation-to-publisher-to-projection-to-reporting fixture; runtime
  execution is recorded in root `blockers.md`.

## Reporting availability — slice 10

- [x] Evaluate temporal and reconciliation checkpoints by registered metric domain and authorized
  scope; do not use source-manifest windows as historical temporal completeness.
- [x] Require both requested-range containment and `complete_through` before returning temporal
  coverage as `available`.
- [x] Report overlapping queued, running, and paused source-history jobs as `backfilling`.
- [x] Downgrade multi-scope results when an authorized scope is missing coverage evidence.
- [x] Return evidence layer, evidence window, and completion boundary in metric coverage metadata.
- [x] Verify available, partial, backfilling, missing-scope, and incomplete-boundary paths.
- [x] Add richer rejected-record completion evidence in slice 12; pre-authorization records remain
  outside the counted boundary until durable identity evidence exists.

## Reporting coverage layers — slice 11

- [x] Map promoted projection checkpoint status to projection coverage state without conflating it
  with temporal completeness.
- [x] Mark missing-generation, failed, and active projection states as `unknown`, `unavailable`,
  and `partial` respectively.
- [x] Evaluate requested breakdown values from authorized report points and count missing values
  as partial dimension coverage without exposing raw identities.
- [x] Return projection state, dimension state, and missing-dimension point counts.
- [x] Verify projection and dimension coverage states in unit and PostgreSQL reporting fixtures.

## Reporting and backfill evidence — slice 12

- [x] Return each metric's registered `coverage.required_sources` in reporting coverage metadata.
- [x] Compare persisted projection-row coverage metadata with the registered required-source set;
  report `available`, `partial`, or `unknown` source evidence without treating metric values as
  proof of source completeness; contradictory metadata downgrades the overall report to partial.
- [x] Count permanent downstream source-backfill rejections only after the authenticated job is
  locked and authorized, in the same transaction as the ingestion failure receipt.
- [x] Keep retryable failures out of rejected-count completion so transient storage/scope failures
  remain retryable and do not create false completion evidence.
- [x] Persist a partial temporal checkpoint with included/excluded counts and no `complete_through`
  when the final authorized source-reconstruction record is rejected.
- [x] Preserve exact-duplicate retries after completion and exclude fact replay/projection rebuild
  from source temporal-completeness evidence.
- [x] Sanitize malformed failure fields and use a deterministic digest identity before quarantine;
  malformed values and raw payloads are not copied into failure evidence.
- [x] Require producer identity matching and a locked authenticated source-service job before
  counting structural rejections; producer mismatches and unauthorized jobs remain uncounted.
- [x] Verify source metadata states and rejected completion evidence in unit and PostgreSQL tests.
- [x] Verify structurally invalid source-backfill rejection, sanitized quarantine identity, and
  partial temporal evidence in the PostgreSQL ingestion fixture.

## Explicitly deferred

- A-02 native Redis integration until a native Redis server is available; Redis is not yet used by
  the foundation runtime.
- A-03 complete product mutation-to-reporting E2E, domain OpenTelemetry exporters, alert rules, and
  tested recovery drills
- A-12 control-management UI remains deferred; evaluation is database-authoritative and expired
  entries fail closed before or after maintenance closure.
- A-13 scheduler dispatch/missed-run facts, campaign, and Tenant M1 slices remain deferred until
  their authoritative source mutations or evaluation workers exist.
- A-04 historical compatibility fixtures until a second major contract or metric version exists
- One complete product mutation-to-reporting E2E orchestration until all service-database
  provisioning, Agent coverage, and run ownership are defined in one safe local command
- A-06 signed audit checkpoint production/verification until the controlled signing boundary exists
- A-07/A-08 authoritative domain mutation instrumentation until the applicable reference vertical
  slices exist
- Reporting UI and full product mutation-to-reporting E2E remain deferred; source reconstruction
  and provider-history backfill execution remains producer-owned behind the claim boundary.
