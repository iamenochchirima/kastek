---
id: customer-analytics-value
title: Customer analytics value plan
status: Draft planning document
owner: Product, Core, and Analytics
last_updated: 2026-09-03
last_reviewed: 2026-09-29
---

# Customer analytics value plan

This document records product exploration and an implementation direction. It does not authorize
code, schema, metric-registry, deployment, or UI changes. When this direction is approved for
execution, create a scoped issue and link this document. Use a separate program plan only if the
work spans several dependent changes.

## Decision in one sentence

Customer analytics should help a user decide what to do next. Raw lifecycle counters, pipeline
health checks, and internal data-quality labels do not belong in the default customer view.

This document is a product and implementation plan only. It does not change the current UI or
metric registry by itself.

## Objective

Replace broad, event-oriented analytics panels with small, deliberate views that answer a specific
customer question for each product area.

Success means that a user can open a surface and quickly understand:

- what is working;
- what needs attention;
- what changed over the selected period; and
- which action or page will resolve the problem.

The system must remain honest. If the platform does not have enough evidence for a number, it must
show no number or a short data note. It must not turn an internal state into a customer KPI.

## Scope

### Included

- The customer-facing analytics panels on the workspace, Connections, Campaigns, agent detail,
  Inbox, Content analytics, and tenant portal surfaces.
- The relationship between the metric registry, report API, source state, coverage, and UI copy.
- A curated default metric set for each surface.
- Metric definitions, ownership, applicability, thresholds, actions, data quality, and privacy.
- Product analytics for measuring whether customers use and act on the reports.

### Excluded

- Replacing the existing Analytics ingestion, projection, authorization, or storage architecture.
- Deleting existing event contracts before their internal consumers are checked.
- Building a general business-intelligence editor in the first release.
- Showing operator observability, Collector output, database health, or raw provider diagnostics to
  customers.
- Claiming historical completeness where the source has not supplied it.

## Findings from the current implementation

The current registry contains 45 active metric definitions across five domains. The customer UI
requests many of them directly and then renders the first four populated metrics as summary cards.
That makes the cards depend on which metrics happen to have data, rather than on a stable product
decision.

| Surface | Current behavior | Product problem |
| --- | --- | --- |
| Workspace overview | Shows completed agent runs, campaign deliveries, connection health checks, messages received, and a few trends from `overview.summary@1`. | It mixes activity, delivery, support, and infrastructure-like counts. A health-check count does not tell a user whether a connection works. |
| Connections | Requests six metrics: lifecycle events, health checks, capability transitions, sync attempts, rate limits, and incidents. It displays populated metrics as cards and expandable rows. | Five of the six are implementation events. They do not answer which account is usable, which needs reconnection, or whether sync is healthy. |
| Campaigns | Requests eleven recipient, delay, retry, pricing, and delivery metrics. | Delivery outcome is useful. Pricing-recorded, retry, suppression, and blocked event counts are secondary details unless they lead to a clear action. |
| Agent detail | Requests eighteen to nineteen runtime, token, cost, tool, approval, effect, schedule, installation, version, readiness, conversation, and handoff metrics. | This is an operator report presented as a customer report. It is too wide and gives equal weight to runs, tokens, approvals, and internal lifecycle events. |
| Inbox and tenant portal | The tenant portal requests the entire `overview.summary@1` set and renders the first four cards plus all returned rows. The current client feature list includes five Inbox metrics. | The portal can show unrelated domains together, while the Inbox metrics do not yet center on open work, response time, resolution, or SLA risk. |
| Content analytics | Uses content and post-insight endpoints separately from the versioned Analytics registry. | The content report has useful business outcomes, but its status and freshness semantics are separate from the other analytics surfaces. |
| Analytics playground | Intentionally exposes the catalog and raw report controls. | This is useful for development and support, but it must stay separate from the normal customer experience. |

The recent `Not Instrumented` display was also a data-pipeline defect. Source manifests were not
materialized into source state. That defect is fixed, but the incident exposed a separate product
problem: even truthful event and coverage states can be poor customer-facing KPIs.

## What the Connections page should answer

The user is not asking, "How many health checks did Core run?" They are asking:

1. Which connected accounts can I use right now?
2. Which accounts need attention, and why?
3. Are provider synchronizations succeeding?
4. Which capabilities are ready for my agents, posts, or campaigns?

### Recommended first version

Use three stable summary cards, followed by a provider/account table.

