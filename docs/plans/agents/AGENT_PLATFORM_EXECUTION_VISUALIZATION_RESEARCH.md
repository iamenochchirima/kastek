---
id: agent-platform-execution-visualization-research
title: Agent execution visualization platform research
sidebar_label: Execution visualization research
slug: /execution-visualization-research
description: Primary-source comparison of agent builders, tracing products, and durable runtimes with execution visualization.
---

# Agent Execution Visualization Platform Research

**Date:** 2026-09-06

**Purpose:** Compare how established agent platforms help developers, operators, and agent
builders understand executions, then use the findings to refine the third Agent Platform
implementation chunk.

This is architecture research, not a recommendation to add any of these products as a runtime
dependency. The relevant question is which interaction patterns and data contracts are worth
adapting to KasiTek's own harness, Temporal workflows, PostgreSQL evidence, tenant isolation, and
local-first development model.

## Comparison

| Platform | Primary role | What it visualizes | Useful pattern for KasiTek | What we should not copy |
| --- | --- | --- | --- | --- |
| n8n | Workflow builder and automation runtime | Authored node canvas, execution list, per-node data, failed-run debug and retry | Load a past run into a safe test context and inspect each step's input/output | Make every ordinary agent a block workflow or treat node success as proof of agent quality |
| LangGraph Studio / LangSmith | Agent IDE plus tracing/evaluation | Graph architecture, live node execution, prompts, tools, intermediate state, threads, traces, time travel | Local test playground, thread/run hierarchy, state inspection, breakpoints, replay/fork for isolated experiments | Treat a graph editor as the default custom-agent experience |
| Google ADK Web UI | Development UI for ADK agents | Sessions, mutable state, event history, agent tree, request/response detail, visual builder | Development-only run inspector with event history and agent-tree drill-down | Use a development UI as a production control plane or expose unrestricted state editing |
| Dify Workflow Studio | Visual AI workflow/app builder | Canvas nodes, variables, execution paths, node outputs, logs, human review, versioned runs | Make intermediate values and branch paths inspectable; allow testing one node or the whole flow | Couple chat agents to a large canvas when a profile plus tools is enough |
| Microsoft Foundry | Agent development and publication lifecycle | Playground conversations, traces, versions, evaluations, and publication | Treat experimentation, immutable versioning, evaluation, and publication as distinct states | Assume a generic test panel proves every published channel |
| AWS AgentCore | Local-to-deployed agent runtime tooling | Real local server/inspector, deployed endpoint, invocation logs | Keep the invocation contract stable while environment and deployment bindings change | Build a second fake runtime for local testing |
| Langfuse | LLM/agent observability and evaluation | Trace tree, sessions, agent graph, generations, tool calls, retrieval, cost, latency, evaluations | Separate session → run/trace → nested operation model; aggregated and exact execution views | Use inferred telemetry graphs as the authoritative execution record |
| Pydantic Logfire | Full-stack OpenTelemetry observability | Live traces, LLM panels, messages, tool calls, token/cost data, backend spans, evaluation links | Correlate agent decisions with the actual backend/API/database work inside a tool | Capture unlimited prompts, tool payloads, or PII in a general telemetry stream |
| Restate UI | Durable execution runtime and control plane | Invocation list, journal, state, nested calls, retries, live execution, pause/resume/cancel/kill/restart | Keep a durable journal separate from telemetry and make controls state-aware and explicit | Copy Restate's runtime; Temporal remains KasiTek's durable execution layer |
| CrewAI AMP | Managed multi-agent deployment platform | Crew execution traces/logs, streaming updates, crew studio | Treat multi-agent parent/child execution as one inspectable call tree | Add multi-agent UI before the single-agent journal and control model is reliable |

## Detailed findings

### n8n: execution data attached to an authored workflow

n8n treats the workflow canvas as the primary artifact. Its execution list can filter runs by
status, and failed executions can be retried with either the currently saved workflow or the
original workflow. A past execution can also be loaded into the current editor so the developer
can debug with the previous data.

