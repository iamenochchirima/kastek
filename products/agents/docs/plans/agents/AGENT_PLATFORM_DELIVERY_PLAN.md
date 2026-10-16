# Agents platform delivery plan

Status: Agreed product direction; implementation and runtime verification pending.
Updated: 2026-10-02.
Scope: Agents backend and client, using existing relocated functionality wherever it fits.

This is the current delivery checklist. Obsolete rewrite roadmaps have been removed. The architecture and current code contracts remain supporting references; they do not create a competing work queue. Do one phase at a time and record working behavior before marking items complete.

## First implementation slice

Start with the [frontend initial implementation checklist](FRONTEND_INITIAL_IMPLEMENTATION_PLAN.md): replace Next.js with React/Vite, reuse Growth styling and UX, create separate public marketing and app layouts, and connect one actual agent creation/Playground journey. It covers the initial frontend work within phases 0–2, not completion of the full platform roadmap. Use normal functional checks for this slice; broader hardening remains later work. Keep existing access controls intact.

## Product outcome

The [next end-to-end checklist](END_TO_END_IMPLEMENTATION_PLAN.md) sequences the
remaining real-response acceptance and selected execution, knowledge/tool, website,
inbox and first-channel work below. Use it for the next bounded implementation;
this document continues to define the complete platform scope.

Users can create, test, publish, and operate API-based agents with short-run or durable execution, and deploy/manage our own filesystem-based personal agent runtime. Agents can use knowledge and external tools and be reached through a website, API, or messaging channels. Personal deployments have a persistent workspace with files, instructions, skills, memory and session material, with authorized tools and channels plugged into the runtime.

Agent behavior, execution mode, hosting, and channel are separate choices. Our filesystem personal runtime uses a managed isolated environment; its lifecycle differs from hosted API execution. Durable execution can run on shared workers or invoke an isolated environment. A short-run agent can save conversations without using a durable orchestrator.

## Architecture and scope

- Keep TypeScript on Node.js, Fastify, React/TypeScript with Vite and React Router, PostgreSQL, and Temporal.
- One repository with clearly owned modules and separately startable API, gateway/channel, and worker processes. Add replicas and separate worker pools as workload requires.
- Platform management owns organizations, memberships, agent definitions, immutable versions, deployments, connections, and usage policy.
- Common platform contracts enforce identity, grants, budgets, cancellation, tools and execution evidence. Hosted execution and the separately built personal runtime satisfy those contracts through their own execution implementations.
- Channel adapters translate provider messages into common conversations. Tool adapters implement controlled external actions. Neither can choose organization scope from model arguments.
- PostgreSQL owns product records and queryable execution evidence. Temporal owns workflow orchestration history. Object storage holds files and artifacts. Search indexes are derived from owned knowledge sources.
- Redis is optional and introduced only for a concrete distributed cache, limit, or coordination requirement. It is not the authoritative product store.
- Labs provides Keycloak, Analytics ingestion, and OpenTelemetry collection through authenticated interfaces. Agents owns its database, organizations, permissions, and sessions.
- No Kubernetes, second durable runtime, infrastructure migration, production deployment, new issue board, or broad rewrite in this plan. Isolated local environments may use Docker; production untrusted-code isolation requires a separate hosting decision.
- No automatic reuse of old completion claims. Existing source is a starting point, not proof of a working standalone product.

## Existing source to inspect and reuse

| Area | Source evidence | What must be established |
|---|---|---|
| API and authentication | src/http/, src/auth/ | Standalone product routes and human versus service identity |
| Agent model and deployments | src/domain/agent-spec.ts, src/db/repositories/agent-deployment-repository.ts | Creation, versioning, playground/live behavior |
| Execution and coordination | src/runtime/, src/temporal/, src/children/ | Shared admission, grants, ordering, durable execution |
| Channels | src/channels/, src/discord/ | Current adapters, delivery, credentials, handoff behavior |
| Knowledge and memory | src/knowledge/, src/memory/ | Ingestion, tenant scope, retrieval and deletion |
| Tools and product integrations | src/capabilities/, src/hosts/, src/core/, src/mcp/ | Core-free operation and explicit optional Growth integration |
| Labs integrations | src/analytics/, telemetry configuration | Delivery and behavior when remote endpoints are unavailable |
| Client | client/apps/agent-platform/ | Existing creation, studio, playground and deployment screens |

