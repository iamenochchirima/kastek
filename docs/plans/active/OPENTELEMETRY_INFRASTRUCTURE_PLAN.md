# Vendor-Neutral OpenTelemetry Infrastructure Plan

**Status:** Active

**Owner:** KasiTek engineering

**Last updated:** 2026-08-27

## Objective

Establish a vendor-neutral observability foundation for KasiTek using OpenTelemetry APIs, SDKs,
semantic conventions, OTLP transport, and an OpenTelemetry Collector boundary. The application
services must be able to produce portable logs, traces, and metrics without importing an Axiom,
Datadog, New Relic, Elastic, or other backend-specific SDK.

Success means that local and staging environments can receive and inspect telemetry end to end,
the service code uses one documented telemetry contract, trace context crosses service and worker
boundaries, telemetry is redacted and bounded, and a future backend can be selected by changing
Collector or deployment configuration rather than rewriting application instrumentation.

This plan establishes infrastructure only. Axiom selection, credentials, datasets, dashboards,
retention, alert rules, and provider-specific queries are deliberately deferred to a later plan.

## Current implementation status

The repository now contains the complete repository-side server-side implementation slice. The Collector
boundary is checked in under `infra/observability/otel-collector/` with pinned profiles, OTLP
receivers, memory limits, batching, redaction, health checks, local Compose startup, a generic
production OTLP template with bounded queue/retry settings and error-preserving tail sampling, and
Railway deployment instructions.
The shared Rust crate initializes logs, traces, metrics, resources, W3C propagation, HTTP metrics,
correlation IDs, provider spans, background spans, and graceful shutdown. Outbound request context
is injected after entering the provider span, and legacy Rust log messages plus telemetry bootstrap
diagnostics are bounded and redacted before stdout/stderr or the OpenTelemetry bridge. Agents initializes the
Node SDK before service modules, enables HTTP/PG/Pino instrumentation with PostgreSQL enhanced
database reporting disabled, adds provider and Temporal
spans, propagates W3C/correlation context through Temporal, and retains a structured stdout
fallback. Direct Rust HTTP injection and the Agents Temporal activity context boundaries have
contract tests, including the Temporal payload-converter round trip. CI, tests, and internal
runbook/documentation updates are included.

Local code/configuration verification and the repository release record are complete. Actual staging deployment, Railway
service creation, and durable backend selection remain external gates. The repository must not
claim complete production observability until those gates are satisfied. The execution checklist
and [release record](./OPENTELEMETRY_INFRASTRUCTURE_RELEASE_RECORD.md) record the exact verification
evidence and the intentionally open gates.

## Scope

### Included

- A shared telemetry contract for logs, traces, metrics, resources, errors, and context.
- OpenTelemetry initialization and export for the Rust services:
  Core, Tenants, Analytics when deployed, and shared Rust crates.
- OpenTelemetry initialization and export for the Agents API, worker, and gateway.
- HTTP, database, background-job, provider-call, migration, and important lifecycle
  instrumentation.
- W3C trace-context propagation plus the existing application correlation ID.
- An OpenTelemetry Collector configuration and deployment boundary for local and hosted
  environments.
- Provider-neutral configuration, redaction, sampling, batching, retry, timeout, and shutdown
  behavior.
- Local and staging verification, failure-mode testing, documentation, and release evidence.

### Excluded

- Choosing or integrating Axiom or another commercial observability backend.
- Provider-specific dashboards, alert rules, query language, retention, billing, or access setup.
- Product analytics events and customer reporting. Those remain governed by the Analytics contracts.
- Browser/client telemetry in the first server-side infrastructure slice. The client may receive a
  later scoped plan after privacy, consent, sampling, and cost decisions are made.
- Replacing every existing log statement in one change. The migration must be incremental, but
  new and touched code must follow the contract.
- Building custom log storage, a custom telemetry protocol, or a custom log aggregation service.

## Context and current baseline

The repository now has a provider-neutral server-side OpenTelemetry implementation:

