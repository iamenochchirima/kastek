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