| Proposed view | What it answers | Candidate data |
| --- | --- | --- |
| Ready connections | How many connected accounts are currently usable? | Latest authoritative connection and capability snapshot, grouped by provider. |
| Needs attention | What may block work now? | Current credential, webhook, permission, provider, or health state, with a remediation link. |
| Sync health | Is synchronization keeping up? | Successful sync rate over a short window plus the oldest or latest successful sync time. |

The table should show one row per connected account with provider, safe display name, current state,
last successful sync, capability summary, and one direct action. A failure timeline can appear when
an account has an unresolved customer-visible incident.

### Do not show by default

These can remain available to support and internal diagnostics, but should not be primary customer
analytics:

- connection creation and status-transition event totals;
- number of health checks;
- capability enablement transition totals;
- raw synchronization attempt totals;
- provider rate-limit encounter totals; and
- incident opening and recovery totals.

The existing event metrics may continue to feed audit, reconciliation, and internal operations. The
first customer release should remove them from the default Connections metric list, not delete their
contracts.

## Proposed customer metric policy by product area

### Workspace overview

Show only cross-product outcomes that help a workspace owner decide where to go next:

- messages received or conversations requiring attention;
- campaign delivery rate or failed recipients when campaigns exist;
- agent task success rate or completed tasks when agents exist; and
- connections needing attention.

Do not use `connection.health_checks` as an overview card. It measures system activity, not user
value. Hide a category when it has no applicable data instead of filling the space with a zero or
an internal status.

### Connections

Use the three-card model above. Keep detailed provider events behind an account detail or support
view. A connection page should favor current state and remediation over historical event volume.

### Campaigns

Default customer metrics should be:

- recipients sent or processed;
- delivery rate;
- failure rate or failed recipients; and
- read rate only when the provider and message type support it.

Show pending recipients, blocked recipients, suppression reasons, retries, and delivery delay in a
campaign detail view when they explain an unfinished or failed campaign. Show pricing only when
actual, provider-backed cost is available and the user has a budget or billing reason to see it.

### Agents

An agent owner usually needs:

- successful task or run rate;
- failed task or run rate with a failure breakdown;
- response time or completion time; and
- usage cost, only when the cost is measured and useful for the account.

Conversation response time, handoff rate, and user-visible outcomes can be added for customer-facing
agents. Token input/output, model-call counts, tool lifecycle events, approval lifecycle events,
effect lifecycle events, schedule lifecycle events, version lifecycle events, and definition
lifecycle events belong in an operations or developer view unless a product decision gives them a
clear user action.

### Inbox

The default view should focus on work and service quality:

- open or unassigned conversations;
- inbound conversation volume;
- first response time;
- resolution or handoff rate; and
- conversations outside the configured response target, when that target exists.

Conversation and message lifecycle totals can support drill-downs, but they should not compete with
open work and response quality.

### Content and social analytics

Keep post performance metrics such as reach, impressions, engagement, clicks, and video views in
the Content area. Normalize status wording and data-quality treatment with the versioned Analytics
reports, but do not force post insights into the Connections, Inbox, or Agent panels.

### Tenant workspace and client views

Tenant analytics should be role-specific. A workspace owner may need lead volume, client activity,
assignment workload, and conversion outcomes. A client should see only that client's outcomes.
Neither view should receive the complete `overview.summary@1` list by default.

## Metric acceptance rules

Every customer-visible metric must pass this review before it enters a default metric set.

- [ ] It answers a named customer question.
- [ ] It supports a decision or links to an action.
- [ ] Its object and grain are explicit, such as account, campaign, conversation, agent, or run.
- [ ] Its numerator, denominator, aggregation, and time semantics are unambiguous.
- [ ] Its source of truth is named. Current state must come from a current snapshot or authoritative
      projection, not be inferred from an event count when that would be misleading.
- [ ] Its applicability is explicit for provider, account mode, message type, agent type, or role.
- [ ] Its owner can explain what a missing, stale, partial, or failed value means.
- [ ] It has a useful comparison, threshold, or action. If none exists, it does not belong on the
      default surface.
- [ ] It has privacy and aggregation boundaries appropriate to the scope.
- [ ] It has enough evidence for the selected time range.
- [ ] It is named in customer language rather than implementation language.
- [ ] Its visual role is clear. It is a summary, trend, breakdown, status, or action list, not an
      arbitrary card added because the data exists.
- [ ] It includes the context needed to understand it, such as period, comparison, target,
      denominator, or applicable population.
