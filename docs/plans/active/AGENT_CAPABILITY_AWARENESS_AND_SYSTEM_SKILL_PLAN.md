# Agent capability awareness and system capability skill

**Status:** Implementation complete through local verification, including a live local KasiAi capability run; staging rollout and production release evidence pending

**Owner:** Agent Platform and Studio

**Last updated:** 2026-09-09

**Depends on:**

- [`AGENT_CAPABILITY_REGISTRY_AND_EXTENSION_SURFACES_IMPLEMENTATION_PLAN.md`](./AGENT_CAPABILITY_REGISTRY_AND_EXTENSION_SURFACES_IMPLEMENTATION_PLAN.md)
- [`AGENT_KNOWLEDGE_GROUNDING_FIX_PLAN.md`](./AGENT_KNOWLEDGE_GROUNDING_FIX_PLAN.md)
- [`AGENT_CONTEXT_RUNTIME_AND_TELEMETRY_IMPLEMENTATION_PLAN.md`](./AGENT_CONTEXT_RUNTIME_AND_TELEMETRY_IMPLEMENTATION_PLAN.md)
- [`AGENT_PLATFORM_HERMES_GAP_CLOSURE_PLAN.md`](./AGENT_PLATFORM_HERMES_GAP_CLOSURE_PLAN.md)

**Reference implementations reviewed:**

- Hermes Agent `/home/enoch/aworkspace/agents/hermes-agent` at `9a84bee265`
- Waku Agent `/home/enoch/aworkspace/agents/waku-agent` at `21486b3`

## Objective

Make every hosted agent aware of its actual capabilities at run time. The model must receive the
same effective tool, connector, plugin, MCP, and skill state that the runtime will enforce. Every
agent must be able to discover what it can use, find the relevant skill instructions, and describe
its limits from that state instead of guessing or failing through the factual-knowledge grounding
guard. KasiAi receives an additional protected platform guidance extension, not a different
capability-discovery mechanism.

Success means:

- capability questions reach the model with a truthful capability summary;
- the model receives the schemas for every capability it may call in that turn;
- connections are described as usable only when a registered, granted adapter exists;
- skills contribute instructions only when they are published, pinned, and dependency-ready;
- factual questions still fail closed without approved evidence;
- approvals, scope checks, redaction, and durable execution evidence remain unchanged.

## Scope

### Included

- A shared capability-awareness contract in the Agent context runtime.
- A version-level portable capability snapshot and digest for candidate promotion.
- A single per-run effective capability snapshot used by prompting, planning, invocation, and
  observability, derived from the portable candidate plus environment bindings.
- A separate `capability_request` intent for self-description and capability discovery.
- A platform-owned, versioned capability-discovery system skill available to every hosted agent.
- An optional protected KasiAi platform-guidance extension layered on top of the generic contract.
- Explicit connector-to-tool readiness and availability projection.
- Model-facing capability summaries derived from the canonical registry.
- Promotion readiness and drift detection for capability/extension snapshots between Playground and
  Live.
- Regression, integration, and release evidence for tools, skills, connectors, plugins, and MCP.

### Excluded

- Replacing the existing capability registry or approval runtime.
- Treating a connected integration as permission to execute actions.
- Loading the entire capability or skill catalogue into every prompt.
- Giving custom agents KasiAi's platform identity or private platform instructions.
- Weakening factual grounding or allowing model claims without trusted evidence.
- Rewriting the Studio graph UI in this plan; the UI consumes the resolved snapshot and journal
  events after the runtime contract is stable.

## Context and constraints

### Current evidence

The runtime already contains the important execution primitives:

- `ToolRegistry` owns executable definitions and model-facing schemas.
- Capability manifests and the capability catalogue provide source, risk, approval, and
  presentation metadata.
- Effective tool grants, connector grants, skill pins, and MCP registration exist.
- `DefaultContextPolicy` includes authorized tool names and grounding rules.
- `activities.ts` resolves grants and passes `tools.list(allowedTools)` to the harness.
- Studio and Playground currently load the `environment=playground` installation, while the main
  KasiAi chat resolves a separate Live system installation. The current Studio deploy action
  publishes a version and retargets the installation it already loaded, so it can update Playground
  rather than Live.
