---
id: opentelemetry-infrastructure-release-record
title: OpenTelemetry Infrastructure Release Record
owner: KasiTek engineering
last_reviewed: 2026-08-27
status: repository evidence complete; hosted staging and durable-destination gates pending
---

# OpenTelemetry Infrastructure Release Record

This record is the release evidence for the provider-neutral server-side OpenTelemetry slice. It
does not approve production observability. Production approval requires the hosted staging and
durable-destination gates listed below.

## Change

Introduce portable OpenTelemetry logs, traces, metrics, resource identity, W3C propagation,
redaction, bounded export, Collector profiles, CI validation, and operational documentation for
the Rust services and Agents processes. Browser telemetry and commercial backend integration are
out of scope.

## Exact implementation commits

The repository implementation is split into reviewable commits:

| Area | Commit |
| --- | --- |
| Rust telemetry and Collector boundary | `9646b562` |
| Agents instrumentation | `a6794971` |
| CI signal and configuration validation | `9f175041` |
| Documentation and release gates | `124bbff2` |
| Operational metrics, queue age, and production sampling | `7f064cce` |

The exact implementation tree used for the repository smoke evidence is `7f064cce`. The current
branch may contain later product commits; those commits are not covered by this record and must be
retested before being promoted as one artifact.

## Release identity

```text
Platform version: 0.1.0 (local validation metadata)
Release tag: not created
Deployed artifact digest: not created
Collector configuration revision: 7f064cce
Deployment environment: local verification only
Staging release ID: not created
Production release ID: not created
```

## Repository verification evidence

- Rust formatting, workspace check, shared observability tests, and Clippy passed.
- Agents type checking and the full test suite passed: 418 tests passed and 43 were skipped.
- All four Collector profiles passed validation with the pinned Collector `0.158.0` binary, and
  the Compose configuration passed validation.
- The local Collector reached readiness and received Rust and Agents logs, traces, and metrics.
  The smoke signals carried service, environment, version, release, commit, trace, span, and
  correlation metadata where applicable.
- Export-disabled behavior, bounded/redacted exception fields, propagation seams, and telemetry
  contract tests passed.
- Public documentation build passed. The internal build compiles the observability page and its
  repository links, but remains blocked by an unrelated broken link in the user-edited
  `docs/internal/architecture/admin-analytics.md` to a removed plan. This infrastructure-only
  change has no public user/API behavior change, so public documentation content is
  `not applicable`.

## Hosted staging gates

The following actions require access to the Railway project and cannot be performed from this
repository:

| Gate | Required evidence | Status |
| --- | --- | --- |
| Create an isolated `otel-collector` staging service | Service ID, environment, image revision, health result | Pending external Railway action |
| Provision staging-only application resources | Service endpoints, database/queue/Temporal namespace, credentials, and domains are isolated from production | Pending external Railway action |
| Configure private OTLP transport | Application OTLP endpoint resolves only to the staging Collector; no production destination is reachable | Pending external Railway action |
| Deploy the exact tested artifact | Platform version, commit SHA, artifact digest, and Collector config revision recorded together | Pending external Railway action |
| Run staging smoke coverage | Health, readiness, request, provider, migration, worker, logs, traces, metrics, and correlation evidence | Pending external Railway action |
| Exercise Collector failure and recovery | Application remains available; bounded loss and restart recovery are recorded | Pending external Railway action |
| Approve durable retention and access | Backend, retention, deletion, access roles, dashboards, alerts, and operational owner | Separate provider-specific decision |

Do not mark these gates complete based on local debug output. The staging `debug` exporter is a
verification sink only and is not durable retention.

## Rollback and disablement

1. Set `OTEL_SDK_DISABLED=true` or remove the OTLP endpoint from the affected application service.
2. Confirm structured stdout logs and liveness endpoints remain available.
3. Stop or revert the Collector configuration if it is the failing component.
4. Promote the previously tested application artifact rather than rebuilding from an untracked
   source state.
5. Record the incident, lost-signal window, and follow-up owner in the release record.

## Approval

```text
Release owner: pending
Rollback procedure approved: pending
Staging evidence attached: no
Durable backend approved: no
Production observability approved: no
```
