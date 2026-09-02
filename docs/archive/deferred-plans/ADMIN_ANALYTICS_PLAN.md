# Admin Analytics, Activity, and Reporting Plan

**Status:** Implementation complete for the committed Admin Analytics surface; runtime acceptance is
pending the concurrent Core observability/analytics changes compiling in the shared worktree.

**Owner:** Product and Engineering

**Last updated:** 2026-08-27

**Prerequisite:** [`ADMIN_UI_MIGRATION_CHECKLIST.md`](ADMIN_UI_MIGRATION_CHECKLIST.md)

Analytics implementation begins only after the Admin Vantage migration reaches its Definition of
Done. This plan defines the data, reporting, activity, and analytics work that follows the visual
foundation.

## Current implementation status

The committed Admin Analytics work now includes the Core aggregate gateway, Overview, Usage,
Revenue, Customers, Activity, Reports, Health, Data Quality, and Audit destinations; cursor-based
activity pagination; bounded CSV exports; saved report definitions; export audit records; and the
Admin navigation split. The Admin dashboard remains a compatibility redirect to `/analytics`.

The shared worktree currently contains unrelated, uncommitted Core changes from another agent.
Those changes prevent Core from compiling in the local stack: the observability instrumentation
references an out-of-scope `result` value, and the organization scope publisher call depends on a
function added only in that concurrent working tree. This plan does not modify or absorb those
changes. Core API, database, authenticated runtime, and end-to-end acceptance checks must run after
that work is reconciled.

## Release record — 2026-08-27

| Field | Decision |
| --- | --- |
| Change | Privileged Admin analytics, activity, reporting, and operations views |
| Owner | Product and Engineering |
| Risk | standard |
| Affected services and user surfaces | `kasitek-core`; Admin Overview, Analytics, Activity, Reports, and Operations routes; Admin database migrations |
| Platform release version or release ID | not applicable — no platform tag was created; implementation commits are `f891dc71`, `832a6e7f`, `76e0b3c0`, and `78db7c86` |
| API/schema/migration changes | Core Admin analytics/activity/report endpoints; saved-report and export-audit tables; additive migrations `20260826180000` and `20260826181000` |
| Feature flag or rollout method | not applicable — Admin-only routes are protected by Core authorization; release after authenticated staging checks |
| Analytics events and success metrics | Report export requests are audited; success is measured by authenticated endpoint correctness, export success/failure visibility, activity freshness, and no cross-organization leakage |
| Logs, metrics, dashboards, and alerts | Existing Core structured logs and audit records; no new production exporter or alert is introduced by this change; not applicable for new dashboards until Core runtime verification completes |
| User, API, internal, and operational documentation | This plan; route and response behavior is documented in the implementation files and must be promoted to the supported API docs if the endpoints become public outside Admin |
| Validation evidence | Admin TypeScript, lint, production build, and diff checks pass; isolated Rust validation is blocked by concurrent Core changes; authenticated runtime checks remain pending |
| Rollback or disable plan | Revert the Admin route/navigation commits and leave the additive tables in place; restore `/dashboard` implementation if required; do not remove migrations in the same release |
| Post-release review date | 2026-09-03, after staging runtime verification |

## Objective

Give KasiTek administrators a trustworthy view of platform growth, adoption, product usage,
revenue, customer activity, and system health. The Admin app must support both historical
analysis and near-real-time investigation without exposing raw customer content or requiring
large browser-side record fetches.

Success means an administrator can answer, from the Admin app:

- What is happening across the platform today and how does it compare with the previous period?
- Which products, plans, channels, and organizations are being used?
- Where are failures, payment problems, delivery problems, or adoption drop-offs occurring?
- What happened to a specific organization or platform resource, and when?
- Is the displayed data current, complete, and safe to act on?

This plan extends the customer analytics work in
[`ANALYTICS_PLAN.md`](ANALYTICS_PLAN.md) and does not replace it.

## Scope

### Included

- A privileged Admin analytics gateway over the existing Analytics reporting service.
- Platform-wide metric sets, comparisons, date ranges, breakdowns, and data-quality metadata.
- A separate chronological Admin activity feed with filters, drill-down links, and live updates.
- Billing and revenue reporting backed by authoritative subscription, invoice, Paystack, and
  credit records.
- A reports area for reusable report definitions and exports.
- Splitting the current overloaded Operations page into analytics, activity, health, recovery,
  and audit surfaces.