- Version extension snapshots are created, but there is no promotion manifest that binds the
  snapshot digest to Live binding readiness, validation evidence, or a rollback target.
- Publication currently advances installations using `follow_published`; that behavior can bypass
  an explicit Deploy action unless Studio-managed Live targets use an explicit active-release
  pointer.
- The Agents/Core browser boundary does not yet expose one complete deployment-status, Live
  preflight, activation, and rollback path. The capability plan must define the data contract that
  path consumes, even though the broader observatory plan owns the final control-plane surface.

The current failure is at the intent and prompt seam. The grounding guard classifies “What can
you do?” as a knowledge question. With zero knowledge matches it skips the model before the model
can use its instructions or tool schemas. Active KasiAi installations also currently have no
pinned skill versions, and connected integrations do not automatically become callable tools.

### Design references

Hermes supplies the following patterns:

- a small SOUL identity document rather than a hard-coded feature catalogue;
- actual tool schemas as the authority for callable capabilities;
- toolset filtering and dynamic tool registration;
- progressive skill discovery and on-demand skill loading.

Waku supplies these patterns:

- explicit SOUL rules that name when each tool should be used;
- one registry that conditionally registers integrations and MCP tools;
- procedural skills loaded from metadata matches;
- per-turn prompt assembly containing identity, model/provider state, memory, and relevant skills.

KasiTek must adapt these patterns to immutable agent versions, organization isolation, installation
grants, Temporal retries, approvals, encrypted credentials, and durable execution evidence.

## Target architecture

```text
User message
    |
    v
Intent classification
    |---------------------|----------------------|
    v                     v                      v
Capability request   Factual question       Action request
    |                     |                      |
Capability snapshot  Knowledge/memory gate   Snapshot + tool schemas
    |                     |                      |
    +-----------> shared context planner <------+
                              |
                              v
                    model call and tool loop
```

### Effective capability snapshot

Introduce one deep module at the runtime seam, tentatively
`agents/src/runtime/effective-capabilities.ts`. It should accept the already-resolved registry,
grant, connection, skill, plugin, and MCP inputs and return an immutable snapshot containing:

- agent and installation scope;
- callable tool manifests and sanitized display metadata;
- source kind, provider, version, risk, approval, and readiness;
- connected resources and their usable capability projection;
- selected skill versions and dependency status;
- unavailable, ungranted, unhealthy, or unsupported items with stable reason codes;
- deterministic ordering and a snapshot checksum.

The module should expose separate projections from the same snapshot:

1. **Execution projection** for authorization, invocation, approval, and audit.
2. **Model projection** for concise prompt context and tool selection.
3. **Studio/journal projection** for observability and configuration surfaces.

No caller should assemble a second capability list from raw tables or UI state.

### Two snapshot layers

The plan deliberately distinguishes the portable snapshot attached to a candidate version from the
effective snapshot used by a run:

1. **Portable candidate snapshot:** immutable agent configuration, tool declarations, pinned skill
   versions, plugin/MCP versions, capability grants, required resource declarations, model policy,
   memory/knowledge policy, and a deterministic capability/extension digest. It is safe to compare
   between environments because it contains no secret values or concrete provider credentials.
2. **Effective run snapshot:** the portable candidate resolved against one installation's grants,
   connector registrations, resource bindings, health, approval policy, quotas, and environment.
   It is the only snapshot the prompt, planner, invocation scope, and journal may use for a run.

The two layers must be linked by candidate/version ID and digest. A Live run may have different
bindings from a Playground run, but it must not silently use a different portable capability or
extension snapshot.

### Playground-to-Live promotion contract

Capability configuration is edited and tested in Playground first. Deployment is an explicit
promotion to a separate Live installation; it is not publication, renaming the Playground
installation, or copying Playground state.

