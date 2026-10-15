# Agents platform architecture

Updated: 2026-10-02.
Status: Current target architecture. Existing source supports parts of it; standalone runtime behavior remains to be verified through the delivery checklist.

## Product model

The platform offers two agent tracks:

| Track | User experience | Execution and storage |
| --- | --- | --- |
| API-based agents | Create, test and publish FAQ, booking, tool-using or workflow agents | Shared bounded execution or Temporal durable workflows; product-owned database records |
| Personal agents | Deploy and manage our own filesystem-based runtime, configure skills/tools and connect channels | Isolated environment with a persistent workspace, files and runtime-owned session/memory state |

Personal agents are a deployment product, not simply another hosted profile with database memory. We build our own runtime; Hermes/OpenClaw are conceptual references, not selected production dependencies. Growth, Agency and future product functionality is plugged in through authorized tools.

Agent behavior, execution mode, hosting and channel are distinct. Durable workflows may invoke an isolated environment. A short-run agent may retain conversation history without durable orchestration. Personal environments may sleep between tasks if their persistence and wake-up contracts support it; always-on behavior is a hosting choice.

## Modules and ownership

- Platform management owns organizations, memberships, agent definitions, versions, installations, deployments, connections, grants, resource limits and usage.
- Hosted execution owns bounded model/tool loops and workflow execution. It enforces the trusted run identity and effective grants before admitting work.
- Personal runtime management owns environment provisioning, runtime revision, workspace volume, credentials delivery, health, stop/restart, cleanup and artifact access. The runtime owns its working files and local session/memory formats through a defined persistence contract.
- Tool execution owns argument validation, credential resolution, authorization, deadlines, approval requirements, external-action receipts and safe retries/reconciliation. Filesystem instructions and model outputs cannot grant permissions.
- The shared live inbox module owns agent-connected conversations, messages, delivery, assignments, internal notes and human/agent control. Agents and Growth expose interfaces to this same authority.
- Channel adapters verify incoming events and translate them to scoped conversations/tasks. Channel connection routing chooses hosted execution or a personal deployment; adapters do not implement competing agent loops.
- Knowledge ingestion and memory modules keep source knowledge, hosted retained memory, conversation history and workflow state distinct. Personal workspace memory is governed by the separate runtime contract and is not silently synchronized with hosted memory.
- Execution evidence and usage own queryable run progress, costs, artifacts and controls. Labs telemetry provides diagnostics; it is not the authoritative run or billing ledger.

The TypeScript/Fastify backend and React/TypeScript/Vite client live in one repository. React Router provides public and authenticated layouts in one frontend. The landing page has separate styling; the app shell reuses selected Growth UX. Backend-owned authentication and APIs are reached through same-origin /api routing. Existing Next.js source is the migration starting point, not the selected target. API, gateways and worker processes can be replicated independently. The personal runtime has a separately versioned contract and image; its implementation language and source location are not yet chosen.

## Task paths

### API-based agent

1. API, website or verified channel input resolves the organization, deployment, caller and conversation.
2. Admission validates permissions, budgets, idempotency and conversation ordering, then pins an agent version.
3. A bounded shared worker or Temporal workflow executes through the common tool/model rules.
4. Recorded run events drive the client stream and outgoing channel delivery.

### Personal agent

1. The platform authorizes a task for a personal deployment and records a task ID.
2. Environment management starts or wakes the environment if needed.
3. The runtime accepts the task, uses its persistent workspace and requests permitted tools through scoped interfaces.
4. Authenticated progress/artifact events update platform records; cancellation and restart use the runtime contract.
5. Stopping compute preserves declared workspace data. The contract states whether interrupted work resumes or fails; persisted files alone are not execution recovery.

Duplicate task delivery must not silently start two executions. The platform and runtime agree who owns each task transition and reconcile uncertain outcomes.

## Data and integrations

- Agents PostgreSQL stores platform records, hosted conversations/memory/knowledge, run evidence, credential references and usage. Search/vector indexes are rebuildable projections.
- Object storage holds documents and artifacts. Personal workspace volumes or snapshots persist user files; retention, export, backup and deletion include those volumes.
- Temporal stores durable orchestration history. Optional Redis addresses measured cache/coordination needs; it does not own platform truth.
- Labs Keycloak authenticates people; Agents creates its own session and checks its own organization memberships. Apply the shared-login contract; no dependency on Growth's human session.
- Labs Analytics consumes authenticated published events; the Collector consumes telemetry. Failures must not erase operational or usage records.
- Growth and Agency own their business data and permissions. Their tools use authenticated product interfaces and user/deployment-scoped grants, without direct cross-product database access.
- Provider master credentials stay platform-controlled. Give personal environments only required scoped, revocable credentials or a tool proxy; never expose the platform secret store or Docker socket.

## Shared live inbox across Agents and Growth

Website and messaging channels feed the Agents conversation backend. Agents owns the authoritative history, outbound delivery, assignments, open/resolved state and human/agent control. Build the Agents inbox first, then expose the same scoped commands and live events to Growth's inbox. Growth retains its unrelated inbox functions and its own CRM records.

Human takeover is a backend transition visible in both products. Suppress stale queued agent replies and verify ownership before dispatch; already-dispatched messages may not be retractable. Define pending action behavior separately from message ownership. Return-to-agent is explicit and audited.

Both inboxes support history/search/filter, unread indicators, human replies, assignment, private notes, resolve/reopen and handoff. Notes never enter customer delivery. Live subscriptions carry durable event cursors with missed-event recovery; reply/assignment commands have idempotency and conflict handling.

A Growth organization explicitly connects to permitted Agents deployments. Agents validates workspace mapping, the acting user and scoped grants on every command/subscription. Shared identity or a service credential alone does not grant conversation access. Disconnecting or revoking a user must terminate access.

Growth links conversation references to its contacts/leads through authenticated interfaces. Do not duplicate the authoritative conversation store or write directly to Agents tables. Any read projection must be refreshable, scoped and identified as a projection.

See delivery phases 6A and 6B for backend/frontend work and the cross-product acceptance journey. Growth integration is a separate task; writing this architecture does not change its code.

## Isolation and scaling

Organization and installation scope applies to database queries, retrieval, files, credentials, channels and tasks. Environment identity is derived from authorized deployment records, never from model-selected paths or identifiers.

Bound concurrency, queue length, token/tool usage, workspace size, compute and wall time per organization/deployment. Keep interactive work, background workflows, ingestion and browser/code execution in appropriate worker pools. Conversation ordering and reconnectable progress must work across replicas.

Start with separate processes and local Docker development. No Kubernetes or specific production sandbox vendor is selected. Production execution of customer code needs an explicit isolation/hosting decision. Capacity and cost claims require measured targets and representative checks.

## Current source and verification

Source locations and phase acceptance are in the [delivery plan](../plans/agents/AGENT_PLATFORM_DELIVERY_PLAN.md). Detailed code contracts below describe the hosted runtime; they are not claims that personal deployment has been implemented:

- [Runtime/host interface](agent-runtime-host-boundary.md).
- [AgentSpec](agent-spec.md).
- [Conversation ordering](conversation-ordering.md).
- [Workflow execution](workflow-execution.md).
- [Memory lifecycle](memory-lifecycle.md).
- [Tenant isolation inventory](tenant-isolation-inventory.md).

The new filesystem runtime is covered by the [runtime checklist](../plans/agents/PERSONAL_AGENT_RUNTIME_PLAN.md). Verify historic implementation claims against the current checkout during baseline work.
