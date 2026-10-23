# Administrative reporting

Owner: Platform engineering. Reviewed: 2026-10-23.

## Contract and coverage

Shared types and definitions live in `packages/contracts/src/admin-reporting.ts`.
`@kasitek-labs/server-support/admin-reporting` validates queries, sanitizes responses, collects
bounded HTTP results, and serializes CSV. Products retain database ownership. Current authoritative
values and event-derived Analytics projections remain separate. There is no arbitrary SQL interface.

| Source | Authoritative measurements | Limits |
| --- | --- | --- |
| Growth | Organizations, memberships, conversations, `UsageEvent` quantities, credits, invoice receipts, checkout failures, subscriptions, and Developer API requests | Active organizations require `UsageEvent` activity. Usage does not identify verified human actors. Refund amount/time and current unpaid balances are absent. |
| Agents execution owner | Root/child tasks, durable outcomes, backlog age, settled latency, dispatch attempts, operation tokens, and cost settlements | Evaluation trials are excluded. Missing usage/cost remains partial. Ledger values are usage estimates, not provider billing receipts. |
| Standalone Agents | Organizations, non-revoked memberships, definitions, conversations, channel connections, outbound states, takeover, and staff replies | Product-managed execution organizations are excluded from standalone customer counts. Delivery acceptance and unknown status remain distinct from delivered. |
| Agency | Workspaces, active memberships, clients, and `workspace_usage_events` quantities | Active workspaces require recorded usage. Provider/event quantities stay separate. Unrecorded financial, subscription, and human-activity measurements are unsupported. |
| Labs Analytics | Registered Growth/Agency activity and native Agents completion, failure, token, and unknown-usage trends | Projections cover instrumented scopes and retained evidence, not every current product organization. |

Activation funnels, previous-period comparison rates, and unique cross-product people/customers are
not implemented metrics. Their absence is not zero. No verified identity mapping deduplicates
product memberships into a platform person count.

Only supported metrics advertise a supporting-record query. Customer records may include their
owning organization/workspace name. Other detail includes safe IDs, scope, state, timestamps, and
correlation/root IDs. Messages, prompts, attachments, tool arguments, credentials, and provider
payloads remain outside reports and exports. Support-content access is separate.

## Scope, time, and bounds

An organization filter selects only that product's organization or workspace. Embedded execution
uses verified `product_execution_tenants` mappings in Agents, never ID or email equality. Product
metrics remain separate; shared execution has one accounting owner.

Periods include UTC start and exclude UTC end. The reporting timezone controls trend buckets and
presentation. Current metrics describe the current read snapshot, not historical period-end state.
Analytics does not silently rebucket scopes configured with another timezone into a complete
aggregate. Daylight-saving days can have 23 or 25 hours.

| Bound | Value |
| --- | --- |
| Period | Positive, at most 366 days |
| Record page | At most 100 records; page at most 10,000 |
| Product fan-out | At most three HTTP sources |
| Product response | At most 2,000,000 streamed bytes per source |
| Product HTTP read | 8-second timeout; caller cancellation propagated |
| Trend client | 4-second overall deadline covering resolution and query |
| Authoritative SQL | Read-only repeatable-read; 5-second statement timeout |
| Aggregate trend roots | At most 100 per query |
| Agency descendants | At most 100 authorized scopes per root |
| Trend selection | At most ten registered additive integer metrics |
| Source dimensions | Up to 100 groups; truncation is partial |

The admin does not cache reporting responses. Scoped Analytics queries retain the existing cache,
whose keys include authorization scope and metric/generation context; its TTL is bounded by grant
expiry and 30 seconds. Admin aggregate queries directly read promoted generations. Every receiving
boundary rechecks authority. Successful sources survive another source's outage.

CSV retains the screen's domain, definitions, dimensions, scope, and selected record page. It does
not silently fetch every page. Spreadsheet-formula protection applies to cells.

## Precision and freshness

Decimal-string values preserve PostgreSQL bigint totals across JSON and CSV. Unknown values are
null. A successful read confirming no rows can return zero; a failed read cannot. Metric and trend
states distinguish available, partial, stale, unavailable, and unsupported evidence.

`generatedAt` describes the response. `observedAt` describes a source fact. `completeThrough` requires
an ingestion/projection checkpoint. The latest changed record is not a health or completeness
signal. Authoritative reads have no projection checkpoint and return null. A failed source does
not acquire a fabricated last-known value.