```text
Draft edit
    -> immutable candidate + portable capability snapshot
    -> Playground installation and effective run snapshot
    -> real test runs/evaluations
    -> Live binding preflight
    -> promotion manifest and explicit confirmation
    -> atomic Live version/snapshot activation
```

The deployment status projection consumed by Studio and the Agents page must compare the current
Playground candidate with the active Live release and report at least:

- candidate/version ID and portable capability/extension digest;
- active Live version/digest and previous rollback target;
- required Live resources and binding health without credential values;
- validation/evaluation evidence for the exact candidate;
- `pending`, `ready`, `blocked`, `deploying`, `deployed`, or `rollback_available` state.

Deploy/Promote is visible only when the candidate differs from Live or a user has explicitly chosen
an older immutable version to promote. Selecting an older version is read-only until confirmation;
it must not mutate either environment.

The promotion manifest must record the source Playground installation, candidate/version ID,
portable capability and extension digests, evidence IDs, required binding contract, Live binding
revision, actor, timestamp, expected current Live pointer, previous release, and idempotency key.
Activation must atomically change only the selected Live installation. Runs already in progress
remain pinned to their original version, effective snapshot, and binding revision.

Portable configuration and declarations move forward. Playground credentials, conversations,
memory records, test data, provider side effects, and secret values do not. Memory and knowledge
policy are portable; their environment-local records are not. Missing, unhealthy, expired, or
incompatible Live bindings block promotion with a remediation reason.

Every agent uses the same workspace-scoped promotion lifecycle: a Playground candidate is tested
and then promoted only to that workspace's Live installation. KasiAi has one additional upstream
input—the platform-managed protected baseline and its source release gate—but that does not create
a different user lifecycle. A baseline change must enter the same candidate, readiness, promotion,
activation, and rollback path for each workspace; the existing broad system rollout path must not
be reused for an ordinary workspace Deploy action.

### Current implementation alignment

The following corrections are part of this plan, not optional UI polish:

| Current seam | Required correction |
| --- | --- |
| `StudioWorkspace.deploy()` publishes and deploys the loaded Playground installation | Split candidate publication, Playground update, and Live promotion into separate commands and targets. |
| Live installations can follow publication automatically | Make Studio-managed Live targets explicit active-release pointers so publishing cannot bypass Deploy. |
| Agent listing returns one installation view at a time | Add a paired deployment-status projection for Playground and Live, including digest drift and readiness. |
| Core forwards version publish/rollback but not the complete installation deployment/preflight path | Add authenticated Core proxy/controller contracts for status, preflight, promotion, activation, and rollback. |
| KasiAi deploy is hidden because the agent is protected; system rollout can affect many installations | Expose the same authorized Deploy/Promote contract for every agent. Treat KasiAi's protected baseline as an upstream candidate input and change only the current workspace's Live target. |
| Existing rollback changes publication state and follow-published targets | Roll back the selected Live pointer and binding revision without rewriting Playground, active runs, or evidence. |
| Extension snapshots are not joined to promotion evidence | Require the portable snapshot digest and binding contract in readiness, audit, observability, and rollback records. |

### Shared capability contract

Extend the shared context policy with concise, runtime-owned guidance:

- the current tool schemas are authoritative;
- only listed tools are callable in the current turn;
- a connected service is not callable without a registered and granted adapter;
- skills provide instructions and never grant permissions by themselves;
- capability questions should be answered from the current capability projection;
- account-specific state should be checked with a trusted tool;
- effects remain subject to approval and durable completion evidence;
- raw IDs, credentials, scopes, and internal policy markers stay out of user-facing text.

This contract applies to every hosted agent. Agent Behavior settings still own identity, purpose,
and tone, while the platform-owned discovery contract owns truthful capability awareness.

### Capability intent and grounding

Replace the current broad boolean interpretation with an explicit intent classification seam. At a
minimum it must distinguish:

