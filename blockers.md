# Analytics execution blockers

These items are recorded for follow-up only. They do not stop implementation of the remaining
analytics slices.

## Current worktree compile failure

- `server/kasitek-core/src/services/social_insights.rs:425` currently calls
  `Value::as_i64()` without passing the value to the method. This is part of unrelated dirty
  social-insights work, so it is not changed here. Core library checks can pass from an earlier
  incremental build, but fresh Core test builds and Analytics tests that include Core are blocked
  until that unrelated line is corrected.

## Local Redis integration

- Native `redis-server` and `redis-cli` are not installed in this environment. Docker is
  intentionally not used for local development. Redis remains an optional, non-authoritative cache,
  so PostgreSQL-backed analytics implementation and verification continue without it.

## Provider currency cost

- The current Core/Meta status boundary exposes billable state and bounded pricing category, model,
  and type, but no authoritative currency amount or currency code. Campaign analytics now records
  the available pricing metadata and reports pricing-record counts. A numeric cost metric must wait
  for a source-of-truth amount from the provider payload or a Core billing/usage ledger; no value is
  inferred from billable state.

## Product reporting surfaces and internal control UI

- Analytics reporting requires a short-lived signed grant issued by Core or Tenant Platform. The
  current repository has no customer-facing Core/Tenant reporting gateway or approved rollout
  control-management surface, so direct browser access would bypass the intended authorization
  boundary. The reporting API and fixtures remain complete; the UI slices wait on those owning
  service routes.

## Source heartbeat scheduling

- Core Connections, Campaign, and Tenant manifests are transaction-coalesced at authoritative
  mutation/synchronization boundaries. Independent heartbeat schedules and domain checksums need
  domain-owned scheduler ownership and authoritative counters that are not present in the current
  services. No source is presented as historically complete because of this boundary.

## Operational ownership and full-stack E2E orchestration

- Native local PostgreSQL is now provisioned and used for isolated Core, Tenant, and Analytics
  mutation-to-reporting E2E fixtures. The remaining gap is a single safe command that provisions
  every Core, Agent, Tenant, and Analytics test database and runs the complete cross-service suite.
  The independent domain fixtures and their database migrations are no longer blocked.

## Meta deletion and rejected-record presentation

- Core has no authoritative Meta conversation/message deletion command, so deletion analytics cannot
  be inferred. Analytics stores bounded rejected counts and safe quarantine/quality evidence, but a
  richer customer-facing rejected-reason response needs an approved reporting shape before it can
  be exposed.