| Area | Current baseline | Target change |
| --- | --- | --- |
| Rust | Shared `server/crates/observability` crate using `log`, `env_logger`, JSON stdout, and Actix access logging. | OTel SDK initialization, OTLP export, W3C context, HTTP/worker/provider spans, operation/retry/dependency/queue metric helpers, and a compatibility bridge are implemented. |
| Agents | Fastify/Pino logging, application correlation IDs, and legacy console paths. | Early OTel bootstrap, HTTP/PG/Pino instrumentation, provider/Temporal spans, structured logging, redaction, and shutdown are implemented for server entrypoints. |
| Analytics | Product analytics facts and metrics are separate from infrastructure telemetry. | Add only service health and pipeline-operational telemetry; do not mix customer analytics facts into OpenTelemetry. |
| Client | No direct OpenTelemetry setup. | Keep outside the initial server-side slice. |
| Export | No durable provider has been selected. | OTLP Collector boundary, local/staging verification profiles, redaction, health, error-preserving tail sampling, and generic future-backend template are implemented; durable export is deferred. |
| Release identity | Local version metadata and release-process requirements exist, but no hosted artifact has been promoted. | Attach platform version, commit/artifact identity, service name, and environment to telemetry and record the exact implementation commits. |

The current deployment direction uses separate hosted services and GitHub Environments for
staging and production. The Collector must not collapse those environment boundaries or share
production credentials with staging.

## Target architecture

```text
Rust services ─┐
Agents services ─┼─ OpenTelemetry API/SDK ── OTLP ──► OpenTelemetry Collector
Local test app ─┘                                      │
                                                       ├─ debug/stdout exporter (local verification)
                                                       └─ provider exporter (future backend decision)
```

The service code owns instrumentation and portable attributes. The Collector owns transport
processing, resource normalization, batching, filtering, sampling policy where appropriate, and
the eventual provider exporter. Deployment configuration owns endpoints and credentials.

The Collector is the preferred production boundary because it allows the backend to change
without changing every service. Direct OTLP export from an application is acceptable as a local
fallback or temporary bootstrap, but it must not introduce a provider SDK or provider-specific
fields into application code.

## Design decisions

1. Use OpenTelemetry for the three operational signals: logs, traces, and metrics. Product
   analytics remains a separate system.
2. Use OTLP as the service-to-Collector transport. Default to the protocol supported by the
   selected SDK and document the chosen deployment value; HTTP/protobuf is the initial candidate
   where hosted networking makes HTTP simpler.
3. Use official OpenTelemetry semantic conventions for HTTP, database, messaging, exceptions,
   resources, and service identity. Add a KasiTek-specific attribute only when an official
   convention does not cover the operational need.
4. Keep the existing `correlation_id` as an application investigation field. Use W3C
   `traceparent` and OpenTelemetry trace/span IDs for distributed tracing.
5. Preserve structured stdout logging as a fallback during migration and when telemetry export is
   disabled. Export failure must not make the request or worker operation fail.
6. Use environment configuration for enablement, endpoint, protocol, headers, sampling, and
   resource metadata. No secrets or backend names belong in shared application libraries.
7. Make telemetry volume bounded: batch records, cap queues and attribute cardinality, redact
   sensitive values, and define behavior when the Collector is unavailable.
8. Start with server-side services and workers. Treat browser telemetry as a separate privacy and
   cost decision rather than silently enabling it.

## Implementation phases

### Phase 0 — Contract, inventory, and decisions

- Confirm the deployable service inventory and which services are enabled in each environment.
- Define the required resource attributes and service naming scheme.
- Define structured log fields, severity mapping, stable event names, bounded error codes, and
  exception representation.
- Define the trace boundaries for HTTP, database calls, provider calls, Temporal workflows and
  activities, queue work, webhooks, and migrations.
- Define redaction rules and prohibited fields, including credentials, authorization headers,
  tokens, message bodies, prompts, and unnecessary personal data.
- Decide which operational metrics are mandatory for each service and worker.
- Record ownership, risk, deployment topology, and unresolved Collector hosting questions.