- `capability_request`: what the agent can do, available tools, integrations, skills, or limits;
- `knowledge_request`: factual/configured information requiring approved evidence;
- `memory_request`: prior conversation, preferences, or durable facts;
- `effect_request`: an action that may require tools and approval;
- casual or conversational turns.

`capability_request` must not enter the no-evidence grounding fallback. `knowledge_request` keeps
the existing fail-closed behavior. The classifier must remain deterministic and covered by exact
message fixtures.

### Per-agent capability discovery and system skill

Add a platform-owned, versioned capability-discovery skill, tentatively
`agent-capability-discovery`, for every hosted agent. It is a runtime-owned contract, not an
agent-specific personality prompt. It teaches the model to:

- answer capability questions from the current effective projection;
- distinguish catalogue presence, connection state, and callable tools;
- use the current tool schemas as the authority for actions it may call;
- discover relevant skill metadata and load the matching skill instructions progressively;
- use trusted connection discovery for account-specific questions;
- describe approval-gated actions and limits accurately;
- report unavailable, ungranted, unhealthy, or unsupported capabilities;
- avoid claiming support based on names, stale memory, or catalogue presence alone.

The skill must not contain a hard-coded list of current tools. The effective capability snapshot and
registered schemas supply the changing list. Every agent receives the compact discovery contract
and only the skill/tool projections allowed by its current snapshot.

Use progressive loading rather than putting every skill body and every tool description into every
prompt:

```text
effective snapshot
    -> compact capability summary and callable tool schemas
    -> filtered skill index and dependency/readiness state
    -> relevant skill body on match or explicit discovery
    -> trusted tool result as the authority for account-specific state
```

The runtime must resolve this once per run and reuse it for prompt assembly, planning, invocation,
authorization, approvals, and journaling. An agent may discover an unavailable capability and its
reason, but it must not invoke it.

KasiAi may additionally load a protected, versioned `kasiai-platform-guidance` extension. That
extension adds KasiTek-specific identity, connection-discovery conventions, approval language, and
platform guidance. It does not replace the generic discovery skill, grant tools, or contain a
hard-coded catalogue. Custom agents receive the generic capability-discovery skill without KasiAi's
protected identity or private platform instructions.

### User-editable behavior and settings boundaries

The current Overview page exposes a large raw Instructions editor. That combines platform policy,
agent behavior, capabilities, memory, and deployment state into one opaque prompt. Replace it with
separate settings contracts.

The Overview tab becomes a read-only summary containing the agent identity, active version,
Playground/Live deployment status, and a concise draft-change summary. It must not contain the
full Instructions editor, memory configuration, or capability configuration.

Add a Behavior tab for the small set of agent characteristics users should be able to change:

- purpose and role;
- audience or workspace context;
- tone and response length;
- initiative level;
- language and formatting preferences;
- short, stable behavior rules;
- an optional advanced instruction overlay for expert users.

Store these values as typed candidate configuration. The advanced overlay is not the complete
system prompt and cannot replace platform safety, permissions, approval rules, capability grants,
or native system skills.

Keep Memory as a separate tab. It controls runtime data policy rather than personality:

- memory scope;
- allowed retrieval sources and retrieval behavior;
- write and consolidation policy;
- retention and review controls where supported;
- memory-policy readiness and evidence boundaries.

Memory records and conversations remain environment-local. They are not copied as part of a
candidate promotion. A Memory change must follow the same candidate, Playground, preflight, Deploy,
version, and rollback lifecycle as Behavior and capability changes.

The runtime prompt is assembled in this order:

```text
platform safety and execution contract
  -> behavior settings
  -> approved capabilities and native/system skills
  -> relevant memory and knowledge evidence
  -> current conversation and task
```

Behavior and memory-policy edits apply to the next Playground turn after save. They create drift
from Live and require explicit Deploy before affecting Live. Runs already in progress remain pinned
to their original candidate and effective snapshot.

### Connectors, plugins, MCP, and skills

Use one activation chain:

```text
catalogue item
  -> connection/installation configuration
  -> registered adapter or MCP tool
  -> grant and readiness check
  -> effective snapshot
  -> model schema and runtime invocation
```