- Role-aware access, redaction, retention, reconciliation, and rollout verification.

### Excluded from the first release

- Direct browser access to the Core or Analytics databases.
- Arbitrary SQL for Admin users.
- Raw message bodies, prompts, attachments, provider payloads, credentials, or payment secrets.
- Replacing the existing customer analytics experience.
- Repricing credits, changing subscription rules, or redesigning Paystack checkout.
- Treating every metric as exactly real time when it is produced by a delayed projection.

## Current baseline and gap

The Admin app currently has no Analytics or Activity boundary in
[`client/apps/admin/src/components/admin/sidebar.tsx`](../../client/apps/admin/src/components/admin/sidebar.tsx).

- [`dashboard/page.tsx`](../../client/apps/admin/src/app/(dashboard)/dashboard/page.tsx) fetches
  complete lead and conversation lists and derives a few totals in the browser. It has no date
  range, comparison, trend series, subscription view, or platform usage view.
- [`operations/page.tsx`](../../client/apps/admin/src/app/(dashboard)/operations/page.tsx)
  combines agent runtime health, recovery commands, retention, webhooks, projection lag,
  notifications, and audit records into one large recovery console. It should remain useful, but
  it is not a product analytics dashboard.
- [`server/kasitek-core/src/api/admin.rs`](../../server/kasitek-core/src/api/admin.rs) exposes
  Admin CRUD, billing, and operations routes, but no Admin catalog, report query, activity query,
  or activity stream route.
- [`server/kasitek-core/src/controllers/admin.rs`](../../server/kasitek-core/src/controllers/admin.rs)
  only provides four basic statistics: users, admins, social posts, and WhatsApp campaigns.
- The Analytics service already has a versioned registry, report query API, previous-period
  comparisons, scope authorization, freshness, coverage, and generation metadata in
  [`server/kasitek-analytics/src/reporting.rs`](../../server/kasitek-analytics/src/reporting.rs).
- Core and Agent Platform already publish durable facts through transactional Analytics outboxes
  in [`server/kasitek-core/src/analytics/mod.rs`](../../server/kasitek-core/src/analytics/mod.rs),
  [`server/kasitek-core/src/workers/analytics_publisher.rs`](../../server/kasitek-core/src/workers/analytics_publisher.rs),
  and `agents/src/analytics`. This should be extended instead of creating an unrelated second
  metric pipeline.

The central gap is not the absence of all data. It is the absence of a privileged platform scope,
Admin metric definitions, a normalized cross-domain activity projection, and an Admin UI that
separates analysis from operational recovery.

## Target Admin information architecture

Keep existing business-management routes, but add clear top-level destinations:

| Area | Purpose | Initial routes |
| --- | --- | --- |
| Overview | Platform health at a glance: growth, active organizations, adoption, usage, revenue, and critical issues | `/dashboard` retained as alias; `/analytics` canonical |
| Analytics | Historical, comparable product and commercial analysis | `/analytics`, `/analytics/usage`, `/analytics/revenue`, `/analytics/customers` |
| Activity | Chronological cross-platform event investigation | `/activity` |
| Reports | Saved report configurations, exports, and later schedules | `/reports` |
| Operations | Live health and controlled recovery actions | `/operations/health`, `/operations/agents`, `/operations/data-quality`, `/operations/audit` |
| Commercial | Billing catalog, invoices, quotations, and payment administration | Existing routes retained |

The first navigation pass should show `Overview`, `Analytics`, `Activity`, `Reports`, and
`Operations` as the new platform section. Existing Leads, Conversations, Billing, Outreach,
Access, and Agencies remain available; they should link to relevant analytics or activity views
where useful.

### Overview layout

The overview should use one global filter bar:

- `7D`, `30D`, `90D`, `12M`, and custom range;
- UTC as the canonical aggregation timezone, with the displayed timezone explicit;
- compare previous period, off by default for uncluttered charts;
- product, plan, channel, and organization filters where the metric supports them;
- `Data as of`, coverage, and partial-data indicators on the page and on affected cards.

Recommended first-row metrics:

- Organizations: total, new, and active;
- Users: new and active;
- Activation rate, once the activation definition is approved;
- Active subscriptions and trial-to-paid conversion;
- Collected revenue or MRR, with the financial definition clearly labelled;
- Platform operations and failure rate;
- AI/provider cost and credit consumption as secondary operational metrics.

Recommended visual hierarchy:

