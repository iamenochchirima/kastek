# Analytics information architecture research

**Status:** Research note

**Owner:** Product and analytics

**Research date:** 2026-09-05

**Last reviewed:** 2026-09-29

This note investigates how customer-facing SaaS analytics are commonly organized across overview
dashboards, section pages, detail views, and operator diagnostics. It is a planning input only. It
does not authorize code, schema, registry, API, or UI changes.

The research uses first-party product documentation and design guidance where possible. Source
findings are separated from Kasitek-specific recommendations. Any statement marked **Inference**
is a conclusion for Kasitek, not a direct claim made by a source.

## Executive finding

Kasitek should have one overall entry point, but it should not have one giant analytics page.

The useful structure is a layered model:

```text
Workspace overview
  current outcome and exceptions
        |
        +--> Section analytics
        |      Connections, Agents, Campaigns, Inbox, Content
        |
        +--> Entity detail
        |      one connection, agent, campaign, conversation, or post
        |
        +--> Operator diagnostics
               freshness, ingestion, projections, provider errors, instrumentation
```

The overview answers, "What needs my attention and is the system producing value?" Section pages
answer, "How is this part of the product performing and what should I do next?" Detail views answer,
"Why did this specific item succeed or fail?" Operator diagnostics answer, "Is the platform itself
healthy?"

Those are different questions. Combining them creates the exact problem Kasitek is seeing now:
implementation counters appear beside customer outcomes and ask the user to interpret internal
system state.

## What the sources say

### 1. An overview dashboard is a summary, not the whole analytics system

Microsoft's Power BI guidance describes a dashboard as a single place to monitor the current state,
with detailed information kept in underlying reports. It recommends choosing metrics based on the
audience's decisions, removing non-essential information, and keeping the important story on one
screen. See [Tips for designing a great Power BI dashboard](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips).