- [ ] It is not repeating another metric or visual on the same surface.
- [ ] It looks deliberate and remains legible at supported desktop, tablet, and mobile widths.
- [ ] It leads to a decision, explanation, or action. Decorative charts and motion do not pass.

## Reporting and visual quality standard

Customer analytics should feel alive because the data tells a clear story, not because the page is
packed with animation or decorative charts. Every report should make the sequence below apparent:

1. What is this page about, and what scope and period does it cover?
2. What is the most important outcome or current state?
3. What changed, and does it need attention?
4. What explains the change?
5. What can the user inspect or do next?

A good default composition may include a prominent outcome with its comparison, a short trend, an
attention list with direct actions, and a ranked breakdown. It should not use a grid of equal-weight
cards where every number looks equally important. It should not show a chart without a clear
question, takeaway, or drill path.

Visual review is part of metric review. Before release, review each card, chart, table, badge, and
insight for usefulness, necessity, hierarchy, context, readability, and responsive behavior. If a
visual does not change what the user understands or does, remove it or move it to a detail or
diagnostic view.

## State and data-quality policy

Customer analytics needs three separate layers:

1. The value, such as a delivery rate or number of ready connections.
2. The interpretation, such as "Needs attention" with a reason and action.
3. The evidence note, such as "Data through 14:00" or "History available from 28 Aug".

The UI must not put internal pipeline labels such as `Not Instrumented`, `projection rebuilding`,
or `3/30 points` beside every customer number. Those states remain in the report contract and the
playground. The normal UI should map them to concise customer language only when the state affects
the decision:

| Internal condition | Customer treatment |
| --- | --- |
| No applicable source | Hide the metric or say "Not available for this account". |
| Source is configured but has no observations | Hide the empty card and show one page-level empty state if needed. |
| Recent source data with incomplete history | Show the value with a short history note, not a warning badge on every card. |
| Stale source for an actionable object | Show "Needs attention" and the action that can restore it. |
| Projection or reporting failure | Show "Analytics unavailable" with retry/support context. |

The report API should keep precise availability, freshness, coverage, and projection fields. The
customer components should consume those fields through a deliberate view model instead of printing
their raw values.

## Data model direction

The current event contracts are useful inputs, but they cannot answer every customer question.

- Keep event metrics for trends, audit, reconciliation, and internal diagnostics.
- Add snapshot or derived metrics for current connection readiness, open work, active agents, and
  other current-state questions.
- Use ratios for quality questions where the denominator is meaningful. A sync success count alone
  is less useful than success rate plus the last successful sync.
- Do not derive current active connections by counting historical connection-created events.
- Do not mark a 30-day report complete because one recent source manifest exists.
- Keep source state and coverage evidence authoritative in Analytics, while Core remains authoritative
  for current provider connection and capability state.
- Prefer additive registry changes and curated per-surface allowlists. Do not remove old contracts
  until internal consumers and support workflows are checked.

## Implementation phases

### Phase 0: product decisions and inventory

- [ ] Assign a product owner for each surface and a technical owner for each metric family.
- [ ] Confirm the primary user question and primary action for Workspace, Connections, Campaigns,
      Agents, Inbox, Content, and tenant views.
- [ ] Mark every existing metric as `customer_default`, `customer_detail`, `internal`, or
      `deprecated_candidate`.
- [ ] Record the source of truth, applicability, denominator, freshness expectation, and action for
      every proposed metric.
- [ ] Decide whether current-state metrics require a Core snapshot contract or can be derived from
      existing authoritative data.
- [ ] Keep the Analytics playground as the diagnostic view and exclude it from customer acceptance.

### Phase 1: Connections pilot

- [ ] Replace the six-event default list with the approved three-card Connections model.
- [ ] Add a stable provider/account table with safe identity, readiness, last sync, and remediation.
- [ ] Define the current-state and sync-health metric contracts before changing the registry.
- [ ] Map provider-specific unsupported capabilities to "Not available" with an explanation and
      remediation where possible.
- [ ] Keep rate limits and incident history in detail or support views.
- [ ] Add fixtures for ready, stale, unsupported, reconnect-required, and no-data accounts.
- [ ] Test that cards remain stable when one metric has no observations.

### Phase 2: Agent analytics

- [ ] Reduce the default agent view to run outcome, failure, response time, and optional cost.
- [ ] Move tool, approval, effect, schedule, installation, and version details behind an Operations
      or Developer section.