- bar charts for daily counts and event volume;
- area/line charts only for continuous trend or comparison series;
- stacked bars for product/channel/plan mix;
- ranked tables for organizations, products, plans, and failure categories;
- no chart should render a row of indistinguishable zero dots when there is no data;
- cash values must be visually primary on revenue screens; credits are a supporting usage unit.

### Production chart standard

Charts are a first-class reporting surface. Every chart must be built from a registered metric
and a documented query, with the same care as a financial or operations report. Placeholder
charts, arbitrary dots, decorative gradients, misleading straight-line joins, and charts whose
labels do not explain the period or unit are not acceptable for release.

Each chart must provide:

- a meaningful title, short metric description, unit, aggregation, selected date range, timezone,
  and `data_as_of` timestamp;
- a real time scale with adaptive tick labels: daily dates for short ranges, readable multi-day or
  weekly labels for longer ranges, and month labels for annual ranges;
- a correctly scaled y-axis with human-readable values such as `1.2K`, `R 24.5K`, `100K credits`,
  or `82%`, including a visible zero baseline where zero has meaning;
- exact hover values, date/time, dimensions, and comparison values in a tooltip, plus a visible
  legend that can isolate or hide a series;
- an intentional chart type: vertical bars for discrete daily volume, stacked bars for mix,
  lines/areas for continuous trends, funnel steps for conversion, and tables when ranking or
  exact values matter more than shape;
- a clear previous-period treatment that is opt-in, visually subordinate, and never confused with
  the current period;
- peak/low or threshold annotations only when they convey a useful operational or business fact;
- links from a point, bar, segment, or table row to the matching filtered Activity, customer,
  billing, or Operations view;
- responsive behavior that preserves the data: charts reflow at desktop/tablet/mobile widths,
  retain usable touch targets, and never crush labels into unreadable text;
- accessible labels and summaries for keyboard and screen-reader users, with color never being the
  only difference between series.

Required first-release chart inventory:

| Surface | Charts |
| --- | --- |
| Platform overview | Daily active organizations/users, organization and user growth, product activity mix, revenue/collections trend, and a ranked organization activity table |
| Product usage | Daily operations by product, Agent run outcomes, conversation/message volume, campaign delivery funnel, connection health, and credits granted versus consumed |
| Revenue and billing | Collected revenue and refunds, active subscription movement, plan mix, payment outcome breakdown, and credit lifecycle movement |
| Customers | Organization lifecycle, activation funnel, active/inactive cohort trend, plan distribution, and top/bottom activity cohorts with sample-size context |
| Activity | Event volume by time and domain, severity/failure distribution, and the live chronological event stream |
| Operations | Run/failure trend, delivery failure trend, queue/projection lag, provider health, reconciliation backlog, and incident timeline |

The chart layer must support loading skeletons, no-data states, unavailable metrics, partial
coverage, stale projections, query errors, and large-value formatting without collapsing the
layout. A zero value must mean zero observed events; it must never be used to hide missing
instrumentation. Chart tests must assert both the data mapping and the rendered labels/ticks for
7D, 30D, 90D, 12M, and custom ranges.

## Analytics surface and metric contract

### Admin metric domains

Create Admin metric sets in the Analytics registry rather than hard-coding every card in React.
The first sets should be:

1. `admin.platform.overview@1`
   - organization and user growth;
   - active organizations/users;
   - activation funnel;
   - subscriptions, trials, churn/cancellations;
   - platform event volume and error volume.
2. `admin.product.usage@1`
   - Agent runs, outcomes, model calls, tokens, cost, tools, approvals, handoffs;
   - conversations, inbound/outbound messages, response and resolution measures;
   - campaign send, delivery, read, failure, block, and unsubscribe measures;
   - social/content publishing and connected-channel health;
   - public API and webhook volume where the source contract supports it.
3. `admin.revenue.billing@1`
   - active plans and plan mix;
   - paid invoices, collected amount, refunds, failed payments, PAST_DUE subscriptions;
   - Paystack checkout and webhook outcomes;
   - credits granted, consumed, reserved, expired, and manually adjusted.
4. `admin.customers@1`
   - organization/workspace lifecycle;
   - active and inactive organizations by plan/product;
   - customer or workspace activity ranking;
   - lead and conversation funnel where those records are in the Admin/Core boundary.
5. `admin.operations@1`
   - queue/run health, delivery failures, provider failures, projection lag, reconciliation,
     and alert counts. This complements the operator projections; it does not replace them.