An integration with no adapter remains visible as connected but unavailable. A tool with no grant
is unavailable to the agent. A skill with unmet capability or connector requirements is omitted
from loaded instructions and reported with a reason code. MCP and plugin tools use the same
snapshot, approval, redaction, and durable operation contracts as native tools.

## Implementation plan

1. [x] Confirm the existing registry, grant, connector, skill, MCP, plugin, prompt, grounding, and
   deployment seams against the current active plans; record ownership conflicts and the Core proxy
   routes that are missing.
2. [x] Define the immutable portable candidate snapshot types, deterministic digest, and pure
   projection functions.
3. [x] Define the effective per-run snapshot and prove that prompt assembly, planning, invocation,
   authorization, approvals, and journaling consume that same snapshot.
4. [x] Define the deployment-status projection and promotion manifest: candidate/live pointers,
   capability/extension digests, binding contract and revision, validation evidence, expected Live
   pointer, actor, idempotency key, previous release, and rollback target.
5. [x] Split publication from deployment in the Studio/API contract. Publishing must update only the
   candidate/Playground path; promotion must target a separate Live installation atomically.
6. [x] Add paired Playground/Live status and authenticated Core proxy/controller routes for Live
   binding preflight, promotion, activation, and target-scoped rollback.
7. [x] Ensure Studio-managed Live installations do not follow publication automatically, and add
   stale-pointer/concurrency checks so an old preflight cannot overwrite a newer Live release.
8. [x] Apply the same promotion path to custom and protected agents. For KasiAi, resolve the
   platform-managed baseline into each workspace candidate while keeping the source release gate
   as an upstream validation step, not a separate user deployment lifecycle.
9. [x] Resolve one effective capability snapshot per run after dynamic registrations and grants are
   known.
10. [x] Pass the snapshot into `DefaultContextPolicy`, the provider planner, the model tool list,
    the invocation scope, and the execution journal.
11. [x] Add capability intent classification and bypass only the inappropriate grounding branch.
12. [x] Add the shared capability contract to the main system prompt for all hosted agents.
13. [x] Create, publish, and load the generic capability-discovery system skill for every hosted
    agent, then layer the protected KasiAi platform-guidance extension only onto KasiAi.
14. [x] Remove the raw full-system Instructions editor from Overview and add the structured Behavior
    tab for identity, behavior preferences, stable rules, and the optional advanced overlay.
15. [x] Keep Memory as a separate memory-policy tab for scope, retrieval, write/consolidation,
    retention, review, and readiness. Do not use it as a second prompt editor or move memory
    records into portable promotion payloads.
16. [x] Wire connector readiness and adapter registration so connected services become callable only
    through explicit capabilities.
17. [x] Add capability resolution, promotion, activation, and rollback events plus Studio-readable
    projections without exposing secrets or raw provider identifiers.
18. [ ] Run focused tests, agent build checks, local manual KasiAi checks, promotion/rollback tests,
    and staging smoke tests. Local focused/runtime, promotion, local KasiAi, and local
    staging-equivalent checks are complete; authenticated browser checks and hosted staging
    evidence remain release gates.
19. [ ] Roll out the capability-aware path, compare grounding and tool-use telemetry, and remove
    temporary compatibility logic after the review window. The scoped
    `capability_awareness_enabled` control is implemented; staged enablement and post-review
    compatibility removal remain release-owner work.

### Implementation evidence

- `pnpm test` in `agents`: 190 test files passed, 40 skipped; 1,129 tests passed, 122 skipped.
- `pnpm build` in `agents`: passed.
- `pnpm exec tsc --noEmit` and targeted ESLint for the changed Studio/settings/integration files:
  passed.
- `pnpm build` in `client/apps/client`: passed; all 56 generated pages completed.
- `pnpm build` in `docs/internal-site`: passed after adding the staging runbook.
- `cargo check --manifest-path server/kasitek-core/Cargo.toml`: passed after adding the authenticated
  deployment proxy routes.
