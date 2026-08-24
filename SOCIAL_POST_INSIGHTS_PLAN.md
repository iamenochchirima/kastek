# Per-Post Social Insights Plan

**Status:** Active — report filtering, coverage summaries, and persisted sync outcomes are in place; provider hardening and richer history presentation remain.

**Related planning template:** [PROJECT_PLAN.md](PROJECT_PLAN.md)

**Scope:** Organization-scoped performance data for content posts published through KasiTek's
connected social channels. This plan covers provider-reported per-post metrics, historical
snapshots, cross-platform reporting, and agent-readable reports.

## Objective

Allow the workspace and its agents to query the performance of as many published posts as each
provider permits, broken down by post and platform, without presenting unavailable metrics as zero.

For each published platform copy, support these normalized metric families when the provider
exposes them:

- Impressions and reach
- Likes and reactions
- Comments
- Shares and reposts
- Clicks
- Video views
- Historical change and growth over time

Success means that a user can ask an agent for a report such as “How are my posts doing this
month?” and receive per-post, per-platform results, coverage limitations, and the time each result
was last refreshed.

## Current implementation boundary

The current content system already has:

- `SocialPost` records and platform variants
- `SocialPublishJob` records per platform
- A provider `externalPostId` for published jobs
- Publication status and timestamps
- A content analytics page with local counts for published, scheduled, and failed posts
- WhatsApp campaign delivery/read analytics
- Platform capability flags that identify some providers as analytics-capable

The first implementation now has provider insight fetchers, metric snapshot storage, insight
routes, scheduled synchronization, a bounded manual refresh, and agent read capabilities. The
existing analytics service still mostly covers KasiTek agent, connection, campaign, and
conversation telemetry; it is not a substitute for provider-reported post performance.

## Scope

### Included

- Per-post and per-platform provider insight retrieval
- Bulk retrieval with provider pagination, batching, rate-limit handling, and bounded result sizes
- Historical observations so growth is calculated from snapshots rather than guessed
- A normalized metric contract with provider-specific extensions where necessary
- Freshness, coverage, permission, and unavailable-data states
- Organization and connection isolation
- Content analytics UI and post-detail presentation
- Read-only agent tools for individual posts and bounded cross-post reports
- Reconciliation, retries, backfill, audit, and deletion behavior

### Excluded from the first implementation

- Predictive performance scoring or recommendations presented as facts
- Automated publishing or content changes based only on metrics
- Scraping provider web pages
- Treating unsupported metrics as zero
- Exposing provider credentials or raw external account identifiers to agents
- A single provider-specific schema that prevents adding future platforms

## Metric contract

Each observation must identify:

- Internal organization ID
- Internal `SocialPost` ID
- Internal `SocialPublishJob` ID
- Provider/platform
- Connected account reference, kept inside the server boundary
- Provider post reference, kept inside the server boundary
- Metric key
- Numeric value, with an explicit integer/decimal type where required
- Provider metric definition or source field
- Observation time
- Provider reporting window, when the provider supplies one
- Fetch time and freshness state
- API version or adapter version
- Coverage and limitation codes

Metric values must distinguish:

- `available`: provider returned a value
- `unsupported`: this provider does not expose the metric
- `not_authorized`: the connected account lacks the required permission
- `not_found`: the provider post no longer exists or is inaccessible
- `temporarily_unavailable`: retryable provider/API failure
- `not_published`: no provider post exists yet

For growth, retain immutable or append-only observations and calculate:

- Absolute change from two observations
- Percentage change only when the denominator is meaningful
- Time-series points for a selected range
- A clear “not enough observations” state for new posts

Do not mix cumulative provider counters with window totals. Store the provider's counter/window
semantics and normalize only where the meaning is equivalent.

## Provider adapter design

Create a provider-neutral insight interface with one adapter per supported platform:

1. Resolve published `SocialPublishJob` records with a valid external post ID.
2. Group requests by provider and connected account.
3. Fetch the maximum safe page or batch size supported by that provider.
4. Follow provider pagination until the requested bound is reached.
5. Normalize returned fields into the common metric contract.
6. Preserve provider-specific fields in a versioned extension object.
7. Record rate limits, permission failures, missing posts, partial pages, and provider errors.

The initial adapter matrix must cover every current social platform—Facebook, Instagram, Threads,
TikTok, Bluesky, LinkedIn, and X—but each metric remains optional. Capability flags must only be
marked as supported after the adapter, permissions, and end-to-end tests exist for that provider.

## Storage and synchronization

Add a provider-observation model owned by the content/analytics boundary. It should support:

- Unique idempotency for `(publish job, metric key, provider window, observed at, adapter version)`
- Efficient lookup by organization, post, platform, metric, and time range
- Latest-value queries without losing historical observations
- Separate sync state for each connection/provider
- Retry scheduling and dead-letter/error details without blocking publishing
- Retention and deletion by organization and connected account

Use two complementary paths:

- Background sync for recently published posts and posts still receiving meaningful updates
- Bounded manual refresh for a post or report, returning the last known values if refresh is
  delayed or rate-limited

The sync worker must be independent of the publish worker. A provider insights outage must never
make a post publish fail.

## API and agent contract

Add organization-scoped read endpoints for:

- A single post's platform breakdown and time series
- A bounded list of posts filtered by platform, publication range, and post IDs
- A report aggregate containing totals, top posts, platform comparisons, freshness, and coverage

Add read-only agent capabilities, tentatively:

- `kasitek.core.content_post_insights` — one post, optionally limited to selected platforms and
  metrics
- `kasitek.core.content_posts_insights_report` — bounded cross-post report with date range,
  platform filters, metric filters, and pagination

