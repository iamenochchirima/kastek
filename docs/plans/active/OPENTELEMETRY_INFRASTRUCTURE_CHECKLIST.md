# Vendor-Neutral OpenTelemetry Infrastructure Checklist

**Status:** Active — repository implementation and release record are complete; hosted staging and durable-backend gates remain open.

**Owner:** KasiTek engineering

**Last updated:** 2026-08-27

This checklist executes [the OpenTelemetry infrastructure plan](./OPENTELEMETRY_INFRASTRUCTURE_PLAN.md).
It covers the infrastructure and application instrumentation boundary only. Do not mark the work
complete until the implementation evidence and release record exist.

`[x]` means implemented and verified in this repository. `[ ]` means an external gate, an
unresolved platform decision, or work intentionally deferred to the provider-specific follow-up.
The plan remains under `docs/plans/active/` until the staging evidence and release owner approval
exist.

## 0. Scope and ownership

- [x] Confirm this work is provider-neutral and does not add Axiom, Datadog, New Relic, Elastic,
      Splunk, or another backend SDK.
- [x] Assign an owner for the telemetry contract: KasiTek engineering.
- [x] Assign a provisional operational owner for Collector availability and telemetry incidents:
      platform-ops until a named individual is assigned.
- [x] Confirm the enabled service inventory for local, staging, and production:
      Core, Tenants, Analytics when deployed, Agents API, Agents worker, and Agents gateway.
