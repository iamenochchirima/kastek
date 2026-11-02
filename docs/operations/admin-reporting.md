# Administrative reporting

Owner: Platform engineering. Reviewed: 2026-10-23.

The [incident centre](incident-centre.md) adds durable monitoring and independent administrator
sessions. Reporting queries remain product-owned. With `OPS_BACKEND_URL` configured, the admin
validates the current Labs session before issuing product-bound actor assertions. A Growth outage
does not fall back to cached authority.

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

The Customers page searches product-owned names by case-insensitive substring or exact IDs.
Search is bounded to 100 characters and filters the paginated customer records only; it does not
change aggregate metrics, grant authority, or search message content. Search is unavailable with
metric detail. Selecting a result applies that owning product and organization/workspace ID while
preserving the reporting period and timezone. IDs from different products remain distinct.

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
| Customer search | At most 100 characters; customer records only |
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
| Analytics | `ANALYTICS_DATABASE_URL` for ingestion and workers; optional `ANALYTICS_REPORTING_DATABASE_URL` for the separate non-owner reporting pool; ingestion credentials, reporting keys, and resolver credentials |

Standalone Agents trends use HMAC admin queries with optional organization scope; their resolver
token is optional. Growth/Agency scoped queries retain signed reporting grants. All-organization
queries use the admin assertion. Missing configuration stays visibly unavailable.

## Read-only diagnostics

`/operations` includes reporting status for Growth, Agents, Agency and Analytics alongside the
existing Growth webhook recovery and support grants. It has Refresh and per-source Refresh;
there is no replay, backfill, projection rebuild or quarantine mutation in this panel.
`GET /api/operations/reporting?source=all|growth|agents|agency|analytics` requires `admin:report`.
It calls each product's `GET /api/admin/reporting/diagnostics` or Analytics
`GET /v1/admin/reporting/diagnostics` through the same session/assertion boundaries as reporting.
Responses are uncached and bounded to 64 KiB per source with an eight-second HTTP deadline.

| Observation | Meaning and limit |
| --- | --- |
| Configuration | Required publisher endpoint and token are present. This does not prove remote credential acceptance. |
| Connectivity | The owning API connected to its source database. An unreachable service is disconnected at the collector; an invalid assertion is unauthorized. |
| Schema | Required source and outbox objects exist. Missing tables, columns or diagnostics function produce incompatible/unknown states rather than zero. |
| Reads | A bounded read succeeded under the active database role. Denied reads use a safe code and do not expose database errors. |
| Pending / retrying | Durable outbox rows pending or leased; retrying is that subset with an earlier attempt. These are current queue counts, not delivery-rate estimates. |
| Pending receipts | Agents task-event receipts not yet expanded into the outbox. Null for products without this receipt stage. |
| Publication state | Quarantined takes precedence; otherwise pending outbox rows or pending Agents receipts mean backfilling. With no pending work, no accepted delivery is no activity; an accepted delivery is ready. |
| Last published | Latest outbox acknowledgement. It does not prove the projection worker consumed the event. |
| Failure code | Latest safe machine code among nonterminal/quarantined outbox rows; no provider response or request payload. |
| Projection pending / failed | Pending or leased projection work, and failed work. Oldest pending describes queue age. |
| Backfilling / promoted checkpoints | Checkpoints currently rebuilding, and checkpoints with a promoted generation; the latter is not a count of all historical generations. |
| Source / ingestion / checkpoint / promotion time | Separate latest observed source, accepted ingestion, checkpoint update and generation-promotion times. They are not interchangeable watermarks. |
| Complete through / coverage | Global complete-through remains null and coverage unknown. Fresh activity and empty queues do not prove historical completeness. |
| Source states | Aggregate counts of recorded availability states, without scope IDs or content. |

Product queries use read-only transactions and a two-second SQL statement timeout. Analytics uses
a fixed-search-path security-definer function that exposes only these aggregate observations;
public execution is revoked. No source labels, customer names, raw errors, event bodies, secrets,
prompts or messages enter diagnostics. Observation-time OTLP records use service/stage labels for
`kasitek.reporting.backlog` and the existing queue-age instrumentation. The panel does not install
a collector, alert rules or polling daemon. Worker liveness is separate from queue progress.

## Migrations and runtime permissions

Each service runs its own additive migrations through its existing runner.

| Owner | Schema |
| --- | --- |
| Growth | `20261023030000_admin_sessions`; `20261023095000_admin_commercial_safety`; `20261023103000_admin_report_scope` adds export scope JSON |
| Agents | `067_native_analytics.sql` adds native outbox, receipt table, and task-event trigger |
| Analytics | `20261023100000_native_agents_reporting.sql` registers scope/producer permissions; `20261023110000_admin_reporting.sql` adds bounded root lookup and query audit; `20261023120000_reporting_diagnostics.sql` adds aggregate diagnostic metadata; `20261023130000_reporting_grant_insert.sql` binds grant inserts to the transaction authorization context |
| Agency | Existing workspace, usage, and audit schema; no new reporting-reader migration |