Trend scope coverage counts included and eligible instrumented roots, not the whole current product
population. Global projections retain that limitation. Scope caps, stale evidence, missing temporal
coverage, and timezone differences prevent a complete aggregate. Charts leave gaps unknown. Tables
retain exact values; unsafe JavaScript integers are not drawn as rounded quantities.

## Execution and financial semantics

Agents counts each root once under its admitted consumer. Model totals include child work once per
operation. Dispatch retries, reads, and settlement replays do not create another charge. Consumer
breakdowns partition execution-owner totals rather than adding another platform cost.

Root outcomes use the admission cohort and current state. Settled latency p95 uses roots settled
in the period. An open cohort has no implied final success rate. Dispatch retries count attempts
after the first, not model invocation retries. Provider/model identity comes from recorded routes.
The cost ledger stores USD micros and labels its values as usage estimates. Known estimates and
unknown operations remain separate. Credits are usage quantities, not money.

A Growth root with operations costing 100 and 200 micros and child work costing 50 has one Agents
execution total of 350 micros, attributed to Growth. If the child cost is unknown, known cost is
300 with partial coverage and one unknown operation. Replaying a settlement changes neither total.

Native Analytics derives observations from committed task events through durable receipt/outbox
identity. Publication replay does not inflate projections. Evaluation trials are excluded.
Standalone scopes use `agents_organization`; embedded work uses verified consuming-product scopes.
Retired runtime event names are not sources for these metrics.

Amounts retain source minor units and explicit currency. No implicit exchange rate combines ZAR
and USD. `invoiced` uses source issue time; `paid` uses paid time. Paid receipts are recorded
collections, not provider net settlement. Growth billing records paid receipts, not an unpaid
receivable lifecycle. Pending checkouts do not establish debt. Commercial admin invoices lack
product-organization scope and are not merged into these totals. Refund status lacks amount/time.
Outstanding and refunds remain unsupported where those facts are absent. Current subscription
status and plan counts do not imply revenue.

## Configuration and authority

Opaque Growth sessions authenticate the admin. `admin:report` permits reads, `admin:export` permits
exports, and `admin:write` permits saved-definition changes. Service assertions expire after
60 seconds and bind actor, audience, capability, method, exact path, and body digest. Browser
responses, saved reports, logs, and audit payloads never include service credentials.

| Process | Settings |
| --- | --- |
| Admin Next.js | `CORE_BACKEND_URL`, `TENANTS_BACKEND_URL`, `AGENTS_BACKEND_URL`, `KASITEK_ADMIN_SERVICE_SECRET` |
| Growth, Agency, Agents, Analytics | Matching server-only `KASITEK_ADMIN_SERVICE_SECRET`, at least 32 bytes |
| Product trend clients | `ANALYTICS_REPORTING_URL`; Growth/Agency also require `ANALYTICS_REPORTING_RESOLVER_TOKEN` |
| Scoped Growth/Agency trends | `ANALYTICS_REPORTING_PRIVATE_KEY`, issuer/audience and optional key ID; matching Analytics public keys, allowed issuers, and source-specific resolver credentials |
| Agents publisher | `AGENTS_ANALYTICS_INGESTION_URL` and `AGENTS_ANALYTICS_INGESTION_TOKEN`; both absent disables publication |
| Analytics | Its own database URL, ingestion credentials, reporting keys, and resolver credentials |

Standalone Agents trends use HMAC admin queries with optional organization scope; their resolver
token is optional. Growth/Agency scoped queries retain signed reporting grants. All-organization
queries use the admin assertion. Missing configuration stays visibly unavailable.

## Migrations and runtime permissions

Each service runs its own additive migrations through its existing runner.

| Owner | Schema |
| --- | --- |
| Growth | `20261023030000_admin_sessions`; `20261023095000_admin_commercial_safety`; `20261023103000_admin_report_scope` adds export scope JSON |
| Agents | `067_native_analytics.sql` adds native outbox, receipt table, and task-event trigger |
| Analytics | `20261023100000_native_agents_reporting.sql` registers scope/producer permissions; `20261023110000_admin_reporting.sql` adds bounded root lookup and query audit |
| Agency | Existing workspace, usage, and audit schema; no new reporting-reader migration |

Use a separate non-owner Analytics runtime role without superuser or `BYPASSRLS`. Existing
projection reads retain row-level authorization. The bounded root-lookup security-definer function
has a fixed search path and revoked public access. Extend the existing scoped-reporting role grants
with the following permissions. `analytics_runtime` is an example deployment role, not one created
by the migration:

