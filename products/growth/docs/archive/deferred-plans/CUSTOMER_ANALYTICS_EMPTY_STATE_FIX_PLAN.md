# Customer Analytics Empty-State Fix Plan

**Status:** Active

**Owner:** Client frontend

**Last updated:** 2026-08-30

## Objective

Make customer analytics distinguish real observations from empty reporting buckets. When a report
contains no observed values, the interface must show one concise empty state instead of metric
cards, charts, tables, freshness badges, coverage badges, or internal instrumentation states.
When a report contains data, including an observed value of zero, the existing reporting UI must
remain available and accurate.

Success means an all-null report produces a single `No activity yet` state across every affected
customer analytics surface, while partially and fully populated reports continue to render useful,
responsive visualizations.

## Scope

### Included

- Define one reusable rule for determining whether a report point, series, and metric contain an
  observed numeric value.
- Treat finite numeric zero as real data.
- Treat empty series and series containing only `null`, `undefined`, or non-finite values as empty.
- Filter empty metrics before selecting summary cards or metric details.
- Replace all-null feature reports with one concise panel-level empty state.
- Prevent shared trend charts and series tables from rendering axes, baselines, null rows, or
  reporting badges when no observed values exist.
- Apply and verify the behavior on Connections, Campaigns, Inbox, Agent analytics, the workspace
  analytics overview, and the analytics playground.
- Preserve loading, service-error, and retry states as states distinct from an empty successful
  report.
- Add regression coverage for empty, zero-valued, partially populated, and fully populated reports.
- Verify desktop, tablet, and mobile behavior.

### Excluded

- Changes to Analytics API response contracts, metric definitions, source-state calculation, or
  report aggregation.
- Changes to analytics ingestion, publishers, outboxes, databases, or Railway configuration.
- New analytics metrics, date-range controls, chart libraries, or dashboard information
  architecture.
- Hiding genuine service errors or failed report requests behind an empty state.
- Redesigning admin analytics; this plan covers customer workspace analytics only.

## Context and constraints

- The Analytics API intentionally returns metric objects and expected time buckets even when every
  point has a `null` value. Backend states such as `not_instrumented` and coverage such as `0/30`
  remain valid diagnostic metadata.
- The client currently uses metric-object count and series length as proxies for data presence.
  That causes an all-null report to render em-dash cards, empty graphs, null table rows, and
  `Not Instrumented` / `Unknown · 0/30 points` badges.
- `AnalyticsTrendChart` briefly returned an empty state for an empty value list when introduced in
  commit `0c46c8f0`; commit `9a7db2d9` replaced that guard with a placeholder baseline. The cards,
  detail rows, and status badges were never covered by the intended panel-level behavior.
- The `vintage` branch is fully contained in `main` and has no analytics-only fix to restore. This
  work must complete the intended behavior on `main`.
- Existing API payloads and internal instrumentation metadata must remain intact for diagnostics.
  The change is a presentation and filtering correction.
- Reuse `AnalyticsEmptyState` and existing card/loading/error primitives. Do not add another empty-
  state component or native browser UI.
- Empty-state copy must remain concise. The default copy for a successful report without observed
  values is `No activity yet`.
- Shared-component changes must not turn an observed zero into an empty state or remove valid
  zero-value chart points and table rows.

## Affected implementation

| Area | Current problem | Required outcome |
| --- | --- | --- |
| `feature-analytics-panel.tsx` | Selects cards and details from every returned metric object. | Select and render only metrics with observed values; show one panel empty state otherwise. |
| `analytics-visualizations.tsx` | Draws a placeholder chart for all-null data and treats null-filled buckets as table rows. | Return a concise empty state or no visualization content when there are no observed values. |
| `analytics-feedback.tsx` | Correctly formats backend state, but callers expose diagnostic badges on empty reports. | Keep reusable badges available, but do not render them as empty-report content. |
| Agent analytics | Repeats unavailable status, em-dash cards, and empty metric details. | Follow the same observed-data filtering and panel-level empty-state rule. |
| Workspace overview | Converts missing values to zero and renders empty trend cards. | Distinguish missing data from observed zero and avoid fake activity. |
| Analytics playground | Uses the shared chart and table components. | Preserve diagnostic use while rendering all-null metric series intentionally. |

## Implementation checklist

### 1. Confirm boundaries and fixtures

- [x] Trace the shared feature analytics panel, feedback components, chart, and table rendering.
- [x] Identify current consumers in Connections, Campaigns, Inbox, Agent analytics, workspace
  overview, and analytics playground.