Every metric must define its numerator, denominator, event-time semantics, dimensions, scope,
availability, freshness, coverage, privacy class, and comparison behavior. “Active” must mean a
meaningful product event, not merely a page load. Activation must be explicitly approved before
it appears as a KPI.

### Data-source policy

| Data | Preferred source | Admin use |
| --- | --- | --- |
| Product usage trends | Analytics facts and projections | Report queries, charts, comparisons, breakdowns |
| Organizations, users, memberships | Core authoritative tables plus lifecycle events | Current counts, growth, customer drill-down |
| Subscriptions, invoices, Paystack, credits | Core billing tables and billing events | Financial and credit reporting; exact current state |
| Agent health and recovery | Agent operator projections through Core | Operations and incident response |
| Admin/security actions | Core audit records | Audit/activity; never inferred from `updatedAt` |
| Delivery/webhook state | Delivery tables, event facts, and operator projections | Usage, failure analysis, and recovery |

The current Dashboard must stop downloading every lead and conversation merely to count them.
Use bounded aggregate endpoints/report queries for cards and paginated list endpoints only for
recent records or drill-downs.

## Activity and realtime design

Activity is different from analytics. Analytics answers “how many and how did it trend”; Activity
answers “what happened, to what, when, and with what outcome.”

### Activity event envelope

Reuse the approved Analytics event envelope and existing Core/Agent outboxes. Add missing event
contracts for platform events that are currently only represented by mutable state:

- organization, user, membership, access, and onboarding lifecycle;
- trial, subscription, checkout, invoice, payment, refund, and credit operations;
- agent, campaign, conversation, content, connection, API, webhook, and delivery outcomes;
- Admin actions, support access, recovery commands, feature flags, holds, and security events.

Each activity record should expose only safe indexed fields:

`event_id`, `occurred_at`, `ingested_at`, `source`, `domain`, `action`, `status`, `severity`,
`actor_type`, redacted `actor_id`, `organization_id`, `resource_type`, `resource_id`,
`correlation_id`, and validated safe metadata.

Product activity can be projected from Analytics facts. Admin/security audit records remain Core
authoritative. The Admin gateway may combine these sources into one cursor-paginated feed, but it
must preserve the source and audit semantics of each record.

### Live behavior

- Add `GET /api/admin/activity` with cursor pagination and filters for date, domain, action,
  status, severity, source, organization, resource, and correlation ID.
- Add a durable live stream such as `GET /api/admin/activity/stream` using SSE or the existing
  application realtime boundary after confirming its deployment support.
- Use a database-backed cursor/last-event-id for reconnect and backfill. Redis/pub-sub may reduce
  latency but must not be the source of truth.
- Target activity freshness of a few seconds where the source emits an event.
- Refresh KPI cards/charts on a short interval or on stream invalidation, but display the report's
  `data_as_of` and projection lag. Near-real-time activity must not be presented as exact realtime
  financial reporting.
- Provide pause live, new-event count, reconnect state, and a bounded initial window. Do not
  stream an unbounded high-cardinality feed into the browser.

## Reports

The first Reports release should be a controlled report builder over the registry:

- choose an approved metric set or metric;
- choose date range, interval, comparison, dimensions, and permitted filters;
- show availability, coverage, freshness, and data-as-of before export;
- save a report definition, not a materialized copy of sensitive data;
- export bounded CSV initially, with export action auditing;
- add scheduled email/report delivery only after saved reports and export controls are proven.

Report definitions must be versioned against the metric registry. If a metric changes, an old
saved report should remain interpretable or be marked for review; it must not silently change
meaning.

## Permissions and privacy

Create explicit Admin analytics permissions instead of treating `admin:read` as unlimited access.
The existing role model should be mapped as follows, subject to security approval:

| Role | Proposed access |
| --- | --- |
| viewer | Aggregate overview and approved product metrics; no raw customer content or unrestricted exports |
| support | Viewer access plus approved organization/customer activity under a support grant |
| operator | Operations health, activity, incidents, and recovery evidence; no financial administration by default |
| security | Audit, access, security activity, and data-quality evidence |
| admin / superadmin / owner | Full aggregate analytics, billing/revenue, reports, and approved exports |

Enforce authorization in Core before issuing a short-lived Analytics reporting grant. The browser
must never receive Analytics private keys, ingestion credentials, or direct database credentials.
All report exports, support access, sensitive drill-downs, and recovery actions must be audited.

## Implementation checklist

### Phase 0 — Definitions and inventory