Inspect the old Growth implementation for missing channel or user-journey pieces only where needed. Port agent-owned functionality into Agents; do not restore duplicate runtimes in Growth or copy its product database ownership. Reuse current source when it meets the contract; remove obsolete code only after its useful replacement works.

## Phase 0: Establish the usable baseline

- [ ] Inventory routes, screens, migrations, dependencies and launch commands. Classify relevant features as working, broken, source-only, or absent, with evidence.
- [ ] Include existing inbox/handoff functionality in the baseline inventory, distinguishing source availability from a working live inbox.
- [ ] Identify hidden Growth dependencies in human authentication, capability execution, source-path checks, and client configuration.
- [ ] Document one local startup path for API, client, PostgreSQL and Temporal, including required model credentials and optional processes. Never print secrets.
- [ ] Identify which existing agent creation/run journey can be recovered first and the smallest fixes needed.
- [ ] Record initial targets for concurrent conversations, background runs, latency and operating cost. Use explicit assumptions pending measurements.

Minimal check: start the required processes and inspect health; attempt one existing create/run journey and record the actual result. Do not run all historical suites to inventory the product.

Exit: a concise baseline with known blockers and the first working slice identified.

## Phase 1: Standalone organizations and platform access

- [ ] Consume the shared-login contract from the separate Labs/Growth task. Register an Agents OIDC client and implement an Agents-owned backend session without requiring Growth /api/auth/me.
- [ ] Apply the agreed account policy: email/password, Google and passkeys through Keycloak, open registration, HttpOnly product cookies, 7-day inactivity and 30-day maximum, browser-wide logout and all-device logout, optional two-factor and recovery codes.
- [ ] Implement personal workspace and organization onboarding, creation, initial ownership, invitations and roles. Define the exact personal/team relationship before granting access.
- [ ] Enforce organization scope on agents, conversations, runs, credentials, knowledge, files and account actions. Keep machine/API credentials separate from human sessions.
- [ ] Connect client sign-in, organization selection, onboarding and permission-denied states to Agents APIs.

Dependency: the other agent owns the shared provider implementation. Coordinate through its published configuration/contract; do not edit its files or invent a competing login system. Work on independent runtime modules while waiting. A production-like browser acceptance cannot be claimed until real shared login is available.

Minimal check: one fresh user signs in and opens their workspace; another user cannot access it; an invited member receives only the assigned permissions.

Exit: Agents is independently accessible using the shared provider and its own authorization.

## Phase 2: Recover a complete creation and playground journey

- [ ] Reuse and finish agent creation/editing for instructions, model settings and permitted capabilities. Start with a template for FAQ or lead capture.
- [ ] Persist drafts and immutable published versions; pin every run to its effective configuration and grants.
- [ ] Connect client playground chat to the actual Agents run API. Show streamed output, status, tool results, errors and cancellation.
- [ ] Keep playground and live connections, credentials and data scope distinct; verify isolation rather than relying on an environment label.
- [ ] Implement list/detail/archive and deployment status using existing lifecycle code where possible.

Minimal check: create an agent, test it, publish a version, edit its draft and confirm the earlier published version remains stable. Reconnect to a run and retrieve its recorded progress.

Exit: the user can create an agent and observe a real execution end to end.

## Phase 3: Shared runtime and short-run execution

- [ ] Establish one admitted run identity with organization, conversation, version, installation, actor and effective grants; resolve it from trusted records.
- [ ] Reuse the common harness and provider adapters. Separate bounded direct execution from durable orchestration without duplicating policy or tool logic.
- [ ] Support short-run API execution with explicit timeout, token/tool-step budgets, cancellation and recorded outcomes. Communicate that interrupted direct runs are not automatically resumed.
- [ ] Persist conversation history separately from orchestration state. Order work within a conversation and allow unrelated conversations to execute concurrently.
- [ ] Add authenticated API invocation, scoped API credentials, usage recording and common error/status responses for API and playground callers.

