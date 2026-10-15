# Agent runtime research and proposed decisions

Date: 2026-10-07. Scope: execution boundaries for the Agents platform. This is research and a proposal, not a claim that every contract below is implemented or a replacement implementation plan.

## What the sources establish

There is no universal agent architecture standard established by these sources. They describe compatible patterns and specific products. Their agreement supports a design direction; it does not require adopting their frameworks.

Anthropic distinguishes predefined workflows from agents whose model chooses the next action. It recommends starting with the simplest useful arrangement. Its workflow patterns already contain model calls, routing and dynamic delegation. A workflow therefore need not be entirely deterministic in its business outputs. The December 2024 article now points readers to newer Managed Agents material for current tooling. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

LangGraph makes the same control-flow distinction and demonstrates fixed graphs with model-driven routing and agent loops. Graphs and autonomy can coexist. This supports a conversational loop calling a bounded business process, although our exact workflow-as-tool API remains a project design decision. [Workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents)

Durability is a separate concern. Temporal requires replay-safe workflow orchestration and puts model calls, database calls and external requests in Activities. A deterministic orchestrator can branch on a recorded model result. This does not make the model's answer deterministic. [Temporal workflow definition](https://docs.temporal.io/workflow-definition)

Restate records operation results and replays recorded steps; non-deterministic external operations belong in `ctx.run`. Its retry policy can limit attempts or time. This is another implementation of durable execution, not evidence that autonomous agents require switching away from Temporal. [Restate durable steps](https://docs.restate.dev/develop/ts/durable-steps)

Persistence also has different scopes. LangGraph separates thread checkpoints from cross-thread stores. Saved conversation history, execution recovery and long-term memory should consequently be separate concepts in our platform. An in-memory checkpointer does not survive a process restart. [LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)

For filesystem work, Anthropic's April 2026 architecture separates session records, the agent loop and the sandbox. Sandbox failure can then be handled independently of session storage. Its credential proxy keeps service credentials outside the environment running generated code. This is a useful reference for our personal runtime boundary, not a requirement to use Anthropic's managed product. [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)

## Recommendation for KasiTek

Keep two runtime families: hosted agents and the separate filesystem runtime. Within hosted execution, support an autonomous model/tool loop and reusable workflow execution. Do not create three completely isolated stacks for conversation, workflow and personal use.

Treat these as independent dimensions:

| Dimension | Meaning |
| --- | --- |
| Audience | Personal user, customer service or another product purpose |
| Execution environment | Hosted platform or filesystem workspace |
| Control flow | Model-selected actions, declared workflow, or a combination |
| Recovery | Bounded direct execution or durable execution |
| Access channel | Website, WhatsApp, API or another adapter |

A website agent can use durable execution. A workflow can contain autonomous steps. A personal agent can invoke the same business workflows. Neither a channel nor the `personal` audience label alone determines a runtime.

Use the autonomous loop for interpreting requests, asking questions, choosing permitted tools and explaining results. Use workflows for required business steps, approvals, timers and coordinated actions. A workflow model step should return a validated result; server code owns policy decisions and permitted transitions.

Example: a WhatsApp assistant understands a return request and collects the order number. It calls a published return workflow. The workflow checks eligibility, waits for approval if required, creates the return and reports its outcome. The conversation remains available while the process waits. A workflow may use a model to classify a reason, but the model cannot waive the eligibility policy.

Keep TypeScript and the existing shared model/tool code. Keep Temporal as the current durable engine. LangGraph and Restate are comparison sources, not proposed new dependencies. A framework or engine change needs a concrete unmet requirement first.

## Contracts to define before more builder work

These are proposed project contracts, rather than completed source behavior:

- A callable workflow has a published version, input/output schemas, required permissions and a declared execution policy.
- Invocation carries organization, principal, agent, conversation and parent-run identifiers. Permission checks cannot trust identifiers supplied by the model.
- Starting a workflow returns a stable execution identifier and a truthful state, such as running, waiting, completed, failed or canceled. A waiting process must not be reported as a completed business action.
- Short work can return a result directly. Longer work returns a handle and later emits completion or a request for input into the associated conversation.
- Continuation, approval, cancellation and status lookup use that execution identifier and the same authorization boundary.
- Model and tool budgets apply to workflow steps as well as conversational loops. Child work retains correlation with its parent.
- The filesystem runtime owns workspace files, process execution and workspace lifecycle. Shared services expose model access, scoped tools, credentials, knowledge and run events through explicit contracts. No Kubernetes requirement follows from this boundary.

## Retry caveat

Durability does not automatically make an external write happen exactly once. Temporal explicitly notes that an Activity can complete its external action and crash before reporting completion, causing a retry. Use stable operation identifiers and provider-supported idempotency keys; for ambiguous failures, query the external result or require reconciliation before repeating a write. [Temporal Activity definition](https://docs.temporal.io/activity-definition)

LangGraph likewise restarts an interrupted node from its beginning. Code before an approval interruption can execute again; it recommends idempotent writes or separate side-effect nodes. Do not implement approval as a UI-only pause around an untracked external write. [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

## Existing code and the gap

Read-only source inspection found:

- `src/domain/agent-spec.ts` currently declares `execution.mode` as `autonomous`, while `runtime.executionStrategy` independently accepts `simple` or `durable`.
- `src/runtime/simple-run-executor.ts` rejects workflow graphs in direct execution.
- `src/workflows/graph.ts` and `src/workflows/executor.ts` retain graph execution, including an agent-loop dependency.
- `src/temporal/activities.ts` calls `executeWorkflowGraph` and supplies shared execution dependencies.

This supports reuse and separation. It does not prove that a conversational agent can already invoke a published workflow as a tool, or that the builder is complete. The next implementation should define that invocation contract and then connect existing graph execution to it. Keep the personal filesystem runtime behind a separate lifecycle contract.

No code changes or tests were performed for this research.
