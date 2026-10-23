---
owner: engineering
last_reviewed: 2026-10-23
---

# Feature map

This is the index of user-facing routes currently present in Growth. The Agency tenant portal
and central Admin UI live in their owning monorepo directories and are outside this Growth route map.

For local startup, environment, and test commands, use [Local Development](../internal/development/local-development.md).
The main client runs on port `3000`; the other app ports and service prerequisites are listed in
that guide.

## Main client

Routes below are under `web/src/app/`.

| Feature area | User entry point | Source route | Verification starting point |
| --- | --- | --- | --- |
| Shared login | `/login`, `/signup`, `/auth-error`, `/onboarding`, `/invite/<token>`, workspace Account security | `(auth)/`, `onboarding/`, `invite/`, `components/auth/` | Provider login, registration and account management use Labs Keycloak through Core. [Frontend contracts and verification](../internal/development/shared-login-frontend.md). Browser verification requires the configured Labs identity runtime, Core database and email delivery; Google additionally needs its configured OAuth client. |
| Agents and general assistant | `/agents`, `/agents/conversations/<id>`, dashboard quick access; contextual content/campaign/report actions | `(dashboard)/agents/`, `components/dashboard/agents/` | Four defaults and their managed model provision through durable setup. Growth-owned presets share configurable permitted tools for business context, content/campaign discovery and reads, explicit-range analytics, and exact reviewed content DRAFT saves. Multi-record evidence retains current access checks. Operator-controlled managed-default upgrades preserve customisations; saved settings apply to future turns. Authorized task capture supports owner-run evaluations. [Integration setup](../../../agents/docs/growth-integration.md) and the controlled `growth-product-http.test.ts` journey exercise the actual UI, Growth BFF, signed shared HTTP, Restate and Growth record readback. Model evaluations and live-provider acceptance remain owner-run. |
| Campaigns | `/campaigns` | `(dashboard)/campaigns/page.tsx` | Run the client locally, open the route, then follow the task's real campaign path and inspect its visible/API result. |
| Contacts | `/contacts` | `(dashboard)/contacts/page.tsx` | Run the client locally, open the list and a contact detail, and verify the requested change in the UI and its backing API. |
| Inbox | `/inbox` | `(dashboard)/inbox/page.tsx` | Run the required local services, open the inbox, and verify the conversation action and resulting state. |
| Calendar and bookings | `/calendar`, `/bookings` | `(dashboard)/calendar/page.tsx`, `(dashboard)/bookings/page.tsx` | Open the route with the required service and test data available; verify the visible event or booking and its persisted result. |
| Content | `/content`, `/content/posts`, `/content/calendar`, `/content/history` | `(dashboard)/content/` | Open the relevant route and verify the content state plus the API side effect for the task. |
| Analytics | `/analytics` | `(dashboard)/analytics/page.tsx` | The Growth client requests Analytics catalog and report data through its `/api/analytics` routes. Analytics service source and local setup live in Labs. This source move preserves the Growth client routes and configured endpoint; it does not verify a live report response. |
| Workspace | `/workspace`, `/workspace/team`, `/workspace/settings`, `/workspace/profile` | `(dashboard)/workspace/` | Open the relevant route with an authorized local account and verify the saved state after navigation or reload. |
| Billing | `/billing`, `/upgrade` | `(dashboard)/billing/page.tsx`, `(dashboard)/upgrade/page.tsx` | Use a test account and the configured billing test environment; do not use live payment credentials for local verification. |
| Developer surfaces | `/developers`, `/developers/api`, `/developers/cli`, `/developers/mcp` | `(dashboard)/developers/` | Verify against the documented local service and credentials for the specific developer workflow. |

## Central admin integration

The separate `apps/admin-site` client exposes `/analytics`, `/analytics/customers`,
`/analytics/adoption`, `/analytics/usage`, `/analytics/revenue`, `/analytics/reliability`, and
`/reports`. `/operations` adds persistent incident detection and monitor coverage for Growth,
Agents, Agency, and Analytics, alongside the existing reporting diagnostics and recovery controls. Customer name/ID search filters bounded records; selecting a
result opens its owning product scope. Growth supplies scoped organization, usage, billing, and safe customer metadata through
`GET /api/admin/reporting`. Agents and Agency remain independent HTTP sources. Growth's main
`/analytics` route above remains customer-facing and is not this privileged admin.

The [admin reporting reference](../internal/architecture/admin-analytics.md) maps the boundaries.
Verification starts with `products/growth/api/tests/admin-reporting-source.test.ts`, shared
reporting tests, and `apps/admin-site/tests/admin-report-format.test.ts`. Browser verification
covers product and organization filters, permitted metric detail, source outages, private saved
scopes, audited CSV and the worker-pause/source-outage recovery paths against the dedicated
development services. The [operational profile](../../../../docs/operations/admin-reporting.md#dedicated-development-profile)
keeps product databases and the existing Agents app separate. Model evaluations remain
owner-run.

## Map rules

- Add or change a feature entry in the same pull request as shipped user behavior.
- Describe current behavior only. Specs and planned work live in the selected issue tracker.
- For a feature without a runnable local path, name the missing service, credential, or test data
  instead of claiming it was verified.

### Administrative customer operations

The separate Labs admin exposes `/customers` and `/customers/:product/:customerId` for current
account facts and scoped recovery. Growth owns pure credit/entitlement projections, failed webhook
replay with two distinct approvals, durable receipts and scoped support-access audits. Agents and
Agency own their respective APIs over HTTP. Metadata and actions are development-only and
independently gated. Verification uses `products/growth/api/tests/admin-customers.test.ts` and
`scripts/customer-operations-smoke.mjs`; model/product eval execution remains with the owner.
See [the operations runbook](../../../../docs/operations/admin-customer-operations.md).

### Incident and operations centre

The Labs admin exposes `/operations`, `/operations/incidents/:id`, `/operations/settings`, and
`/operations/audit`. Operators investigate incidents, assign ownership, acknowledge conditions,
manage scoped maintenance, and follow existing customer recovery links. Operations owns its
independent admin sessions, durable worker, and database. Growth exposes pure source signals,
authorized audit metadata, and an idempotent in-app notification bridge. Notification read state
is recipient-scoped and does not acknowledge an incident.

Focused verification starts with `services/operations/tests/engine.test.ts`, identity fixtures,
`services/operations/tests/telemetry.test.ts`, and the shared/source operation tests. Actual
development HTTP and browser evidence belong to the release handoff. Evals remain owner-run.
See the [incident-centre reference](../../../../docs/operations/incident-centre.md).
