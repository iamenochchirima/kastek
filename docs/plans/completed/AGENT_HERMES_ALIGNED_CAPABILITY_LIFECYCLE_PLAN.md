# Hermes-aligned capability lifecycle

**Status:** Active. Registry-driven activation, effective snapshots, Playground candidate promotion,
rollback, and Hermes-style skill discovery are implemented locally. The lifecycle is intentionally
single-mode: every installation is pinned and Live changes only through explicit Deploy. Remaining
work is the local proxy/browser end-to-end evidence pass.

**Owner:** Agent Platform and Studio

**Last updated:** 2026-09-10

## Implementation status

The local implementation now uses the existing catalog/registry as the activation seam. Native
connection completion grants its declared bundle to the installation, the effective runtime
snapshot groups callable actions by provider, registry generations and capability digests are
persisted with run/deployment evidence, and Deploy mirrors the Playground capability state to Live
with an opaque-credential rollback snapshot. Plugin, MCP, and skill candidate activation now use
the same Playground-only candidate path. The remaining unchecked item below is deliberately not
claimed as complete: it needs the local browser flow through the dev-client proxy.

**Depends on:**

- [`AGENT_CAPABILITY_REGISTRY_AND_EXTENSION_SURFACES_IMPLEMENTATION_PLAN.md`](./AGENT_CAPABILITY_REGISTRY_AND_EXTENSION_SURFACES_IMPLEMENTATION_PLAN.md)
- [`AGENT_PLATFORM_HERMES_GAP_CLOSURE_PLAN.md`](./AGENT_PLATFORM_HERMES_GAP_CLOSURE_PLAN.md)
- [`AGENT_PLATFORM_EXECUTION_OBSERVATORY_AND_CONTROL_PLANE_PLAN.md`](./AGENT_PLATFORM_EXECUTION_OBSERVATORY_AND_CONTROL_PLANE_PLAN.md)
- [`AGENT_MODEL_FIRST_GROUNDING_ARCHITECTURE_PLAN.md`](./AGENT_MODEL_FIRST_GROUNDING_ARCHITECTURE_PLAN.md)
- [`HERMES_WAKU_CAPABILITY_AWARENESS.md`](../../research/HERMES_WAKU_CAPABILITY_AWARENESS.md)

## Objective

Make capability activation and model awareness follow the mature Hermes pattern without importing
Hermes code. One canonical, scoped registry must determine what the agent can discover, what the
model can call, and what the runtime will authorize. Connections, configured plugins, MCP servers,
and added skills must become available to the Playground agent through that registry. Deploy must
promote the exact tested capability configuration and pinned extensions to Live.

The user-visible contract is:

```text
Connect / configure / add in Playground
  -> validate and register the extension
  -> activate its declared capability bundle in the Playground candidate
  -> resolve the effective tool and skill projection for the next run
  -> test in Playground
  -> Deploy the immutable candidate to Live
```

A connection or plugin never bypasses grants, policy, approval, health, or dispatch-time scope
checks. "Available" means that the extension is represented by the canonical registry and its
declared capabilities are visible in the Playground projection; only ready and admitted tools are
sent as callable schemas. Unready items remain visible with a typed reason.

## Scope

### Included

- A Hermes-style canonical capability registry and generation-aware snapshots.
- Scoped native, connection, plugin, MCP, and user-created capability registration.
- Declarative provider/integration manifests that map one connection to a named capability bundle.
- Automatic Playground activation of the bundle produced by a successful connection or plugin setup.
- Progressive skill discovery: metadata index first, relevant instruction body on demand.
- One immutable portable candidate snapshot and one immutable effective per-run snapshot.
- Exact model-facing tool schemas derived from the admitted registry projection.
- Grouped provider/service summaries such as `Google Calendar -> list, create, update, delete`.
- Playground-to-Live Deploy, preflight, atomic activation, and rollback of the same extension state.
- Capability, plugin, MCP, skill, deployment, and revocation tests plus local end-to-end evidence.

### Excluded

- Vendoring or importing Hermes runtime code.
- A second prompt-only capability catalogue or a hard-coded feature inventory in each agent soul.
- Treating a connected account as unconditional permission to execute side effects.
- Copying credential values, conversation memory, test data, or provider payloads during Deploy.
- Hosted staging or Railway/Cloudflare production work; this plan is verified locally through the
  existing development proxy and tunnel setup.