Minimal check: the same bounded agent works through playground and API; limits stop excess work; two unrelated conversations run concurrently; unauthorized tools are rejected.

Exit: simple agents can operate on shared workers without requiring durable orchestration for every run.

## Phase 4: Tools, knowledge and useful business actions

- [ ] Restore existing document/site ingestion and organization-scoped retrieval. Use object storage for source files/artifacts and preserve deletion and access rules across derived indexes.
- [ ] Separate conversation history, retained personal memory, source knowledge and workflow state; expose appropriate user controls for each.
- [ ] Provide a tool catalog and credential connection flow. Reuse existing adapters and add one real calendar/booking integration plus an external REST or MCP connection.
- [ ] Enforce tool grants, server-held secrets, argument validation, deadlines, provider limits and approvals for consequential actions.
- [ ] Record action identity, attempts and receipts. Use external idempotency where supported; reconcile uncertain writes before retrying. Do not claim exactly-once external effects.
- [ ] Connect the client to knowledge readiness, tool connection health, permissions and approval requests. Keep optional Growth capabilities behind explicit authenticated contracts.

Minimal check: answer from an uploaded source, deny another organization's source/tool credentials, perform one confirmed booking/action, and show an uncertain/failed action accurately without an unsafe duplicate.

Exit: an agent completes a useful business task using its own knowledge and authorized tools.

## Phase 5: Durable workflows and operational controls

- [ ] Reuse Temporal execution for waits, schedules, approvals, retries and long-running model/tool operations. Keep nondeterministic calls and effects outside deterministic workflow logic.
- [ ] Finish versioned workflow definitions, validate their nodes/edges and connect the existing graph editor to execution. Support bounded branching and child-agent delegation with narrowed grants.
- [ ] Implement explicit queued, running, waiting, completed, failed and cancelled states; show their recorded transitions in the client.
- [ ] Support restart recovery, timeouts, cancellation and operator retry only when action outcomes permit it. Bound histories and continuation for long-lived work.
- [ ] Separate interactive and background queues/pools, with per-organization admission and concurrency limits. Pin compatible worker/version behavior for existing workflows during upgrades.

Minimal check: a workflow waits for approval, survives worker restart and completes; a repeated delivery does not repeat a confirmed external action; cancellation and child permissions are enforced.

Exit: users can build and observe resumable workflows without learning Temporal internals.

## Phase 6: Website and messaging deployment

- [ ] Implement one channel connection model with organization, agent version, environment, credentials and permitted operations.
- [ ] Recover website chat and an embeddable widget with appropriate browser/origin controls, scoped session identity and abuse limits.
- [ ] Recover existing Discord and WhatsApp paths. Inventory Telegram and Facebook/Instagram functionality before claiming support; reuse or port agent-owned adapters where present.
- [ ] Add Facebook Messenger and Instagram after website and the first existing messaging channel work. Record provider app approval, business-account and credential requirements as dependencies.
- [ ] Verify webhook authenticity, durably accept before acknowledging where required, deduplicate deliveries, preserve conversation ordering and track outbound delivery outcomes.
- [ ] Implement channel-specific attachments/capabilities, human handoff, agent pause/resume ownership and provider messaging policies. Explain unavailable capabilities in the client.

Minimal check per enabled channel: one inbound message produces one reply; repeated webhook delivery does not duplicate it; failed delivery is visible; human takeover prevents competing agent replies.

Exit: one published agent is reachable through website and a real messaging channel; remaining channels have explicit completion status.

### Phase 6A: Shared live inbox in Agents

The Agents conversation backend owns agent-connected conversations. Deliver its inbox first; Growth then consumes the same commands and events. This work does not replace Growth's unrelated inbox functionality.

