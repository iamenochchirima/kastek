# Plugin Adapter Runtime and Rollout Plan

**Status:** Active

**Owner:** KasiTek platform engineering

**Last updated:** 2026-09-09

## Objective

Provide a safe, tested way to make catalogued plugins executable in KasiTek without treating
catalog metadata as runnable code. Each plugin must move independently from `metadata_only` to
`supported` only after its adapter, configuration, credentials, runtime execution, grants, and
tests are complete.

Success means a user can select a supported plugin, configure it through the existing capability
flow, grant it to an agent version, run its capabilities, see useful readiness and failure states,
and revoke or disable it without affecting unrelated plugins.

## Scope

### Included

- A KasiTek plugin adapter contract aligned with Hermes' manifest and registration boundaries.
- Per-plugin readiness, configuration, credentials, installation, grants, and runtime status.
- Safe execution through the existing extension/package and isolated plugin-runtime boundaries.
- A first end-to-end reference adapter for Tavily.
- Phased support for additional plugins grouped by runtime family where the adapter is genuinely shared.
- Catalog, UI, API, runtime, observability, security, and rollback work required for supported plugins.

### Excluded

- Unlocking all catalogued plugins without adapters.
- Executing arbitrary Hermes Python modules inside the hosted KasiTek process.
- Treating Hermes platform/channel plugins as ordinary tool plugins; those remain connection or
  channel integrations.
- Rebuilding the existing OAuth connection system as part of plugin support.
- Implementing every catalog entry in the first release.

## Context and constraints

- The reviewed catalog currently contains 104 plugin entries; 103 are `metadata_only` and one is
  marked `supported`.
- The current supported mapping is Tavily → `kasitek.web.search`.
- KasiTek already has extension package declarations, package validation, immutable extension
  resolution, installation/publishing routes, agent-version grants, and an isolated plugin
  subprocess protocol. These are the foundations to extend, not parallel systems to replace.
- Hermes uses distinct native plugin surfaces: manifest plus `register(ctx)` plugins, deferred
  platform adapters, provider plugins, portable packages, and MCP servers. KasiTek should adopt
  the separation and lifecycle, while preserving hosted multi-tenant isolation and credential
  boundaries.
- Credentials must remain in KasiTek's credential/configuration system. Plugin packages must not
  receive raw workspace secrets through catalog metadata or unrestricted environment inheritance.
- A plugin is selectable only when its adapter and readiness checks pass. Metadata-only entries may
  remain visible as catalog entries but must remain unavailable.

## Implementation plan

### Phase 1 — Establish the adapter contract

- [x] Define the versioned `PluginAdapter` contract for identity, supported version, capabilities,
      configuration schema, required credential references, readiness checks, health checks, and
      invocation.
- [x] Define the adapter registry and make catalog `adapterStatus` derive from registry support
      rather than a manually edited UI flag.
- [x] Define the boundary between plugin adapters, native connections, channel integrations, and
      remote MCP providers: the registry exposes native capability or isolated-plugin execution,
      native connector references remain credential-owned, and remote MCP remains an explicit
      `mcpCapabilityIds` dependency.
- [ ] Define adapter lifecycle states: catalogued, installed, configured, granted, ready,
      unhealthy, disabled, and revoked.
- [x] Ensure adapter identity includes plugin id, version, checksum, and runtime protocol version.

### Phase 2 — Complete the isolated execution path

- [ ] Connect the plugin package resolver to the plugin execution runtime without bypassing package
      validation or immutable agent-version snapshots.
- [ ] Enforce organization, installation, agent-version, and capability-grant scope at invocation.
- [x] Enforce input/output/frame limits, timeouts, cancellation, cleanup, and crash handling.
- [x] Redact credentials and sensitive request/response data from logs and execution evidence.
- [x] Record bounded execution evidence with outcome, duration, byte counts, and failure code.
- [x] Add a kill-switch or feature gate for plugin execution independently of connection execution.

### Phase 3 — Build the Tavily reference adapter

- [ ] Implement Tavily configuration and credential resolution using the existing credential model.
- [ ] Map Tavily search/extract operations to the approved `kasitek.web.search` capability surface.
- [ ] Add readiness checks for missing, invalid, revoked, and unhealthy credentials.
- [ ] Add provider timeout, retry, rate-limit, and upstream error normalization.
- [ ] Connect install → publish → configure → grant → invoke for one agent version.
- [ ] Expose supported, configured, connected, unhealthy, and disabled states in the plugin UI.
- [ ] Verify disable/re-enable and credential rotation without affecting other plugins.

### Phase 4 — Make the user flow honest and independent

- [x] Replace the current lock-only interpretation with clear readiness states and the next
      required action for each plugin.
- [ ] Add plugin configuration dialogs that use existing application forms and toasts.
- [ ] Keep plugin enablement independent: installing or disabling one plugin must not install,
      configure, or revoke another.
- [ ] Preserve connected/ready ordering and category filtering in the catalog.
- [ ] Ensure unsupported metadata entries cannot submit an installation request.
- [ ] Show required credentials and external setup only when the selected plugin needs them.
- [ ] Add retry, health, and revoke behavior for adapter failures.

