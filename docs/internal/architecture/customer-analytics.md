---
id: customer-analytics
title: Customer Analytics Display Semantics
slug: /architecture/customer-analytics
sidebar_position: 7
owner: engineering
last_reviewed: 2026-08-30
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

## Error boundary

An unavailable or failed Analytics API request remains an error state with retry behavior. It must
not be converted into a successful empty report, because doing so would hide reporting failures.

## Ownership

The Analytics service owns aggregation and source-state calculation. The client owns the
presentation rule above and must apply it consistently across Connections, Campaigns, Inbox, Agent
analytics, the workspace overview, and the analytics playground.
