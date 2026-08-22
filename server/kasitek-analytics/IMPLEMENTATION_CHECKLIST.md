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
- [x] Add local storage and migration helpers and wire them into the full local stack.
- [x] Run package tests, Clippy, workspace check, shell syntax, Compose config, and diff checks.
- [ ] Run PostgreSQL/Redis container integration, migration, backup, and restore drill.

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

## Explicitly deferred

- A-03 CI, local full-stack E2E, OpenTelemetry exporters, alerts, and runbooks
- A-04 contracts registry and generated producer bindings
- Source outboxes, ingestion, authentication, projections, reporting, and UI