- [x] Confirm that `vintage` contains no missing implementation to merge.
- [x] Confirm the backend intentionally returns null-filled buckets and instrumentation metadata.
- [x] Capture representative fixtures for:
  - [x] no metric results;
  - [x] 30 returned buckets with only null values;
  - [x] observed zero values;
  - [x] mixed null and numeric values;
  - [x] a report containing both empty and populated metrics;
  - [x] a failed report request.

### 2. Add canonical observed-data helpers

- [x] Add a shared, side-effect-free predicate for a valid observed point.
- [x] Add a shared predicate for whether a metric has at least one observed value.
- [x] Add a helper for filtering observed points where a table or visualization requires it.
- [x] Ensure the predicates accept finite `0` and reject `null`, `undefined`, `NaN`, and infinite
  values.
- [x] Replace duplicated reverse-search and series-length checks in affected analytics components
  where doing so prevents inconsistent empty handling.
- [x] Keep denominator handling independent: a denominator must not make a metric appear populated
  when its report value is absent unless that metric's contract explicitly treats the denominator
  as the reported value.

### 3. Correct the shared feature analytics panel

- [x] Filter report metrics by observed values before calculating summary cards.
- [x] Select up to four summary cards from populated metrics, not from the first four raw results.
- [x] Render populated metric details only.
- [x] Show one `AnalyticsEmptyState` with `No activity yet` when no metric has observed data.
- [x] Remove empty-report em dashes, freshness badges, coverage badges, exactness labels, warnings,
  and expandable rows.
- [x] Keep the panel title, reporting period, timezone, loading skeleton, error state, and retry
  behavior intact.
- [x] Verify Connections, Campaigns, and Inbox inherit the corrected behavior without page-specific
  forks.

### 4. Correct shared charts and tables

- [x] Make `AnalyticsTrendChart` determine emptiness from observed finite values.
- [x] Prevent all-null data from drawing an SVG baseline, axes, grid, polyline, or fake date labels.
- [x] Ensure isolated null gaps do not create misleading line connections between unrelated
  observations; split segments or otherwise preserve gaps.
- [x] Keep observed zero points visible and correctly scaled.
- [x] Make `AnalyticsMetricSeriesTable` filter unobserved rows before rendering.
- [x] Show a concise empty state when no observed table rows remain.
- [x] Calculate denominator-column visibility from displayed rows.
- [x] Format valid dates safely and avoid throwing on malformed or absent bucket timestamps.
- [x] Keep chart and table labels accessible to screen readers.

### 5. Align specialized analytics surfaces

- [x] Apply the observed-data rule to Agent analytics summary cards and metric details.
- [x] Replace an entirely empty Agent report with one `No activity yet` state.
- [x] Do not expose aggregate source-availability badges when the report has no user activity;
  preserve genuine request/service errors separately.
- [x] Update workspace overview cards so missing data is not formatted as an observed zero.
- [x] Remove or collapse empty workspace trend cards instead of rendering placeholder charts.
- [x] Verify the analytics playground still supports inspecting populated metrics and presents
  all-null series intentionally without fake graphs or null rows.
- [x] Confirm no affected surface displays `Not Instrumented` or `Unknown · 0/30 points` as its
  primary empty-report UI.

### 6. Responsive and visual quality

- [ ] Desktop: verify card hierarchy, chart width, detail expansion, and empty-state spacing.
- [ ] Tablet: verify summary wrapping, chart/table layout, and detail controls.
- [ ] Mobile: stack content intentionally, prevent horizontal page overflow, and give dense tables
  an intentional scroll or compact treatment.
- [ ] Verify empty states do not leave oversized blank panels or duplicated borders.
- [ ] Verify light and dark theme contrast for populated charts and empty states.
- [ ] Verify focus, keyboard expansion, accessible names, and non-colour-only status communication.

### 7. Regression coverage

- [x] Extend analytics Playwright fixtures with all-null, observed-zero, mixed, and partial reports.
- [x] Add an authenticated feature-panel test proving an all-null response shows exactly one
  `No activity yet` state.
- [x] Assert the empty response does not show `Not Instrumented`, `Unknown`, `0/30 points`, em-dash
  metric cards, metric detail rows, SVG charts, or null-value table rows.
- [x] Add a test proving an observed zero remains visible as data.
- [x] Add a test proving populated metrics render when empty and populated metrics share one report.
- [x] Add or retain a test proving report failures use the error/retry state rather than the empty
  state.
- [x] Extend mobile coverage to check for horizontal overflow on an affected feature panel.

### 8. Documentation and release evidence

- [x] Document the presentation rule in the appropriate internal analytics architecture reference:
  backend source readiness is diagnostic metadata, while customer empty states depend on observed
  metric values.
- [x] Confirm public documentation change is not applicable because no public API or documented
  workflow contract changes.
