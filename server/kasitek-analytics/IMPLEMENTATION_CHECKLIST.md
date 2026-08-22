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

## Explicitly deferred

- A-02 native Redis integration until a native Redis server is available; Redis is not yet used by
  the foundation runtime.
- A-03 complete product mutation-to-reporting E2E, domain OpenTelemetry exporters, alert rules, and
  tested recovery drills
- Source outboxes, ingestion, authentication, projections, reporting, and UI