- [ ] Add a clear filter to one agent installation and one time range.
- [ ] Make failed runs actionable by linking failure class to the relevant run or configuration.
- [ ] Keep model and token details available only when the user has a cost or performance reason to
      inspect them.

### Phase 3: Campaigns, Inbox, and Content

- [ ] Define the default campaign outcome cards and move diagnostics into campaign detail.
- [ ] Define Inbox workload and response-quality metrics, including the handling of missing SLA
      configuration.
- [ ] Reconcile Content insight status wording with the shared customer analytics state policy.
- [ ] Ensure provider-specific metrics are hidden when the selected provider does not supply them.

### Phase 4: Workspace and tenant reports

- [ ] Replace the broad `overview.summary@1` customer default with role-specific curated sets.
- [ ] Give workspace and client views separate metric allowlists and authorization tests.
- [ ] Make the overview cards stable, contextual, and linked to the surface that can resolve an
      issue.
- [ ] Remove duplicate reports that show the same number with different semantics.

### Phase 5: Measurement and cleanup

- [ ] Add product analytics for report opened, detail expanded, remediation clicked, and filter
      changed, without recording customer content or provider credentials.
- [ ] Measure time to first useful action, remediation click-through, report load success, and the
      percentage of default cards with a clear action.
- [ ] Review whether customers understand each label through support feedback or a small usability
      test before expanding the metric set.
- [ ] Archive or demote metrics that fail the acceptance rules. Keep their contracts only when an
      internal consumer still needs them.

## Acceptance criteria for the first release

- [ ] Each customer surface has a documented purpose and owner.
- [ ] The default view has no raw lifecycle, health-check, rate-limit, or projection counters.
- [ ] Connections answers readiness, attention, sync health, and remediation within one screen.
- [ ] Empty or inapplicable metrics do not create blank cards or noisy badges.
- [ ] Internal data-quality states are not printed as customer KPI labels.
- [ ] Every displayed problem has a reason and an action, or the UI says that no action is available.
- [ ] Every default visual has a clear purpose, hierarchy, context, and drill path.
- [ ] The report communicates change and attention without relying on decorative animation or
      arbitrary chart variety.
- [ ] Cards, charts, tables, and action states remain deliberate and legible across supported
      desktop, tablet, and mobile widths.
- [ ] Metric values are stable across provider and data-availability differences.
- [ ] Scope authorization and client/workspace isolation have negative tests.
- [ ] The report remains usable on desktop and mobile widths.
- [ ] The release has tested data evidence for fresh, stale, partial, unsupported, and unavailable
      states.

## Release record

This plan follows `docs/internal/operations/release-process.md`. The release record will be
completed when implementation begins.

```text
Change: Curate customer analytics around decisions and actions
Owner: Product, Core, and Analytics
Risk: standard
Affected services and user surfaces: Analytics API, Core analytics gateway, client, tenant portal,
  Workspace, Connections, Campaigns, Agents, Inbox, and Content analytics
Platform release version or release ID: TBD at implementation
API/schema/migration changes: TBD after the Phase 0 source-of-truth decision; prefer additive
  registry and snapshot contracts
Feature flag or rollout method: TBD; use a guarded customer analytics view if both versions need
  to run during validation
Analytics events and success metrics: report_opened, detail_expanded, remediation_clicked, and
  report_filter_changed, with no content or credential fields; measure report success, useful-action
  rate, remediation click-through, and default-card action coverage
Logs, metrics, dashboards, and alerts: report request failures, latency, source freshness, and
  remediation outcomes with release and correlation identity; no raw customer content
User, API, internal, and operational documentation: update the customer analytics architecture,
  metric registry notes, user-facing analytics help, and support runbook
Validation evidence: unit, registry, authorization, database, component, responsive, and live
  smoke tests for the affected surfaces
Rollback or disable plan: disable the curated view or revert the per-surface allowlist while
  retaining existing event contracts and report storage
Post-release review date: TBD, within 14 days of production release
```

## Related documents

- [Customer analytics architecture](../../internal/architecture/customer-analytics.md)
- [Agent platform architecture audit](../../../AGENT_PLATFORM_ARCHITECTURE_AUDIT.md)
- [Analytics metric definitions](https://github.com/Kasitek-Labs/kasitek-labs/tree/main/services/analytics/metrics)
- [Feature and platform release process](../../internal/operations/release-process.md)
