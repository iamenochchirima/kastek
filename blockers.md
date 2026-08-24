# Analytics execution blockers

These items are recorded for follow-up only. They do not stop implementation of the remaining
analytics slices.

## Current worktree compile failure

- The current unrelated dirty credit-ledger work changes
  `server/kasitek-core/src/services/credits.rs` without updating its callers and row shape. A
  fresh `cargo test -p kasitek-core --lib` reports mismatched `reserve_credits` and
  `capture_credits` calls plus missing `ReservationRow.pricing_version` fields. These files are
  outside the Analytics UI slice and are intentionally unchanged.

## Provider currency cost

- The current Core/Meta status boundary exposes billable state and bounded pricing category, model,
  and type, but no authoritative currency amount or currency code. Campaign analytics now records
  the available pricing metadata and reports pricing-record counts. A numeric cost metric must wait
  for a source-of-truth amount from the provider payload or a Core billing/usage ledger; no value is
  inferred from billable state.

## Remaining product reporting surfaces and internal control UI

- UI-01 now provides authenticated Core and Tenant catalog/report gateways and an authenticated
  Analytics scope resolver. The remaining UI slices still need the shared frontend client, local
  playground, feature dashboards, tenant/client views, per-agent views, overview composition, and
  browser E2E. Direct browser access to Analytics remains intentionally unsupported.

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