- Replacing the existing Temporal execution, approval, redaction, or durable-effect contracts.

## Context and constraints

### Hermes contract to adopt

Hermes provides the reference boundary:

- tool modules register their schema, handler, toolset, and availability check in one registry;
- enabled/disabled toolsets resolve to exact names, then availability checks remove uncallable tools;
- plugin and MCP registrations are scoped and generation-aware;
- the model receives the exact admitted schemas, while prompt guidance explains how to use them;
- skills expose a compact metadata index and load full bodies with progressive disclosure;
- credentials stay in scoped runtime state, never in the model-visible prompt;
- a registry or MCP change refreshes the agent tool snapshot and invalidates stale model/cache state.

The primary source comparison is recorded in
[`HERMES_WAKU_CAPABILITY_AWARENESS.md`](../../research/HERMES_WAKU_CAPABILITY_AWARENESS.md).

### Current KasiTek seams and implementation status

- `allowedTools` and connector readiness are resolved independently. A connected Google Calendar
  account can therefore appear in Connections while `kasitek.calendar.*` is absent from the model
  tool set.
- Native OAuth/API-key/local-connector setup now records the connection, connector grant, and
  installation-scoped capability bundle; existing connected rows are covered by migration 162.
  Effective installation grants map connected connector IDs back through the canonical integration
  catalog, so the bundle is declared once and cannot drift between routes and runtime admission.
- The current capability summary lists tools and services separately, so the model is not told which
  provider owns which actions.
- Plugin/MCP catalogue discovery and runtime admission use the existing extension snapshot seam;
  plugin, MCP, and skill installs activate an immutable Playground candidate when the current
  version is published. Dedicated install-to-Playground browser coverage is still pending.
- The current capability snapshot is the right seam, but every registry/connection/skill change must
  advance its generation/digest and refresh the next run's projection.
- Capability self-description answers from the current registry snapshot and is covered by the
  shared system contract. Prompt metadata/body progressive disclosure and explicit Hermes-compatible
  `skills_list`/`skill_view` tools are implemented. Linked skill files are stored as immutable
  version children and loaded only through an explicit, pinned `skill_view` request.

### Environment

- Playground and Live remain separate installation targets.
- Local verification uses the repository runtime plus `https://dev-client.kasitek.co.za/` as the
  existing server proxy through the local Cloudflare tunnel.
- Deploy is the only operation that changes the Live active candidate.
- Existing approval, installation-grant, credential-reference, redaction, and journal boundaries
  remain authoritative.

## Target architecture

### 1. Canonical registry

Create one registry seam, extending the existing capability registry rather than adding another
parallel list. Every registered entry has:

- stable capability ID and tool name;
- version and source (`builtin`, `connection`, `plugin`, `mcp`, or `user`);
- provider/integration ID and user-facing display name;
- toolset/bundle ID;
- description, input/output schemas, risk class, approval mode, and required scope;
- availability/readiness probe;
- scoped adapter/invoker reference;
- dependency and compatibility metadata.

Registration, deregistration, plugin unload, MCP refresh, and connection activation increment a
generation. Snapshot derivation uses a coherent generation and never reads a half-updated registry.
No UI, prompt builder, or integration route may construct a second callable-tool list.

### 2. Extension and capability activation

The registry distinguishes these states:

| State | Meaning | Model exposure |
| --- | --- | --- |
| Discovered | Catalogue metadata exists | Studio/catalogue only |
| Configured | Required settings/credentials/dependencies are present | Studio, with readiness reason |
| Registered | Adapter and schemas are loaded in the scoped registry | Candidate projection |
| Ready | Health/readiness checks pass | Callable only if also admitted |
| Unavailable | Missing grant, dependency, health, or adapter | Not callable; reason retained |
| Revoked | Connection/plugin/skill was removed or disabled | Removed from next snapshot |

#### Connections

Each integration manifest declares its provider identity and capability bundle. For example,
Google Calendar declares the calendar read/write capabilities it implements. A successful Connect
operation must:

1. persist the connection and opaque credential reference;
2. validate or record health and dependency state;
3. activate the declared bundle on the current Playground candidate;
4. recompute the candidate capability digest;
5. refresh the next Playground run's registry projection.

This makes a connected provider immediately usable in Playground without requiring the user to
manually discover and toggle every tool. It does not remove approval from writes or bypass the
installation grant and dispatch checks. Disconnect/revoke removes the bundle from future
Playground snapshots and marks the draft as needing Deploy if Live differs.

