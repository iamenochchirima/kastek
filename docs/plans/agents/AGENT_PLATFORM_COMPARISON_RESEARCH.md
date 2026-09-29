# Agent platform comparison research

**Status:** Research note

**Owner:** Agent Platform

**Research date:** 2026-09-03

## Question

Which current agent platforms and execution runtimes are worth studying for KasiTek's goal of
reliable, stateful, tool-using agents that can pause for approval, survive failures, and report
truthful outcomes?

This is a research note only. It does not propose adopting a vendor or changing product code.
Claims below are based on first-party documentation or source repositories linked in each section.

## Executive summary

No single platform cleanly replaces KasiTek's current architecture.

- **LangGraph/LangSmith Deployment** is the closest reference for a stateful agent server: graph
  checkpoints, threads, runs, interrupts, a task queue, streaming, MCP/A2A, and self-hosting
  options.
- **Temporal** remains the strongest reference for durable, long-running business operations. It
  is an execution substrate rather than an agent toolkit.
- **Pydantic AI** is a useful reference for typed tools, deferred approval, provider-independent
  MCP, and OpenTelemetry-native instrumentation without forcing a large control plane.
- **OpenAI Agents SDK** demonstrates a compact agent loop with sessions, serializable approval
  state, handoffs, and built-in tracing. Durable execution is intentionally delegated to systems
  such as Temporal, Restate, Dapr, or DBOS.
- **Restate** and **Inngest** show lighter durable-function models that checkpoint steps and wait
  for external events. They are useful design references, but adopting a second execution runtime
  alongside Temporal would add operational and conceptual cost.
- **Letta** is the strongest reference for persistent agent identity and long-term memory, not for
  provider-side effects or workflow reconciliation.
- **Dify** is the strongest visual workflow/plugin reference, but its visual abstraction should not
  replace typed, auditable effect boundaries for KasiTek's external actions.
- **Microsoft Foundry Agent Service** and **Google Vertex AI Agent Engine** show what a managed
  enterprise control plane provides: hosted runtime, sessions, tools, identity, tracing, and
  deployment. They also demonstrate the cost of cloud-specific coupling.

The main architectural lesson for KasiTek is to keep three boundaries explicit:

```text
Agent loop and context
        ↓
Durable operation coordinator
        ↓
Provider/tool adapter and external effect
```

An agent framework can help with the first boundary. Temporal already covers much of the second.
The provider adapter needs its own readiness, timeout, idempotency, receipt, reconciliation, and
capability contract. No reviewed platform makes that provider-specific contract disappear.

## Comparison matrix