Sources: [all executions](https://docs.n8n.io/workflows/executions/all-executions/) and [debug and
re-run past executions](https://docs.n8n.io/workflows/executions/debug).

**KasiTek decision:** Adopt the idea of deriving a reproducible input fixture from a prior run.
Adapt it so re-execution creates a new real Playground run pinned to explicit candidate and binding
snapshots. Because that run may repeat effects, require the normal approval, idempotency, and
reconciliation policy. Do not adopt the block-first authoring model for ordinary agents.

### LangGraph Studio and LangSmith: agent IDE plus trace debugger

LangGraph Studio has graph and chat modes. Graph mode exposes execution details and intermediate
state; chat mode provides a simpler interface for testing chat-oriented agents. The local
development server lets a developer inspect prompts, tool arguments and returns, token and latency
data, use breakpoints, and rerun a thread from a prior step. Studio also supports editing state
and forking a thread for experiments.

LangSmith's trace UI complements Studio with message, turns, and details views. The thread remains
the navigation context while a developer drills into a specific model or tool run.

Sources: [LangSmith Studio](https://docs.langchain.com/oss/python/langgraph/studio), [Studio
features](https://langchain-ai.github.io/langgraph/concepts/langgraph_studio/), [Studio run and
thread workflows](https://langchain-ai.github.io/langgraph/cloud/how-tos/datasets_studio/), and
[LangSmith trace views](https://docs.langchain.com/langsmith/view-traces).

**KasiTek decision:** Adopt the distinction between a simple Playground conversation and a detailed
run inspector. Adopt replay/fork as a development feature. Adapt it to immutable candidate,
extension, and environment binding snapshots, Temporal checkpoints, effect receipts, and a new
Playground run identity. Never edit an active live run's state from the browser.

### Google ADK Web UI: event-first development inspection

ADK Web is explicitly positioned as a development and debugging UI. It provides session
management, state inspection, event history, and a visual builder. ADK's event view can show an
agent tree and lets a developer inspect the request and response passed through each agent.

Sources: [ADK Web Interface](https://adk.dev/runtime/web-interface/), [ADK event model](https://adk.dev/live/events/),
and [ADK multi-agent event view](https://codelabs.developers.google.com/codelabs/production-ready-ai-with-gc/3-developing-agents/build-a-multi-agent-system-with-adk).

**KasiTek decision:** Adopt event history as the basis for live development inspection and make
agent/child relationships visible when they exist. Adapt state inspection to bounded, redacted
projections and durable command requests. Keep production controls separate from the local
developer playground.

### Dify: inspect the values moving through a visual flow

Dify combines a visual workflow canvas with a run inspector. Its workflow surface emphasizes node
outputs, variables, execution paths, logs, human review, version history, and testing a single node
or the complete flow.

Source: [Dify Workflow Studio](https://dify.ai/workflows).

**KasiTek decision:** Adopt the visibility of intermediate context decisions, retrieval results,
tool outputs, and branch paths. Do not make the canvas the required configuration surface for
simple customer-facing agents. Our generated execution graph should show actual behavior even when
the agent was configured as a profile with skills and tools.

### Langfuse: traces, sessions, and two graph readings

Langfuse models observations as nested steps inside traces, with traces grouped into sessions. It
supports agent graphs inferred from nested observations and provides two readings: an aggregated
view that collapses repeated steps and cycles, and an expanded view that shows each actual call.
Its guidance emphasizes one generation per model invocation, with tool calls nested beside the
generation that requested them, rather than wrapping an entire loop in one opaque generation.

Sources: [Langfuse data model](https://langfuse.com/docs/observability/data-model), [agent
graphs](https://langfuse.com/docs/observability/features/agent-graphs), and [trace best
practices](https://langfuse.com/docs/observability/best-practices).

**KasiTek decision:** Adopt the session → run → nested operation hierarchy and the aggregated versus
expanded graph choice. Adopt the rule that every model turn and tool call is independently visible.
Adapt graph construction so durable journal events—not inferred telemetry—remain authoritative.

### Logfire: AI details plus the backend work behind tools

Logfire's AI panels show messages, tool calls, token usage, latency, and cost. Its OpenTelemetry
foundation also allows the same trace to include backend spans, such as database queries and API
calls performed inside a tool. Its live view supports real-time trace arrival and historical search.

Sources: [AI observability](https://logfire.pydantic.dev/docs/ai-observability/), [LLM
panels](https://logfire.pydantic.dev/docs/guides/web-ui/llm-panels/), and [live
view](https://logfire.pydantic.dev/docs/guides/web-ui/live/).

**KasiTek decision:** Adopt full-stack correlation. A tool item in the observatory should link to
its bounded capability result and, where permitted, a correlated backend trace or operation—not
just show that the model requested a tool. Keep raw data and sensitive content behind authorization
and retention policy.

### Restate: journal-backed execution control

Restate's UI exposes active and completed invocations, a step-by-step journal, state, nested calls,
and controls such as cancel, kill, pause, resume, and restart from a journal prefix. Restate's
documentation also distinguishes durable journals from OpenTelemetry traces and exposes journal
retention as a debugging and audit decision.

Sources: [Restate observability and control](https://docs.restate.dev/ai/patterns/observability-control),
[invocation management](https://docs.restate.dev/services/invocation/managing-invocations), and
[journal retention](https://docs.restate.dev/services/configuration).

**KasiTek decision:** This is the closest reference for the control-plane model. Adopt the idea that
the UI reads a durable execution journal and that pause/cancel/restart controls are explicit state
transitions. Adapt restart and replay to Temporal workflows, operation receipts, and external-effect
reconciliation. Do not provide a generic “restart from here” action until the effect policy proves
which operations are safe to replay.

## Verified Playground execution findings

The platforms use different terminology, but their useful development surfaces execute agent code
and expose real runtime events rather than manufacturing successful results:

- LangGraph Studio connects to a locally running agent server and executes the agent's graph,
  prompts, tools, state, and threads. The development deployment is separate from production, but
  it is still an execution environment. Sources: [LangGraph Studio](https://docs.langchain.com/oss/python/langgraph/studio)
  and [local server](https://docs.langchain.com/oss/python/langgraph/local-server).
- Google ADK Web runs and debugs agents with actual sessions, state, and event history, while
  explicitly remaining a development interface rather than a production UI. Source: [ADK Web
  Interface](https://adk.dev/runtime/web-interface/).
- Dify's test-run path invokes the workflow, and plugin remote debugging routes real plugin
  invocations to a local process. Sources: [application testing](https://docs.dify.ai/en/guides/application-orchestrate/creating-an-application)
  and [plugin remote debugging](https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/remote-debug-a-plugin).
- Microsoft Foundry separates configuration, Playground testing, tracing/evaluation, versioning,
  and publication. Microsoft also warns that a test panel does not necessarily reproduce every
  published channel behavior. Sources: [agent development lifecycle](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/development-lifecycle),
  [playgrounds](https://learn.microsoft.com/en-sg/azure/ai-foundry/concepts/concept-playgrounds?view=foundry),
  and [channel testing limitation](https://learn.microsoft.com/en-us/microsoft-copilot-studio/authoring-test-bot).
- AWS AgentCore's development command starts a real local server and inspector; deployment then
  makes the agent available through a deployed endpoint using the same invocation model. Source:
  [AgentCore CLI lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-get-started-cli.html).

The architecture lesson is not that test and live resources must be identical. It is that runtime
semantics should be identical while resource authority is environment-specific. A credible
Playground therefore needs real model calls, tool implementations, provider/gateway adapters,
receipts, retries, approvals, and durable evidence, bound to isolated or constrained test
resources. A mock can support automated unit tests, but it cannot certify an agent for promotion.

**KasiTek decision:** Playground is a first-class environment on the same AgentHarness and Temporal
runtime as live. Candidate configuration and extension snapshots are portable and immutable.
Credentials, provider accounts, data namespaces, channel identities, destinations, quotas, and
approvers are resolved through separate environment bindings. Promotion activates the exact tested
candidate against validated live bindings; it does not recreate the configuration or copy test
state.

## Sanitized design direction for KasiTek

The comparison narrows the third chunk to five surfaces:

1. **Real execution Playground:** select an immutable candidate, extension snapshot, and Playground
   binding snapshot; execute through the production-equivalent runtime and inspect the result.
2. **Run observatory:** inspect a session → run → operation hierarchy for test and active runs.
3. **Timeline:** the exact ordered account of what happened, including waits, retries, parallel
   operations, delivery, and unknown outcomes.
4. **Graph view:** a generated overview of the timeline, with aggregated and expanded modes. It is
   not the source of truth and it does not imply authored blocks.
5. **Control and recovery:** state-aware commands that become durable events and show pending,
   refused, completed, or failed outcomes.

The third chunk should therefore add explicit requirements for:

- per-model-turn and per-tool-call visibility rather than one opaque “agent run” span;
- session grouping across multiple conversational runs;
- aggregated and exact execution graph modes;
- real-run replay/fork with a new run identity, repeated-effect warning, and normal approval and
  idempotency policy;
- explicit environment identity and immutable resource-binding revisions on every run;
- same-artifact and same-candidate parity checks between Playground and live;
- promotion manifests that bind real execution/evaluation evidence to the exact candidate digest;
- per-channel proof through real gateway ingress and delivery paths;
- inspection of context decisions, token use, latency, cost, retrieval provenance, and bounded
  tool result projections;
- correlation from agent operation to backend/provider activity where authorized;
- durable journal authority distinct from sampled telemetry;
- development playground controls separated from production operator controls;
- manual evaluation and annotation links as a later extension of the run inspector.

## Deliberate non-goals

- We are not building an n8n clone.
- We are not requiring ordinary agents to be authored as graphs.
- We are not storing raw prompts, credentials, or unrestricted tool payloads in every projection.
- We are not using OpenTelemetry spans as the durable state machine.
- We are not adding a third-party observability dependency as the Agent Platform runtime.
- We are not enabling arbitrary state edits or side-effect replay from the UI.
- We are not presenting mock or dry-run success as evidence that an agent is ready for live use.
- We are not copying Playground credentials, conversations, memories, data, or effects into live.

## Research limitations

This comparison focuses on official product and developer documentation. It does not measure each
product's runtime performance, pricing, retention defaults, security posture, or usability through
hands-on trials. Those are separate evaluation questions if KasiTek later considers an external
observability product.

## Independent UX synthesis for the KasiTek Playground

This section is an additional design pass based on the current official product documentation and
the KasiTek execution model. It is intentionally a UX recommendation, not a proposal to copy any
competitor's runtime or visual style.

### What the current products make clear

- **The development loop must be explicit.** Microsoft Foundry presents a lifecycle of create,
  test, trace, evaluate, publish, and monitor. It treats saved agent versions as immutable while
  allowing unsaved changes for experimentation. See [the Foundry development lifecycle](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/development-lifecycle)
  and [Foundry Playgrounds](https://learn.microsoft.com/en-us/azure/foundry/concepts/concept-playgrounds).
- **A simple chat view and a deep debugger serve different users.** LangGraph Studio separates
  chat mode from graph mode, then adds threads, breakpoints, state inspection, and fork/re-run
  actions for deeper debugging. See [How to use Studio](https://docs.langchain.com/langsmith/use-studio)
  and [LangSmith Studio](https://docs.langchain.com/langsmith/studio).
- **Development inspection is event-first.** Google ADK Web provides sessions, state inspection,
  and event history, but explicitly labels the interface as development-only. That is a useful
  debugging pattern, not a reason to make a browser UI the runtime authority. See [ADK Web](https://adk.dev/runtime/web-interface/).
- **Durable control needs a journal-shaped interface.** Restate exposes invocations, a step-by-step
  journal, state, nested calls, and explicit cancel/kill actions. KasiTek should use the same
  clarity while keeping Temporal and the KasiTek journal as the runtime authority. See [Restate
  Observability & Control](https://docs.restate.dev/ai/patterns/observability-control).
- **The local inspector should still exercise the real harness.** AgentCore's local development
  flow opens an inspector that can chat with the harness, inspect traces, browse resources, and
  override harness settings for the session. This supports KasiTek's same-runtime Playground
  requirement. See [AgentCore harness development](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness-get-started.html).
- **Tool and extension development needs a visible attachment point.** Dify's remote plugin
  debugging attaches a local plugin to a workspace and lets users trigger it through a workflow or
  agent while inspecting the live invocation. KasiTek can adapt the idea to MCP, skills, and
  connectors without exposing secrets or treating a debug attachment as production authority. See
  [Dify plugin debugging](https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/remote-debug-a-plugin).

### Proposed KasiTek product model

The Playground should feel like a serious agent workbench, not a chatbot page and not a workflow
canvas. The primary mental model is:

```text
Configure a draft → Run a real test → Understand the execution → Validate evidence → Promote
```

Use one agent workspace with four explicit modes:

1. **Build** — configure the agent profile and its declared capabilities.
2. **Playground** — submit direct or channel-bound test inputs against a pinned candidate and
   Playground binding.
3. **Runs** — inspect sessions, runs, operations, retries, waits, receipts, and failures.
4. **Release** — compare candidates, validate evidence, review binding differences, promote, and
   roll back.

These are modes of one workspace, not unrelated dashboard pages. The active candidate, environment,
binding revision, and release state should remain visible in the workspace header.

### Proposed screen structure

#### Build mode: profile first

Use a compact vertical configuration rail with sections such as:

- Behavior: identity, instructions, response style, model policy.
- Capabilities: tools, skills, plugins, MCP servers, requested versus granted access.
- Knowledge and memory: source declarations, retrieval policy, memory scope.
- Channels: web, WhatsApp, Telegram, Discord, REST, MCP, and declared delivery behavior.
- Safety and operations: approvals, handoff, budgets, limits, timeouts, and concurrency.
- Environment: Playground resource bindings and readiness, kept separate from portable agent data.

The main panel should show the effective configuration, not a form maze. Each section should expose
what is portable, what is environment-bound, and what is unresolved. The user should be able to
create an immutable candidate without ever seeing secret values.

#### Playground mode: a three-pane test workbench

- **Left: Test setup.** Candidate/version, Playground environment, channel or direct invocation,
  test input, binding health, destination, budget, and approval requirements. This pane is also the
  readiness gate; it should tell the user what is missing before a run starts.
- **Center: Interaction.** Conversation or channel-shaped input/output. The center should make the
  test feel like the actual experience the customer will have, including attachments and gateway
  metadata where relevant.
- **Right: Execution.** A live, generated activity stream showing context preparation, model turns,
  selected tools, tool results, approvals, handoff, delivery, retries, and unknown effects. Selecting
  an item opens bounded detail in place; the user should not have to leave the test to understand it.

The right pane is not a decorative node animation. It is a readable execution account backed by the
journal. The user can switch it between a compact timeline and a generated graph overview, while the
timeline remains the authoritative reading.

#### Runs mode: investigation without losing context

Start with a run list grouped by session, source channel, environment, candidate, state, and age.
Selecting a run keeps the conversation/input visible while exposing:

- Summary: outcome, current state, environment, candidate, and binding revision.
- Timeline: ordered operations with retries, waits, and deliveries preserved.
- Graph: generated overview or exact execution; never presented as authored configuration.
- Operation detail: bounded inputs/outputs, provenance, attempts, receipts, latency, cost, and safe
  next actions.
- Context: retrieval provenance, context decisions, and token budget decisions where authorized.

Replay and fork should be actions on a checkpoint, not edits to the original run. The UI must warn
when the new run can repeat an external effect.

#### Release mode: evidence before promotion

Release should read as a checklist of evidence, not a generic deploy button:

1. Candidate digest and extension snapshot.
2. Required Playground scenarios and channel evidence.
3. Evaluation results and unresolved failures.
4. Playground/live binding differences.
5. Required authority, destination, approval, and rollback target.
6. Atomic activation and post-activation smoke state.

The final action should be **Promote candidate**, with the exact candidate, evidence, binding
revision, and rollback target visible before approval.

### Interaction rules

- Keep environment identity and candidate identity persistent; never make a user infer whether they
  are testing or affecting live traffic.
- Use state language instead of animation: `waiting for approval`, `retrying`, `unknown effect`,
  `replaying`, and `reconciliation required` must be explicit.
- Use color only as a secondary state cue. Status must also be represented by text, icons, and layout.
- Keep the timeline dense but calm. Expand detail on demand; do not render every payload in the
  default view.
- Make every control explain its valid transition and refusal reason. Do not expose a generic
  restart or retry action when the operation is not idempotency-safe.
- Make the conversation and execution evidence adjacent. The user should be able to answer both
  “what did the customer see?” and “what did the agent actually do?” in one view.
- Treat the graph as a navigation aid and pattern overview, never as a second source of truth.
- Do not use neon gradients, floating AI ornaments, decorative node animations, or a giant empty
  canvas to imply intelligence. The product should look like a high-quality operations workbench.

### What KasiTek should deliberately avoid

- Reusing the current workflow editor as the main Playground.
- Making ordinary agents assemble from blocks before they can be configured as profiles.
- Building a fake test chat that bypasses real capabilities, gateways, receipts, and delivery.
- Hiding environment, destination, or authority differences behind a generic “test” label.
- Treating traces or browser state as the durable source of truth.
- Making the main screen an operator wall of metrics instead of a focused test-and-understand loop.
- Copying competitor concepts without adapting them to tenant isolation, durable execution, effect
  reconciliation, and KasiTek's channel model.