- `cargo test --manifest-path server/kasitek-core/Cargo.toml --lib`: 271 passed, 3 ignored.
- `git diff --check`: passed during the implementation batches.
- Local unit and HTTP coverage includes capability intent, snapshot projection, readiness reasons,
  promotion preflight, stale-pointer/idempotency checks, rollback, and route conformance.
- Local durable smoke passed with an isolated installation-token key and temporary API/gateway
  ports: REST credential exchange, tool discovery, idempotent durable execution, MCP authentication,
  protocol negotiation, and terminal completion all passed. The fixture was deleted after the run.
- A local KasiAi platform-message run answered “What tools and capabilities can you use?” from the
  effective snapshot (20 callable tools, 35 unavailable tools, no connected services, no loaded
  skills), and the run journal recorded `agent.capabilities.resolved` with `capabilityAwarenessEnabled:
  true`, `intent: capability_request`, and a snapshot digest. This verifies the native discovery
  contract is reaching the real model path rather than existing only in unit tests.
- The `capability_awareness_enabled` operator flag is additive, defaults to enabled when absent, and
  can disable only the model-facing capability contract/native discovery path while retaining the
  effective snapshot for tool admission and audit. Migration 161 and command validation cover it.
- A rollout regression test verifies that toggling `capability_awareness_enabled` changes only the
  model-facing native guidance; callable schemas, tool admission, and the effective snapshot digest
  remain identical.
- Capability snapshot digests exclude volatile run identity, so retries and equivalent Playground/Live
  resolutions compare the same candidate state; a regression test covers different run IDs.
- The local staging-equivalent capability smoke passed through the real registry/runtime seams with
  one base tool, one connected connector, one MCP tool, one isolated plugin, one pinned
  dependency-ready skill, an unavailable dependency, and an approval-gated external effect. The
  smoke also verified that the plugin and approved effect execute only through the granted runtime.
- Hosted staging execution and evidence capture are documented in
  [`agent-capability-awareness-staging.md`](../../internal/runbooks/agent-capability-awareness-staging.md);
  the target and isolated credentials are not present in this workspace.
- The local OpenTelemetry smoke passed with structured success and handled-error events. Durable
  cross-release telemetry comparison remains a staging gate.

The remaining unchecked items require a running local/staging environment with real KasiAi
connections, one MCP/plugin binding, an approval-gated effect, and release telemetry comparison.
They are validation and rollout gates, not unimplemented runtime or API seams.

## Verification

### Targeted behavior tests

- “What are the things you can do for me?” reaches the model and receives a capability answer.
- “What other things can you help with, I want a full list” does not emit
  `agent.grounding.blocked`.
- A factual question with no approved evidence still returns the grounded fallback.
- A capability answer lists only tools in the effective snapshot.
- A connected but unsupported integration is not described as callable.
- A connected integration with a registered adapter and grant appears in the model schemas.
- A pinned, dependency-ready skill is loaded; an unmet skill is omitted with a reason.
- Approval-gated tools still pause before external effects.
- Every hosted agent receives the generic capability contract, current callable tool schemas, and
  filtered skill-discovery projections. Custom agents do not receive KasiAi's identity or protected
  platform guidance.
- Overview contains only the identity, version, deployment, and draft summary; it has no raw
  full-system Instructions editor, memory editor, or capability editor.
- Behavior settings update the next Playground turn after save and do not affect Live until explicit
  Deploy.
- Behavior settings cannot override platform safety, permissions, capability grants, approval
  requirements, or native/system skills.
- Memory settings change retrieval/write policy only. They do not change identity, tone, or the
  agent's capability list.
- Editing, publishing, and running a Playground candidate never changes Live.
- A capability or extension digest mismatch makes deployment pending and exposes a Live preflight,
  rather than silently activating the candidate.
- Missing or unhealthy Live bindings block promotion with a stable remediation reason.
- Deploying a selected historical version activates that exact immutable snapshot only after explicit
  confirmation.
- A failed or stale activation cannot move the Live pointer; concurrent activation is rejected by
  the expected-pointer/idempotency check.