```sql
GRANT USAGE ON SCHEMA analytics TO analytics_runtime;
GRANT EXECUTE ON FUNCTION analytics.admin_reporting_roots(TEXT, TEXT) TO analytics_runtime;
GRANT INSERT ON analytics.admin_reporting_audit TO analytics_runtime;
```

Migrations use the schema owner; runtime services do not. Audit read access needs a separate explicit
operator grant. These grants do not authorize product database access.

## Recovery, rollback, and release

Analytics retains existing ingestion identity, deduplication, quarantine, manifests, and promoted
projection generations. Repair publication from durable receipts/outbox rows, preserving record
IDs. Late-arrival correction and rebuilds follow registered coverage and generation-promotion rules.
A rebuild does not establish historical completeness. Reconcile current authoritative totals and
projection buckets using their different time semantics and recorded watermarks.

Analytics audits actor, product, metric keys, scope counts, request ID, and time. Safe logs include
`admin.reporting.query`, `admin.reporting.failed`, and `analytics.native.publish.failed`. Shared HTTP
calls reuse provider spans. Collector retention, alert routing, and production lag thresholds remain
operator-managed; this block provisions no new monitoring service.

Disable a product source by removing its reporting authority or endpoint configuration. Missing
Analytics configuration leaves authoritative facts available with unavailable trends. Remove both
Agents ingestion settings to stop publication, retaining pending durable records for recovery.
Rollback reverts reporting callers before revoking runtime grants. Retain session, audit, commercial,
and outbox data. Do not restore raw user-ID session cookies or delete accepted projection records.

| Release concern | Decision |
| --- | --- |
| Owner/change | Platform engineering, iamenochchirima; existing admin cleanup and product-owned reporting |
| Risk/services | Standard; privileged access and additive schema across admin, Growth, Agents, Agency, and Analytics |
| Identity | Repository `VERSION` is `0.1.0`. A deployment record must identify final commit and service artifacts. No release tag or production version bump is created here. |
| Documentation | This reference, admin README, root architecture, Growth admin architecture, and feature map |
| API/schema | Version-1 reporting DTO, scoped metadata APIs, and additive migrations above |
| Measurement | Registered native execution metrics, existing product events, query/export audit, bounded logs |
| Validation | Isolated engineering source, contract, HTTP, projection, and browser checks. These do not establish deployed credentials, hosted staging, or live acceptance. |
| Rollout | Build shared packages; apply owner migrations; provision least-privilege grants; configure authority; enable sources separately. No production rollout is authorized here. |
| Rollback | Disable source/publisher configuration and revert callers, retaining durable facts and audit |
| Collector/OTLP | No Collector change in this block. Actual deployed revision, destination, retention, and redaction evidence remain deployment responsibilities. |
| Customer rollout/evals | No customer-facing rollout or model-evaluation run in this block. Live acceptance remains owner-run. |
| Post-release review | Owner records a date with a separately authorized rollout; not scheduled by local implementation |

## Verification

Run against isolated disposable PostgreSQL, never a connected customer database. Product suites
create temporary schemas or databases. Full native-pipeline checks load built Analytics through
`ANALYTICS_SERVICE_DIST`.

```sh
pnpm build:shared
pnpm verify:boundaries
ADMIN_REPORTING_TEST_DATABASE_URL=postgres://... products/growth/api/node_modules/.bin/tsx --test products/growth/api/tests/admin-reporting-source.test.ts
ADMIN_REPORTING_TEST_DATABASE_URL=postgres://... products/agency/api/node_modules/.bin/tsx --test products/agency/api/tests/admin-reporting-source.test.ts
AGENTS_TEST_DATABASE_URL=postgres://... ANALYTICS_SERVICE_DIST=/absolute/path/to/services/analytics/dist pnpm --filter @kasitek/agents exec vitest run test/admin-reporting.test.ts
node --test packages/server-support/tests/admin-reporting*.test.mjs
```

Browser checks cover all six pages at desktop, tablet, and mobile widths, source outage, filters,
permitted metric detail, private save/reopen, CSV precision/formula protection, and viewer permissions.
Fixtures cover equal IDs across products, mixed currencies, unknown cost, root/child/retry accounting,
late data, and daylight-saving boundaries. Engineering checks verify transport, authority,
persistence, projections, and UI behavior. Model evaluations, live provider acceptance, production
rollout, and real-account changes remain owner-run.