#### Plugins and MCP

Configured plugins and MCP servers follow the same contract:

1. validate a namespaced manifest and compatibility/dependency requirements;
2. register its schemas, handlers, toolset, and availability probe in the scoped registry;
3. activate the declared bundle for the Playground candidate;
4. expose ready schemas, typed unavailable reasons, and provenance in the snapshot;
5. refresh the next turn after late registration, reload, or revocation.

Plugin code never gets global registry access by accident. Namespaces, version pins, tenant scope,
declared capabilities, environment references, and permission boundaries are checked before
registration. MCP trust/read-only metadata is captured at discovery and rechecked at invocation.

#### Skills

Adding a skill in Playground creates or updates a versioned skill record, publishes it to the
candidate index, and pins the selected version. The runtime then:

- exposes only name, description, compatibility, and dependency metadata in the compact index;
- matches relevant skills against the current request, channel, audience, and capability state;
- loads the relevant instruction body only after matching;
- loads linked references/scripts only when the skill workflow asks for them;
- never treats skill instructions as a permission grant.

Removing, unpublishing, or changing a skill advances the candidate digest and refreshes future runs.

### 3. Portable and effective snapshots

The portable candidate snapshot contains only non-secret, versioned configuration:

- selected capability bundles and individual overrides;
- connection/provider IDs and opaque credential references;
- registered plugin/MCP versions and manifest digests;
- published/pinned skill versions and dependency declarations;
- agent policy, model policy, memory policy, and extension generation.

The effective run snapshot resolves that candidate against one installation's grants, health,
credential binding, quotas, approval policy, and environment. It contains:

- callable tool schemas and invocation metadata;
- unavailable tools and stable reason codes;
- provider-grouped connected services and their usable capability IDs;
- skill metadata plus only the bodies matched for this request;
- registry generation and deterministic snapshot digest.

Prompt assembly, planner admission, invocation, approval, journal events, and Studio observability
all consume this same effective snapshot. A run keeps its snapshot immutable while in flight.

### 4. Model-facing contract

The model receives:

- the exact callable tool schemas from the admitted registry projection;
- a concise runtime-owned contract saying that schemas are authoritative;
- a grouped capability summary derived from the snapshot;
- a compact skill index and any matched skill bodies;
- provider/model identity without credentials or raw connection IDs.

The native capability-awareness skill teaches the model how to answer capability questions and use
trusted discovery tools. It does not list capabilities in static prose and cannot grant access.
Capability requests are classified separately from factual knowledge requests and never sent through
the no-evidence factual fallback.

### 5. Playground-to-Live lifecycle

```text
Draft edit/connect/plugin/skill change
    -> immutable candidate + portable capability snapshot
    -> Playground registry activation and effective run snapshots
    -> test runs/evaluations
    -> Deploy preflight against Live
    -> atomic Live candidate + extension binding activation
    -> immutable deployment evidence and rollback target
```

Deploy promotes the exact selected candidate, capability bundle selections, plugin/MCP pins, and
skill pins tested in Playground. It reuses opaque organization credential references where valid; it
does not copy secret payloads or Playground conversation data. Missing or unhealthy Live bindings
block promotion with a typed preflight reason.

Rollback atomically restores the previous Live candidate and binding revision. It does not rewrite
Playground, mutate in-flight runs, or erase evidence. Selecting an older version remains read-only
until the user confirms Deploy.

## Implementation plan

1. [x] Freeze the registry contract and remove competing capability lists. Document the descriptor,
   toolset, provider, readiness, scope, and generation fields; add an assertion that every model
   schema and invoker comes from the same registry entry.
2. [x] Add a declarative integration-to-capability-bundle map for every supported connection,
   starting with Google Calendar, Gmail, Drive, internal Calendar, Apple, and Tavily. Include
   provider display metadata and per-action risk/approval metadata.
3. [x] Wire Connect, disconnect, OAuth completion, and API-key completion to candidate activation
   and digest refresh in Playground. Add the same activation path for configured plugins and MCP.
4. [x] Make plugin/MCP registration scoped, namespaced, versioned, dependency-checked, and
   generation-aware. Capture trust/read-only metadata before invocation. The extension snapshot,
   isolated plugin adapter, remote MCP pin, and staging smoke paths now share this admission seam.