- [x] Record the implementation commit SHA and validation output before closing the plan.
- [ ] Move this file to `docs/plans/completed/` only after implementation and required verification
  are complete.

## Acceptance criteria

- [ ] A successful report whose metrics contain no finite numeric values shows one `No activity
  yet` state in the relevant analytics panel.
- [ ] The same report shows no empty metric cards, fake charts, null-value table rows, freshness or
  coverage badges, instrumentation labels, or expandable metric details.
- [ ] A finite observed zero is displayed as `0` and is eligible for charts and tables.
- [ ] A partially populated report renders only populated metrics and does not let early empty
  metrics displace populated summary cards.
- [ ] Loading, empty, partial-data, full-data, and service-error states are visually and
  semantically distinct.
- [ ] Connections, Campaigns, Inbox, Agent analytics, workspace overview, and analytics playground
  all follow the same data-presence semantics.
- [ ] Populated charts remain readable, accurately scaled, accessible, and responsive.
- [ ] No affected page introduces horizontal overflow at supported mobile width.
- [ ] No Analytics API, schema, ingestion, database, or deployment contract changes are required.

## Verification checklist

- [x] Review changed files for duplicated data-presence logic and remove inconsistent checks.
- [x] Run targeted ESLint on the changed analytics components and tests.
- [x] Run `pnpm --filter client lint` (zero errors; one pre-existing warning remains in an unrelated file).
- [x] Run `pnpm exec tsc --noEmit`.
- [ ] Run `pnpm --filter client test:e2e:analytics` with authenticated analytics storage or test
  credentials.
- [x] Run `pnpm exec next build --webpack` (production build passes).
- [ ] Run `pnpm build:client` with the default Turbopack path; currently blocked by the environment
  failing to spawn its CSS worker with `Operation not permitted`.
- [ ] Visually verify empty, zero-valued, partial, and populated fixtures at desktop, tablet, and
  mobile widths.
- [ ] Record skipped or environment-blocked checks with the exact reason; do not mark the plan
  complete while a required behavior remains unverified.

## Release record

| Field | Decision |
| --- | --- |
| Change | Correct customer analytics empty-data detection and presentation. |
| Owner | Client frontend. |
| Risk | Standard: shared analytics components affect several customer surfaces. |
| Affected services and user surfaces | Client application; Connections, Campaigns, Inbox, Agent analytics, workspace overview, and analytics playground. Analytics API is read-only and unchanged. |
| Platform release version or release ID | Patch release; implementation commit `8aa93ce7` is the current checkpoint. Final platform release ID is to be recorded at release. |
| API/schema/migration changes | Not applicable. |
| Feature flag or rollout method | Normal client deployment after build and authenticated fixture verification; no feature flag planned. |
| Analytics events and success metrics | No event-contract change. Success is zero empty-report regressions and correct rendering of empty, zero, partial, and populated fixtures. |
| Logs, metrics, dashboards, and alerts | Not applicable; this introduces no new server operation or failure mode. Existing client request errors remain visible through the error state. |
| User, API, internal, and operational documentation | Add the internal display-semantics decision. Public/API/runbook changes are not applicable. |
| Validation evidence | ESLint and TypeScript pass; Webpack production build passes; anonymous analytics E2E passes; authenticated analytics E2E and visual checks remain blocked by the expired local workspace session. |
| Rollback or disable plan | Revert the client implementation commit and redeploy the previous client artifact. No data rollback is required. |
| Post-release review date | First business day after production deployment; record the actual date at release. |

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Empty report definition | A report is empty when none of its metric points contain a finite numeric value. | Client frontend | Decided |
| Zero values | Finite zero is observed data, not an empty state. | Client frontend | Decided |
| Internal source state | Preserve it in the API and diagnostics; do not use it as primary customer empty-state content. | Analytics and client | Decided |
| Empty-state copy | Use `No activity yet`; add no description unless a surface requires clarification. | Product/client | Decided |
| Backend changes | None expected; escalate only if a metric contract cannot distinguish missing from observed zero. | Analytics | Decided |
| Specialized panels | Agent analytics and workspace overview are included because they share the same defect pattern. | Client frontend | Decided |

## Notes and blockers

- Authenticated Playwright tests require either analytics test credentials or
  `.playwright/.auth/user.json`. The existing local storage file contains an expired session and
  redirected every authenticated test to Sign in. Refresh it with a verified workspace account or
  provide `ANALYTICS_PLAYWRIGHT_EMAIL` and `ANALYTICS_PLAYWRIGHT_PASSWORD` before marking the
  authenticated browser and visual checks complete.
- The default Turbopack production build is blocked in this environment because its CSS worker
  cannot bind a process port (`Operation not permitted`). The equivalent Webpack production build
  passes.
- No current external dependency blocks implementation.