### Phase 1 — Shared Rust observability foundation

- Extend `server/crates/observability` into the common Rust telemetry bootstrap.
- Pin compatible OpenTelemetry dependencies at the workspace level and keep provider-specific
  exporters out of the crate.
- Initialize resource metadata from environment and release build metadata.
- Configure trace, metric, and log providers with batch processing, bounded queues, timeout,
  retry, and graceful shutdown.
- Bridge or migrate the existing `log`/`env_logger` usage so existing structured logs can gain
  trace context without requiring an all-at-once rewrite.
- Add Actix HTTP server spans and status/error attributes.
- Add database, outbound HTTP, provider, migration, and background-work instrumentation where the
  libraries support it; add narrow manual spans around important boundaries where they do not.
- Keep liveness and readiness endpoints available even when telemetry export is disabled or the
  Collector is unavailable.
- Add unit and integration tests for initialization, field mapping, redaction, shutdown, and
  exporter failure.

### Phase 2 — Agents telemetry foundation

- Initialize the Node OpenTelemetry SDK before Fastify, database, Temporal, and gateway modules
  are loaded.
- Add HTTP/Fastify and PostgreSQL instrumentation where supported.
- Add manual spans around Temporal workflows/activities, provider calls, webhook handling,
  credential operations, migrations, and important lifecycle transitions.
- Connect Pino records to trace/span context and preserve `correlation_id`.
- Replace or wrap `console.log`, `console.warn`, and `console.error` in touched operational paths
  so they use the structured logger with stable event names and error codes.
- Configure flush and shutdown for API, worker, and gateway process lifecycles.
- Add tests that prove a request, provider call, queued job, and worker execution can be related
  by trace and correlation context.

### Phase 3 — Cross-service context propagation

- Inject and extract W3C trace context for internal and external HTTP boundaries where it is safe.
- Carry trace context and correlation context through Temporal headers and worker execution.
- Preserve correlation context across webhooks, retries, outboxes, and asynchronous handoffs.
- Never trust a caller-supplied tenant, user, or authorization field merely because it appears in
  telemetry context; authorization remains an application concern.
- Define behavior for missing, malformed, or oversized context headers.
- Add cross-service tests covering Core/Agents/Tenants boundaries and asynchronous work.

### Phase 4 — Collector infrastructure

- Create an explicit repository-owned Collector configuration directory under the infrastructure
  area selected for deployment; keep environment overlays separate and reviewable.
- Configure OTLP HTTP and/or gRPC receivers according to the deployment decision.
- Configure resource detection and normalization without overwriting authoritative service or
  release attributes.
- Add memory limiting, batching, retry, timeout, and queue behavior appropriate to the service
  size and hosting limits.
- Add redaction/filter processors for fields that must never leave the service boundary.
- Add a debug/stdout exporter for local verification and a non-production staging verification
  mode. Do not treat debug output as long-term production retention.
- Add Collector health, readiness, internal metrics, resource limits, and graceful shutdown.
- Validate configuration in CI and in the local stack.
- Document the provider exporter interface without adding a provider implementation in this plan.

### Phase 5 — Local and staging end-to-end verification

- Add local configuration that starts the Collector with a debug exporter and points all enabled
  services to it.
- Emit a synthetic request, database operation, background job, error, and metric from a safe test
  path; verify all expected signals arrive with service, environment, release, and context data.
- Verify traces connect across HTTP and asynchronous worker boundaries.
- Verify logs remain available through stdout when Collector export is disabled.
- Stop or corrupt the Collector connection and prove application requests, health checks, and
  worker processing remain functional within documented loss limits.
- Deploy the Collector and instrumented services to isolated staging only after staging resources,
  credentials, databases, queues, and domains meet the environment requirements.
- Run staging smoke tests using a staging release ID and record telemetry evidence.

### Phase 6 — Production readiness without provider selection

- Decide whether the Collector will run as a separate hosted service, a supported sidecar, or an
  equivalent isolated process. Record resource and network requirements.
