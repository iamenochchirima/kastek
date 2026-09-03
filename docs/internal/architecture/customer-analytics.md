---
id: customer-analytics
title: Customer Analytics Display Semantics
slug: /architecture/customer-analytics
sidebar_position: 7
owner: engineering
last_reviewed: 2026-09-03
---

# Customer Analytics Display Semantics

Customer workspace analytics is a read-only presentation of aggregate Analytics API reports. The
API may return a metric definition and its requested time buckets even when no source has produced
an observation in the selected period.

## Empty and populated reports

The client determines whether a metric is populated from its report points:

- A finite numeric value is an observation. `0` is valid observed data.
- `null`, `undefined`, `NaN`, and infinite values are not observations.
- A metric whose series contains no observations is empty, even if the API returned empty time
  buckets.
- A report with no populated metrics uses one concise empty state and does not render empty cards,
  charts, tables, or instrumentation badges.
- A partially populated report renders only metrics with observations.

Source availability, freshness, coverage, and instrumentation states remain part of the API response
for diagnostics. They are not a substitute for user activity and should not be presented as the
primary customer-facing content for an empty report.

## Source state and freshness

An accepted source manifest is materialized into one source-state row per supported metric. This
keeps manifest capability evidence and observation evidence on the same reporting path, including
metrics that have no individual observation yet. `freshness.state` is derived from the latest
source timestamp and the metric's freshness window; it is not a copy of the source availability
state. A source can therefore be available but stale.

Projection work records must retain both the minimum and maximum source storage IDs for a fact
window. The projection worker uses these bounds when coalescing live events and replay work.

## Error boundary

An unavailable or failed Analytics API request remains an error state with retry behavior. It must
not be converted into a successful empty report, because doing so would hide reporting failures.

## Ownership

The Analytics service owns aggregation and source-state calculation. The client owns the
presentation rule above and must apply it consistently across Connections, Campaigns, Inbox, Agent
analytics, the workspace overview, and the analytics playground.