- [x] Record browser/client telemetry as a separate follow-up rather than enabling it implicitly.
- [x] Create and link the implementation issue: [#2](https://github.com/iamenochchirima/kasitek/issues/2).
- [x] Create the repository release record at
      `docs/plans/active/OPENTELEMETRY_INFRASTRUCTURE_RELEASE_RECORD.md`.
- [x] Classify the implementation risk and identify whether production enablement requires an
      approval gate.

## 1. Telemetry contract

### Service identity and resources

- [x] Define stable `service.name` values for every deployable process.
- [x] Define `service.version` from the platform release/runtime metadata.
- [x] Define the deployment environment attribute and values for local, staging, and production.
- [x] Attach the platform release ID, commit SHA, or artifact digest without relying on log prose.
- [x] Define process, host/container, and deployment metadata that is safe and useful.
- [x] Document which resource attributes are authoritative and must not be overwritten by the
      Collector.

### Logs

- [x] Define structured log fields for timestamp, severity, service, environment, release,
      operation, outcome, error code, trace ID, span ID, and correlation ID.
- [x] Define the stable lowercase dot-separated event vocabulary and enforce its syntax at the
      Agents logger boundary.
- [x] Apply stable events to modified Agents paths and the Core/Tenant worker, source-backfill,
      Analytics outbox, and Analytics projection boundaries.
- [x] Migrate the legacy Rust `log!` callsites for startup, shutdown, request completion, provider
      call, retry, migration, queue transition, and terminal-failure paths. Only the two
      observability smoke-fixture records retain `log!` macros, and CI rejects new operational
      Rust `log!` macros.
- [x] Define severity mapping across Rust `log`/`tracing` and Agents/Pino.
- [x] Define exception type, message, stack, and cause fields with bounded sizes.
- [x] Define attribute cardinality limits and fields that must remain in the body instead of
      indexed attributes.
- [x] Define prohibited data: secrets, tokens, authorization headers, cookies, message bodies,
      prompts, raw provider responses, and unnecessary personal data.
- [x] Add redaction tests for representative credential and provider fields, including bounded
      legacy Rust `log!` messages; webhook and user payload tests remain limited to the existing
      request/serializer contract.

### Traces and metrics

- [x] Define HTTP server/client, database, provider-call, webhook, migration, queue, Temporal,
      and worker span boundaries.
- [x] Define required span status and error recording behavior.
- [x] Define and implement the minimum metric set at each instrumented boundary: request/job
      count, error count, latency, in-flight work, queue age, retries, and dependency failures;
      resource saturation is owned by the Collector/host platform. Queue age and retry metrics are
      emitted by the Agents outbox owner, and the shared operation helpers cover Rust boundaries.
- [x] Extend metric wiring to the current Core/Tenant worker and source-backfill loops, Analytics
      outbox publisher, Analytics projection processor, and their retry/dependency boundaries.
      Queue age remains limited to queues that expose an enqueue timestamp.
- [x] Keep product analytics metrics separate from service health metrics.
- [x] Define metric units, names, attributes, and cardinality limits using OpenTelemetry conventions.
- [x] Define baseline trace sampling and error-preserving behavior for production: application
      traces reach the Collector and the production template retains all error traces plus a 20%
      probabilistic baseline.

## 2. Rust implementation

- [x] Extend `server/crates/observability` as the single Rust telemetry bootstrap.
- [x] Add compatible OpenTelemetry dependencies at the workspace level and update lockfiles.
- [x] Keep backend/provider SDKs out of Rust application crates and shared libraries.
- [x] Initialize resources from environment and build/release metadata.
- [x] Configure trace, metric, and log providers with batch processing, bounded queues, timeouts,
      retries, and graceful shutdown.
- [x] Bridge existing `log`/`env_logger` records or migrate the shared logging path so records
      include trace/span context where available.
- [x] Add Actix request spans with route, method, status, duration, and bounded error information.
- [x] Add database spans and metrics for important SQL operations without recording query values,
      credentials, or sensitive parameters.
- [x] Add outbound HTTP/provider spans with provider name, operation, status, retry, and duration;
      inject W3C context after entering the provider span, and do not record tokens, authorization
      headers, raw provider responses, or full payloads.
- [x] Add migration and background-worker instrumentation where applicable.
- [x] Make exporter setup configurable and safe when disabled.
- [x] Ensure liveness and readiness endpoints do not depend on successful telemetry export.
- [x] Add Rust unit tests for resource mapping, log mapping, redaction, provider-child propagation,
      sampling, and disabled
      exporter behavior.
- [x] Add a Rust signal smoke fixture proving a representative span, log, and metric reaches the
      local Collector; a full live HTTP/database integration remains a staging gate.

## 3. Agents implementation

- [x] Add the Node OpenTelemetry SDK and initialize it before Fastify, PostgreSQL, Temporal, and
      gateway modules load.
- [x] Add compatible HTTP/Fastify and PostgreSQL instrumentation.
- [x] Disable PostgreSQL enhanced database reporting so query parameters and result data do not
      enter telemetry spans.
- [x] Add manual spans for Temporal workflows and activities where automatic instrumentation is
      insufficient.
- [x] Add manual spans for provider calls, webhook processing, credential operations, migrations,
      retries, and lifecycle transitions.
- [x] Connect Pino records to trace/span context and preserve `correlation_id`.
- [x] Establish a structured logger wrapper for operational paths.
- [x] Inventory existing `console.log`, `console.warn`, and `console.error` calls.
- [x] Migrate touched operational paths from console output to the structured logger.
- [x] Define and test behavior for remaining legacy console output during the migration period:
      no `console.*` calls remain in `agents/src`; stdio and telemetry fallback diagnostics use
      direct stderr intentionally, with bounded/redacted exception text.
- [x] Configure API, worker, and gateway shutdown hooks to flush telemetry without hanging process
      termination.
- [x] Add tests for HTTP requests, provider failures, webhook handling, Temporal execution, and
      correlation context where existing test seams permit; live Temporal/provider tests remain
      environment-dependent.

## 4. Context propagation

- [x] Use W3C `traceparent` propagation for supported internal HTTP calls.
- [x] Define whether and how `tracestate` is preserved: the W3C propagator preserves it when
      present; unsupported or malformed values are ignored.
- [x] Continue propagating `x-correlation-id` for application investigation and support workflows.
- [x] Ensure new correlation IDs are generated only when one is not already present and are bounded.
- [x] Carry trace and correlation context through Temporal headers and worker execution.
- [x] Carry correlation context through outboxes, retries, provider callbacks, and webhooks.
- [x] Define behavior for missing, malformed, untrusted, or oversized context headers.
- [x] Verify tenant, user, and authorization decisions never rely on telemetry context.
- [ ] Add live cross-service tests for Core/Agents/Tenants and asynchronous worker paths; source
      propagation seams and local signal tests exist, but no staging topology is available yet.

## 5. Collector infrastructure

- [x] Select and document the repository infrastructure directory for Collector configuration:
      `infra/observability/otel-collector/`.
- [x] Add a pinned Collector Dockerfile and provider-neutral baseline configuration.
- [x] Add a local Compose entrypoint with OTLP and health ports.
- [x] Document the same-project Railway service deployment shape and private endpoint.
- [x] Add a reproducible service definition at
      `infra/observability/otel-collector/railway.json` for the pinned image, health check, and
      restart policy; resource sizing and service creation remain external deployment decisions.
- [x] Validate the configuration with the pinned Collector binary.
- [x] Run the Collector and verify its health endpoint reaches the ready state.
- [x] Add versioned local, staging, and production Collector configuration overlays.
- [x] Configure OTLP HTTP and gRPC receivers; hosted protocol selection remains HTTP/protobuf.
- [x] Configure resource normalization without replacing application service or release identity.
- [x] Add memory limiting and bounded batching.
- [x] Add retry, timeout, queue, and backpressure behavior in the production template.
- [x] Add redaction/filter processors for prohibited fields that reach the Collector.
- [x] Add a local debug/stdout exporter.
- [x] Add a staging verification exporter that does not require a commercial backend: the checked-in
      staging profile uses `debug` and is explicitly non-durable.
- [x] Do not add provider credentials, provider-specific datasets, or commercial exporter config
      to the provider-neutral baseline.
- [x] Add Collector health and readiness endpoints.
- [x] Enable Collector internal metrics and document what they mean.
- [x] Define baseline CPU, memory, queue, and network limits for the hosted Collector profile;
      Railway resource sizing remains an external deployment decision.
- [x] Define graceful shutdown and behavior during Collector restarts.
- [x] Validate every Collector configuration in CI.
- [x] Resolve the hosted topology decision: use a separate same-project Railway Collector service
      per environment; service creation remains an external deployment gate.

## 6. Local development

- [x] Add a safe local telemetry configuration with no production endpoint or credentials.
- [x] Start the Collector from the documented local stack path; the official `0.158.0` binary was
      used locally because the Docker daemon is unavailable in this workspace.
- [x] Point enabled Rust and Agents services at the local Collector using environment variables.
- [x] Emit the complete synthetic HTTP, database, provider, worker, error, and metric set; both
      checked-in smoke fixtures exercise those boundaries without real credentials or customer
      data. Live DB/provider/worker execution remains environment-dependent.
- [x] Verify logs, traces, and metrics appear in Collector debug output.
- [x] Verify service, environment, version, commit, trace, span, and correlation fields where
      applicable; the Rust smoke proves release/resource and log trace/span identity.
- [ ] Verify trace relationships across HTTP and asynchronous work in a live multi-service stack;
      direct Rust HTTP injection and Agents Temporal activity-boundary contract tests now pass,
      while live multi-service evidence remains a staging gate.
- [x] Disable telemetry export and verify the services retain their stdout fallback by endpoint
      omission and `OTEL_SDK_DISABLED` handling.
- [x] Document behavior when the local Collector stops: application work continues and bounded
      telemetry batches may be lost.
- [x] Confirm no generated telemetry fixture contains credentials or personal data before commit.

## 7. Staging and hosted environments

- [ ] Create an isolated staging Collector service/process.
- [ ] Use staging-only service endpoints, databases, queues, Temporal namespace, credentials, and
      domains.
- [x] Document non-secret staging variables for OTLP endpoint, protocol, enablement, sampling, service
      identity, environment, and release metadata.
- [x] Document that any transport authentication belongs only in the staging secret store; no
      secret values are in source control.
- [x] Define the staging boundary so it cannot send telemetry to a production destination.
- [ ] Deploy the exact staging-tested artifacts with platform version and commit identity.
- [ ] Run staging health, readiness, smoke, request, worker, provider, and migration checks.
- [ ] Verify Collector receipt and context correlation using the staging release ID.
- [ ] Stop/restart the Collector and test service behavior, queue bounds, and recovery.
- [ ] Record staging evidence in the release record.
- [x] Document that a Collector debug exporter is verification-only and not durable production
      retention.
- [x] Do not mark production observability complete until a durable backend, access policy,
      retention policy, and operational owner are approved in a separate provider plan.

## 8. Security, privacy, and reliability

- [x] Review every logged attribute for secrets, tokens, authorization material, message content,
      prompts, and personal data.
- [x] Add automated redaction tests for Agents and Collector processing; Rust uses the shared
      compatibility bridge and bounded request/span fields.
- [x] Bound and redact Rust telemetry bootstrap diagnostics and Agents telemetry/stdio fallback
      diagnostics before writing directly to stderr.
- [x] Set maximum message, exception, attribute, and header sizes.
- [x] Set maximum queue sizes and define drop behavior when buffers fill.
- [x] Ensure telemetry export uses timeouts and cannot block user requests or worker progress.
- [x] Ensure telemetry failures are visible through safe local diagnostics without recursive log
      storms.
- [x] Define provider-neutral access-control requirements for telemetry configuration and future
      backend access; concrete identity-provider roles remain a provider/deployment decision.
- [x] Define provider-neutral retention and deletion requirements before provider enablement;
      concrete durations and deletion APIs remain a provider/deployment decision.
- [x] Review sampling for error visibility, security investigations, and support workflows before
      production; the production template uses error-preserving tail sampling and the release
      record requires the deployed sampling decision.
- [x] Verify health endpoints distinguish process liveness from dependency readiness.
- [x] Document incident steps for exporter failure, Collector failure, telemetry leakage, and
      excessive telemetry volume.

## 9. CI and verification

- [x] Add Rust formatting, lint, unit, integration, and build checks for telemetry changes.
- [x] Add Agents type, test, and build checks for telemetry changes; lint is not a separate existing
      repository command.
- [x] Validate Collector configuration syntax and required receivers/processors/exporters.
- [x] Add contract tests for resource fields, log fields, span relationships, and metric names.
- [x] Add redaction and prohibited-field tests.
- [x] Add exporter-disabled handling and document Collector-unavailable behavior; a live outage
      test remains environment-dependent.
- [x] Add an end-to-end local test that captures all enabled signals from at least one Rust and one
      Agents service.
- [x] Add a local/CI release smoke assertion that searches Collector output by platform release
      ID; a durable-backend search remains a staging/provider gate.
- [ ] Add a durable release smoke test that searches retained telemetry by platform release ID
      after a backend is approved.
- [x] Record commands, versions, evidence locations, and skipped checks in this file, the plan,
      and the [release record](./OPENTELEMETRY_INFRASTRUCTURE_RELEASE_RECORD.md).

## 10. Documentation and release integration

- [x] Update `docs/internal/operations/observability.md` with the implemented architecture,
      service contract, and actual status.
- [x] Add an internal Collector operations/runbook document with startup, health, failure,
      redaction, restart, and recovery procedures.
- [x] Update `docs/internal/development/local-development.md` with safe local telemetry setup.
- [x] Update `docs/internal/operations/environments.md` with staging/production Collector
      boundaries and secret handling.
- [x] Update the canonical release process if the telemetry release gate changes.
- [x] Add telemetry evidence fields to the feature/release record: logs, metrics, traces,
      Collector health, and rollback behavior.
- [x] Public documentation: record `not applicable` for this infrastructure-only change unless a
      user-visible troubleshooting or API behavior changes.
- [x] Analytics events: record `not applicable`; operational telemetry is not customer analytics.
- [x] Versioning: record the platform release tag, commit, artifacts, and Collector configuration
      revision used for staging and production.
- [x] Rollback: document exporter disablement, previous artifact promotion, and Collector config
      rollback.
- [x] Internal documentation build and full link validation pass; stale links in the internal
      documentation index and Admin Analytics reference were removed, and both Docusaurus builds
      now pass.

## 11. Completion gate

- [ ] All plan acceptance criteria are satisfied.
- [x] Local end-to-end evidence is attached to the implementation record.
- [ ] Staging end-to-end evidence is attached to the release record.
- [x] Known gaps and deferred provider work are explicitly recorded.
- [x] Production readiness is not claimed without a durable approved destination.
- [ ] The final platform release identity and deployed artifact identity are recorded.
- [ ] The owner approves the rollback and incident procedure.
- [ ] Move the plan and checklist from `docs/plans/active/` to `docs/plans/completed/` only after
      implementation and required verification are complete.

## Implementation evidence — 2026-08-27

Repository evidence for the implementation slice:

- Initial implementation tree: `cargo fmt --all -- --check`, `cargo check --workspace`,
  `cargo test -p observability` (9 passed), and
  `cargo clippy -p observability --all-targets --all-features -- -D warnings` passed.
- Current targeted Rust verification: `cargo test -p observability --lib` (12 passed),
  `cargo test -p analytics-producer --lib` (14 passed), `cargo test -p analytics-reporting --lib`
  (4 passed), `cargo test -p kasitek-core --lib` (190 passed, 3 ignored),
  `cargo test -p kasitek-analytics --lib` (66 passed), and `cargo test -p kasitek-tenants` (5
  passed). The local Analytics maintenance PostgreSQL test remains failing at its quarantine-work
  assertion; the Tenants binary test emits a pre-existing unused-parameter warning.
- Agents: `pnpm exec tsc -p tsconfig.json --noEmit`, `pnpm test`, and `pnpm run build` passed (75
  test files passed, 17 skipped; 421 tests passed, 43 skipped). The Temporal activity-boundary
  test verifies that JSON-encoded string headers are decoded before correlation context is
  restored. The observability CI workflow now runs the affected Rust service suites and the Agents
  build in addition to the shared telemetry checks.
- Disabled-export fallback: `OTEL_SDK_DISABLED=true LOG_FORMAT=json RUST_LOG=info cargo run
  -p observability --example otel-smoke` emitted both legacy `log!` and `tracing!` records to
  stdout without attempting an OTLP connection.
- Collector: `docker compose -f infra/observability/otel-collector/compose.yaml config --quiet`
  passed. The pinned Collector `0.158.0` binary validated `config.yaml`, `config.local.yaml`,
  `config.staging.yaml`, and `config.production.template.yaml` with placeholder template values.
- Local signal smoke: the official Collector binary reached `/` ready state and received Rust
  and Agents traces, logs, and metrics. Both smoke fixtures carried `service.name`, environment,
  `service.version=0.1.0`, release ID, and commit SHA; logs and spans shared trace/span context.
  The Collector shut down cleanly after the capture.
- Privacy hardening: the legacy Actix access formatter now excludes raw URLs, query strings,
  remote addresses, referers, and user agents. Rust legacy log messages and telemetry bootstrap
  diagnostics are bounded and redact common credential forms before stdout/stderr or the
  OpenTelemetry bridge. Agents PostgreSQL enhanced database reporting is disabled; touched provider
  paths omit raw response bodies and webhook payloads.
  Agents exception messages, stacks, telemetry-bootstrap diagnostics, and stdio fallback errors
  redact common credential forms before they are recorded or returned.
- Boundary completion: `tracing_log::LogTracer` now bridges legacy Rust `log!` records into the
  OpenTelemetry subscriber when export is enabled; the Core/Tenant source-backfill loops and
  Analytics projection/outbox boundaries now record shared operation metrics and stable events.
  The Rust W3C HTTP injection and provider-child context contract tests and Agents Temporal
  activity-boundary propagation test also pass; live multi-service trace relationship evidence
  remains a staging gate. All production Rust operational log callsites now use the shared
  structured tracing API; CI rejects new legacy macros outside the smoke fixture.
- Documentation: public and internal Docusaurus builds passed. The internal documentation index
  and Admin Analytics reference were cleaned so current technical documentation no longer links
  to removed strategy or implementation-plan material; no public user/API documentation change
  is required for this infrastructure-only work.
- Versioning: local validation metadata is `0.1.0`; the current observability implementation tree
  is recorded through `bf9f953d`; no platform release tag or deployed
  artifact was created by this work.

Checks intentionally not claimed as complete:

- Docker container build/run could not be repeated locally because the Docker daemon is not
  available. The GitHub workflow contains the containerized smoke test.
- The current full-workspace `cargo check --workspace` and `cargo fmt --all -- --check` pass;
  targeted observability and analytics-producer tests/checks pass, and the existing Analytics
  maintenance PostgreSQL test still fails to discover its quarantine work row in the local
  database.
- Railway staging service creation, private DNS, environment variables, isolated resources, and
  staging release evidence require external platform access.
- The implementation PR/issue link and release-owner approval must be added by the repository
  owner in the project tracker or Git hosting system.
- Durable backend selection, retention, access control, dashboards, alerts, and production search
  by release ID are deferred to a provider-specific observability plan.

## Release impact record

```text
Change: Introduce vendor-neutral OpenTelemetry instrumentation and Collector infrastructure.
Owner: KasiTek engineering; provisional Collector incident owner: platform-ops.
Risk: standard for repository changes; high for production enablement until staging and durable-destination gates pass.
Affected services and user surfaces: Rust Core/Tenants/Analytics services, Agents API/worker/gateway/maintenance processes, and Collector deployment configuration; no direct user-interface behavior change.
Platform release version or release ID: local validation metadata 0.1.0; implementation tree recorded in the release record; no release tag or deployed artifact.
API/schema/migration changes: not applicable; migration execution is instrumented but schemas are unchanged.
Feature flag or rollout method: OTEL_SDK_DISABLED, OTEL_EXPORTER_OTLP_* endpoint/protocol, resource metadata, and sampler environment variables; stdout fallback remains available.
Analytics events and success metrics: not applicable; operational telemetry remains separate from customer analytics.
Logs, metrics, dashboards, and alerts: OTLP logs/traces/metrics, Collector health, resource normalization, bounded processing, redaction, and runbook are implemented; durable dashboards/alerts are not yet configured.
User, API, internal, and operational documentation: internal observability, local development, environments, release process, and Collector runbook updated; public documentation not applicable.
Validation evidence: Rust and Agents checks passed; Collector profiles validated; local Rust all-signal smoke passed; CI includes the Rust/Agents/Collector container smoke path; staging was not available.
Rollback or disable plan: set OTEL_SDK_DISABLED=true or remove the OTLP endpoint while retaining stdout logs; promote the prior application artifact and restore the previous Collector configuration.
Post-release review date: before any staging or production promotion.
```