- Rollback changes the selected Live pointer and binding revision without mutating Playground,
  active runs, conversations, memories, or execution evidence.
- Every agent's promotion updates only the selected workspace's Live installation. KasiAi's
  platform baseline release may be operated separately by the platform, but normal workspace
  deployment still uses the shared candidate and promotion lifecycle.

### Technical checks

- Agents unit and integration tests for intent, snapshot projection, skill selection, grants,
  connector readiness, MCP/plugin registration, and prompt assembly.
- Agent TypeScript build and generated capability documentation checks.
- Redaction checks for model, journal, Studio, and error projections.
- Local run inspection showing `agent.capabilities.resolved`, model tool schemas, and tool events.
- Local deployment inspection showing the portable snapshot digest, effective Playground/Live
  snapshots, promotion manifest, binding revision, activation record, and rollback target.
- Local staging-equivalent smoke test with one base tool, one connected connector, one pinned skill,
  one MCP tool, one isolated plugin, and one approval-gated action.
- Hosted staging smoke test with the same capability mix and real provider/MCP/plugin bindings.

## Release record

- **Change:** Runtime capability awareness for every hosted agent, capability-question routing,
  the per-agent capability-discovery system skill, the protected KasiAi guidance extension,
  structured user-editable Behavior settings, separate Memory policy settings, and the capability
  snapshot/promotion contract that keeps Playground changes out of Live until explicit deployment.
- **Owner:** Agent Platform and Studio.
- **Risk:** high. The change affects model prompts, tool admission, integrations, skills, and
  protected KasiAi behavior.
- **Affected services and user surfaces:** Agents API and worker, capability registry, connector
  adapters, skill/MCP/plugin activation, KasiAi chat, custom-agent runs, Studio capability and
  execution observability.
- **Platform release version or release ID:** to be assigned at implementation release.
- **API/schema/migration changes:** skill system-scope pin/read-path changes plus typed Behavior and
  Memory-policy configuration, candidate snapshot, deployment-status, promotion-manifest,
  binding-preflight, activation, and rollback contracts; keep migrations additive and reversible.
  No destructive data migration is required for the initial rollout.
- **Feature flag or rollout method:** capability-awareness runtime flag plus protected KasiAi
  version rollout. Existing factual grounding remains the safe fallback.
- **Analytics events and success metrics:** capability-request success rate, model-call admission
  rate for capability questions, capability-resolution failures, unavailable-capability reasons,
  tool-call success rate, grounding-block rate by intent, pending-deployment rate, preflight
  failures, promotion/activation/rollback outcomes, and Live binding drift. Reuse the analytics
  registry.
- **Logs, metrics, dashboards, and alerts:** structured `agent.capabilities.resolved`, capability-
  intent, promotion preflight, activation, and rollback events with candidate/live IDs, snapshot
  digests, bounded counts, release identity, and no raw message bodies or credentials. Alert on
  resolver failures, unexpected model/tool divergence, digest mismatch, binding drift, stale
  pointer rejection, and activation failure.
- **User, API, internal, and operational documentation:** update agent capability discovery,
  skills, connectors, KasiAi behavior, Playground/Live deployment semantics, rollback behavior,
  and Studio observability documentation.
- **Validation evidence:** local evidence is recorded in the implementation-evidence section above;
  staging smoke and telemetry comparison remain release gates.
- **Rollback or disable plan:** disable the capability-awareness flag and promotion controls, keep
  the existing factual grounding guard and tool grants intact, and atomically restore the previous
  Live candidate/binding revision for the affected workspace. Do not delete candidate snapshots,
  conversations, memories, active-run evidence, or promotion records. A platform-managed KasiAi
  baseline rollback is an upstream release action; workspace Live rollback still uses the shared
  target-scoped mechanism.
