# Agent capability registry and extension surfaces

**Status:** Active

**Owner:** Agent Platform and Studio

**Last updated:** 2026-09-08

**Depends on:**

- [`AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](../agents/AGENT_PLATFORM_IMPLEMENTATION_PLAN.md)
- [`AGENT_PLATFORM_HERMES_GAP_CLOSURE_PLAN.md`](./AGENT_PLATFORM_HERMES_GAP_CLOSURE_PLAN.md)
- [`AGENT_CONTEXT_RUNTIME_AND_TELEMETRY_IMPLEMENTATION_PLAN.md`](./AGENT_CONTEXT_RUNTIME_AND_TELEMETRY_IMPLEMENTATION_PLAN.md)
- [`AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md`](./AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md)

**Hermes reference:** `/home/enoch/aworkspace/agents/hermes-agent`, revision
`9a84bee265daad14340a80d7585928cd8ea1f9eb`, reviewed 2026-09-08.

## Objective

Replace the current split and limited capability presentation with one canonical, versioned
capability registry and snapshot resolver that can discover, configure, grant, and execute:

- built-in KasiTek tools;
- external connectors;
- skills;
- plugins;
- MCP servers and their discovered tools;
- user-created tools.

The result must provide a rich Studio directory without exposing the whole catalog to every model
request. A run receives only its immutable, authorized capability snapshot. The existing execution
journal, context runtime, approval system, credential vault, memory seams, and Temporal durability
remain the owning runtime contracts.

## Why this work is needed

The current implementation has useful execution primitives but no single directory model:

- `agents/src/tools/registry.ts` is an execution registry, with handlers and schemas, but it is
  not a discovery/catalogue model.
- `agents/src/temporal/activities.ts` registers native tools directly in a large composition
  function.
- `agents/src/integrations/catalog.ts` contains only a small provider list and is not the source
  of truth for skills, plugins, MCP, or user-created tools.
- Skills, extension packages, MCP providers, and integrations have separate lifecycle records and
  partial Studio projections.
- The Studio can list selected capability classes, but cannot present one rich, searchable,
  source-aware directory with readiness, permissions, versions, logos, and toolsets.

This is why the current UI feels limited even though the backend contains more than the visible
connector list: execution definitions, provider metadata, extension packages, and active grants
are not projected through one canonical interface.

## Hermes patterns adopted and adapted

| Hermes reference | KasiTek decision |
| --- | --- |
| `tools/registry.py` and `toolsets.py` | Adopt a central descriptor registry plus named toolsets. Adapt execution to the existing `ToolRegistry`, `CapabilityRuntime`, approval, idempotency, redaction, and journal contracts. |
| `hermes_cli/plugins_loader.py` and `plugins/plugin.yaml` | Adopt manifest-driven plugin discovery and explicit tool registration. Adapt executable plugin code to the existing isolated plugin adapter; never import tenant code into the Temporal worker. |
| `hermes_cli/skills_hub.py`, `skills/`, and `optional-skills/` | Adopt built-in, optional, installed, trusted-source, and local skill sources with metadata and on-demand loading. Adapt installation, versioning, tenant scope, and prompt loading to PostgreSQL snapshots and context budgets. |
| `tools/mcp_tool_discovery.py`, `hermes_cli/mcp_config.py`, and `optional-mcps/` | Adopt server configuration, discovery, per-server filtering, and first-class MCP tool registration. Adapt transport, OAuth, credentials, health, retries, and snapshotting to the durable MCP operation seam. |
| Hermes toolsets and dynamic plugin/MCP aliases | Adopt grouped capability bundles as a user-facing selection unit while retaining per-tool authorization and model-facing schemas. |
| Hermes rich catalog | Adapt the directory concept, not its local filesystem or trust model. KasiTek requires organization isolation, immutable agent versions, installation grants, approvals, credential references, and durable evidence. |

Reference files reviewed:

- `/home/enoch/aworkspace/agents/hermes-agent/toolsets.py`
- `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/plugins_loader.py`
- `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/skills_hub.py`
- `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/mcp_config.py`
- `/home/enoch/aworkspace/agents/hermes-agent/hermes_cli/mcp_startup.py`
- `/home/enoch/aworkspace/agents/hermes-agent/plugins/spotify/plugin.yaml`
- `/home/enoch/aworkspace/agents/hermes-agent/optional-mcps/airtable/manifest.yaml`

## Ownership and canonical interfaces

There must be one source of truth for each concern:

1. **Capability registry** — owns immutable capability descriptors, source type, versions,
   schemas, presentation metadata, toolset membership, risk, scopes, approval, and readiness
   requirements. It extends the existing runtime registry rather than creating a second execution
   path.
2. **Provider and extension catalogs** — own discoverable provider/package records and lifecycle
   state. They do not execute tools.
3. **Snapshot resolver** — resolves an agent version plus installation grants, credentials,
   connector health, MCP discovery, skill pins, plugin versions, and policy into one immutable
   run snapshot.
4. **Capability runtime** — validates and invokes the resolved capability using the existing
   operation, approval, effect receipt, redaction, and journal contracts.
5. **Context runtime** — remains the only owner of model-facing selection, token/byte accounting,
   fit decisions, pruning, compaction, overflow recovery, and context telemetry. Rich registry
   size must never become prompt size automatically.
6. **Execution journal** — remains the only event source for discovery, readiness, activation,
   invocation, MCP, plugin, and tool progress evidence.

### Connections versus MCP

Connections and MCP are separate views over one activation model:

- **Connections** manages native service bindings: OAuth accounts, API keys, local connectors,
  resource bindings, credential references, and environment-specific health.
- **MCP** manages a server and its discovered, versioned tools: endpoint/transport, discovery,
  tool filters, server health, revision pins, and MCP-specific permissions.
- A native Google Calendar adapter appears under Connections. A Google Calendar MCP server
  appears under Capabilities → MCP. They do not duplicate credentials or tool registries.
- Both surfaces resolve into the same immutable agent-version extension snapshot. A connection
  supplies access; it does not grant an MCP server, and browsing either directory does not grant
  runtime access.
- Agent creation provisions the Playground installation as part of the creation flow. Live is a
  later deployment target; users do not perform a manual Playground installation step.

### Canonical descriptor shape

The descriptor interface must cover the information required by runtime, Studio, and audit without
requiring callers to understand provider-specific storage:

```text
CapabilityDescriptor
  id, version, kind, source, provider, toolset
  name, description, category, logo, tags
  inputSchema, outputSchema
  riskClass, requiresApproval, timeout, executionMode
  requiredScopes, credentialRequirements, resourceSelector
  readinessChecks, availability, health
  provenance, package/version/checksum, created/updated timestamps
```

Kinds are `builtin_tool`, `connector_tool`, `skill`, `plugin_tool`, `mcp_tool`, and
`user_tool`. Skills are descriptors and instructions, not executable tool handlers. Plugin and
user-created executable code must use an approved isolated adapter or MCP transport.

### Toolsets

Toolsets are named, versioned groups of capabilities. They provide directory and configuration
leverage, but the runtime still resolves and authorizes individual capability IDs. Toolsets may be
static (for example `web`, `workspace`, or `content`) or dynamic (a plugin or MCP server).

The resolver must support:

- nested includes with cycle detection;
- per-agent allow/deny selection;
- per-installation grants and credential scope narrowing;
- readiness filtering without silently removing the descriptor;
- deterministic ordering and snapshot checksums;
- per-run tool projection after context planning.

## Implementation checklist

### 1. Registry core and compatibility seam

- [x] Map the existing registry, integration catalog, skills, extensions, MCP, grants, and Studio
  consumers.
- [x] Define the versioned capability descriptor, source, provider, toolset, readiness, and
  snapshot contracts in the existing Agent Platform contract area.
- [x] Extend `ToolRegistry` to register and list descriptors without exposing handlers, while
  preserving `invoke`, schema validation, approval, timeout, cancellation, and effect identity.
- [ ] Replace direct ad hoc metadata with manifest-backed registration helpers.
- [x] Keep the current capability discovery and MCP/API projections backward compatible while
  adding source/provider/toolset fields.
- [x] Add registry conformance tests for duplicate IDs, versions, schema completeness, toolset
  cycles, deterministic ordering, source provenance, and snapshot checksums.

### 2. Built-in KasiTek tools

- [ ] Convert native registrations in `agents/src/temporal/activities.ts` into grouped,
  manifest-backed registrations without changing handler semantics.
- [ ] Add categories, logos, toolset membership, summaries, readiness requirements, and concise
  Studio metadata for every built-in capability.
- [ ] Include platform primitives such as time, memory commands, response/media, workspace/core
  reads, content, inbox, bookings, channels, handoff, delegation, and observability where the
  runtime actually supports them.
- [ ] Resolve the distinction between always-installed built-ins and grantable built-ins in the
  descriptor and readiness model.
- [ ] Regenerate capability documentation from the canonical registry.

### 3. External connectors

- [ ] Replace the small `INTEGRATION_CATALOG` as the long-term source of truth with provider
  descriptors that can expose multiple capability/toolset entries.
- [ ] Keep provider credentials, OAuth, local connector secrets, health, and scopes behind the
  existing encrypted credential and integration adapters.
- [ ] Add connector directory metadata and readiness states without making unconfigured providers
  appear executable.
- [ ] Add provider bundles for the initial high-value directory: calendar, messaging, email,
  files, notes, tasks, CRM, project management, search, and observability.
- [ ] Add an adapter contract so each provider contributes catalog metadata, credential flow,
  health check, capability descriptors, and invocation handlers through one seam.

### 4. Skills

- [ ] Define a versioned skill manifest with source, trust, author, category, tags, dependencies,
  required toolsets, configuration references, platform constraints, and content checksum.
- [ ] Support built-in, optional, organization, and user-created skill sources with explicit
  publication and revocation state.
- [ ] Add search, browse, install, pin, enable, disable, update, and rollback operations.
- [ ] Load skills on demand through the context runtime with selected/omitted reasons and budget
  accounting; never inject the entire skill catalog into the prompt.
- [ ] Add skill-to-toolset and skill-to-capability dependency readiness checks.

### 5. Plugins

- [ ] Complete manifest-driven plugin lifecycle: discover, validate, install, publish, pin,
  configure, enable, disable, revoke, and remove.
- [ ] Register plugin tools into the canonical capability registry with namespaced IDs and source
  provenance.
- [ ] Reuse the existing isolated plugin adapter and enforce checksum, runtime compatibility,
  declared permissions, resource limits, timeout, cancellation, output limits, and tenant scope.
- [ ] Support plugin-bundled skills and toolsets without allowing plugin code to import worker
  internals or bypass capability authorization.
- [ ] Add adversarial tests for undeclared capability use, import escape, secret leakage,
  oversized output, duplicate execution, stale snapshots, crash, timeout, and cancellation.

### 6. MCP servers

- [x] Make MCP provider configuration a versioned, scoped extension record with transport,
  credential reference, server metadata, trust/source, and tool filters.
- [x] Discover MCP tools and register them as namespaced `mcp.<provider>.<tool>` descriptors with
  schemas, provenance, readiness, and server toolset membership.
- [ ] Support HTTP and stdio-compatible adapters only through the managed Agent Platform seam;
  do not run arbitrary MCP processes inside the Temporal worker.
- [ ] Add connect, authenticate, discover, health-check, refresh, filter, enable, disable,
  revoke, and reconnect lifecycle operations.
- [x] Reuse the durable MCP operation coordinator, snapshot checksum, cancellation, timeout,
  unknown-outcome, and journal contracts already defined in the Hermes gap plan.
- [x] Add bounded discovery and per-server filtering so a large MCP server cannot overflow the
  model request or bypass approval policy.
- [x] Project pinned, healthy, published MCP revisions and their discovered tools into the
  immutable extension snapshot used for publication and run admission.

### 7. User-created tools

- [ ] Define user-created tool types: declarative skill-backed tool, MCP-backed tool, and isolated
  plugin-backed tool. Do not accept arbitrary source execution in the Agent Platform worker.
- [ ] Add a creation flow requiring name, description, input/output schema, source/endpoint,
  credentials, scopes, approval policy, and test/readiness result.
- [ ] Version and publish user-created tools into the same descriptor registry with organization
  ownership and immutable checksums.
- [ ] Add draft/test/publish/rollback/revoke lifecycle and a safe test invocation that cannot
  bypass grants or write production effects.
- [ ] Include user-created tools in agent version snapshots and live deployment promotion.

### 8. Studio directory and configuration

- [x] Build one capability directory backed by the canonical catalog, with first-class views for
  Tools, Skills, Plugins, MCP, and User-created tools; keep native Connections as a separate
  binding surface.
- [x] Provide search, category/source filters, branded logos, versions, trust/provenance,
  readiness, permissions, configured state, and concise configure/enable actions.
- [x] Keep discovery separate from activation: browsing a capability does not grant or load it.
- [x] Show toolsets as useful bundles while exposing individual tools and permissions before
  activation.
- [x] Reuse the shared compact directory row/card pattern and model-picker/configuration shell.
- [ ] Add responsive desktop/tablet/mobile behavior and accessible loading, empty, error, and
  confirmation states.

### 9. Runtime, context, journal, and deployment integration

- [x] Resolve one immutable capability snapshot at agent-version publication/run admission,
  including pinned MCP revisions.
- [ ] Pass only the authorized, ready, context-fitting model tool projection to the context
  runtime; keep the full registry out of model requests.
- [ ] Add journal events for catalog discovery, provider readiness, skill load, plugin activation,
  MCP discovery, toolset resolution, and user-tool test/publish lifecycle using existing run,
  turn, attempt, manifest, source-boundary, and snapshot identifiers.
- [ ] Add Studio graph nodes for capability resolution, skill load, plugin/MCP discovery, and
  actual tool invocation without creating a second telemetry stream.
- [ ] Preserve Playground draft versus Live published snapshots; a running session keeps its
  pinned snapshot while new sessions use the new version.
- [ ] Add migration/compatibility handling for existing `allowedTools`, integration IDs, skill
  pins, extension package references, and MCP provider version IDs.

### 10. Verification and release evidence

- [ ] Registry unit and conformance tests.
- [ ] Provider/credential/readiness integration tests.
- [ ] Skill, plugin, MCP, and user-tool lifecycle tests.
- [ ] Authorization, approval, scope, redaction, output-limit, and snapshot tests.
- [ ] Context-budget tests proving catalog size does not become prompt size.
- [ ] Journal and Observatory projection tests for successful, blocked, failed, and revoked paths.
- [ ] Studio component, accessibility, responsive, and browser-flow tests.
- [ ] Agent Platform and client production builds plus targeted lint/type checks.
- [ ] Release record: standard/high risk classification, affected services, migration/compatibility
  decision, analytics/logging/metrics, documentation, rollout flag, validation, and rollback.

## Explicit non-goals

- Do not create a second compaction engine, prompt assembler, token policy, transcript, or
  telemetry projection.
- Do not put memory storage, semantic revision logic, consolidation, retention, deletion, or
  retrieval ranking in the capability registry.
- Do not execute arbitrary plugin or user source inside the Temporal worker.
- Do not automatically grant every catalog entry to every agent.
- Do not send the complete catalog, all skill content, or all MCP schemas in every model request.
- Do not replace Temporal, PostgreSQL, the encrypted credential boundary, or the existing durable
  execution journal.

## Release record

```text
Change: Canonical capability registry and managed extension directory
Owner: Agent Platform and Studio
Risk: high
Affected services and user surfaces: Agent API, Temporal worker, PostgreSQL extension/grant data,
  credential/integration adapters, Studio, Playground, Live deployment, Observatory, MCP/API discovery
Platform release version or release ID: to be assigned at release
API/schema/migration changes: expected; additive migrations and compatibility projections required
Feature flag or rollout method: staged behind capability-directory and extension-runtime flags
Analytics events and success metrics: catalog browse, activation, readiness, discovery failure,
  tool invocation success/failure, and publish/rollback outcomes; registry owner to define schemas
Logs, metrics, dashboards, and alerts: structured lifecycle logs, provider/MCP/plugin readiness and
  failure metrics, discovery latency, activation errors, and snapshot mismatch alerts
User, API, internal, and operational documentation: required
Validation evidence: registry, security, lifecycle, context-budget, journal, Studio, build, and
  end-to-end evidence required before completion
Rollback or disable plan: disable new directory/runtime adapters, preserve existing grants and
  compatibility projections, and pin new runs to the last known-good snapshot
Post-release review date: to be assigned
```

## Current status

The canonical descriptor catalog, toolset resolver, source adapters, registry projection, connector
projection, MCP registration metadata, organization-scoped directory route, first-class Studio
capability tabs, separate Connections surface, automatic Playground provisioning path, and pinned
MCP-to-extension-snapshot projection are implemented. Focused registry, source-adapter,
integration, snapshot, and client lint checks pass. Remaining work is the broader provider
directory, stdio/managed MCP transport, complete plugin and user-tool lifecycle persistence,
full activation/grant snapshot wiring for every source, and responsive/browser end-to-end
verification. The existing execution and context ownership boundaries remain unchanged.