Analytics can use two database pools. `ANALYTICS_DATABASE_URL` remains the ingestion/worker
writer connection. `ANALYTICS_REPORTING_DATABASE_URL`, when configured, supplies reporting,
admin aggregate reads and diagnostics through a separate non-owner role. Without it, these
handlers use the main pool. Production operators must decide and provision this separation;
the browser cannot choose a connection or execute SQL.

The development reader is `NOSUPERUSER NOBYPASSRLS` and owns no Analytics objects. The writer owns
its dedicated database and uses the existing ingestion/worker architecture; it is also
`NOSUPERUSER NOBYPASSRLS`. Do not describe owner writes as RLS-restricted reader operations.
Migrations run with the schema owner, not the reporting reader. Review the role name below;
`analytics_report_reader` is an example existing role, not one created by a migration.

```sql
GRANT USAGE ON SCHEMA analytics TO analytics_report_reader;
GRANT SELECT ON
  analytics.service_identity,
  analytics.reporting_scope,
  analytics.scope_ancestor,
  analytics.reporting_grant,
  analytics.analytics_backfill_job,
  analytics.analytics_coverage_checkpoint,
  analytics.analytics_projection_checkpoint,
  analytics.analytics_source_state,
  analytics.analytics_projection_generation,
  analytics.analytics_projection_contribution,
  analytics.analytics_projection_rollup
TO analytics_report_reader;
GRANT INSERT ON analytics.reporting_grant, analytics.admin_reporting_audit
TO analytics_report_reader;
GRANT EXECUTE ON FUNCTION analytics.admin_reporting_roots(TEXT, TEXT),
  analytics.admin_reporting_diagnostics()
TO analytics_report_reader;
```

The bounded metadata functions have fixed search paths and revoked public execution. Projection
SELECTs retain RLS. Scoped transactions call `analytics.set_authorization_context(BIGINT[], TEXT)`;
the narrow grant INSERT policy requires both an authorized scope and the matching transaction's
grant ID. Grant-table INSERT does not permit product-fact, projection, assignment or scope writes.
If the deployment revokes default public function execution, grant the reader the existing
`set_authorization_context(BIGINT[], TEXT)`, `clear_authorization_context()` and
`scope_is_authorized(BIGINT)` functions as required by the scoped transaction path. Audit SELECT
requires a separate operator grant. None of these grants authorize a product database.

## Dedicated development profile

The operational profile lives in ignored `.runtime/admin-reporting/`. Its directory is mode 700;
`growth.env`, `agency.env`, `agents.env`, `analytics.env` and `admin.env` are mode 600. The maintained
`.env.example` in each service lists its supported variables. Copy definitions, provision private
values locally, and never commit or print the populated profiles. The process tool sets
`KASITEK_ENV_FILE` to the exact selected private file. Growth, Agency and Analytics load that
explicit profile without falling back to their service-local `.env`; missing explicit files fail
startup. This prevents an unset development value from importing an older checkout credential.
Product signing private keys
stay in Growth/Agency; Analytics holds the corresponding public key and source-bound resolver and
ingestion credentials. Server assertions share the configured administrative secret.

| Service | Development endpoint | Dedicated database on loopback PostgreSQL port 15432 |
| --- | --- | --- |
| Growth | `http://localhost:4000` | `kasitek_growth_reporting_dev` |
| Agency | `http://localhost:8090` | `kasitek_agency_reporting_dev` |
| Agents reporting profile | `http://localhost:14100` | `agents_platform_reporting_dev` |
| Analytics API / worker | `http://localhost:4300` / separate worker process | `kasitek_analytics_reporting_dev` |
| Admin | `http://localhost:3001` | No direct product database connection |

These are persistent dedicated development databases, not production replicas. Existing Agents
API/UI on 4100/3100 and their database remain separate. The earlier other-PC connection could not
be reached by SSH during setup; its previous configuration and database were retained. The new
profile neither depends on that machine nor replaces its records.

Build shared packages and the four APIs, then build the admin with its profile. Run owner migration
commands only after verifying the selected development database; the process tool does not run
Prisma or Analytics migrations for you. Growth uses Prisma migration deployment with `DIRECT_URL` set to the selected database.
The fresh dedicated development database applied all 87 checked-in migrations; it was not
initialized with `db push` or a fabricated migration ledger.
Agents setup accepts a fresh empty dedicated database or the exact current schema checksum; it
refuses an older schema instead of deleting it.

From the repository root, these commands load credentials from files rather than shell arguments:

```sh
(
  cd products/growth/database
  node --env-file=../../../.runtime/admin-reporting/growth.env node_modules/prisma/build/index.js migrate deploy
)
KASITEK_ENV_FILE=.runtime/admin-reporting/analytics.env node --env-file=.runtime/admin-reporting/analytics.env services/analytics/dist/migrate-main.js
node --env-file=.runtime/admin-reporting/agents.env products/agents/api/dist/composition/setup.js
pnpm reporting:dev preflight
pnpm reporting:dev start --allow-startup-migrations
pnpm reporting:dev status
```

