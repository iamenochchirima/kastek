---
id: opentelemetry-infrastructure-release-record
title: OpenTelemetry Infrastructure Release Record
owner: KasiTek engineering
last_reviewed: 2026-08-27
status: repository evidence complete; hosted staging and durable-destination gates pending
tracking_issue: https://github.com/iamenochchirima/kasitek/issues/2
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
| Release record and local evidence | `a5aeaf74` |
| Remaining worker boundaries, event enforcement, and log bridge | `586f2444` |
| Event normalization contract tests | `64227832` |
| Disabled-export fallback, CI regression check, and documentation cleanup | `91d0598b` |
| HTTP and Temporal context-propagation contract tests | `eb06783f` |
| Provider-child propagation, Rust log redaction, and provider payload hardening | `deacc9e5` |
| Rust operational log migration and legacy-macro CI guard | `917b530d` |
| CI smoke-fixture exclusion correction | `dfff04d1` |
| Service-boundary test and Agents build CI coverage | `4ddec15b` |
| Bootstrap and stdio diagnostic redaction | `b0a0cf7d` |
| Explicitly disable PostgreSQL payload instrumentation | `edc63ee6` |
| Finish remaining Rust operational log migration and remove unnecessary display-name telemetry | `bf9f953d` |
| Add reproducible Railway Collector service definition | `988c93cb` |
| Validate the Railway Collector service definition in CI | `e99ad4e9` |
| Format committed Rust service code | `b2b9cedb` |
| Normalize one-shot Agents events and smoke trigger paths | `29eae0a8` |
| Use portable Python command for Collector validation | `198c1c5c` |

The exact implementation tree used for the repository smoke evidence is now
`198c1c5c` (`198c1c5c` is the current repository-side implementation commit). The Collector
configuration content is unchanged from `7f064cce`; the Railway service definition is recorded in
`988c93cb`. The current tree includes the follow-up worker,
event-contract, compatibility-boundary, disabled-export fallback, documentation, and
context-propagation, provider-child propagation, log-redaction, operational-log migration,
bootstrap/stdio diagnostic-redaction, explicit PostgreSQL payload-instrumentation disablement, and
the final remaining operational log migration changes. The current
branch may contain later product commits; those commits are not covered by this record and must be
retested before being promoted as one artifact.

## Release identity

```text
Platform version: 0.1.0 (local validation metadata)
Release tag: not created
Deployed artifact digest: not created
Collector configuration revision: 7f064cce
Railway service definition revision: 988c93cb
Deployment environment: local verification only
Staging release ID: not created
Production release ID: not created
```

## Repository verification evidence

- The initial implementation tree passed Rust formatting, workspace check, shared observability
  tests, and Clippy. Its shared observability test count was 9. The current tree passed
  `cargo test -p observability --lib` (12 tests), `cargo test -p analytics-producer --lib` (14
  tests), and `cargo test -p analytics-reporting --lib` (4 tests); Analytics unit and ingestion
  tests pass, while the
  local maintenance PostgreSQL test does not discover its quarantine work row.
- Agents type checking, production build, and the full test suite passed after the propagation
  regression fix: 421 tests passed and 43 were skipped. The Temporal activity-boundary test
  verifies JSON string payload decoding before async correlation context restoration. CI now runs
  the same Agents build and the affected Rust service suites.
- The disabled-export Rust smoke emitted both legacy `log!` and `tracing!` records to stdout with
  `OTEL_SDK_DISABLED=true`, confirming the fallback remains visible without an OTLP endpoint.
- All four Collector profiles passed validation with the pinned Collector `0.158.0` binary, and
  the Compose configuration passed validation.
- The local Collector reached readiness and received Rust and Agents logs, traces, and metrics.
  The smoke signals carried service, environment, version, release, commit, trace, span, and
  correlation metadata where applicable.
- Export-disabled behavior, bounded/redacted exception fields, legacy Rust log redaction,
  provider-response payload hardening, propagation seams, bootstrap/stdio diagnostic redaction,
  disabled PostgreSQL enhanced database reporting, and telemetry contract tests passed.
- The shared Rust W3C HTTP injection test passed with `traceparent` and `tracestate`, and the
  provider-child regression test confirmed request construction observes the dependency span.
  The Agents Temporal activity-boundary test passed with bounded correlation context.
- A clean checkout of the committed observability tree passes `cargo fmt --all -- --check`, the
  shared observability tests, and Clippy. A clean `cargo check --workspace` is currently blocked
  by three unrelated organization/analytics symbols split across the committed tree and the
  user's uncommitted product changes (`enqueue_organization_scope_definition` and two
  `create_org` call sites). The mixed working tree does pass `cargo check --workspace`, with one
  pre-existing unused-parameter warning in Tenants; that mixed state is not a releasable artifact.
  The Core suite passed with 190 tests and 3 ignored, the Analytics suite passed with 66 tests,
  and the Tenants binary suite passed with 5 tests. The observability CI workflow now rejects new
  operational Rust `log!` macros outside the smoke fixture and runs when the Agents local OTel
  smoke script changes, and validates the Railway JSON with `python3`.
- Public and internal documentation builds passed after removing stale links from the internal
  documentation index and Admin Analytics reference. This infrastructure-only change has no
  public user/API behavior change, so public documentation content is `not applicable`.

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
