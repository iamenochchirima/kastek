---
id: admin-analytics
title: Admin Analytics and Reporting
slug: /architecture/admin-analytics
sidebar_position: 6
owner: engineering
last_reviewed: 2026-08-27
---

# Admin Analytics and Reporting

## Scope

Admin Analytics provides platform-level aggregates and investigation surfaces. It is separate
from customer workspace analytics and must not expose raw message bodies, prompts, attachments,
provider payloads, credentials, payment secrets, or unrestricted database access.

The browser uses the Admin Next.js routes as a same-origin proxy. Core remains the authorization
and data boundary:

```text
Admin browser -> Admin Next.js API route -> Core Admin API -> authoritative Core records
```

## Surfaces

| Surface | Route | Responsibility |
| --- | --- | --- |
| Overview | `/analytics` | Platform KPIs, period comparison, coverage, and top-level trends |
| Usage | `/analytics/usage` | Operations, messages, campaigns, and credit usage trends |
| Revenue | `/analytics/revenue` | Collections, subscriptions, payment outcomes, and credit lifecycle |
| Customers | `/analytics/customers` | Organization lifecycle, plan mix, and activity ranking |
| Activity | `/activity` | Cursor-paginated cross-domain event investigation and optional SSE updates |
| Reports | `/reports` | Approved report definitions, saved definitions, bounded CSV exports, and export status |
| Operations | `/operations/health`, `/operations/data-quality`, `/operations/audit` | Health, source freshness/coverage, and security/audit evidence |

`/dashboard` remains a compatibility route and redirects to `/analytics`.

## Core API boundary

Core exposes the following Admin-only endpoints under the existing authenticated Admin session:

- `GET /api/admin/analytics/overview`
- `GET /api/admin/analytics/usage`
- `GET /api/admin/analytics/revenue`
- `GET /api/admin/analytics/customers`
- `GET /api/admin/activity`
- `GET /api/admin/activity/stream`
- `GET /api/admin/reports`
- `POST /api/admin/reports`
- `POST /api/admin/reports/export`
- `DELETE /api/admin/reports/{reportId}`

Analytics queries have bounded date ranges, page sizes, and CSV output. Responses identify the
requested range and timezone and include freshness/coverage metadata where the source can provide
it. Current-state billing values come from Core billing records; delayed trend values must not be
described as exact real-time financial reporting.

The activity feed combines safe indexed fields from Core event/audit sources. Its cursor is the
pagination boundary and its live stream is bounded and deduplicated; the database remains the
source of truth. A reconnecting client must be able to fall back to the query endpoint.

## Authorization and privacy

Core checks the Admin session and `admin:read` before returning analytics. Aggregate analytics is
available to the approved Admin read roles. Saving, deleting, and exporting report definitions is
restricted to the approved administrative roles. Support-grant access and security/audit access
remain distinct operational concerns.

Report definitions are private to their creating Admin. Export requests create an
`AdminReportExportAuditEvent` record and record success or failure without storing sensitive report
payloads in the audit row.

## Data and schema changes

The saved-report and export-audit tables are additive:

- `20260826180000_add_admin_saved_reports`
- `20260826181000_add_admin_report_export_audit`

Do not remove either table as part of a rollback. Reverting the UI and routes is safe while the
tables remain unused. Any later metric-definition change must preserve report-definition version
interpretability or mark the saved definition for review.

## Chart and reporting rules

Charts use the selected date range and explicit UTC aggregation. Daily discrete activity is shown
as bars with readable date ticks, a visible zero baseline, human-readable units, exact hover values,
and no-data/unavailable states. Long ranges aggregate to readable monthly buckets. Comparisons are
visually subordinate and must not be confused with the current period. Cash values are primary on
Revenue; credits remain a separate usage unit.

## Release and verification

Release-specific evidence for this surface follows the [feature and platform release
process](../operations/release-process.md) and belongs in the associated change or release
record. This page remains the current technical reference for the boundary, migrations, and
verification requirements.

Admin TypeScript, lint, production build, and diff checks pass. Authenticated Core smoke checks,
database verification, and end-to-end activity/report export checks must be rerun when the shared
Core worktree compiles. The current pending dependency is a concurrent observability change that
references an out-of-scope `result` value, plus a concurrent organization-scope publisher change
that must be reconciled before Core can start.