- [ ] Inventory and reuse conversation repositories, handoff service, conversation controls, delivery coordination and event notifications. Verify their behavior before claiming inbox support.
- [ ] Define one authoritative conversation model for customer messages, agent/human replies, assignments, open/resolved status, agent/human ownership, unread state and delivery outcomes. Keep internal notes separate from customer-visible messages.
- [ ] Provide scoped APIs for list/history/search/filter, reply, assignment, private notes, resolve/reopen, take over and return control to the agent. Record authenticated actor and audit evidence for changes.
- [ ] Implement backend-enforced ownership transitions. Human takeover pauses automatic replies; invalidate queued agent replies and recheck ownership immediately before dispatch. Define behavior for already-dispatched messages and pending non-message actions rather than promising to retract them.
- [ ] Serialize conflicting takeover/assignment changes and deduplicate reply commands. Prevent two inbox clients or a retry from creating duplicate outbound messages.
- [ ] Publish ordered live message/status/assignment/delivery events with replay cursors and missed-event recovery. Enforce authorization on subscriptions and revoke access when grants change; support reconnects across replicas.
- [ ] Build the Agents inbox with live history, channel/agent/status/assignment filters, search, unread indicators, teammate assignment, private notes, reply/attachments, resolve/reopen and human/agent ownership controls.
- [ ] Show pending, sent, failed and provider-confirmed delivery states only when supported by the channel. Keep manual retries subject to duplicate protection and provider messaging rules.

Minimal check: a customer message appears, an agent replies, a person takes over and replies through the same channel, and control returns to the agent. Verify stale queued agent replies are suppressed after takeover, internal notes are never sent, and reconnect retrieves missed messages without duplicates.

Exit: the Agents inbox operates a real channel conversation and enforces shared backend ownership.

### Phase 6B: Growth access to the same inbox

Growth changes belong to a separate bounded integration task after the Agents inbox interfaces work. Keep Growth on rewrite and coordinate with the separate login task; no changes to its files are implied by writing this plan.

- [ ] Implement an explicitly authorized connection between a Growth organization and permitted Agents organizations/deployments. Never infer access from shared email, login, or matching organization IDs.
- [ ] Define revocable per-user delegation for inbox read, reply, assignment and handoff actions. Agents verifies the connected workspace, actor and grants; a broad service credential alone does not authorize every Growth user.
- [ ] Add Growth backend adapters for inbox commands and live subscriptions. Keep service/delegation credentials off the browser and use approved APIs/events instead of direct Agents database queries.
- [ ] Display agent-connected conversations within Growth's inbox using Agents IDs, commands and events. Preserve Growth's other conversations and clearly identify the source.
- [ ] Link Agents customer/conversation references to authorized Growth contact/lead records. Keep CRM data product-owned; search/read projections are scoped and refreshable rather than competing conversation writers.
- [ ] Reflect replies, assignments, resolution and takeover made in either product in the other. Use the same command IDs and conflict responses for concurrent actions.
- [ ] Revoke access when a workspace connection or user's permissions are removed. Define disconnected/unavailable states and resync instead of accepting unsynchronized local writes.

Minimal check: customer message → agent reply → human takeover in Growth → both inboxes update → human reply → return to agent. Also verify simultaneous commands do not duplicate replies, reconnection catches up, and an unrelated Growth workspace or revoked user is denied.

Exit: authorized users manage one conversation from either product while Agents remains authoritative. Agency adoption is later work.

## Phase 7: Deploy and manage the filesystem personal runtime

Runtime development has a [separate linked checklist](PERSONAL_AGENT_RUNTIME_PLAN.md). This phase delivers the user-facing deployment product, not merely a hosted agent with database memory.