- **Post-release review date:** to be assigned with the release owner.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Generic capability contract | Shared context runtime, not duplicated in each agent prompt | Agent Platform | Implemented |
| Capability discovery skill | Platform-owned, versioned, available to every hosted agent; compact summary and filtered skill/tool projections come from the effective snapshot | Agent Platform | Implemented |
| KasiAi guidance extension | Protected, versioned platform guidance layered onto the generic discovery skill; never the source of the tool catalogue | Agent Platform | Implemented |
| Capability source of truth | One effective per-run snapshot reused by prompt, planner, runtime, and Studio | Agent Platform | Implemented |
| Promotion source of truth | Immutable portable candidate snapshot plus explicit promotion manifest; never the browser's selected version or raw installation settings | Agent Platform | Implemented |
| Playground/Live relationship | Separate installation pointers with environment-specific bindings; publishing does not activate Live | Agent Platform | Implemented |
| Deployment visibility | Show Deploy/Promote only when candidate and Live digests or required binding state differ | Studio | Implemented |
| Historical version selection | Read-only preview until explicit promotion confirmation | Studio | Implemented |
| Rollback semantics | Atomically restore the previous Live candidate and binding revision; keep active runs and evidence unchanged | Agent Platform | Implemented |
| Agent promotion scope | Every agent promotes a candidate only to the selected workspace's Live installation; no cross-workspace mutation | Agent Platform | Implemented |
| KasiAi baseline | Platform-managed baseline is an upstream candidate input and release-gate concern, not a different user lifecycle | Agent Platform | Implemented |
| Connected integrations | Connection state does not imply callable capability | Platform Integrations | Implemented |
| System-skill loading scope | Source-defined runtime inclusion supplies the versioned generic skill to every hosted agent; user skills remain pinned and progressively loaded | Agent Platform | Implemented |
| Settings information architecture | Overview is a read-only summary; Behavior owns user-editable identity and response preferences; Memory owns retrieval/write policy | Studio and Agent Platform | Implemented |
| User-editable behavior boundary | Advanced instructions are an overlay, not the complete system prompt, and cannot override platform-owned rules | Studio and Agent Platform | Implemented |
| Memory settings boundary | Keep Memory for scope, retrieval, write/consolidation, retention, review, and readiness; keep records environment-local | Studio and Agent Platform | Implemented |
| Google Calendar/Drive/Gmail tools | Decide which adapters and actions are supported first | Platform Integrations | Open |
| Capability summary size | Compact prompt projection first; detailed discovery is progressive through the metadata index and matched skill bodies | Context Runtime | Implemented |
| Rollout flag | `capability_awareness_enabled`, scoped globally, by organization, or installation; absent rows default enabled | Release owner | Implemented |

## Notes and blockers

- Existing capability-registry and extension-surface work owns catalogue and snapshot foundations;
  this plan adds the model-awareness and KasiAi behavior layer on top of those seams.
- The portable capability snapshot introduced here is the contract shared by capability awareness
  and Playground-to-Live promotion. The effective run snapshot remains environment-specific and
  must resolve Live bindings independently.
- Existing knowledge grounding remains correct for factual questions. This plan changes intent
  routing and capability context, not the evidence policy.
- The current Studio deployment path is not aligned with this contract: it targets the loaded
  Playground installation, while the browser/Core path lacks the complete promotion preflight and
  activation surface. These are explicit implementation tasks above, not accepted behavior.
- The current Overview Instructions editor is not aligned with the user-editable behavior boundary.
  It must be removed from Overview and replaced by typed Behavior settings. Overview must not become
  a memory or capability editor.
- The capability-discovery design is per-agent. The protected KasiAi guidance extension is only an
  additional identity and platform-policy layer; it must not be mistaken for the generic discovery
  mechanism or used to hard-code KasiAi's current tools.
- The Memory tab remains necessary when it represents memory policy. It should not be used as a
  second prompt editor or as a view of portable memory records.
- Runtime, deployment, Studio settings, and rollout-control implementation is recorded above. The
  remaining gates are environment-bound: authenticated local browser checks against KasiAi, staging
  provider/MCP/plugin/approval smoke, telemetry comparison, and release-owner sign-off.