- Define production secret and variable names without storing values in the repository.
- Define sampling, retention expectations, access control, incident access, and data deletion
  requirements at the platform level. Provider-specific implementation remains deferred.
- Document that production operational visibility is incomplete until a durable backend is selected
  and configured. A Collector debug exporter is not a production logging destination.
- Add a release gate that refuses to claim observability readiness when the configured Collector
  has no approved durable destination.

### Phase 7 — Documentation, CI, and handoff

- Update `docs/internal/operations/observability.md` with the implemented architecture and actual
  configuration names.
- Add a focused internal architecture or operations page for the Collector, service contract,
  redaction, troubleshooting, and local verification.
- Update local-development and environment documentation with safe telemetry setup.
- Add a release-process entry describing the telemetry evidence required for feature releases.
- Add CI checks for dependency/configuration validity, schema/field contract tests, redaction,
  builds, and Collector configuration validation.
- Record the release owner, implementation evidence, rollback action, and known gaps.
- Move this plan and its checklist to `docs/plans/completed/` only after implementation and
  verification are complete.

## Release impact record

This plan must use the following record when implementation begins and again for the release that
first enables it. The repository implementation record is:

```text
Change: Introduce vendor-neutral OpenTelemetry instrumentation and Collector infrastructure.
Owner: KasiTek engineering; provisional Collector incident owner: platform-ops.
Risk: standard for repository changes; high for production enablement until staging and durable-destination gates pass.
Affected services and user surfaces: Rust Core/Tenants/Analytics services, Agents API/worker/gateway/maintenance processes, and Collector deployment configuration; no direct user-interface behavior change.
Platform release version or release ID: local validation metadata 0.1.0; implementation tree edc63ee6; no release tag or deployed artifact.
API/schema/migration changes: not applicable; migration execution is instrumented but schemas are unchanged.
Feature flag or rollout method: OTEL_SDK_DISABLED, OTEL_EXPORTER_OTLP_* endpoint/protocol, resource metadata, and sampler environment variables; stdout fallback remains available.
Analytics events and success metrics: not applicable; operational telemetry remains separate from customer analytics.
Logs, metrics, dashboards, and alerts: OTLP logs/traces/metrics, Collector health, resource normalization, bounded processing, redaction, and runbook are implemented; durable dashboards/alerts are not yet configured.
User, API, internal, and operational documentation: internal observability, local development, environments, release process, and Collector runbook updated; public documentation not applicable.
Validation evidence: Rust and Agents checks passed; Collector profiles validated; local Rust all-signal smoke passed; CI includes the Rust/Agents/Collector container smoke path; staging was not available.
Rollback or disable plan: set OTEL_SDK_DISABLED=true or remove the OTLP endpoint while retaining stdout logs; promote the prior application artifact and restore the previous Collector configuration.
Post-release review date: before any staging or production promotion.
```

## Implementation evidence — 2026-08-27

The full command-level record is maintained in the [execution checklist](./OPENTELEMETRY_INFRASTRUCTURE_CHECKLIST.md).
The short result is: the initial implementation tree passed Rust formatting, workspace check,
shared-crate tests, and Clippy; the current targeted observability, analytics-producer, and
analytics-reporting tests pass; Agents type checking and the full test suite passed; all Collector profiles passed
validation; and the local Collector received Rust and Agents traces, logs, and metrics with
matching trace/span context and release metadata. The current full-workspace `cargo check
--workspace` and `cargo fmt --all -- --check` pass. One local Analytics maintenance PostgreSQL
test also fails to discover its quarantine work row. The public and
internal documentation builds passed after stale links were removed from the internal
documentation index and Admin Analytics reference.
The disabled-export Rust smoke also emitted both legacy `log!` and `tracing!` records to stdout
with `OTEL_SDK_DISABLED=true`.
The Rust W3C HTTP injection and provider-child context contract tests and Agents Temporal
activity-boundary correlation test passed; the latter also guards decoding of Temporal JSON string
payloads before restoring async context. Legacy Rust log redaction, raw provider-response removal,
and bounded webhook logging are covered by the implementation and targeted tests.
The CI workflow contains the containerized Rust plus Agents signal smoke and rejects new
operational Rust `log!` macros outside the smoke fixture. The legacy Actix access formatter, Rust
compatibility logger, provider response handling, and Agents exception telemetry apply the final
privacy bounds described in the checklist, including bounded/redacted bootstrap and stdio fallback
diagnostics and disabled PostgreSQL enhanced database reporting.