Power BI also makes the distinction explicit: dashboards are one page and reports can have multiple
pages, with reports providing filtering and slicing that dashboards do not. See [Dashboards for
business users](https://learn.microsoft.com/en-us/power-bi/explore-reports/end-user-dashboards).

**Inference for Kasitek.** A workspace overview should be a compact decision surface. It should not
be the place where every product area publishes its complete metric inventory. The overview can link
to section analytics and detail views without duplicating them.

### 2. Section analytics should follow the user's job in that section

Intercom organizes reporting around operational domains such as conversations, responsiveness,
SLAs, team inbox performance, teammate performance, and AI-agent performance. It provides templates
for these areas instead of presenting every chart in one default view. Reports can then be
customized, filtered, inspected, and drilled into. See [Intercom reports
explained](https://www.intercom.com/help/en/articles/200-intercom-reports-explained).

GitLab exposes analytics at multiple scopes and provides separate dashboards for value streams,
DORA metrics, merge request analytics, usage trends, and other concerns. Its Value Streams Dashboard
combines a small set of organization-level panels, then lets users drill into projects or metrics.
See [Analyze GitLab usage](https://docs.gitlab.com/user/analytics/) and [Value Streams
Dashboard](https://docs.gitlab.com/user/analytics/value_streams_dashboard/).

**Inference for Kasitek.** Each Kasitek section should own a small set of metrics tied to the work a
user performs there. A Connections view should help a user get channels ready and keep them usable. A
Campaigns view should help a user understand delivery and outcome. An Agents view should help a user
understand task completion and intervention. The section should not repeat unrelated workspace or
operator metrics.

### 3. Detail views are where deeper analysis belongs

Power BI's drillthrough guidance describes a deliberate flow: start with a summary, identify a
visual element, drill into supporting transaction-level detail, then return to the source page. The
detail page can also provide a broader view when the starting point is a narrow segment. See [Use
report page drillthrough](https://learn.microsoft.com/en-us/power-bi/guidance/report-drillthrough).

Shopify follows a similar pattern. Its overview cards show selected performance metrics, and the card
title opens the corresponding report for more detail. It also hides metrics that do not apply to the
store's enabled channels. See [Using the Analytics overview
dashboard](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard/using-the-overview-dashboard).

Stripe separates account operations from reporting and product-specific analytics. Its Dashboard
handles account resources and current operations, while Reporting provides historical, filterable,
exportable, accounting-grade views. See [Stripe Dashboard basics](https://docs.stripe.com/dashboard/basics?locale=en-GB)
and [Stripe reporting](https://docs.stripe.com/stripe-reports).

**Inference for Kasitek.** Every prominent customer-facing metric should have a sensible next view.
That might be a filtered list, a timeline, an event explanation, or an action such as reconnect,
retry, review, or publish. A metric with no useful drill path is a candidate for removal or for an
operator-only view.

### 4. Operator diagnostics should be a separate audience and surface

Datadog distinguishes dashboards used as status boards and dashboards used for troubleshooting,
correlation, and data exploration. Its dashboard documentation describes real-time system health,
anomaly detection, issue prioritization, and root-cause diagnosis as monitoring use cases. See
[Datadog dashboards](https://docs.datadoghq.com/dashboards/).

Power BI similarly recommends using drillthrough pages and tooltips for additional detail instead of
putting every detail on the main page. Its optimization guidance also recommends limiting visuals and
using drillthrough pages to avoid jamming a report page with detail. See [Power BI optimization
guide](https://learn.microsoft.com/en-us/power-bi/guidance/power-bi-optimization).

**Inference for Kasitek.** Counts such as projection points, manifest coverage, source-state rows,
registry completeness, ingestion attempts, job leases, raw event totals, and instrumentation status
belong in an internal diagnostics area. They may explain why a customer metric is unavailable, but
they are not customer KPIs. The customer may see a concise state such as "Data delayed" with a useful
next step, while an operator can inspect the exact cause elsewhere.

### 5. Metric selection should start with value and decisions

Amplitude's North Star framework defines a North Star Metric as a measure of the value customers get
from a product and recommends connecting it to input metrics that teams can influence. It also
recommends one North Star per product in a simple product and customer context. See [The North Star
Playbook](https://amplitude.com/blog/introducing-north-star-playbook) and the [North Star Playbook
PDF](https://info.amplitude.com/rs/138-CDN-550/images/Amplitude-The-North-Star-Playbook.pdf).

Mixpanel's guidance defines vanity metrics as numbers that do not drive a decision or connect to user
value. Its suggested tests ask who owns the metric, what action follows a change, whether it connects
to user value, and what context or counter-metric is required. See [What are vanity metrics?](https://mixpanel.com/blog/vanity-metrics/).

Amplitude also describes the risk of inconsistent metric definitions across charts, dashboards, and
experiments, and recommends shared definitions, reuse, official status, and change history. See
[Metrics reimagined](https://amplitude.com/blog/platform-metrics-launch).

**Inference for Kasitek.** A customer-facing KPI should pass all of these tests:

1. It describes a customer or business outcome, or a leading input with a known relationship to that
   outcome.
2. A user can make a different decision when it changes.
3. The responsible user or team is clear.
4. The time window, population, scope, and comparison are visible.
5. The metric has a defined source, freshness expectation, and known limitations.
6. A supporting detail or action exists.

Raw volume, internal lifecycle events, and implementation coverage can remain useful evidence for
engineering, but they should not become default customer KPIs merely because they are available.

### 6. Progressive disclosure beats a dense default page

The GOV.UK design guidance says dashboards are for high-level indicators, not detailed insights. It
warns that dashboards can leave interpretation to users, become outdated, and overwhelm people when
the hierarchy is weak. It recommends a clear structure and concise explanations. See [Dashboards](https://brand.design-system.service.gov.uk/data/dashboards/)
and [Data visualisation principles](https://brand.design-system.service.gov.uk/data/).

The GOV.UK Details component gives a concrete progressive-disclosure pattern: let users reveal
additional detail only when they need it. See [Details](https://design-system.service.gov.uk/components/details/).

IBM Carbon's data table guidance uses expandable rows to disclose more information while keeping a
large set of resources scannable. See [Carbon data table usage](https://carbondesignsystem.com/components/data-table/usage/).

**Inference for Kasitek.** Default views should show the decision-relevant summary. Definitions,
methodology, source coverage, and technical evidence should be available through an info affordance,
expanded row, drill-in, or detail route. They should not occupy the same visual weight as the answer
the user came to get.

### 7. Freshness and applicability are part of the metric, not decoration

Google's Looker Studio documentation treats data freshness as an explicit source property. Refresh
rates vary by connector, cached results are served within a freshness threshold, and reports should
make the last refresh meaningful. See [Manage data freshness](https://docs.cloud.google.com/data-studio/manage-data-freshness).

Shopify displays warning or critical indicators when data is incomplete, a definition has changed,
or a data delay is known. It also omits channel metrics when the relevant channel is not used. See
[Using the Analytics overview dashboard](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard/using-the-overview-dashboard).

Intercom documents that a report containing multiple datasets can show the slowest dataset's sync
time. The timestamp is therefore a property of the report's evidence, not merely a page decoration.
See [Create a custom report](https://www.intercom.com/help/en/articles/4549035-create-a-custom-report).

**Inference for Kasitek.** Every customer metric should have an explicit display state:

| State | Meaning | Customer treatment |
| --- | --- | --- |
| Available | Evidence meets the metric's freshness and coverage rules | Show the value and period |
| Fresh but partial | The latest data is current, but historical coverage is incomplete | Show the value with a short coverage note; do not imply a full period |
| Delayed | The source or projection is older than the metric allows | Show the last known time and a useful recovery or wait state |
| No data yet | The feature has no eligible records | Explain what event creates the first value, if needed |
| Not applicable | The workspace or account does not use the relevant capability | Hide the metric or explain why it does not apply |
| Failed | The system attempted to compute or collect the metric and could not | Show a clear error state and an action, not zero |
| Restricted | The viewer lacks permission for the underlying data | Omit the metric or show a permission-safe summary |

The UI should not present `0`, `Not Instrumented`, `projection rebuilding`, or a partial coverage
fraction as if each were an ordinary customer outcome. Those values can be accurate and still be
the wrong default language.

### 8. Scope and permissions should shape the view

GitLab provides analytics at instance, group, and project levels, with different features and
permissions at each scope. See [Analyze GitLab usage](https://docs.gitlab.com/user/analytics/) and
[GitLab permissions](https://docs.gitlab.com/user/permissions/).

Intercom separates workspace reporting permissions from report-level access and distinguishes full
access, explore-only, and view-only access. See [Report sharing and access controls](https://www.intercom.com/help/en/articles/9867813-report-sharing-and-access-controls).

Datadog uses managed and custom roles, with separate read and write permissions for dashboards and
granular access controls for individual resources. See [Datadog role permissions](https://docs.datadoghq.com/account_management/rbac/permissions/)
and [Granular access control](https://docs.datadoghq.com/account_management/rbac/granular_access/).

**Inference for Kasitek.** Scope and role should affect the default view, not the meaning of a metric.
An owner may need workspace outcomes and spend. A channel operator may need connection state and
delivery issues. A support user may need inbox workload. An engineer may need diagnostics. These
views should share a metric definition and authorization boundary, while selecting different default
cards and actions.

## Recommended information architecture for Kasitek

This section is a Kasitek recommendation based on the source findings and the current analytics
planning material. It is not a description of an implemented design.

### Workspace overview

The workspace overview should answer four questions without requiring the user to interpret backend
state:

1. What produced value during the selected period?
2. What needs attention now?
3. Which major area is falling behind or unavailable?
4. Where should I go next?

Candidate content, subject to product validation:

- a small set of outcome or outcome-proxy cards for the workspace's active product areas;
- an attention queue such as failed runs, disconnected channels, blocked approvals, or content that
  needs review;
- a compact health summary for agents, connections, campaigns, and inbox, only when that area is
  enabled and has trustworthy evidence;
- one trend or comparison where it changes a decision;
- direct links to the relevant section or detail view.

**Inference.** Kasitek should start with no more than a handful of default overview cards and should
prefer an attention queue over a wall of counts. The exact number should come from user testing and
screen constraints, not a universal dashboard rule.

### Section analytics

Each section should have a consistent shell:

```text
Section purpose and scope
  period, comparison, account/workspace filter
  primary outcome or current state
  trend or comparison
  attention items
  item-level table or ranked list
  drill-in and next action
```

Candidate section questions:

| Section | The page should help answer | Better default evidence | Keep out of the customer default |
| --- | --- | --- | --- |
| Connections | Which channels are ready, degraded, or need action? | Ready connections, needs attention, sync freshness, usable capabilities, last successful sync | Lifecycle event totals, capability transition counts, projection coverage, raw sync attempts |
| Agents | Are agents completing useful work reliably? | Completed runs, user-visible failures, intervention rate, response time where defined, outcome trend | Prompt token totals, internal node counts, trace volume, worker lease state |
| Campaigns | Did the campaign deliver and produce the intended response? | Delivery, audience reached, engagement or conversion when measured, failed items, next action | Queue depth, raw webhook counts, internal retry totals |
| Inbox | What requires a response and how is service quality changing? | Open workload, age or SLA risk, response and resolution measures, assigned ownership | Event ingestion counts, projection jobs, raw message receipt counts |
| Content and social | What was published and what should happen next? | Published, failed, engagement or downstream outcome where supported, channel-specific limits | Provider API request totals, internal serialization errors, unsupported capability inventory |

These are candidate questions, not final KPI definitions. Each section needs a metric contract before
implementation.

### Entity detail

Entity detail should explain one item and lead to an action. Examples include:

- one connection: provider, account identity, current authorization, capabilities, last successful
  sync, recent failures, reconnect or reauthorize action;
- one agent: version, installed capabilities, recent runs, failure reason, pending approval, retry or
  configuration action;
- one campaign: status, audience, delivery timeline, outcome, failed items, duplicate or retry state;
- one conversation: current owner, response timeline, SLA state, tool or provider failure, retry or
  handoff action.

The detail view may expose more evidence than the overview, but it should still distinguish customer
state from technical diagnosis. A raw event timeline is useful when it explains a failure; it is not a
replacement for a clear current state.

### Operator diagnostics

Operator diagnostics should be accessible to the people responsible for keeping the product working.
It can contain:

- ingestion and projection freshness;
- source coverage and backfill status;
- metric registry and definition versions;
- job attempts, leases, retries, and dead letters;
- provider error classes and rate limits;
- instrumentation gaps and collection failures;
- query latency, cost, and cache behavior;
- tenant isolation and authorization checks.

This area should support diagnosis and remediation. It should not leak implementation vocabulary into
the customer analytics pages simply because the same data powers both views.

## One overall dashboard or one per section?

The answer is both, with different responsibilities.

| Layer | Job | Default amount of information | Navigation |
| --- | --- | --- | --- |
| Workspace overview | Orient and prioritize | Small, stable, outcome and exception focused | Links to sections and urgent items |
| Section analytics | Manage one product area | A focused set of metrics, filters, trends, and item lists | Links to entity detail and actions |
| Entity detail | Explain and resolve one item | Full context for one entity and its recent history | Links back to the source section |
| Operator diagnostics | Maintain the platform | Broad technical evidence, search, logs, and run state | Restricted route or admin surface |

A single overall page is useful as a landing page and shared vocabulary. It is not a substitute for
section analytics. Per-section pages are useful because the user questions, data windows, actions,
and applicable metrics differ. Detail pages and diagnostics prevent the overview from becoming a
technical dump.

## Metric design rules for Kasitek

Before a metric is promoted to a default customer view, record:

| Field | Required decision |
| --- | --- |
| User question | What decision or question does this answer? |
| Outcome relationship | What customer or business value does it represent, or which known input affects that value? |
| Owner | Who can act when the metric changes? |
| Scope | Workspace, tenant, agent, connection, campaign, conversation, or provider account |
| Population | Which records count, and which are excluded? |
| Time window | Current state, rolling period, calendar period, or event timeline |
| Comparison | Previous period, target, baseline, peer group, or none |
| Definition | Formula and plain-language explanation |
| Source | Authoritative data source and joins |
| Freshness | Expected update time and stale threshold |
| Coverage | Minimum evidence needed to show a value or trend |
| Applicability | Which plans, channels, capabilities, and states make it relevant |
| Failure state | What the user sees when computation or collection fails |
| Next action | The route or operation that helps the user respond |
| Permission | Who may view, explore, export, or administer it |

The metric registry should distinguish at least these classes:

- **Outcome:** the result the customer cares about, such as completed work or successful delivery.
- **Leading input:** an activity known to influence an outcome, such as a configured connection or
  completed approval.
- **Guardrail:** a quality or safety measure that prevents optimizing one number at the expense of
  another.
- **Diagnostic:** evidence used to explain platform behavior.
- **Exploratory:** a measure under investigation that is not promoted to a default KPI.

Only the first three classes should normally appear in customer-facing defaults. Diagnostic and
exploratory metrics need explicit placement and labels.

## Visual and narrative quality standard

Useful data can still make a bad report. Every card, chart, table, badge, and insight must earn its
space twice: first by answering a real question, then by making the answer easy to see.

Before showing a visual, ask:

- Is it useful for the person on this page?
- Is it necessary, or is it repeating another element?
- Does it look clear and intentional at the supported screen sizes?
- Does it show enough context to interpret the number, such as period, comparison, target, or
  applicable population?
- Does it lead to a decision, explanation, or action?

Reports should feel alive through meaning, not decoration. A strong report can combine:

- one prominent outcome with its period and change;
- a short trend that makes movement visible;
- an attention list that names the problem and opens the fix;
- a ranked table or breakdown that explains what is driving the change; and
- progressive detail for users who need to investigate further.

Avoid a wall of equal-sized cards, charts without a takeaway, decorative animation, arbitrary chart
variety, and color used as decoration instead of status. A visual that looks attractive but does
not change what the user understands or does should be removed.

Each report should have a clear reading order:

1. The page purpose and scope.
2. The most important outcome or current state.
3. What changed and whether it needs attention.
4. The reason or breakdown.
5. The detail and action path.

This quality bar applies to the workspace overview, section reports, entity detail, and operator
views. The amount of detail changes by audience, but the standard does not.

## Empty, stale, partial, and inapplicable data

Analytics should treat data state as part of the product contract. The system should never turn an
unknown value into a reassuring zero.

Recommended rules:

- `No data yet` means the metric has no eligible records. Explain the first event that would create
  data only when the user needs that information.
- `Not applicable` means the capability or channel is not enabled for this scope. Hide the metric when
  its absence is obvious, or explain the dependency when it affects setup.
- `Delayed` means a known freshness threshold has been exceeded. Show the last successful update and
  the likely recovery action.
- `Partial` means the value is valid for the evidence available but not for the requested history.
  State the covered period instead of presenting a full-period comparison.
- `Failed` means collection or computation failed. Show the failure and an action. Do not show zero.
- `Restricted` means the data exists but the viewer cannot access it. Avoid leaking counts or
  identities.

The default visual language should use plain customer terms. Technical labels such as `Not
Instrumented`, `projection rebuilding`, `source summary`, or `registry coverage` belong in the
diagnostic explanation, not the headline card.

## Current Kasitek analytics inventory

The current implementation already has several analytics entry points. They do not yet form one
clear hierarchy.

| Area | Current code path | What it shows today | Planning concern |
| --- | --- | --- | --- |
| Workspace | [`WorkspaceAnalyticsOverview`](../../../client/apps/client/src/components/dashboard/workspace-analytics-overview.tsx) | Four highlight cards and three trends from `overview.summary@1`, including completed and failed agent runs, campaign delivery, response time, and connection health checks | This should become a compact triage view. A health-check count is not a customer outcome. |
| Dedicated analytics page | [`/analytics`](<../../../client/apps/client/src/app/(dashboard)/analytics/page.tsx>) | Reuses the workspace overview and catalog status | It currently duplicates the workspace analytics entry point instead of offering a distinct report purpose. |
| Connections | [`FeatureAnalyticsPanel`](../../../client/apps/client/src/components/analytics/feature-analytics-panel.tsx) | Six connection metric families, mostly lifecycle, health-check, capability, sync, rate-limit, and incident event counts | The page needs current readiness, attention reasons, sync health, capability availability, and remediation. |
| Campaigns | [`campaigns-page-client.tsx`](../../../client/apps/client/src/components/dashboard/campaigns/campaigns-page-client.tsx) | Eleven metrics spanning recipient outcomes, delivery, delay, retry, suppression, and pricing | Outcome metrics and operational counters need separate treatment. |
| Agents | [`AgentAnalyticsPanel`](../../../client/apps/client/src/components/dashboard/agents/agent-analytics-panel.tsx) and [`/agents/analytics`](<../../../client/apps/client/src/app/(dashboard)/agents/analytics/page.tsx>) | Agent runs, model calls, tokens, cost, tools, approvals, effects, schedules, installations, versions, readiness, conversations, and handoffs | The current list is useful for agent owners and operators, but too broad for a default customer view. |
| Content | [`AnalyticsDashboard`](../../../client/apps/client/src/components/social/analytics-dashboard.tsx) and [`/content/analytics`](<../../../client/apps/client/src/app/(dashboard)/content/analytics/page.tsx>) | Publishing status, connected channels, WhatsApp campaign totals, and social post insights | Publishing workflow state and content performance should be related but distinct reports. |
| Registry and overview set | [`metrics/`](https://github.com/Kasitek-Labs/kasitek-labs/tree/main/services/analytics/metrics), [`overview.summary.yaml`](https://github.com/Kasitek-Labs/kasitek-labs/blob/main/services/analytics/metrics/metric-sets/overview.summary.yaml), and [`agent.performance.yaml`](https://github.com/Kasitek-Labs/kasitek-labs/blob/main/services/analytics/metrics/metric-sets/agent.performance.yaml) | Versioned definitions, metric sets, dimensions, freshness, coverage, and permissions | The registry is a useful foundation. The UI needs curated surface-specific allowlists rather than broad set expansion. |
| Diagnostics | [`AnalyticsPlayground`](../../../client/apps/client/src/components/analytics/analytics-playground.tsx) and [`/analytics/playground`](<../../../client/apps/client/src/app/(dashboard)/analytics/playground/page.tsx>) | Catalog inspection, raw report queries, and data-quality evidence | This is the right home for technical evidence. It should remain separate from customer defaults. |

This inventory is based on the current source tree. It is not a complete audit of every admin and
tenant report yet. Phase 0 below must finish that inventory before any default metric set is
redesigned.

## Recommended navigation model

```text
Analytics
  Overview
  Connections
    Connection detail
  Agents
    Agent detail
  Campaigns
    Campaign detail
  Inbox
    Conversation or queue detail
  Content
    Post or channel detail
  Diagnostics          restricted
```

The navigation should not force users to visit the overview before they can work in a section. The
overview is the default orientation point. Section pages remain first-class destinations and should
retain their local filters and actions.

## What this means for the current Kasitek analytics work

The existing [customer analytics value plan](CUSTOMER_ANALYTICS_VALUE_PLAN.md) already points toward
a Connections pilot, derived customer metrics, explicit freshness, and hiding raw implementation
states. This research supports that direction and adds a stronger information architecture:

1. Keep one workspace overview, but make it a decision and attention view.
2. Make Connections the first section-level pilot because connection readiness and sync health lead
   directly to setup and remediation actions.
3. Keep customer-facing metric cards separate from the analytics platform's source, projection, and
   instrumentation evidence.
4. Give every promoted metric a drill path and action before adding it to a default view.
5. Use one shared metric definition and scope model across overview, section, detail, exports, and
   operator views.
6. Remove or demote cards that cannot answer a user question, support a decision, or explain a next
   action.

**Inference.** Kasitek should not begin by implementing a new global dashboard. The safer first move
is to inventory all current analytics surfaces, classify every metric by audience and metric class,
then redesign one complete section, probably Connections, using the layered model. That gives the
team a real pattern to repeat and exposes data-quality gaps before they spread across the product.

## Research-based planning checklist

This is a planning checklist, not an implementation checklist.

- [ ] Inventory every analytics card, chart, table, badge, and insight across the workspace.
- [ ] Record the user question, metric class, scope, owner, action, and source for each item.
- [ ] Mark implementation and operator metrics that are currently visible to customers.
- [ ] Identify duplicate metrics with different names, formulas, time windows, or scopes.
- [ ] Define the workspace overview's limited set of decisions and attention states.
- [ ] Define the first section pilot and its supported user jobs.
- [ ] Define the detail route and action for every pilot metric.
- [ ] Define empty, stale, partial, delayed, failed, restricted, and inapplicable states.
- [ ] Define role and tenant scope rules before exposing cross-tenant comparisons or exports.
- [ ] Add plain-language metric definitions and freshness information.
- [ ] Validate the information architecture with users who perform the target jobs.
- [ ] Measure whether users reach the intended action faster and whether low-value analytics are
  actually removed.

## Sources

The links below are the primary sources used for this note.

- [Microsoft Power BI dashboard design tips](https://learn.microsoft.com/en-us/power-bi/create-reports/service-dashboards-design-tips)
- [Microsoft Power BI dashboards versus reports](https://learn.microsoft.com/en-us/power-bi/explore-reports/end-user-dashboards)
- [Microsoft Power BI report drillthrough](https://learn.microsoft.com/en-us/power-bi/guidance/report-drillthrough)
- [Microsoft Power BI optimization guide](https://learn.microsoft.com/en-us/power-bi/guidance/power-bi-optimization)
- [GOV.UK: How to set performance metrics for your service](https://www.gov.uk/service-manual/measuring-success/how-to-set-performance-metrics-for-your-service)
- [Google Research: Measuring the user experience on a large scale](https://research.google/pubs/measuring-the-user-experience-on-a-large-scale-user-centered-metrics-for-web-applications/)
- [Datadog dashboards](https://docs.datadoghq.com/dashboards/)
- [Intercom reports explained](https://www.intercom.com/help/en/articles/200-intercom-reports-explained)
- [Intercom report sharing and access controls](https://www.intercom.com/help/en/articles/9867813-report-sharing-and-access-controls)
- [Intercom custom report](https://www.intercom.com/help/en/articles/4549035-create-a-custom-report)
- [GitLab analytics](https://docs.gitlab.com/user/analytics/)
- [GitLab Value Streams Dashboard](https://docs.gitlab.com/user/analytics/value_streams_dashboard/)
- [GitLab roles and permissions](https://docs.gitlab.com/user/permissions/)
- [Stripe Dashboard basics](https://docs.stripe.com/dashboard/basics?locale=en-GB)
- [Stripe reporting](https://docs.stripe.com/stripe-reports)
- [Shopify Analytics overview dashboard](https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/overview-dashboard/using-the-overview-dashboard)
- [Google Looker Studio data freshness](https://docs.cloud.google.com/data-studio/manage-data-freshness)
- [Amplitude North Star Playbook](https://amplitude.com/blog/introducing-north-star-playbook)
- [Amplitude Metrics reimagined](https://amplitude.com/blog/platform-metrics-launch)
- [Mixpanel vanity metrics](https://mixpanel.com/blog/vanity-metrics/)
- [GOV.UK dashboard guidance](https://brand.design-system.service.gov.uk/data/dashboards/)
- [GOV.UK data visualisation principles](https://brand.design-system.service.gov.uk/data/)
- [GOV.UK Details component](https://design-system.service.gov.uk/components/details/)
- [IBM Carbon data table usage](https://carbondesignsystem.com/components/data-table/usage/)
