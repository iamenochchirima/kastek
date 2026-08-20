# MCP 2026 Stateless Migration Checklist

**Status:** Local implementation batch complete; staging, external conformance, rollout, and policy gates remain

**Created:** 2026-08-15

**Target protocol:** MCP `2026-07-28` stateless protocol core

**Compatibility protocol:** Pre-2026 handshake-era MCP, initially `2025-06-18`

**Scope:** Agent API MCP handler, separately deployed MCP gateway, local stdio bridge, shared
capability/result contracts, authentication and security, tests, rollout, documentation, and
retirement of the pre-2026 compatibility path.

**Purpose:** Provide an end-to-end migration path from the current `2025-06-18` initialize-based
contract to the `2026-07-28` per-request stateless contract without breaking existing agents.

This is an execution aid retained for historical reference.

## References

- [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP versioning and compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [MCP tools contract](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- Current Agent MCP handler: `agents/src/http/app.ts`
- Current MCP gateway: `agents/src/gateway/app.ts`
- Current stdio bridge: `agents/src/gateway/stdio.ts`
- Current integration contract: `agents/docs/mcp-integration.md`

## Operating rules

- Use the precise terms **2026 stateless path** and **pre-2026 compatibility path**.
- Do not implement this by changing only the `2025-06-18` version constant.
- Keep the same installation authentication, capability registry, shared invocation service,
  approval boundary, idempotency, audit, and durable run ownership.
- The gateway remains a stateless transport process. It must not acquire database, Temporal,
  approval, business-policy, or product-data ownership.
- Prefer a dual-era `/mcp` endpoint. A pre-2026 `initialize` request selects the compatibility path;
  a request with 2026 per-request metadata selects the 2026 stateless path.
- Never enable or advertise `2026-07-28` in hosted production until the local conformance suite and
  staging smoke pass. Development/test defaults exercise the 2026 path; production defaults keep
  the rollback-safe compatibility path until explicitly enabled.
- Keep external client, hosted gateway, provider, browser, Redis, and policy-dependent evidence
  separate from local implementation evidence.
- Preserve unrelated worktree changes and stage only files owned by this migration.

## 1. Baseline and migration decisions

- [x] Record the current implementation as `2025-06-18`, POST JSON-RPC, `initialize`, `tools/list`,
  `tools/call`, `tools/status`, and custom cancellation handling.
- [x] Record that the gateway is already stateless at the process boundary and rejects standalone
  MCP `GET` and session deletion requests.
- [x] Record the migration-start gap: the implementation did not implement 2026 `_meta` fields,
  `server/discover`, `Mcp-Method`, `Mcp-Name`, `resultType`, cache hints, MRTR, or the Tasks
  extension. The current batch now covers the core 2026 contract and a basic Tasks polling path;
  MRTR remains open.
- [ ] Approve the supported-version policy: `2026-07-28` plus the existing pre-2026 compatibility
  revision during migration.
- [x] Choose a feature flag and rollout state for the 2026 stateless path, with a safe production
  default that preserves current clients (`MCP_STATELESS_ENABLED` and
  `MCP_GATEWAY_STATELESS_ENABLED`; explicit 2026 rollback returns `-32022`).
- [ ] Define the initial client support policy: hosted Agent clients, local stdio clients, generic
  MCP clients, and named external clients that are actually verified.
- [ ] Record whether `subscriptions/listen` is required for the first release. If not required,
  declare list-change notifications unavailable and keep `tools.listChanged` false.
- [ ] Record whether the official Tasks extension is required for the first release or follows as a
  second migration increment after core request/response conformance.

## 2. Version and era negotiation

- [x] Add a shared protocol module containing typed constants for `2026-07-28` and the supported
  pre-2026 revision(s), rather than duplicating strings across API, gateway, and stdio code.
- [x] Add an explicit `McpEra` type with `stateless_2026` and `pre_2026_compatibility` values.
- [x] Detect the 2026 stateless path from per-request `_meta.io.modelcontextprotocol/protocolVersion`
  and validate the matching `MCP-Protocol-Version` HTTP header.
- [x] Detect the pre-2026 compatibility path from an `initialize` request that does not carry 2026
  stateless metadata.
- [x] Reject ambiguous requests instead of silently downgrading a request that claims 2026 but lacks
  required metadata.
- [x] Return `UnsupportedProtocolVersionError` with the supported-version list and requested version
  when the requested revision is unavailable.
- [x] Return the protocol-defined `HeaderMismatch` error for mismatched or missing required HTTP
  headers on the 2026 path.
- [x] Implement `server/discover` for the 2026 path with supported versions, capabilities, server
  identity, optional instructions, `resultType`, and cache metadata.
- [ ] Add a compatibility matrix test covering:
  - 2026 stateless client to dual-era server;
  - pre-2026 client to dual-era server;
  - unsupported revision to dual-era server;
  - 2026 client to pre-2026-only behavior;
  - pre-2026 client to 2026-only behavior;
  - malformed and era-ambiguous requests.
- [ ] Ensure negotiation and error responses do not expose bearer tokens, installation secrets,
  client assertions, or private organization data.

## 3. 2026 stateless request contract

- [x] Add strict, reusable schemas for the 2026 request metadata under `params._meta`.
- [x] Require and validate the per-request protocol version and client capabilities.
- [x] Accept and validate client identity metadata; bound lengths and sanitize values used in logs.
- [x] Treat the request body as the source of truth and reject body/header disagreement.
- [x] Validate `Mcp-Method` against the JSON-RPC `method` for every HTTP request.
- [x] Validate `Mcp-Name` against `params.name` for `tools/call` and against the relevant resource or
  prompt field for methods that require a name.
- [x] Implement the required encoding/decoding rules for non-ASCII `Mcp-Name` values.
- [x] Forward and validate `Mcp-Param-*` headers if any tool schema uses `x-mcp-header`; the current
  registry declares none, while adapters enforce ASCII/control-character and sensitive-name guards.
- [x] Reject unsafe custom header values and prevent header injection, newline injection, and secret
  propagation; credential-like `Mcp-Param-*` names are rejected before forwarding.
- [ ] Preserve JSON-RPC request IDs exactly and ensure retries use a new request ID when required by
  MRTR.
- [x] Return HTTP 404 plus JSON-RPC method-not-found errors for unsupported 2026 methods.
- [x] Return HTTP 400 plus JSON-RPC protocol errors for malformed 2026 requests.
- [x] Ensure notification responses follow the 2026 transport contract and do not emit response bodies
  for accepted notifications.

## 4. Capability discovery and result envelopes

- [x] Add `resultType: "complete"` to every ordinary 2026 result.
- [x] Add `io.modelcontextprotocol/serverInfo` response metadata where required or recommended.
- [x] Keep capability filtering installation-, organization-, grant-, resource-, and environment-
  scoped on every request; never turn discovery into a global catalog.
- [x] Make `tools/list` deterministic by stable tool name ordering.
- [x] Add `ttlMs` and `cacheScope` to `tools/list` results. Use a private cache scope when results
  depend on installation grants or credential policy.
- [x] Preserve canonical capability manifests as the source of tool names, descriptions, input
  schemas, output schemas, risk metadata, approval metadata, and redaction rules.
- [x] Validate all exposed input and output schemas against JSON Schema 2020-12 at manifest
  registration (the canonical `ToolRegistry` now uses Ajv 2020).
- [ ] Add pagination/cursor behavior if the filtered capability catalog can exceed the intended
  response bound.
- [x] Ensure structured content remains JSON-safe and bounded at the Agent API response boundary;
  the registry validates declared output schemas before execution. Schema-specific conformance
  fixtures remain part of the external gate.
- [x] Keep custom `tools/status` behavior documented as a KasiTek platform extension alongside the
  basic Tasks mapping; do not claim it is an official core MCP method.

## 5. Tool calls, approvals, and durable operations

- [x] Keep 2026 `tools/call` on the existing protocol-neutral installation invocation service.
- [x] Preserve current grant, resource, availability, kill-switch, approval, idempotency, quota, and
  execution-time authorization checks.
- [x] Preserve durable run, tool invocation, usage, audit, approval, effect, and provider evidence.
- [x] Return a standards-compliant `resultType: "complete"` result for immediate safe reads.
- [x] Define the 2026 response for accepted durable work so clients can reliably locate operation
  state without treating acceptance as completed business work.
- [x] Map the existing durable `runId` and operation status model to the official
  `io.modelcontextprotocol/tasks` extension if Tasks is enabled.
- [x] Implement the scoped Tasks polling/update semantics for task creation, polling, update
  acknowledgement, and cooperative cancellation. Full MRTR input requests remain a separate
  unchecked extension gate.
- [x] Preserve custom status endpoints for existing clients during the compatibility period.
- [x] Decide how approval-required actions are represented: durable task polling first, MRTR input
  requests, or both based on client extension capabilities.
- [ ] If MRTR is enabled, implement `resultType: "input_required"`, bounded `inputRequests`, signed or
  protected request state, retry ID rules, and `inputResponses` validation.
- [ ] Ensure approval responses never accept caller-supplied organization, installation, actor, or
  resource identity as authoritative.
- [x] Verify duplicate calls with the same idempotency key return the original operation and do not
  duplicate effects.

## 6. Streamable HTTP transport and cancellation

- [x] Keep one MCP POST endpoint and do not introduce protocol session storage.
- [x] Require `Accept: application/json, text/event-stream` support on modern HTTP requests and pass
  the negotiated value through the gateway.
- [x] Return JSON for ordinary responses; do not advertise `subscriptions/listen` or long-lived SSE
  streams until that feature is approved and its proxy/runtime limits are verified.
- [ ] Implement `subscriptions/listen` only if list/resource change notifications are part of the
  approved first release.
- [x] Keep standalone `GET /mcp` and session `DELETE /mcp` unavailable for the 2026 path.
- [x] Do not mint, echo, or depend on `Mcp-Session-Id` on the 2026 path.
- [x] Ignore `Last-Event-ID` for the 2026 path and do not promise stream resumption.
- [x] Treat a closed request response stream as cancellation for in-flight HTTP work.
- [x] Stop or signal durable work safely on disconnect without cancelling completed effects.
- [x] Limit `notifications/cancelled` to transports/revisions where it is valid; do not require it for
  modern Streamable HTTP cancellation.
- [x] Validate `Origin` when present, reject invalid origins, and document the hosted allowlist.
- [x] Bind the local gateway process to loopback unless an explicit production deployment boundary
  requires another bind address.

## 7. Gateway implementation

- [x] Add a gateway protocol adapter that preserves the stateless boundary and does not duplicate
  Agent API capability or policy logic.
- [x] Forward `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`, permitted `Mcp-Param-*`, `Accept`,
  authorization, correlation, and required internal gateway headers.
- [x] Prevent forwarding of client-controlled organization, actor, installation, or internal trust
  headers.
- [x] Validate modern headers at the gateway before upstream forwarding and validate again at the
  Agent API boundary.
- [x] Preserve upstream status, content type, request IDs, protocol errors, and bounded response
  handling without leaking upstream secrets.
- [x] Preserve disconnect propagation and bounded upstream timeouts for JSON responses; full SSE
  stream timeout behavior remains gated with `subscriptions/listen`.
- [ ] Keep rate limits keyed by safe credential/network dimensions and add protocol-era/revision
  dimensions to redacted metrics.
- [x] Confirm gateway health/readiness does not require database or Temporal ownership.
- [x] Add gateway tests for header forwarding, mismatch rejection, rollback-disabled versions,
  response content negotiation, redacted metrics, and disconnect cancellation.
- [ ] Add dedicated bounded SSE/JSON response-size tests for modern response streams.
- [ ] Add deployment configuration for proxy buffering, idle timeout, request timeout, and SSE
  response handling if `subscriptions/listen` is enabled.

## 8. Local stdio bridge

- [x] Remove the unconditional `2025-06-18` header from the stdio bridge.
- [x] Forward modern per-message `_meta` unchanged and select the matching HTTP protocol header.
- [x] Add a one-time `server/discover` probe and deterministic fallback to the pre-2026 `initialize`
  flow; a modern-only endpoint returns a local unsupported-version error instead of receiving an
  incompatible handshake.
- [x] Preserve newline-delimited JSON framing, notification silence, bounded request size, and
  bounded response size.
- [x] Do not synthesize client identity or capabilities that the local client did not provide.
- [x] Preserve bearer authentication and prevent tokens from appearing in stdout, stderr, errors,
  or JSON-RPC payloads.
- [x] Add modern, pre-2026, unsupported-version, malformed-input, and notification tests; stdio
  uses bounded request cancellation while gateway disconnect cancellation is covered separately.
- [x] Document the bridge's supported protocol eras and the required environment variables.

## 9. Authentication, authorization, and privacy

- [x] Keep installation-token audience, issuer, subject, expiry, revocation, organization, and
  installation checks unchanged for both eras.
- [x] Keep MCP read/write scopes independent from REST scopes.
- [x] Re-evaluate authorization on every modern request; do not infer authority from a prior request.
- [ ] If an OAuth authorization server is exposed, implement the 2026 issuer-validation and
  client-credential issuer-binding requirements before advertising that conformance.
- [x] Keep the existing key-bound installation-token exchange compatible with modern MCP metadata.
- [ ] Redact client metadata, tool arguments, custom headers, request state, and structured output
  according to existing audit/redaction policy.
- [ ] Never mark credentials, tokens, provider secrets, or private resource selectors as
  `x-mcp-header` values.
- [x] Add cross-organization, cross-installation, revoked-token, suspended-installation,
  wrong-audience, expired-token, and scope-denial tests for both eras.
- [x] Add an Origin/DNS-rebinding security test for hosted HTTP.
- [x] Default the local gateway bind to loopback and keep production binding explicit.
- [ ] Add a process-level loopback-binding assertion for local startup.

## 10. Test and conformance matrix

### Unit and contract tests

- [x] Add typed schemas and fixtures for all 2026 request metadata and result envelopes.
- [x] Add positive/negative tests for protocol, method, name, custom-header matching, and sensitive
  custom-header rejection; schema-specific `x-mcp-header` declarations are currently absent.
- [x] Add `server/discover` contract tests.
- [x] Add deterministic discovery and cache metadata tests.
- [x] Add `resultType` and server metadata assertions for tools, status, errors, and durable results.
- [x] Add Tasks creation, polling, update acknowledgement, and cancellation tests. MRTR tests remain
  open because MRTR is not advertised.

### Agent API and gateway integration tests

- [x] Run modern requests directly against the Agent API.
- [x] Run the same modern requests through the gateway and assert equivalent transport behavior.
- [x] Run pre-2026 initialize requests through both layers and assert no regression.
- [x] Assert gateway-to-API header/body mismatch protection at both boundaries.
- [x] Assert disconnect cancellation and no post-completion cancellation.
- [x] Assert rate limits, kill switches, readiness, bounded payloads, and safe error bodies.

### Stdio tests

- [x] Run a modern per-request metadata conversation through the bridge.
- [x] Run a pre-2026 initialize conversation through the bridge.
- [x] Verify discovery probe fallback and notification silence.
- [x] Verify bridge behavior when the hosted endpoint advertises only one era.

### Durable and policy tests

- [ ] Verify worker restart/reconnect does not lose operation state or duplicate effects.
- [ ] Verify approval-required MCP calls can be approved, denied, expired, and reconciled.
- [ ] Verify idempotency, retry, cancellation, and ambiguous-outcome behavior.
- [ ] Verify MCP/hosted-agent parity for capability identity, authorization, domain operation,
  approval, audit, effect receipt, and final outcome.

### External conformance

- [ ] Run the official MCP Inspector or equivalent 2026-capable client against staging.
- [ ] Run a generic 2026-capable HTTP client with `server/discover`, `tools/list`, and `tools/call`.
- [ ] Run a generic pre-2026 client against the compatibility path.
- [ ] Verify at least one real hosted agent client and one local stdio client.
- [ ] Record exact client versions, request traces with secrets redacted, and pass/fail evidence.
- [ ] Do not check canonical external-client rows based only on local tests.

## 11. Documentation and generated contracts

- [x] Rewrite `agents/docs/mcp-integration.md` using the 2026 stateless path terminology.
- [x] Document both request examples: 2026 stateless and pre-2026 compatibility.
- [x] Document `server/discover`, required metadata, required HTTP headers, error codes, caching,
  cancellation, and supported extensions.
- [x] Document the exact compatibility and fallback behavior for HTTP and stdio.
- [x] Document that `tools/status` is a KasiTek platform extension alongside optional Tasks support.
- [x] Update generated capability/MCP documentation only from the canonical capability registry
  (`pnpm generate:capabilities`); no generated diff was required.
- [x] Add a migration note for external agent owners (`agents/docs/mcp-2026-migration.md`). A
  release changelog entry remains pending because this repository has no release changelog file.
- [ ] Publish a deprecation notice only after the 2026 path is enabled and observed in staging.

## 12. Observability and rollout

- [x] Add redacted counters for protocol era, protocol revision, safe method buckets, result class,
  and latency at the gateway; rejection reason, client identity class, and cancellation dimensions
  remain pending for the hosted observability rollout.
- [ ] Add alerts for modern header mismatch spikes, unsupported-version spikes, legacy traffic,
  failed discovery, and gateway/upstream divergence.
- [ ] Add dashboards that do not expose tokens, arguments, private tool catalogs, or organization
  identifiers outside the approved scope.
- [x] Enable the 2026 path in local development behind `MCP_STATELESS_ENABLED` and
  `MCP_GATEWAY_STATELESS_ENABLED` flags.
- [ ] Enable it in an isolated staging gateway with dual-era support.
- [ ] Run external client smoke and rollback tests in staging.
- [ ] Enable dual-era production support without removing pre-2026 behavior.
- [ ] Monitor client/version/error telemetry before changing defaults.
- [ ] Define a rollback switch that disables only the 2026 path while preserving the current path.
- [ ] Document deployment, proxy, timeout, and health-check settings for the hosted gateway.

## 13. Pre-2026 compatibility retirement

- [ ] Publish the measured client population and remaining pre-2026 traffic before setting a removal
  date.
- [ ] Provide a migration notice and actionable unsupported-version response.
- [ ] Keep compatibility behavior for the approved deprecation window; the 2026 specification has a
  formal lifecycle/deprecation policy.
- [ ] Confirm no supported client depends on `initialize`, `Mcp-Session-Id`, standalone GET streams,
  `Last-Event-ID`, or the old cancellation behavior before removal.
- [ ] Remove compatibility code only after external verification, product approval, and rollback
  preparation.
- [ ] Update the supported-version list, docs, tests, metrics, and deployment configuration together.
- [ ] Archive this migration checklist only after the canonical blueprint/audit evidence is updated.

## 14. Completion gates

- [ ] 2026 stateless protocol contract passes unit and integration tests.
- [ ] Pre-2026 compatibility contract remains green.
- [ ] Agent API and gateway return equivalent policy, capability, and invocation outcomes.
- [ ] Installation authentication, organization isolation, scopes, approvals, idempotency, audit,
  effects, and durable operations remain intact.
- [ ] Gateway and stdio transport behavior passes bounded, cancellation, security, and error tests.
- [ ] Modern and pre-2026 external client smoke evidence is recorded.
- [ ] Hosted deployment and proxy behavior are verified.
- [ ] Documentation, generated capability catalog, migration notes, and support policy are current.
- [ ] Rollback has been exercised.
- [ ] Canonical Blueprint Slice 7 and Audit AR-005/AR-008 evidence is updated only for the gates that
  actually passed.

## Canonical mapping

- Blueprint Slice 7: MCP/REST external surface, discovery, Streamable HTTP, external-client proof,
  and gateway deployment/conformance.
- Audit AR-005: shared MCP invocation/runtime boundary, durable outcomes, approval, cancellation,
  and parity.
- Audit AR-008: gateway safety boundary, protocol negotiation, lifecycle, errors, cancellation,
  deployment, scaling, and health.
- Temporary local execution tracking:
  [TEMP_AGENT_PLATFORM_UNBLOCKED_WORK_CHECKLIST.md](TEMP_AGENT_PLATFORM_UNBLOCKED_WORK_CHECKLIST.md)

## Evidence log

| Date | Area | Evidence | Result |
| --- | --- | --- | --- |
| 2026-08-15 | Baseline | `agents/src/http/app.ts`, `agents/src/gateway/app.ts`, `agents/src/gateway/stdio.ts`, `agents/docs/mcp-integration.md` | Current `2025-06-18` initialize-based contract confirmed; 2026 stateless gaps recorded |
| 2026-08-15 | Planning | Official MCP `2026-07-28` specification, versioning, Streamable HTTP, discovery, tools, and changelog references | Dual-era migration selected as the safe implementation direction; implementation evidence is recorded below |
| 2026-08-15 | Protocol core | `agents/src/mcp/protocol.ts`, `agents/src/http/app.ts`, `agents/test/mcp-2026.test.ts` | 2026 metadata/header validation, `server/discover`, deterministic/cacheable discovery, result metadata, Tasks polling/cancel/update, and pre-2026 compatibility tests pass |
| 2026-08-15 | Gateway/stdio | `agents/src/gateway/app.ts`, `agents/src/gateway/server.ts`, `agents/src/gateway/stdio.ts`, `agents/test/mcp-2026-transport.test.ts` | Header forwarding/mismatch protection, Origin allowlist, per-message stdio version selection, disconnect propagation, and transport tests pass |
| 2026-08-15 | Agent verification | `pnpm build`; `pnpm test` | Build passes; 49 files / 247 tests pass; 17 integration files / 38 tests remain environment-gated skips |
| 2026-08-15 | Rollout controls | `agents/src/config/index.ts`, `agents/src/gateway/server.ts`, `agents/test/config.test.ts`, `agents/test/mcp-2026.test.ts`, `agents/test/mcp-2026-transport.test.ts` | Production-safe 2026 feature flags and gateway/API rollback tests preserve the pre-2026 path |
| 2026-08-15 | Stdio migration | `agents/src/gateway/stdio.ts`, `agents/test/stdio.test.ts`, `agents/docs/mcp-2026-migration.md` | One-time discovery probe, deterministic compatibility fallback, modern-only protection, bounded responses, and no synthetic client identity pass |
| 2026-08-15 | Schema/transport bounds | `agents/src/tools/registry.ts`, `agents/src/http/app.ts`, `agents/src/gateway/app.ts`, focused MCP tests | Ajv 2020-12 manifest validation, Agent API 1 MiB response bound, gateway bounded forwarding, safe method/result metrics, and sensitive custom-header rejection pass |

## Known blockers and non-blockers

### Implementation work, not blockers

- 2026 request schemas, negotiation, discovery, result metadata, header validation, and tests are
  ordinary implementation work.
- Gateway/stdio forwarding and docs are ordinary implementation work.
- Tasks/MRTR are scoped extension work and may be staged after core protocol conformance.

### External or policy gates

- Real hosted client support and generic-client conformance require external runtime verification.
- Provider effects, seeded database, Redis multi-instance, browser, deployment, and production
  policy gates remain governed by the canonical checklists.
- A client that supports only the pre-2026 protocol cannot use a 2026-only endpoint; dual-era support
  is therefore required during migration.