| Platform | Persistence | Durable execution | Human approval / interrupts | Tool integrations | Observability | Deployment / self-hosting | Key lesson and tradeoff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **LangGraph + LangSmith Deployment** | Checkpoints per graph step, threads, long-term store, history/time travel | Agent Server adds a durable task queue and resumes from checkpoints | `interrupt()` persists state and waits indefinitely; resume uses the same thread | LangChain tools, MCP, A2A, custom graph nodes | LangSmith traces, Studio, run state, logs/metrics depending deployment | OSS graph; standalone Agent Server with Docker/Compose/Kubernetes; full LangSmith self-hosting is Enterprise | Closest model for a stateful agent server. It makes state and runs first-class, but self-hosting still means operating Postgres, Redis, workers, and deployment concerns. |
| **OpenAI Agents SDK + Responses API** | SDK sessions can use SQLite, SQLAlchemy, Redis, or other application stores; Responses supports provider-managed continuation identifiers | SDK core is a run loop; official integrations connect it to Temporal, Restate, Dapr, and DBOS for durable long-running runs | Approval-required tools yield interruptions; serializable `RunState` resumes later | Function tools, hosted MCP, handoffs, guardrails, provider-native Responses tools | Built-in traces for model calls, tools, handoffs, guardrails, and custom events | SDK runs in our application; no separate OpenAI agent runtime required. Responses and tracing introduce OpenAI service dependency | Good compact harness and approval model. It deliberately leaves durable job ownership and external-effect reliability to the application/runtime. |
| **Letta** | Persistent agent state and memory blocks are stored in its database-backed server; local mode stores agents, conversations, provider connections, and secrets locally | Persistent conversations and schedules, but not a general durable workflow/effect engine in the reviewed material | Stateful conversations and user-driven interactions are first-class; a general effect-approval/reconciliation contract is not the main documented abstraction | Registered tools, skills, channels, SDK/API, and model/provider connections | Server/API state and app tooling; less explicit run-level workflow tracing than LangGraph or OpenAI Agents SDK | Open-source App Server, Docker, CLI/local mode, or Letta Cloud | Excellent reference for durable identity and memory. It should not be treated as the reliability layer for publishing, payments, or other ambiguous external effects. |
| **Dify** | Application conversation state and workflow execution records; persistence depends on the self-hosted deployment | Workflow engine supports multi-step execution, branching, iteration, triggers, and background-style automation; provider-effect reconciliation remains application logic | Human Input node can pause for approval, edits, comments, forwarding, and timeout handling | Built-in tools, custom APIs, HTTP, MCP, and typed tool plugins; plugin types include tools, triggers, datasources, and agent strategies | Detailed workflow traces, node outputs, variables, execution paths, logs, latency, usage, and feedback | Cloud-ready service; open-source repository and self-hosted deployment | Strong visual product and plugin model. Visual workflows improve visibility, but critical side effects still need typed contracts, idempotency, and provider-specific state handling. |
| **Pydantic AI** | Application-managed agent message/history state; durable integrations persist execution through the selected backend | First-party/co-maintained integrations for Temporal, DBOS, Prefect, and Restate; durable agents survive restarts and long waits | Deferred tools support approval-required and externally executed tools; resume after resolution | Typed function tools, MCP toolsets, provider-native tools, LangChain tool adapters | OpenTelemetry-native spans for model/tool calls; Logfire is optional and commercial/self-hostable on Enterprise | Runs as an application library; can use any OTel backend and any durable backend | A strong reference for a small, typed, composable layer. It is not a complete multi-tenant control plane or provider-connection center. |
| **Temporal** | Durable workflow history, activity results, timers, signals, and visibility data | Core strength: crash recovery, retries, timers, signals, activities, and long-running workflows | Signals/Updates and workflow state model approval as an external message; application defines the approval UI and policy | No provider catalog; external APIs run in Activities with explicit retry, timeout, idempotency, and compensation design | Web UI, metrics, logs, tracing integrations, workflow visibility | Open-source service can be self-hosted; Temporal Cloud is managed | Best substrate for KasiTek's durable operation layer. It does not provide agent semantics, provider OAuth, tool schemas, or truthful provider reconciliation automatically. |
| **Inngest** | Persists completed step results and function state in its durable execution service | Step-level retries, memoization, sleeps, event waits, fan-out, and failure handlers; functions run on our compute | `waitForEvent()` can suspend until human approval, webhook, or another event | Functions, events, webhooks, step calls, and application-defined integrations | Step-level execution history, retries, failures, and platform observability | Application functions run on our compute, including serverless; the current product model uses Inngest's execution service for coordination | A simpler durable-function programming model than Temporal. It is attractive for bounded jobs, but adding it beside Temporal would duplicate orchestration primitives. |
| **Restate** | Journaled invocations, durable state, timers, and durable promises | Log-first runtime replays completed operations and resumes after failures/suspensions | Durable promises can wait for approvals or webhooks without holding a process | Service-to-service calls, workflows, durable promises, and application-defined tools | UI and CLI inspect application/service/invocation state | Restate Server can run on VMs/Kubernetes; Restate Cloud is managed | Useful reference for a lightweight runtime and event-driven waits. It brings a different execution model and operational dependency than Temporal. |
| **Microsoft Foundry Agent Service** | Prompt agents have service-managed state; hosted agents have session-level state and persistent files | Managed hosted-agent runtime handles endpoint lifecycle, scaling, and session resume; it is not a self-hosted execution substrate | Managed toolboxes provide centralized authentication and governance; general approval workflows still belong in agent/application code | Built-in file/code/web tools, OpenAPI, MCP, A2A, SharePoint/Fabric-related tools, managed toolboxes | Agent tracing, Application Insights, evaluations, metrics, dashboards | Fully managed Azure service; custom hosted agent code runs in Microsoft's managed container runtime | Shows the value of a unified enterprise control plane. The tradeoff is Azure identity, data, deployment, and protocol coupling. |
| **Google Vertex AI Agent Engine** | Sessions store interaction history; Memory Bank provides managed long-term memory, currently documented as Preview | Managed runtime deploys, scales, and operates Python agents; workflow durability beyond runtime/session behavior belongs to the app/framework | No equivalent general approval primitive was found in the reviewed Agent Engine documentation; implement approval in the agent/application | Function calling and framework integrations, especially ADK, LangChain, and LangGraph | Cloud Trace/OpenTelemetry, Cloud Logging, and Cloud Monitoring | Managed Google Cloud runtime; deployment is Python-focused; no self-hosted Agent Engine service | Shows a strong managed runtime plus memory and observability. It is a poor fit as KasiTek's core because it ties runtime, identity, data, and operations to GCP. |

