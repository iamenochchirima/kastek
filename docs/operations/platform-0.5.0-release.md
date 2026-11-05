---
title: Platform 0.5.0 release record
owner: platform engineering
last_reviewed: 2026-11-05
---

# Platform 0.5.0 release record

Change: Agents business workflows, after-hours assistance, validated customer follow-up,
recoverable tool failures, guarded context-overflow recovery, and current Agents/MCP integrations.
Growth publishes the combined revision 14 capability catalogue while retaining distinct historical
publication identities.

Owner: Enoch Chirima. Risk: high.

Affected services and surfaces: Agents API and Restate worker, Agents web application and website
widget; Growth API and its analytics worker. Growth web, Agency, Identity, Analytics, and Labs
source behavior do not change in this release.

Platform release ID: `0.5.0`. Release commit, Railway deployment/image IDs, Vercel deployment ID,
runtime binding digest, migration checksums, and post-release verification are recorded in
[`docs/operations/releases/platform-0.5.0-artifacts.json`](releases/platform-0.5.0-artifacts.json).

## Data and compatibility

Agents adds additive migrations `128_business_procedures.sql`,
`129_human_assistance_requests.sql`, and `130_customer_timeout_notices.sql`. Production is
currently at the verified migration 127 baseline. The API pre-deploy step applies 128–130 before
the new API starts. Growth database migrations are not applicable. Existing agent configuration,
permissions, contacts and receipts remain intact. Selected procedures are opt-in; existing agents
do not gain workflows or permissions automatically.

The release keeps the existing Agents task runtime identity and publishes compatible current
capability definitions. Runtime rollout preserves historical Growth publication revisions and
checks the exact reviewed manifest digest. Drain root admission during the paired API/worker
rollout, recheck accepted work, update bindings, and reopen admission only after readiness succeeds.

## Measurement, logs and documentation

Analytics events, metric names, dashboards and exporters: not applicable; no new Analytics producer,
Collector configuration or exporter is introduced. Existing bounded operation outcomes, receipts,
queue signals and structured errors remain the release evidence. Logs do not add customer message
bodies, contact values, secrets or credentials.

Current behavior and contracts are documented in the Agents business workflow, source-boundary,
product capability, Growth agent access, and public MCP/REST references. Public documentation and
the feature map change with the implementation. A new ADR is not applicable: this implements the
approved versioned-procedure architecture and retains the existing tool execution model.

## Validation and rollout

Validation records Node 24 builds, focused Agents workflow/contact/error/context checks, Growth API tests,
Growth frontend checks where source changed, contract checks, database migration evidence, import
boundaries, and the production smoke results. Database and external-channel acceptance use the
separately owned test environment; no test post is part of deployment.

Promote the same reviewed main commit. Railway watch paths select Agents API/worker and Growth API/
analytics worker; image-only services are not rebuilt. Deploy the Agents API migration before
bringing up the matching Agents worker. Keep new task admissions drained through runtime binding
preview/apply and health checks. Release the Agents web application from the same commit. Verify
health, API readiness, widget asset, signed-in UI, current publication identity, and that new
conversations use the updated runtime. Record any unverified external provider acceptance
explicitly.

## Rollback

Restore the preceding Agents API/worker and Agents web artifacts, Growth API/worker artifacts, and
the recorded prior runtime binding digest. Retain additive schema, workflow instances, customer
requests, contacts, and operation receipts. Do not retry uncertain external effects with new request
identities. Keep admissions drained until the restored API/worker pair and bindings are healthy,
then resume them. No destructive database rollback is required.

Post-release review: 6 November 2026, covering errors, task settlement, response latency, queue
health, widget delivery and MCP readiness.
