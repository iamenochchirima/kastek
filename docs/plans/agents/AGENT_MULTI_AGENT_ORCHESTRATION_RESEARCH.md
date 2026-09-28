# Multi-agent orchestration research

**Status:** Initial research note

**Owner:** Agent Platform

**Research date:** 2026-09-04

This note explains multi-agent orchestration and maps the main runtime patterns to Kasitek. It does
not propose an immediate implementation or a runtime change.

## What multi-agent orchestration means

Multi-agent orchestration is the controlled execution of more than one agent toward one user or
business outcome. It decides:

- which agent owns the user-facing turn;
- which specialist agents may receive work;
- whether work runs sequentially, in parallel, as a race, or in an evaluator loop;
- what context and authority each child receives;
- how results return to the parent and how conflicts are resolved;
- how deadlines, budgets, approval, cancellation, and failures propagate;
- how the full invocation graph is inspected and controlled.

Using several prompts inside one process is the simplest form. Calling independently versioned and
installed agents with separate tools, memory, credentials, and policy is the more useful platform
form, but it needs stronger execution contracts.

## Common orchestration patterns

| Pattern | Ownership | Good use | Main risk |
| --- | --- | --- | --- |
| Router | A classifier selects one agent | Clear task categories | A wrong route becomes a hidden single point of failure |
| Supervisor | A parent agent calls specialists and owns the final result | Open-ended tasks and result synthesis | The parent can over-delegate, repeat work, or exceed budgets |
| Agent as tool | A specialist handles one typed subtask and returns structured output | Research, review, extraction, drafting | Passing unbounded conversation history leaks context and wastes tokens |
| Handoff | The active agent transfers user-facing ownership | Sales, support, and staged conversations | Ownership, memory, and allowed tools can become ambiguous |
| Deterministic graph | Code selects the order and conditions | Regulated or repeatable business processes | Less flexible when the route cannot be known in advance |
| Parallel fan-out and fan-in | A parent starts independent specialists and aggregates results | Independent research or account-level work | Partial failure, conflicting writes, and unbounded cost |
| Race | Several agents attempt the same task and the policy selects a winner | Latency or model diversity experiments | Wasted work and unclear cancellation of losing branches |
| Evaluator loop | A worker produces output and a reviewer accepts or requests revision | Quality-controlled drafting | Infinite revision loops and self-reinforcing model errors |