- [ ] Approve the navigation names and route compatibility plan.
- [ ] Define active organization, active user, activation, churn, trial conversion, MRR, gross
      collected, refund, and failure-rate semantics.
- [ ] Produce a source-to-metric matrix for Core, Agent Platform, Tenant Platform, and providers.
- [ ] Mark each metric as exact, partial, unavailable, or current-state-only.
- [ ] Define role/permission rules for aggregates, customer drill-downs, exports, and finance.
- [ ] Decide whether the first platform scope includes Tenant Platform descendants or starts with
      Core organizations and adds tenant scope after cross-service reconciliation.

### Phase 1 — Admin reporting boundary

- [ ] Add an Admin-only reporting scope (for example `core_platform` or `platform_admin`) to the
      Analytics scope hierarchy.
- [ ] Add Admin reporting permissions and validate them in both Core and Analytics.
- [ ] Add Core Admin catalog/query endpoints that issue short-lived service grants and proxy to
      Analytics.
- [ ] Add transactional aggregate endpoints for exact billing/current-state values that do not
      belong in delayed Analytics projections.
- [ ] Add request limits, query budgets, correlation IDs, and consistent error envelopes.
- [ ] Add cross-scope isolation and role tests before exposing the UI.

### Phase 2 — Platform overview

- [ ] Replace browser-derived Dashboard totals with bounded Admin aggregate/report queries.
- [ ] Add the shared date-range, comparison, filter, loading, partial-data, and error states.
- [ ] Implement overview KPI cards with current value, previous-period delta, and data-as-of.
- [ ] Add production-grade daily activity bars, growth/adoption trends, product mix, revenue
      trend, and top organizations tables with real axes, units, tooltips, legends, comparisons,
      responsive behavior, and drill-down links.
- [ ] Make cash/revenue primary on billing cards and keep credits as a separate usage measure.
- [ ] Add links from every card/table to the matching Analytics, Activity, Billing, or Operations
      detail view.

### Phase 3 — Product and commercial analytics

- [ ] Implement Product Usage tabs for Agents, Conversations, Campaigns, Connections, Content,
      API/Webhooks, and Credits.
- [ ] Implement the complete chart inventory for each usage domain using registered metrics and
      truthful coverage/freshness metadata.
- [ ] Implement Revenue/Billing analytics from subscription, invoice, Paystack, and credit data.
- [ ] Make revenue charts amount-first, with currency, payment state, refund treatment, and
      previous-period comparison clearly visible.
- [ ] Add plan/product/channel/organization breakdowns where dimensions are available.
- [ ] Reconcile report totals against authoritative Core tables for a fixed test period.
- [ ] Add clear “not instrumented” and “partial coverage” states instead of zero-filling missing
      domains.

### Phase 4 — Activity feed and live updates

- [ ] Catalogue existing immutable event tables and existing Analytics contracts.
- [ ] Add missing lifecycle events at the transaction boundary, using the existing outbox pattern.
- [ ] Add the normalized activity projection, retention policy, indexes, and safe metadata schema.
- [ ] Implement cursor-paginated activity query and organization/resource drill-down links.
- [ ] Implement SSE/realtime delivery with reconnect, backfill, deduplication, and permission
      checks.
- [ ] Add pause-live, unread/new-event state, filters, severity, source, and correlation search.
- [ ] Keep operator notifications and recovery commands linked from Activity rather than mixing
      their controls into the analytics charts.

### Phase 5 — Reports and exports

- [ ] Implement approved metric-set report builder.
- [ ] Persist versioned saved report definitions.
- [ ] Add bounded CSV export with progress/loading state and audit record.
- [ ] Add export authorization, redaction, retention, and failure handling.
- [ ] Decide and implement scheduled reports only after the first export flow is reliable.

### Phase 6 — Operations restructuring

- [ ] Split the current Operations page into Health, Agent Operations/Recovery, Data Quality, and
      Audit.
- [ ] Move projection lag, coverage, freshness, reconciliation, and publisher state into Data
      Quality.
- [ ] Keep kill switches, holds, feature flags, replay, retention, support grants, and recovery
      commands in Agent Operations/Recovery.
- [ ] Keep security/access records in Audit and link relevant events into the Activity feed.
- [ ] Preserve existing command approval, expected-version checks, and redaction behavior.

### Phase 7 — Rollout and hardening

- [ ] Backfill only what can be reconstructed truthfully; label historical gaps and effective
      dates.