Agency's normal API and publisher entry points run its additive migrations on startup. The flag
acknowledges that behavior for the reviewed dedicated database. Growth/Agency publishers use their
existing analytics-publisher process mode; the Analytics worker projects accepted observations;
Agents publishes from its API's durable receipts. Unrelated Growth API background workers are
disabled in this profile. Preflight checks configuration, build presence, port conflicts and database
TCP connectivity for primary and optional reporting databases. It rejects PostgreSQL query overrides and non-loopback database targets. Configured reporting, ingestion and admin-source HTTP origins must match the profile ports above. These checks do not establish successful authentication, current schema or event delivery.
The process manager checks ownership before reuse/shutdown and leaves explicitly adopted external
processes running. See the [admin process commands](../../apps/admin-site/README.md#development-reporting-processes).

### Recovery checks

1. Open `/operations` and inspect each source's configuration, schema, reads and publication queue.
2. If projection work accumulates, check `pnpm reporting:dev status analytics-worker` and restart
   the owned worker with `pnpm reporting:dev start analytics-worker`. Empty queues alone are not
   completeness evidence; compare the promoted checkpoint and the requested source scope.
3. If publication is pending or retrying, check the owning publisher and its configured endpoint.
   Restore the same credentials and process; let durable identities retry. Do not create replacement
   event IDs to make counters move. Quarantined work needs investigation through its owning service's
   established recovery path; this read-only panel cannot release it.
4. When one source is unavailable, retain the other reports and restore that source separately.
   Refresh its diagnostics and reopen the same scoped report before checking export.
5. Stop only selected owned processes with `pnpm reporting:dev stop SERVICE`. Do not kill by port,
   clear outboxes, delete projection generations, or reset the older Agents database.

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
| Owner/change | Platform engineering, iamenochchirima; operational development reporting, read-only diagnostics and customer lookup |
| Risk/services | High; development configuration, database selection, privileged access and additive schema across admin, Growth, Agents, Agency, and Analytics |
| Identity | Repository `VERSION` is `0.1.0`. A deployment record must identify final commit and service artifacts. No release tag or production version bump is created here. |
| Documentation | This reference, admin README, root architecture, Growth admin architecture, and feature map |
| API/schema | Version-1 reporting and diagnostic DTOs, bounded customer-search query, optional reader pool and additive migrations above |
| Measurement | Registered native execution metrics, existing product events, query/export audit, bounded logs |
| Validation | Isolated engineering checks plus actual dedicated development HTTP, database, worker-recovery and browser journeys. These do not establish hosted staging, production deployment or live-provider acceptance. |
| Rollout | Build shared packages; apply owner migrations; provision least-privilege grants; configure authority; enable sources separately. No production rollout is authorized here. |
| Rollback | Disable source/publisher configuration and revert callers, retaining durable facts and audit |
| Collector/OTLP | No Collector change in this block. Actual deployed revision, destination, retention, and redaction evidence remain deployment responsibilities. |
| Customer rollout/evals | No customer-facing rollout or model-evaluation run in this block. Live acceptance remains owner-run. |
| Post-release review | Owner records a date with a separately authorized rollout; not scheduled by local implementation |

## Verification

The 2026-10-23 development acceptance used the running dedicated services, not synthetic reporting
responses. Browser paths exercised all three product scopes, customer lookup, permitted metric
detail, private save/reopen, audited export, responsive Operations and viewer restrictions. Native
Agents publication produced one completed root and 100/20 input/output tokens through authenticated
HTTP; four duplicate submissions did not change those projections. Growth's local Meta-shaped
source fixture produced two conversations and one message, with projection count two and partial
coverage. A further controlled conversation exercised publisher pause/recovery and advanced that
conversation projection to three after publication resumed. These are engineering fixtures, not live Meta/provider traffic or model evaluations.

Agency client lifecycle projection advanced from one to two after recovery and to three after
restoring its source fixture. While the Analytics worker was paused, two pending work items were
visible and the trend stayed at one; resuming the worker advanced it to two. An Agents reporting
API outage preserved the other product reports, and restoring it recovered the same scoped view.
These checks establish this development path, not throughput capacity or historical completeness.
Local screenshots, result JSON and CSV evidence were captured under
`/tmp/kasitek-admin-operational-proof/`; they are session artifacts and may expire. Repeatable
engineering checks live in the repository paths below.


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
pnpm test:reporting-dev
pnpm --filter @kasitek/analytics exec tsx --test tests/admin-reporting-diagnostics.test.ts tests/reporting-read-pool.test.ts
```

Browser checks cover all six pages at desktop, tablet, and mobile widths, source outage, filters,
permitted metric detail, private save/reopen, CSV precision/formula protection, and viewer permissions.
Fixtures cover equal IDs across products, mixed currencies, unknown cost, root/child/retry accounting,
late data, and daylight-saving boundaries. Engineering checks verify transport, authority,
persistence, projections, and UI behavior. Model evaluations, live provider acceptance, production
rollout, and real-account changes remain owner-run.

## Customer investigation

Customer IDs in supporting records link to `/customers/:product/:customerId` in the existing admin.
This uses separate owning-service metadata/operation APIs. Reporting authority itself grants no
recovery or content access. See [Customer operations](admin-customer-operations.md).