5. [x] Rework the effective capability resolver so connector bindings, grants, health, registry
   entries, and policy produce one coherent snapshot. A connected service may list only capability
   IDs that are both registered and admitted.
6. [x] Replace the flat model summary with provider-grouped capability projections while retaining
   exact tool names and schemas for the model API.
7. [x] Align skill activation with Hermes progressive disclosure: metadata index, compatibility
   filtering, matched body loading, version pinning, digest invalidation, and explicit
   `skills_list`/`skill_view` tools are implemented. Linked files are persisted outside the compact
   index and loaded on demand; current `knowledge_source_ids` remain metadata only.
8. [x] Ensure capability-request intent reaches the model and uses the current snapshot instead of
   the factual grounding fallback. Keep the generic platform system skill shared by every agent;
   layer protected KasiAi guidance without creating a separate mechanism. The remaining grounding
   review is post-model and is owned by the linked model-first architecture plan.
9. [x] Connect registry generations and candidate digests to the existing Playground run bootstrap.
   A changed connection/plugin/skill affects the next run; an in-flight run keeps its original
   snapshot.
10. [x] Complete Deploy preflight, promotion, and rollback using the candidate capability digest,
    extension bindings, health evidence, and opaque credential references. Live must never follow a
    published candidate implicitly.
11. [x] Add Studio projections for configured, registered, ready, unavailable, and revoked states,
    with minimal copy and one clear Deploy/Deployed state.
12. [x] Add documentation, structured lifecycle events, bounded error codes, and local runbooks for
    activation, refresh, promotion, revocation, and rollback. The public connection guide, internal
    runbook, deployment evidence, and bounded promotion/rollback errors are updated.

## Verification

### Registry and runtime tests

- [x] A registered tool has one schema, one handler, one source/provider, and one authorization
  projection.
- [x] Registry generation changes invalidate the tool-definition and capability-snapshot cache.
- [x] A connected Google Calendar automatically activates its declared list/create/update/delete
  bundle in Playground. The integration catalog declares `kasitek.calendar.list/create/update/delete`,
  native connection completion grants that bundle, and the effective-capability tests verify the
  provider-grouped projection.
- [x] A connected-but-unhealthy, ungranted, unsupported, or unregistered capability is visible with
  a reason and cannot be invoked.
- [x] A configured plugin registers only its declared, namespaced capabilities in its agent scope.
- [x] MCP late registration/reload updates the next turn without changing an in-flight snapshot;
  registry generation and staging smoke tests cover this boundary.
- [x] Capability summaries group provider names with their usable actions and never include secrets.

### Skill tests

- [x] Added and pinned skills appear in the Playground metadata index immediately.
- [x] Only matching, dependency-ready skill bodies enter a turn; irrelevant bodies do not.
- [x] Skill changes advance the candidate digest and affect Playground on the next run.
- [x] Skills cannot make an otherwise ungranted tool callable.
- [x] Hermes-compatible `skills_list`/`skill_view` returns enabled skill metadata and full bodies on demand.
- [x] Persist and serve linked skill files on demand, with path validation, pinning, size limits,
  and organization-scoped row-level security.

### Promotion tests

- [x] New installations and agent specs accept only `pinned`; migration 166 normalizes old rows and
  enforces the single release mode at the database boundary.
- [x] Deploy promotes the exact tested candidate and extension digest to Live.
- [x] Live remains unchanged while Playground receives later edits.
- [x] Missing Live bindings block promotion with a typed preflight result.
- [x] Rollback restores the previous Live candidate and binding revision without changing active
  runs or Playground.
- [x] Repeating the same promotion is idempotent and leaves one evidence record.

### Local verification

- [x] Agent TypeScript build and focused capability, activation, deployment, migration, and HTTP
  tests pass (the current focused run is 104 tests; the broader focused matrix also passes).
- [x] Client type check and production build pass.
- [x] Local end-to-end REST/MCP run through isolated local API/gateway ports passed credential
  exchange, discovery, idempotency, durable tool execution, and MCP execution; the existing
  `https://dev-client.kasitek.co.za/` proxy returned HTTP 200. Capability activation, skill,
  Deploy/Live, and rollback routes are covered by the focused integration/unit matrix; a browser
  click-through remains a manual UI check.