### Phase 5 — Add plugins by family

- [ ] Classify remaining catalog entries as provider/backend, channel/platform, browser, media,
      model provider, memory, standalone hook, portable package, or MCP server.
- [ ] Move channel/platform entries to the connection/channel architecture where appropriate.
- [ ] Identify shared adapter families, such as web search, browser backends, image generation,
      and video generation.
- [ ] Implement one adapter per family with per-plugin identity, configuration, credentials, and
      readiness state.
- [ ] Promote entries to `supported` only after end-to-end tests pass.
- [ ] Leave unsupported or non-target plugin families metadata-only until their runtime boundary
      is implemented.

### Phase 6 — Verification and release

- [ ] Add unit tests for manifest validation, adapter registration, configuration, readiness,
      credential resolution, capability mapping, and error normalization.
- [ ] Add integration tests for installation, publishing, agent-version grants, invocation,
      timeout, cancellation, crash, and revoke flows.
- [ ] Add an end-to-end test for Tavily from the UI through a real or controlled upstream.
- [ ] Add authorization tests for cross-organization, cross-installation, and ungranted access.
- [x] Run client lint, type checking, build, and relevant agent tests.
- [ ] Record analytics events for install started, configured, enabled, invocation succeeded,
      invocation failed, disabled, and revoked; use the existing analytics registry.
- [ ] Add structured logs and metrics for adapter lifecycle and invocation failures without
      logging credentials or full payloads.
- [x] Update supported public/API documentation when the first adapter is available.
- [ ] Record release identity, validation evidence, rollout scope, and rollback conditions.
- [ ] Roll out the adapter runtime behind an execution flag or staged environment gate.
- [ ] Roll back by disabling plugin execution and reverting the adapter registry/runtime artifact;
      preserve catalog and persisted package data for reactivation.

## Verification

- [x] Lint and type check the client and agents packages.
- [x] Run focused extension, plugin-runtime, package-manifest, adapter, and API tests.
- [x] Run client production build.
- [ ] Run Tavily installation/configuration/invocation smoke test in an isolated environment.
- [ ] Confirm unsupported catalog entries remain non-selectable and return a clear readiness state.
- [ ] Confirm one plugin can be revoked or disabled without changing another plugin's grants.
- [ ] Confirm logs and execution evidence contain no credentials or full provider payloads.

## Release record

| Field | Decision |
| --- | --- |
| Change | Add independently supported, adapter-backed plugins to the KasiTek agent runtime |
| Owner | KasiTek platform engineering |
| Risk | standard; high for enabling arbitrary external execution, so execution remains isolated and gated |
| Affected services and user surfaces | Agents API, extension/package runtime, agent version grants, Studio capabilities UI, credential/configuration flow |
| Platform release version or release ID | to be assigned at release |
| API/schema/migration changes | likely adapter registry/configuration contracts; migration required only if existing package/config records change |
| Feature flag or rollout method | required for plugin execution; staged first with Tavily |
| Analytics events and success metrics | required; lifecycle and invocation events registered before release |
| Logs, metrics, dashboards, and alerts | required for lifecycle failures, invocation failures, timeouts, crashes, and upstream health |
| User, API, internal, and operational documentation | required for supported adapters; metadata-only catalog needs no user setup documentation |
| Validation evidence | unit, integration, authorization, runtime, client build, and Tavily smoke evidence |
| Rollback or disable plan | disable plugin execution/adapter registration while retaining catalog and persisted package state |
| Post-release review date | to be assigned with the first staged release |

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Execution model | Use approved KasiTek adapters and isolated plugin workers; do not import arbitrary Hermes Python code into the hosted process. | Platform | Decided |
| Enablement | Support plugins independently; shared infrastructure may ship in batches. | Platform/Product | Decided |
| First adapter | Use Tavily as the reference implementation because the catalog already maps it to `kasitek.web.search`. | Platform | Decided |
| Plugin families | Decide which family follows Tavily after the reference adapter passes staging. | Product/Platform | Open |
| Credential UX | Reuse connection/credential primitives where a plugin needs an external account; do not duplicate OAuth implementations. | Platform | Decided in principle |
| Arbitrary third-party code | Determine whether any future plugin requires a separately provisioned worker image or remains unsupported. | Security/Platform | Open |
| Catalog presentation | Keep metadata-only entries visible but clearly unavailable until an adapter exists. | Product | Decided |

## Notes and blockers

- No implementation blocker is currently known for the Tavily reference slice.
- The isolated runtime now has an explicit registry registration path, but production workers do
  not automatically turn package metadata into executable tools. A future provisioning step must
  resolve the immutable run snapshot, build the adapter/tool registration, and pass the execution
  gate before enabling arbitrary isolated packages.
- External provider credentials and test accounts will be required for staging smoke tests.
- Plugins that are Hermes-only runtime modules, gateway platforms, or local dependency bundles may
  remain unsupported until their correct KasiTek boundary is selected.