## Platform notes and official sources

### LangGraph and LangSmith Deployment

LangGraph describes itself as an orchestration runtime focused on durable execution, streaming,
human-in-the-loop, and persistence. Its persistence layer checkpoints graph state by thread, which
supports memory, inspection, time travel, and recovery. Dynamic interrupts save state and wait for
external input before resuming.

LangSmith Deployment's Agent Server adds the platform shape that is particularly relevant to
KasiTek: assistants, threads, runs, cron jobs, PostgreSQL-backed persistence, a durable task queue,
API servers, queue workers, streaming, MCP, and A2A. The standalone server can run without the
LangSmith control plane; full self-hosted LangSmith requires Enterprise.

Official sources:

- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [Agent Server architecture and persistence](https://docs.langchain.com/langsmith/agent-server)
- [LangSmith deployment options](https://docs.langchain.com/langsmith/deployment)
- [Standalone Agent Server](https://docs.langchain.com/langsmith/deploy-standalone-server)

**What to learn:** make threads, runs, checkpoints, queue ownership, and terminal states explicit
platform resources. Do not hide long-running work inside one request.

**Tradeoff:** LangGraph's restart behavior depends on checkpoint boundaries and idempotent side
effects. A checkpoint does not prove that an external provider accepted an effect; KasiTek still
needs receipts and reconciliation.

### OpenAI Agents SDK and Responses API

The Agents SDK provides a small runner around agents, tools, handoffs, guardrails, sessions, and
tracing. Sessions maintain conversation history through an application-managed store. Human-in-
the-loop tools produce interruptions and serializable `RunState` snapshots that can be stored and
resumed later. The SDK's official running-agents documentation points to Temporal, Restate, Dapr,
and DBOS integrations for long-running durable execution rather than making one durable engine part
of the core SDK.

The Responses API supplies model-side tool and continuation primitives, but using it directly does
not create a KasiTek-owned workflow, approval record, provider effect receipt, or reconciliation
job.

Official sources:

- [Agents SDK overview](https://openai.github.io/openai-agents-python/)
- [Running agents and durable integrations](https://openai.github.io/openai-agents-python/running_agents/)
- [Human-in-the-loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)
- [RunState reference](https://openai.github.io/openai-agents-python/ref/run_state/)
- [Sessions](https://openai.github.io/openai-agents-python/sessions/)
- [Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [Responses API quickstart and tools](https://platform.openai.com/docs/quickstart/make-your-first-api-request)

**What to learn:** approval is a paused run with serializable state, not a second unrelated chat
turn. Keep the original tool arguments and approval decision bound to the resumed run.

**Tradeoff:** the SDK is intentionally composable rather than a full workflow control plane. It
does not remove the need for an execution engine, durable operation records, or provider adapters.

### Letta

Letta focuses on stateful agents, persistent memory blocks, continual learning, and agent identity.
Its documentation supports managed Letta Cloud or running the complete App Server yourself. The
API models agent state, tools, memory blocks, and persisted database state. Local mode is useful
for understanding how an agent can retain its identity, conversations, provider connections, and
secrets on the operator's machine.

The reviewed documentation does not present Letta as a general-purpose external-effect workflow
engine with the same approval, idempotency, receipt, and reconciliation concerns as KasiTek's
publishing and messaging operations.

Official sources:

- [Letta documentation](https://docs.letta.com/)
- [Letta agents API and persisted state](https://docs.letta.com/api/resources/agents)
- [Letta open-source repository](https://github.com/letta-ai/letta)
- [Letta Code local mode and persistence](https://github.com/letta-ai/letta-code)

**What to learn:** separate working context, durable memory, and agent identity; do not treat an
ever-growing conversation transcript as the only memory model.

**Tradeoff:** memory-first agents can be powerful but introduce memory governance questions—scope,
expiry, provenance, correction, and tenant isolation—that are separate from workflow durability.

### Dify

Dify presents agents and workflows on a visual canvas. The documented workflow primitives include
model calls, retrieval, code, branching, iteration, triggers, tools, MCP, and a Human Input node
that can pause for approval, edits, comments, forwarding, or timeout handling. Dify also exposes
workflow traces, node outputs, variables, execution paths, logs, latency, usage, and feedback.

Its plugin system is worth studying because it distinguishes tool plugins, agent strategies,
extensions/endpoints, datasources, and triggers. The open-source repository documents self-hosting
and built-in tools, while Dify's product documentation describes cloud-ready and enterprise
self-hosted deployment.

Official sources:

- [Dify Workflow Studio](https://www.dify.ai/workflows)
- [Dify plugin types](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)
- [Dify tool plugins](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/tool-plugin)
- [Dify Human Input node](https://docs.dify.ai/en/use-dify/nodes/human-input)
- [Dify open-source repository and self-hosting entry point](https://github.com/langgenius/dify)

**What to learn:** make the execution path visible and let integrations be installed as typed,
scoped extension units.

**Tradeoff:** a visual workflow can make ordinary orchestration approachable, but provider-specific
side effects, ambiguous responses, and tenant authorization still require code-level contracts.

### Pydantic AI

Pydantic AI is a typed agent library rather than a complete hosted platform. Its durable-execution
documentation lists Temporal, DBOS, Prefect, and Restate integrations. Its deferred-tool model
handles tools that need approval or external execution and then resumes the run with the resolved
result. MCP is supported as a local toolset or provider-native tool, and its instrumentation emits
standard OpenTelemetry spans for model and tool calls.

Official sources:

- [Pydantic AI overview](https://pydantic.dev/docs/ai/overview/)
- [Durable execution](https://pydantic.dev/docs/ai/capabilities/durable_execution/overview/)
- [Deferred tools and approval](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)
- [MCP](https://pydantic.dev/docs/ai/mcp/overview/)
- [OpenTelemetry and Logfire instrumentation](https://pydantic.dev/docs/ai/integrations/logfire/)
- [Third-party tools](https://pydantic.dev/docs/ai/tools-toolsets/third-party-tools/)

**What to learn:** use typed schemas, capability-style composition, deferred execution, and
provider-neutral tracing as small reusable building blocks.

**Tradeoff:** it supplies good primitives but not KasiTek's multi-tenant control plane, connection
permission center, gateway delivery, or external-effect ledger.

### Temporal

Temporal is an open-source durable execution platform. Its core model persists workflow history,
replays deterministic workflow code, retries Activities, and supports timers and external messages.
Signals or Updates can carry human decisions into a running workflow; the approval UI and business
policy remain application responsibilities. Provider calls should be Activities with bounded
timeouts, retry classifications, idempotency keys, and explicit handling for unknown outcomes.

Official sources:

- [Temporal platform documentation](https://docs.temporal.io/)
- [Temporal message passing](https://docs.temporal.io/develop/go/workflows/message-passing)
- [Temporal production deployment](https://docs.temporal.io/production-deployment)
- [Temporal observability](https://docs.temporal.io/production-deployment/observability)
- [Temporal GitHub repository](https://github.com/temporalio/temporal)

**What to learn:** the workflow should own the durable sequence, while each external call is an
independently retry-safe activity with an observable result.

**Tradeoff:** Temporal has a larger operational and programming model than a queue or job table.
That complexity is justified for long waits, approvals, fan-out, recovery, and reconciliation; it
is unnecessary for a short, read-only model call.

### Inngest

Inngest's durable function model wraps individual side effects in `step.run()` calls. Completed
steps are persisted and skipped on retry, while failed steps retry independently. `step.sleep()`
and `step.waitForEvent()` support long waits, including human approval and webhook callbacks. The
application code runs on the operator's compute, including serverless environments, while Inngest
coordinates execution state and observability.

Official sources:

- [Inngest Functions](https://www.inngest.com/docs/learn/inngest-functions)
- [Inngest error handling and retries](https://www.inngest.com/docs/guides/error-handling)
- [Inngest durable execution model](https://www.inngest.com/docs/learn/how-functions-are-executed)
- [Inngest durable agents](https://www.inngest.com/docs/learn/durable-agents)
- [Inngest source repository](https://github.com/inngest/inngest)

**What to learn:** checkpoint at meaningful side-effect boundaries and suspend a process while it
waits for the real world instead of keeping a request or worker alive.

**Tradeoff:** the model is simpler than Temporal for many jobs, but the current platform still
introduces an external coordination service. It should not be added beside Temporal without a clear
ownership boundary.

### Restate

Restate is a lightweight runtime built around a journal. It persists completed steps, state,
timers, service calls, and durable promises, then replays the journal after failures. Workflows can
wait for approvals or webhooks without holding a process or connection. The official documentation
and repository describe a UI/CLI for inspecting invocations and support self-hosting the Restate
Server on VMs or Kubernetes as well as Restate Cloud.

Official sources:

- [Restate documentation](https://docs.restate.dev/)
- [Restate architecture](https://docs.restate.dev/references/architecture)
- [Restate workflows](https://docs.restate.dev/tour/workflows)
- [Restate service configuration](https://docs.restate.dev/services/configuration)
- [Restate repository](https://github.com/restatedev/restate)
- [Restate self-hosting and Cloud overview](https://restate.dev/blog/resilient-serverless-agents)

**What to learn:** a log-first runtime can make suspension, replay, durable promises, and late
messages natural primitives for agents.

**Tradeoff:** Restate's execution model is different from Temporal's. It may reduce boilerplate
for lightweight services, but running both creates two sources of truth for retries, timers, and
workflow state.

### Microsoft Foundry Agent Service

Foundry Agent Service is a managed enterprise runtime. Prompt agents are configured and hosted by
Foundry; hosted agents package custom code into a managed container runtime with an endpoint,
scaling, identity, session-level state, persistent files, and end-to-end observability. Tools can be
built-in, OpenAPI, MCP, A2A, or organized into managed toolboxes with centralized authentication,
governance, and versioning.

Official sources:

- [Foundry Agent Service overview](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview)
- [Hosted agents](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agents)
- [Foundry Agent Service FAQ](https://learn.microsoft.com/en-us/azure/foundry-classic/agents/faq)

**What to learn:** a separate control plane can manage agent versions, identities, toolboxes,
deployment, tracing, evaluations, and monitoring as one product surface.

**Tradeoff:** it is not self-hosted Agent Service. The managed runtime is attractive when Azure is
the operating environment, but it couples runtime and governance to Azure resources and protocols.

### Google Vertex AI Agent Engine

Vertex AI Agent Engine is a managed Google Cloud runtime that deploys, scales, and manages Python
agents. Its documented services include managed runtime, Sessions for interaction history,
Memory Bank for managed memories, function calling/framework integrations, and observability via
Cloud Trace, Cloud Monitoring, and Cloud Logging. Memory Bank is documented as Preview in the
reviewed pages.

Official sources:

- [Agent Engine overview](https://cloud.google.com/vertex-ai/generative-ai/docs/reasoning-engine/overview)
- [Deploy an agent](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/deploy)
- [Manage sessions](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/sessions/manage-sessions-api)
- [Memory Bank](https://cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/memory-bank/fetch-memories)
- [Agent Engine custom agent and tracing](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/develop/custom)

**What to learn:** managed sessions, memory, deployment, and observability can be separate
services around a small agent object.

**Tradeoff:** the runtime is managed rather than self-hosted, Python-focused, and strongly tied to
Google Cloud identity, storage, and telemetry.

## Recommendation matrix for KasiTek

| Need | Best reference | Recommendation for KasiTek |
| --- | --- | --- |
| Durable external actions | Temporal; Restate/Inngest for comparison | Keep Temporal as the operation owner. Study Restate and Inngest for simpler checkpoint/wait APIs, not as immediate second runtimes. |
| Stateful agent loop | LangGraph; OpenAI Agents SDK | Preserve the existing bounded loop, but adopt explicit checkpoint and resume boundaries around model, tool, approval, and completion steps. |
| Typed tool contracts | Pydantic AI; OpenAI Agents SDK | Keep provider-neutral schemas and normalize tool results before the model sees them. Separate tool entitlement, connection capability, and provider readiness. |
| Human approval | LangGraph interrupts; OpenAI `RunState`; Pydantic deferred tools | Persist the exact arguments, target account, capability snapshot, content/media identity, and approval decision. Resume the same operation, not a newly inferred request. |
| External integrations | Dify plugins; MCP support in Pydantic/OpenAI/LangGraph; Foundry toolboxes | Build a provider adapter registry behind KasiTek's action contract. Use MCP as a transport/extension option, not as the source of truth for authorization or effect completion. |
| Memory | Letta; LangGraph Store; Google Memory Bank | Keep short-term run state separate from long-term memory. Require scope, provenance, retention, correction, and tenant checks before promoting facts. |
| Observability | LangSmith; OpenAI tracing; Pydantic OTel; Temporal visibility | Trace one user request through agent run, tool invocation, operation, provider request, receipt, reconciliation, and gateway delivery. Use stable correlation and release IDs. |
| Deployment/control plane | Foundry; Vertex Agent Engine; LangSmith Deployment | Continue owning KasiTek's agent version, installation, rollout, connection, and gateway control planes. Borrow the concept of immutable versions and visible deployment state. |
| Self-hosting | Temporal; standalone LangGraph Agent Server; Restate; Letta; Dify | Prefer components that can run in our infrastructure, but measure operational burden before adopting another full platform. |

## Proposed learning sequence

1. **LangGraph Agent Server:** inspect its assistants/threads/runs/checkpoint/task-queue model and
   compare it with KasiTek's agent installations, runs, workflow checkpoints, and gateway events.
2. **Temporal:** document one canonical KasiTek operation as a workflow plus independently retry-safe
   provider activities, including approval, unknown outcome, and reconciliation paths.
3. **Pydantic AI and OpenAI Agents SDK:** compare typed tool/deferred approval contracts with the
   existing KasiTek tool registry and action-readiness contract.
4. **Restate and Inngest:** use them to test whether any simpler runtime concepts—durable promises,
   step memoization, event waits, or failure handlers—should influence KasiTek's APIs without
   changing the execution backend.
5. **Letta and Dify:** study memory governance and extension/plugin packaging separately from the
   external-effect runtime.
6. **Foundry and Agent Engine:** use their managed control-plane surfaces as benchmarks for agent
   versioning, identity, deployment, observability, and enterprise governance.

## Release and documentation record

- **Change:** research note only; no product code, API, schema, deployment, or runtime changes.
- **Owner:** Agent Platform.
- **Risk:** low.
- **Affected services and user surfaces:** none.
- **Platform release version or release ID:** not applicable.
- **API/schema/migration changes:** not applicable.
- **Feature flag or rollout method:** not applicable.
- **Analytics events and success metrics:** not applicable.
- **Logs, metrics, dashboards, and alerts:** not applicable.
- **User, API, internal, and operational documentation:** this research note only.
- **Validation evidence:** official documentation and repositories linked above; no runtime changes
  were made.
- **Rollback or disable plan:** remove or supersede this note; no deployed behavior to roll back.
- **Post-release review date:** not applicable.