- [x] `git diff --check` passes. The active plan's dependency and research links resolve locally.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Callable authority | The scoped registry plus availability/admission projection is the only source of model-callable schemas. | Agent Platform | Decided |
| Connection activation | A successful Playground connection automatically selects its declared capability bundle; grants, health, approval, and dispatch checks still apply. | Platform Integrations | Decided |
| Plugin activation | A validated, configured plugin is registered and available in Playground under a namespaced bundle; Live receives it only through Deploy. | Agent Platform | Decided |
| Skill activation | Added skills are published and pinned to the Playground candidate; bodies load progressively and skills never grant permissions. | Agent Platform | Decided |
| Live lifecycle | Deploy promotes the exact tested candidate and extension bindings; publishing alone never changes Live. | Agent Platform and Studio | Decided |
| Credentials | Deploy reuses opaque credential references where valid and never copies secret values into snapshots or prompts. | Security and Platform | Decided |
| Provider grouping | Model and Studio projections group capability actions under explicit provider/integration metadata. | Agent Platform | Decided |
| Hosted staging | No hosted staging work is part of this plan; verification is local through the existing proxy/tunnel. | Release owner | Decided |
| User-created plugin package format | Confirm whether the existing plugin manifest can cover user-created adapters without a compatibility version bump. | Agent Platform | Open |

## Notes and blockers

- The superseded capability-awareness plan remains available for historical evidence; this document
  is the implementation authority for Hermes-aligned activation and promotion.
- The canonical registry and extension-surface plan owns descriptor/catalogue foundations. This plan
  owns their runtime admission, activation, and Playground-to-Live lifecycle.
- No external blocker currently prevents local implementation. If an integration cannot expose a
  safe adapter, it must remain visible as unavailable rather than silently appear callable.
- The repository smoke command reaches the local Agent API and MCP gateway, but its token-exchange
  step is currently disabled because the running local API has no `INSTALLATION_TOKEN_PRIVATE_KEY`.
  This is an environment prerequisite, not a code failure; keep the local E2E checkbox open until
  the configured local process is restarted with that key and the smoke flow is rerun.

## Release record

| Field | Decision |
| --- | --- |
| Change | Hermes-aligned capability registry, extension activation, skill discovery, and Playground-to-Live promotion. |
| Owner | Agent Platform and Studio |
| Risk | High: affects authorization, integrations, model tool exposure, and deployment behavior. |
| Affected services and surfaces | Agents runtime/API, capability registry, connection/plugin/MCP adapters, skills, Playground, Live chat, Studio deployment controls, execution journal. |
| Platform release version or release ID | Local implementation record; assign the platform release ID before a hosted release. |
| API/schema/migration changes | Additive migrations `162_connected_integrations_activate_bundles.sql`, `163_agent_deployment_capability_digest.sql`, `164_agent_deployment_capability_snapshot.sql`, `166_single_pinned_release_mode.sql`, `167_agent_skill_linked_files.sql`, and `168_remove_capability_rollout_modes.sql`; deployment responses now carry capability digest evidence. Existing installations are normalized to pinned by migration 166, and obsolete capability/automatic-deploy flags are removed by migration 168. |
| Feature flag or rollout method | Local-only verification through the existing dev-client proxy; capability awareness and deployment lifecycle are always active. |
| Analytics events and success metrics | Track activation success/failure, callable-capability resolution, unavailable reasons, tool-call admission, skill-load success, promotion success, and rollback success. |
| Logs, metrics, dashboards, and alerts | Structured generation/digest, provider, installation, run, outcome, and bounded reason-code fields; never log secrets or raw provider payloads. |
| User/API/internal documentation | Update capability directory, connection setup, plugin/MCP, skill, Deploy, rollback, and local verification docs. |
| Validation evidence | Agent type check/build; focused activation, capability, deployment, migration, domain, HTTP, analytics, and skill-discovery tests (including linked-file coverage; 76 focused skill/migration tests pass, with 2 DB integration tests skipped); REST/MCP conformance coverage; changed-source client ESLint, TypeScript, route check, and production build. A broad client lint still traverses generated `.vercel/output` artifacts, and the local smoke flow stops at token exchange because the running API lacks `INSTALLATION_TOKEN_PRIVATE_KEY`. |
| Rollback or disable plan | Disable new activation/promotion controls, restore the previous resolver/candidate pointer, and preserve active-run snapshots and evidence. |
| Post-release review date | Set when a platform release ID is assigned. |