The [OpenAI Agents SDK orchestration guide](https://openai.github.io/openai-agents-python/multi_agent/)
distinguishes manager-owned agents-as-tools from handoffs and also describes code-controlled chains,
evaluator loops, and parallel execution. [LangChain's subagent
guide](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents) uses a similar
supervisor model and recommends context isolation for specialist calls. Its [handoff
guide](https://docs.langchain.com/oss/python/langchain/multi-agent/handoffs) treats active-agent
selection as durable conversation state.

## Restate

Restate's primary multi-agent pattern is a durable router or supervisor. The router's model decision,
the specialist call, and the result are journaled. If the process fails after selecting a specialist,
recovery reuses the recorded decision rather than asking the model to route again. Specialists can
run in the same process as tools or handoffs, or as separately deployed Restate services. Restate
also documents parallel calls, racing agents, workflows as tools, and remote agents under the same
invocation model. See [Restate multi-agent
orchestration](https://docs.restate.dev/ai/patterns/multi-agent).

The useful property is not automatic agent intelligence. It is durable communication. Routing,
calls, results, retries, and nested work share one journal and invocation tree. Restate supplies
that model directly, so a remote agent call resembles a local call while the runtime owns recovery.

## Temporal

Temporal does not prescribe supervisor, handoff, or agent-as-tool semantics. Workflows are durable
code, so the application defines those semantics. A parent workflow can start child workflows,
dispatch activities to specialist task queues, wait for all or the first result, send Signals or
Updates, propagate cancellation, and use timers for deadlines. Cross-namespace agent operations can
use Nexus. Temporal persists the orchestration history and replays it after failure.

Temporal's [AI agent reference
architecture](https://go.temporal.io/platform-hub/ai-engineering/ai-reference-architecture) states
the key split: Workflows orchestrate and Activities execute non-deterministic model and tool work.
Its [shared agent framework](https://go.temporal.io/platform-hub/ai-engineering/ai-agent-framework)
shows one common agent workflow dispatching tool activities to separate team task queues and using
Nexus for durable cross-namespace operations.

Compared with Restate, Temporal gives Kasitek the durable mechanics but leaves more application
work. Kasitek must define the delegation envelope, child identity, context rules, capability
attenuation, result schema, budget allocation, cancellation policy, and execution projection.

## Representative agent frameworks

Frameworks such as OpenAI Agents SDK and LangGraph mainly help with agent semantics:

- defining agents and specialist descriptions;
- exposing an agent as a callable tool;
- transferring active ownership through a handoff;
- selecting routes with a model or deterministic code;
- composing sequential, parallel, and evaluator patterns;
- tracing model, tool, and handoff events.

They do not remove the need for a durable runtime and safe external-effect layer. A parallel Python
call can run several agents, but it does not by itself survive process loss, preserve a stable
delegation decision, prevent duplicate effects, or reconcile an unknown provider result. Kasitek
should take the agent-composition ideas while keeping Temporal, approvals, effect receipts, and
reconciliation authoritative.

## Kasitek today

Kasitek already has several foundations:

- one Temporal workflow owns one durable agent run;
- configured graphs support deterministic, model, tool, `agent_loop`, route, approval, wait,
  handoff, `fan_out`, and `fan_in` nodes;
- parallel branches reserve shared model and tool budget, run concurrently, and reject conflicting
  writes when their state is merged;
- waits and approvals checkpoint and resume the current graph;
- agent definitions, immutable versions, installations, grants, principals, memory, and provider
  connections already provide isolated specialist identities;
- Core delegation tokens bind one capability invocation to organization, installation, run,
  invocation, version, arguments, and expiry;
- effect receipts and reconciliation protect external actions from blind retries.

The current graph `agent_loop` node is a specialist prompt inside the same run. It is not yet a call
to another installed agent. Kasitek has no first-class child-agent invocation record, recipient
inbox, result contract, delegated context policy, child budget, cancellation edge, or agent-to-agent
execution permission. The current Core delegation token authorizes an exact capability call; it is
not an agent delegation protocol.

Current implementation references include [workflow execution](../../../agents/src/workflows/executor.ts),
[graph validation](../../../agents/src/workflows/graph.ts), [Temporal run ownership](../../../agents/src/temporal/workflows.ts),
and [Core delegation claims](../../../agents/src/core/delegation.ts).

## Recommended Kasitek shape

Kasitek should begin with supervisor-owned orchestration. One parent remains responsible for the
user-facing result. Specialists receive bounded tasks and return typed results. Handoff and detached
peer work remain separate explicit modes.

```text
Conversation session
        |
        v
Parent agent invocation
        |
        v
AgentOrchestrator
 delegate | wait | race | aggregate | cancel
        |
        +------------------+------------------+
        |                  |                  |
        v                  v                  v
Research child       Copy child        Compliance child
Temporal workflow    Temporal workflow Temporal workflow
        |                  |                  |
        +------------------+------------------+
                           |
                           v
                 typed result aggregation
                           |
                           v
                 parent produces final answer
```

`AgentOrchestrator` should be a deep module with a small interface:

```text
delegate(task, recipient, policy) -> childInvocationId
wait(childInvocationId | groupId) -> typed result
signal(childInvocationId, event)
cancel(childInvocationId | groupId, reason)
inspect(invocationId) -> graph projection
```

Its implementation should hide Temporal child-workflow mechanics, durable inbox records, recipient
resolution, capacity admission, result delivery, cancellation, and journal edges.

Each delegation should pin:

- parent and child invocation IDs;
- recipient installation and agent version;
- typed task and expected result schema;
- selected context references rather than the full parent transcript;
- delegated capabilities and resource scope, always narrower than the parent authority;
- model, tool, token, cost, wall-time, and parallelism budgets;
- safety-plan revision, approval ownership, deadline, and cancellation policy;
- join policy such as all, quorum, first valid, best score, or continue after partial failure;
- idempotency key and whether the child is attached or detached.

PostgreSQL should remain authoritative for the product-visible invocation graph and tenant audit
records. Temporal should own durable execution, child waits, timers, retry, and cancellation.
Initially, installed child agents can run as child workflows in the same namespace. Nexus or A2A
adapters are only needed when an agent is owned by another namespace, platform, or organization.

## Main design constraints

- A child never inherits all parent context, tools, memory, or credentials by default.
- Delegated authority can only narrow. A parent without publish permission cannot create a child
  that has it.
- External effects still pass through the existing capability, approval, receipt, and
  reconciliation path.
- Parallel branches reserve capacity before starting and release it on every terminal path.
- Cancellation propagates to attached descendants; detached work must be visibly detached.
- The parent cannot report success until its declared join policy has a proven result.
- Cycles, recursive delegation depth, agent count, revisions, and total budgets need hard limits.
- Every routing decision, child call, result, retry, wait, approval, and effect appears in one
  execution graph.

## Suggested adoption order

The safest first use case is a read-only supervisor with two or three specialist installations and
typed outputs. Next comes deterministic parallel research and review. Only after cancellation,
budgeting, context isolation, and graph visibility are proven should Kasitek allow children to
propose external effects. Direct peer handoffs, detached work, recursive teams, and cross-platform
A2A delegation should come later.

This order gives Kasitek real multi-agent value without turning every agent into an unrestricted
network participant.