The agent output must use internal post selectors and readable display names. It must not expose
raw provider post IDs, access tokens, account IDs, or provider payloads. The tool should report
“unavailable” or “not authorized” rather than infer a zero.

These are read-only capabilities, so they do not require approval. A manual refresh may be modeled
as a separate durable operation if it triggers provider calls, but returning cached insights must
remain safe and immediate.

## User interface

Extend Content Analytics with:

- Date range and platform filters
- Per-platform totals and coverage indicators
- A post performance table with sortable metrics
- A post detail view with platform tabs and historical charts
- Last refreshed time and refresh state
- Explicit unavailable/partial-data labels
- Pagination or virtualized loading for large post sets

The existing operational cards—published, scheduled, failed, and channel coverage—should remain
separate from provider performance metrics so the two meanings are not confused.

## Permissions and privacy

- Require the workspace analytics entitlement and organization membership.
- Check the connected account's provider scope before fetching insight fields.
- Keep provider tokens, raw payloads, and raw account/post IDs server-side.
- Enforce organization scope in every query and every background job.
- Audit manual refreshes and report access without storing message or post bodies in analytics
  facts unless already part of the authorized content record.
- Respect provider deletion, disconnection, and reauthorization events.

## Implementation checklist

### Phase 0 — Contract and provider verification

- [x] Inventory the current provider OAuth scopes and external post ID formats.
- [ ] Verify the provider endpoint, permissions, metric names, windows, pagination, and limits for
  Facebook, Instagram, Threads, TikTok, Bluesky, LinkedIn, and X.
- [ ] Produce the supported-metric matrix by provider and API version.
- [x] Define normalized metric keys, value types, counter/window semantics, and limitation codes.
- [ ] Decide the retention period and refresh cadence for new, recent, and older posts.

### Phase 1 — Data foundation

- [x] Add the provider insight observation migration and indexes.
- [x] Add sync state, retry scheduling, and classified error persistence; rate-limit-specific backoff remains provider work.
- [ ] Add organization and connection deletion/revocation cleanup.
- [x] Add typed Rust models and safe response DTOs.
- [ ] Add idempotency and organization-isolation tests.

### Phase 2 — Provider adapters

- [x] Add the provider-neutral insight adapter/error boundary.
- [x] Implement Facebook insights for published page content.
- [x] Implement Instagram media insights.
- [x] Implement Threads post insights where the connected account/API permits them.
- [x] Implement TikTok post/video insights where the connected API permits them.
- [x] Implement Bluesky post engagement queries and mark unsupported metrics explicitly.
- [x] Implement LinkedIn post/page analytics where the authorized product permissions permit them.
- [x] Implement X post public metrics and any authorized private metrics.
- [ ] Add pagination, batching, retry, backoff, rate-limit, and partial-result tests per adapter.

### Phase 3 — Sync and reconciliation

- [x] Add a background worker for recently published jobs.
- [ ] Add bounded backfill for historical published jobs.
- [x] Add manual refresh with cached fallback and visible freshness state.
- [ ] Reconcile provider-deleted, inaccessible, and reauthorized posts.
- [ ] Add worker metrics and operational alerts for stale or failing insight syncs.

### Phase 4 — Core APIs and agent tools

- [x] Add the single-post insights endpoint.
- [x] Add the bounded cross-post report endpoint.
- [x] Add capability discovery and scope checks for both read tools.
- [x] Register the two agent capabilities with manifests and redaction rules.
- [x] Add agent client routing, idempotency rules, and output-size limits.
- [x] Add tests for tool discovery and the expanded report contract; authorization, pagination, partial-data, and redaction fixtures remain.

### Phase 5 — Product UI

- [x] Add freshness/coverage state to Content Analytics.
- [x] Add per-post/per-platform metrics to post detail.
- [x] Add publication-range, platform, and metric filters plus report totals and coverage counts.
- [ ] Add time-series growth presentation with insufficient-data states.
- [ ] Add manual refresh and loading/error states.
- [ ] Verify responsive behavior for large tables and charts.

### Phase 6 — Verification and rollout

- [x] Run Rust formatting, linting, and targeted service tests.
- [x] Run agent type checks and capability contract tests.
- [x] Run client lint/type checks and production build.
- [ ] Test each provider with sandbox or fixture responses, including pagination and rate limits.
- [ ] Verify no credentials, raw provider IDs, or provider payloads reach agent responses.
- [ ] Release behind a feature flag and enable providers independently.
- [ ] Monitor freshness, coverage, provider errors, and query latency before broad rollout.

## Definition of done

- A published post can be selected by its KasiTek post identity and inspected per platform.
- Every returned metric has a value or an explicit availability/limitation state.
- Historical snapshots support trustworthy absolute and percentage growth calculations.
- Reports handle large post sets through bounded pagination and provider-safe batching.
- Agents can answer per-post and cross-post performance questions without revealing secrets or raw
  provider identifiers.
- Provider failures, missing permissions, and stale data are visible and never silently treated as
  zero.
- Publishing, channel messaging, and unrelated agent execution continue to work when insights are
  unavailable.

## Open decisions

| Topic | Decision or question | Status |
| --- | --- | --- |
| Retention | How long should per-post observations remain queryable? | Open |
| Refresh cadence | What cadence is acceptable for recent versus older posts? | Open |
| Provider scope | Which provider metrics are available under current app review/scopes? | Open |
| Manual refresh | Should refresh queue a job or wait synchronously for a bounded response? | Open |
| Cross-post ranking | Which metric and time window define “top post” by default? | Open |
| UI charts | Use the existing chart primitive or add a shared analytics chart component? | Open |

## Notes

This document is an implementation checklist, not a claim that provider analytics are currently
available. Provider support must be proven per platform and API version before the UI or agent
describes a metric as available.
