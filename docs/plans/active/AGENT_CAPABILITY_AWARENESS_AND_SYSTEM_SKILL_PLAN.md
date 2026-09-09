# Agent capability awareness and KasiAi system skill

**Status:** Draft

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
same effective tool, connector, plugin, MCP, and skill state that the runtime will enforce. KasiAi
must answer capability questions from that state instead of failing through the factual-knowledge
grounding guard.

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
- A single per-run effective capability snapshot used by prompting, planning, invocation, and
  observability.
- A separate `capability_request` intent for self-description and capability discovery.
- A platform-owned, versioned, native KasiAi system skill.
- Explicit connector-to-tool readiness and availability projection.
- Model-facing capability summaries derived from the canonical registry.
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

This contract applies to custom agents. Agent instructions still own identity, purpose, and tone.

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

### Native KasiAi system skill

Add a platform-owned skill, tentatively `kasiai-platform-capabilities`, with a published immutable
version. It should teach KasiAi how to:

- answer capability questions from the runtime projection;
- distinguish connection state from callable tools;
- use connection discovery for account-specific questions;
- describe approval-gated actions accurately;
- report unavailable, ungranted, or unhealthy capabilities;
- avoid claiming support based on names or catalogue presence alone.

The skill must not contain a hard-coded list of all current tools. The capability snapshot supplies
the list. The skill should be loaded for every protected KasiAi turn through a system-scope pin or
equivalent source-defined system-skill mechanism. It must remain separate from user-editable skills.

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

1. [ ] Confirm the existing registry, grant, connector, skill, MCP, plugin, prompt, and grounding
   seams against the current active plans; record any ownership conflicts.
2. [ ] Define the effective capability snapshot types and pure projection functions.
3. [ ] Resolve one snapshot per run after dynamic registrations and grants are known.
4. [ ] Pass the snapshot into `DefaultContextPolicy`, the provider planner, the model tool list,
   the invocation scope, and the execution journal.
5. [ ] Add capability intent classification and bypass only the inappropriate grounding branch.
6. [ ] Add the shared capability contract to the main system prompt for all hosted agents.
7. [ ] Create, publish, and load the native KasiAi system skill through a versioned system scope.
8. [ ] Wire connector readiness and adapter registration so connected services become callable only
   through explicit capabilities.
9. [ ] Add capability resolution events and Studio-readable projections without exposing secrets or
   raw provider identifiers.
10. [ ] Run focused tests, agent build checks, local manual KasiAi checks, and staging smoke tests.
11. [ ] Roll out the capability-aware path, compare grounding and tool-use telemetry, and remove
   temporary compatibility logic after the review window.

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
- Custom agents receive the generic capability contract but not KasiAi's identity or system skill.

### Technical checks

- Agents unit and integration tests for intent, snapshot projection, skill selection, grants,
  connector readiness, MCP/plugin registration, and prompt assembly.
- Agent TypeScript build and generated capability documentation checks.
- Redaction checks for model, journal, Studio, and error projections.
- Local run inspection showing `agent.capabilities.resolved`, model tool schemas, and tool events.
- Staging smoke test with one base tool, one connected connector, one pinned skill, one MCP tool,
  and one approval-gated action.

## Release record

- **Change:** Runtime capability awareness, capability-question routing, and native KasiAi system
  skill.
- **Owner:** Agent Platform and Studio.
- **Risk:** high. The change affects model prompts, tool admission, integrations, skills, and
  protected KasiAi behavior.
- **Affected services and user surfaces:** Agents API and worker, capability registry, connector
  adapters, skill/MCP/plugin activation, KasiAi chat, custom-agent runs, Studio capability and
  execution observability.
- **Platform release version or release ID:** to be assigned at implementation release.
- **API/schema/migration changes:** likely skill system-scope pin/read-path changes; keep migrations
  additive and reversible. No destructive data migration is required for the initial rollout.
- **Feature flag or rollout method:** capability-awareness runtime flag plus protected KasiAi
  version rollout. Existing factual grounding remains the safe fallback.
- **Analytics events and success metrics:** capability-request success rate, model-call admission
  rate for capability questions, capability-resolution failures, unavailable-capability reasons,
  tool-call success rate, and grounding-block rate by intent. Reuse the analytics registry.
- **Logs, metrics, dashboards, and alerts:** structured `agent.capabilities.resolved` and
  capability-intent events with snapshot checksum, bounded counts, release identity, and no raw
  message bodies or credentials. Alert on resolver failures and unexpected model/tool divergence.
- **User, API, internal, and operational documentation:** update agent capability discovery,
  skills, connectors, KasiAi behavior, and Studio observability documentation.
- **Validation evidence:** to be recorded after implementation and staging verification.
- **Rollback or disable plan:** disable the capability-awareness flag and roll protected KasiAi back
  to the previous published version. Keep the existing factual grounding guard and tool grants
  intact while investigating.
- **Post-release review date:** to be assigned with the release owner.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Generic capability contract | Shared context runtime, not duplicated in each agent prompt | Agent Platform | Proposed |
| KasiAi native skill | Platform-owned, versioned, always loaded for protected KasiAi | Agent Platform | Proposed |
| Capability source of truth | One effective per-run snapshot reused by prompt, planner, runtime, and Studio | Agent Platform | Proposed |
| Connected integrations | Connection state does not imply callable capability | Platform Integrations | Proposed |
| System-skill loading scope | Add an explicit system-scope pin/read path or equivalent source-defined inclusion | Agent Platform | Open |
| Google Calendar/Drive/Gmail tools | Decide which adapters and actions are supported first | Platform Integrations | Open |
| Capability summary size | Compact prompt projection first; detailed discovery may become a read-only capability | Context Runtime | Open |
| Rollout flag | Choose flag name and whether custom agents enter the first rollout | Release owner | Open |

## Notes and blockers

- Existing capability-registry and extension-surface work owns catalogue and snapshot foundations;
  this plan adds the model-awareness and KasiAi behavior layer on top of those seams.
- Existing knowledge grounding remains correct for factual questions. This plan changes intent
  routing and capability context, not the evidence policy.
- No implementation changes are included in this draft. Refine the open decisions before coding.