- [ ] Run dual-read comparisons between old Admin totals and new aggregate queries where the old
      totals are meaningful.
- [ ] Test duplicate, late, out-of-order, and replayed events.
- [ ] Test payment success/failure/refund, subscription state changes, credit grant/debit/expiry,
      agent runs, messages, campaign deliveries, connection failures, and Admin actions.
- [ ] Test viewer/support/operator/security/admin access separately, including support-grant
      expiry and revocation.
- [ ] Test stream reconnect, cursor resume, duplicate delivery, projection lag, unavailable
      source, and partial coverage.
- [ ] Verify no raw customer content, provider secrets, or payment secrets enter event payloads,
      logs, reports, or exports.
- [ ] Run TypeScript, lint, Rust tests, database tests, production builds, and responsive runtime
      checks at desktop, tablet, and mobile widths.
- [ ] Release behind an Admin feature flag and monitor query latency, stream lag, event backlog,
      reconciliation mismatches, and export failures.

## Verification gates

### Backend and data

- [ ] Every metric has a tested formula and authoritative source.
- [ ] Every report response returns range, timezone, generated-at, data-as-of, coverage, and
      projection version.
- [ ] Cross-organization aggregate authorization is tested; no customer grant can access the
      platform scope.
- [ ] Outbox writes are transactionally coupled to the mutation they describe.
- [ ] Event IDs are idempotent and duplicate deliveries do not duplicate rollups or activity.
- [ ] Late events follow the documented late-data window and reconciliation path.
- [ ] Current-state values and delayed analytical values are clearly distinguished.

### Admin UI

- [ ] No analytics page downloads an unbounded lead, conversation, event, or organization list.
- [ ] Every chart is backed by a registered metric and documented source; no placeholder or
      decorative chart ships.
- [ ] Every chart has a correct time axis, adaptive date labels, y-axis units, exact tooltips,
      legends, accessible summaries, and a useful empty/partial/stale state.
- [ ] Date labels and intervals are readable at 7D, 30D, 90D, 12M, and custom ranges.
- [ ] Bar charts are used for daily counts; comparisons are opt-in and visually subordinate.
- [ ] Charts are visually reviewed at desktop, tablet, and mobile widths, including long labels,
      large values, multiple series, and no-data periods.
- [ ] Loading, empty, unavailable, partial, stale, and error states are distinct.
- [ ] Activity supports filtering, pagination, pause-live, reconnect, and drill-down without
      losing the selected range or filters.
- [ ] Billing screens show currency and amount as the primary financial signal.
- [ ] Tables, charts, filters, and the Admin sidebar have intentional mobile behavior.

### Operational acceptance

- [ ] A real platform event appears in Activity within the agreed freshness target.
- [ ] The corresponding historical aggregate updates within the stated projection SLA.
- [ ] A failed payment, payment recovery, webhook replay, and credit adjustment are visible in
      the correct analytics and activity surfaces.
- [ ] An operator can move from a chart anomaly to the relevant activity records and then to the
      existing recovery console without exposing protected payloads.
- [ ] Admin analytics remains usable when one source is delayed or unavailable.

## Decisions and open questions

| Topic | Recommended starting decision | Status |
| --- | --- | --- |
| Canonical platform scope | Add a dedicated privileged platform scope; do not use a customer organization grant with descendant mode | Open |
| Historical source | Analytics projections for trends; Core tables for exact current billing state | Open |
| Activity source | Existing outboxes/contracts plus Core audit facade; no second generic browser event bus | Open |
| Activity freshness | A few seconds when emitted; show `data_as_of` and projection lag everywhere else | Open |
| Default range | 30 days, daily bars, previous-period comparison off | Open |
| Revenue definition | Decide gross collected, net collected, MRR, refunds, and currency treatment before KPI launch | Open |
| Activation definition | Product decision required; do not infer it from login or page views | Open |
| Tenant Platform inclusion | Start with sources that have verified scope/reconciliation support, then expand | Open |
| Saved/scheduled reports | Saved definitions and CSV first; scheduled delivery later | Open |
| Live transport | Use SSE if deployment support is confirmed; retain cursor query as mandatory fallback | Open |

## Notes

This plan is intentionally staged. The first deliverable should be a reliable Admin reporting
boundary and a clean Platform Overview. Product Usage, Activity, Reports, and the Operations split
can then share the same metric catalog and data-quality language without recreating the overloaded
customer Billing and Usage page inside Admin.