- [ ] Agree the separately built runtime's task/event/control interface, supported revisions and persistent workspace contract before integrating it.
- [ ] Implement a local Docker-backed environment manager for trusted development workloads, with deploy/start/stop/status/restart, scoped communication and CPU/memory/time/network limits.
- [ ] Attach persistent workspace storage for runtime files, instructions, skills, memory and sessions. Keep platform permissions, usage, credentials and deployment records platform-controlled.
- [ ] Connect runtime tasks, progress, artifacts, cancellation, idempotent admission and failure/restart reconciliation to Agents platform records. Files surviving restart alone must not imply tasks resume safely.
- [ ] Plug in scoped platform/external tools and route one existing channel to the deployment. Growth/Agency tools remain authenticated product integrations.
- [ ] Provide client controls to deploy/configure the runtime, connect tools/channels, inspect activity and files, and start/stop/restart. Record runtime revision and resource usage.
- [ ] Define sleep/wake, storage retention, backup/export, deletion and secret revocation. Choose production sandbox hosting/isolation before enabling customer code; no Kubernetes or vendor is selected.

Minimal check: deploy one runtime, connect one channel/tool, complete a task, restart and retain declared files/memory, reject cross-deployment access and duplicate task delivery, and verify stop/cleanup controls.

Exit: a user can deploy and manage our filesystem personal runtime locally through the platform. Production customer-code hosting remains gated by the isolation decision.

## Phase 8: Scaling, usage and operating the platform

- [ ] Keep API replicas free of authoritative in-memory sessions or ownership. Support shared event delivery and reconnectable streams across replicas.
- [ ] Enforce per-organization concurrency, request/tool/model limits and spending budgets before work is admitted. Bound queues and provide meaningful overload responses.
- [ ] Track model tokens, tool usage, runtime duration and environment resources with deduplicated usage records. Expose budgets, spend and run history; payment-provider integration is a separate commercial delivery unless explicitly added.
- [ ] Publish Analytics events through the existing outbox/publisher, tolerate transient failure, and export telemetry to Labs. Usage/billing truth remains in Agents records.
- [ ] Add independently startable document and execution workers where the measured workload requires them. Keep database connection pools bounded as replicas grow.
- [ ] Document backups/restores, configuration/secrets, worker upgrades, health/readiness, failure recovery, retention/deletion and migration procedures.
- [ ] Verify representative capacity against the recorded targets and identify bottlenecks before recommending additional infrastructure.

Minimal check: two API/worker replicas share state correctly; one noisy organization hits its limits without blocking another; worker restart preserves durable work; Analytics outage does not erase usage records. Run one bounded representative load check, not repeated broad benchmarks.

Exit: a runnable platform with measured initial capacity, controlled costs and a documented path to additional replicas. This is not a claim of unlimited scale.

## Delivery discipline

- Work one phase at a time. Do not start a wholesale rewrite or make every optional channel a prerequisite for the first useful delivery.
- Use the existing working branch where suitable; keep main plus at most one active branch. No push, merge or production deployment is implied by this planning task.
- After each meaningful slice, run the relevant focused checks and backend build or client typecheck as appropriate. Avoid unrelated full suites and tests that merely repeat implementation details.
- Leave each item unchecked until its actual behavior is verified. Record concise commands, observed outcomes, dependencies and known limits below.
- External credentials, provider approvals and production infrastructure can block their specific acceptance checks. Mocks do not prove those integrations work.

## Progress record

No implementation has been completed under this checklist. Existing code was inspected to establish source locations; no runtime acceptance or capacity validation was performed while writing this plan.

For each completed phase record date, changed revision, working journey, focused checks, remaining blockers and the next phase.

## References

- [Runtime and host implementation evidence](../../architecture/agent-runtime-host-boundary.md).
- [Repository startup and process documentation](../../../README.md).
- [Current platform architecture](../../architecture/agent-platform-architecture.md).
- [Current hosted memory contract](../../architecture/memory-lifecycle.md).
- [Personal runtime checklist](PERSONAL_AGENT_RUNTIME_PLAN.md).
- [Shared login checklist](../../../../plans/shared-login/IMPLEMENTATION.md), owned by the separate login task.
- [Temporal tasks and worker queues](https://docs.temporal.io/tasks).
- [Temporal worker scaling](https://docs.temporal.io/develop/worker-performance).
- [Temporal activity idempotency guidance](https://github.com/temporalio/skill-temporal-developer/blob/main/references/core/gotchas.md).