The Docker daemon was unavailable in this workspace, so the containerized smoke was not run
locally. Railway staging service creation, hosted end-to-end evidence, and durable backend,
provider-specific retention/access/dashboards/alerts, and retained release-ID search remain
external or deferred work. The complete repository-side evidence is in the [release record](./OPENTELEMETRY_INFRASTRUCTURE_RELEASE_RECORD.md).

## Verification and acceptance criteria

The implementation is complete only when all of the following are true:

- Every enabled server-side service identifies itself with a stable service name, platform
  version, commit/artifact identity, and environment.
- Logs, traces, and metrics are emitted through OpenTelemetry-compatible APIs or a documented
  compatibility bridge; no application package imports a backend SDK.
- A request and its downstream HTTP, database, provider, and worker operations can be correlated.
- Structured logs contain stable operational fields and do not expose prohibited data.
- Export is asynchronous and bounded; Collector or backend unavailability does not crash the
  service or block normal health endpoints.
- Local Collector debug output proves receipt of all enabled signals.
- Staging proves the same configuration against isolated resources and records release evidence.
- CI validates application builds, telemetry contract tests, redaction tests, and Collector config.
- Internal documentation describes what is implemented, how to disable it, and what remains
  blocked until a durable provider is selected.
- The first production release does not claim complete observability until it has an approved
  durable destination, access policy, retention policy, and operational owner.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Provider independence | Application code uses OpenTelemetry and OTLP only; provider configuration belongs at the Collector/deployment boundary. | KasiTek engineering | Decided |
| Collector topology | Use a separate same-project Railway service with private DNS unless platform testing proves a supported sidecar is more appropriate. | KasiTek engineering | Provisional; deployment not created |
| Initial transport | Use OTLP with HTTP/protobuf as the initial candidate where hosted networking makes HTTP simpler; confirm against selected SDKs and hosting. | KasiTek engineering | Provisional |
| Local destination | Use the Collector debug/stdout exporter for local end-to-end verification. | KasiTek engineering | Decided |
| Production destination | Select and configure a durable backend in a separate plan. | KasiTek engineering | Deferred |
| Browser telemetry | Excluded from the first server-side slice; require a separate privacy, consent, sampling, and cost decision. | KasiTek engineering | Deferred |
| Trace sampling | Production template uses `parentbased_always_on` at the service boundary and Collector tail sampling that retains errors plus a 20% baseline. | KasiTek engineering | Decided for the provider-neutral template |
| Retention and access | Platform-level access, separation, retention, and deletion requirements are defined; provider-specific roles and durations remain deferred. | KasiTek engineering | Baseline decided; provider implementation open |
| Ownership | Telemetry contract owner is KasiTek engineering; platform-ops is the provisional Collector incident owner until a named individual is assigned. | Repository owner | Provisional |

## Notes and blockers

- A durable production backend is intentionally not selected by this plan. Until one is configured,
  production telemetry can be validated but is not operationally retained.
- The Collector deployment topology is resolved as a separate same-project Railway service; service creation is still an external deployment gate.
- Dependency versions must be selected from the current Rust and Node toolchains during
  implementation and checked into the normal lockfiles.
- No `console.*` calls remain in `agents/src`; direct stderr is retained only for stdio and
  telemetry-bootstrap failure diagnostics, whose exception text is bounded and redacted.
  Production Rust operational log callsites have been migrated; the only remaining legacy macros
  are intentional smoke-fixture records guarded by CI.
