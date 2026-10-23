---
id: admin-analytics
title: Admin analytics and reporting
slug: /architecture/admin-analytics
sidebar_position: 6
owner: engineering
last_reviewed: 2026-10-23
---

# Admin analytics and reporting

## Boundary

The central admin reads Growth, Agents, and Agency through product-owned HTTP interfaces.
Each product retains its database, organization identifiers, permissions, and migrations.
The admin has no direct product database access.

```text
Admin browser -> same-origin Next.js reporting routes -> product reporting APIs
                                                     -> Labs Analytics projections
```

Product reads supply authoritative current state and financial facts. Registered Analytics
projections supply event-derived trends. The two remain separately labelled and are never added
together. The [administrative reporting reference](../../../../../docs/operations/admin-reporting.md)
defines source coverage, metric semantics, configuration, migrations, and rollback.

## Surfaces

| Surface | Route | Responsibility |
| --- | --- | --- |
| Overview | `/analytics` | Product summaries with source coverage |
| Customers | `/analytics/customers` | Product-owned organizations, memberships, plans, and safe customer records |
| Adoption | `/analytics/adoption` | Recorded activity and supported active-user metrics |
| Usage | `/analytics/usage` | Product usage, shared execution attribution, tokens, and model cost |
| Revenue | `/analytics/revenue` | Currency-separated invoice facts and unsupported financial coverage |
| Reliability | `/analytics/reliability` | Root outcomes, backlog, latency, retries, deliveries, and human intervention |
| Activity | `/activity` | Growth's cursor-paginated safe activity feed and bounded SSE updates |
| Reports | `/reports` | Private saved scopes, existing definitions, and audited CSV exports |
| Operations | `/operations` | Read-only reporting diagnostics across products and Analytics; Growth webhook recovery and separately authorized support grants |

`/dashboard` redirects to `/analytics`. The old health, data-quality, and audit pages redirect to
`/operations`; they are not independent monitoring panels. Activity remains Growth-scoped.

## HTTP interfaces

The admin uses `GET /api/analytics/cross-product` and
`POST /api/analytics/cross-product/export`. Product filters select Growth, Agents, Agency, or all.
An organization filter requires a selected product. The UI retains period, timezone, pagination,
and supported metric detail dimensions in the URL. Customer search accepts up to 100 characters
and filters paginated name/ID records only; aggregate metrics keep the original scope. Selecting
a customer applies its owning product and organization without equating IDs across products.

All three products expose `GET /api/admin/reporting`. Growth authenticates the admin session.
Agents and Agency verify short-lived assertions bound to actor, capability, audience, method,
and exact path. Growth or Agency selection also requests Agents execution attributed to that
consumer through verified product tenant mappings. Equal IDs establish no cross-product relationship.

All-organization trends and standalone Agents trends use Analytics `GET /v1/admin/reporting` with a
request-bound admin assertion. Scoped Growth and Agency trends reuse the scope resolver and signed
reporting grants. Only registered additive integer metrics are supported. Existing Growth-only
`/api/admin/analytics/*`, activity, and report-definition APIs remain for their current callers;
they do not establish cross-product source coverage.

Operations reads `GET /api/operations/reporting` with the selected service or all four sources.
Product diagnostics expose configuration presence, bounded source reads, pending/retrying/quarantined
outbox counts and accepted publication time. Agents adds pending event receipts. Analytics exposes
aggregate queue, checkpoint and promotion metadata. These observations do not prove worker liveness,
remote credential acceptance or global completeness, and the panel performs no recovery mutations.

Analytics optionally uses `ANALYTICS_REPORTING_DATABASE_URL` for a separate non-owner reporting pool.
Ingestion and the projection worker retain the main writer connection. The reader has explicit
projection SELECTs, bounded metadata-function execution, audit INSERT and a narrowly authorized
reporting-grant INSERT; it cannot write source facts or projections. The operations reference lists
all role grants and migration requirements.

## State, precision, and permissions

Reports distinguish response generation, latest source observation, and projection completeness.
Unknown watermarks stay null. Partial, stale, unsupported, unavailable, and genuine zero values
remain distinct. One source failure does not blank successful product results. Product reads use
read-only repeatable-read transactions; trends read promoted projection generations.

Integer and monetary values remain decimal strings across transport and CSV. Charts do not round
values beyond JavaScript's exact integer range; tables retain exact values. Money remains in its
source currency. Credits, estimated provider cost, and revenue remain separate units.

Safe records include IDs, scope, state, timestamps, correlation IDs, and an optional product-owned
organization or workspace name. They exclude messages, prompts, attachments, tool arguments,
credentials, and raw provider payloads. Only metrics with an implemented record query advertise detail.

`admin:report` permits reads, `admin:export` permits exports, and `admin:write` permits saved-definition
changes. Every receiving boundary rechecks authority. Support-content access is separate. Saved
reports belong to their creating admin and retain definition version, product, domain, and filters.

Exports retain the same scope, values, and selected record page as the screen. They do not silently
fetch every page. Growth records export status in `AdminReportExportAuditEvent`; Analytics separately
audits admin projection queries. Browser responses never expose service credentials.

## Verification

The [reporting operations reference](../../../../../docs/operations/admin-reporting.md#verification)
lists repeatable checks and rollout responsibilities. The dedicated development profile connects the actual four APIs, publishers, projection worker and
admin, with independent databases and explicit process ownership. Engineering tests exercise isolated source
reconciliation, HTTP authority, projection replay, source outages, exact quantities, saved filters,
exports, and responsive reporting pages. Model evaluations and live provider acceptance remain
owner-run. Local verification does not establish production deployment.
