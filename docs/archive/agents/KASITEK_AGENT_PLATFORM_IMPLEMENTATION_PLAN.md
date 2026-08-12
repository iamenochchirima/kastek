# KasiTek Agent Platform Implementation Plan

**Status:** Archived — superseded by the unified agent-system plan
**Initial product scope:** Direct KasiTek platform  
**Deployment target:** Railway first, portable to AWS, Google Cloud, Azure, or Kubernetes  
**Last updated:** 2026-08-11

## Current implementation evidence

The active direct-product integration and one-way legacy bot cutover are now tracked in
[`KASITEK_UNIFIED_AGENT_SYSTEM_IMPLEMENTATION_PLAN.md`](../../../KASITEK_UNIFIED_AGENT_SYSTEM_IMPLEMENTATION_PLAN.md). The historical cutover checklist
owns the detailed work for the platform/sidebar channel, the first protected KasiAi deployment,
template-created agents, the new Agents UI, and complete removal of the old `/api/bots` and n8n
bot-provisioning system. There is no planned runtime fallback or dual-write path.

- [x] Agent Platform API and worker compile as separate TypeScript process types.
- [x] Dedicated PostgreSQL migrations 001–005 are applied locally, including tool invocation
  audit records.
- [x] Migration 006 adds idempotent run starts, durable run attempts, and ordered run steps.
- [x] Migration 007 adds version- and installation-scoped tool grants with revocation and
  effective-grant intersection at runtime.
- [x] Migration 008 adds scoped rolling conversation summaries used during context rebuilding;
  deterministic summaries are a safe first implementation until a summary model policy exists.
- [x] Migration 009 adds channel connections, bindings, participants, and delivery attempts.
- [x] Migration 010 adds an encrypted credential vault with opaque references, revocation, and
  organization-scoped resolution.
- [x] Migration 011 adds organization-scoped evaluation scenarios and durable evaluation runs.
- [x] Migration 012 adds hashed, expiring, single-use channel pairing tokens and audit-backed
  binding consumption.
- [x] Migration 013 adds separate optimistic-concurrency workflow state for each run.
- [x] Migration 014 adds quarantine status for suspicious imported/inferred memory.
- [x] Migration 015 adds organization-scoped agent schedules with durable next-run state and
  pause/resume controls.
- [x] Migration 016 adds scoped global/organization/agent/installation/tool kill switches with
  runtime enforcement and operator controls.
- [x] Migration 017 adds idempotent definition/scope installation identity; protected global
  system definitions can now be installed into organizations without weakening installation data
  isolation.
- [x] Temporal workflow contracts include durable approval and cancellation signals, status
  query support, idempotent terminal handling, and exact argument-hash resume checks.
- [x] Run events are available through a replica-safe PostgreSQL-polled SSE stream.
- [x] `kasitek-core` exposes an authenticated, organization-scoped read-only customer boundary;
  the initial `kasitek.core.customer_get` tool uses it without database access.
- [x] Local verification: TypeScript build; 81 tests with the PostgreSQL integration flag;
  `cargo fmt --check`; `cargo check -p kasitek-core`; and the client production build.
- [ ] Temporal Cloud execution, worker restart recovery, and multi-replica failover still need
  a live namespace and deployment credentials.

## 1. Purpose

This document is the working implementation checklist for the complete KasiTek Agent Platform.
It covers the shared system used to define, version, deploy, execute, observe, and govern all
KasiTek agents.

KasiAi will be the first system-owned agent deployed on this platform. It is not a separate
runtime. Booking agents, support agents, channel agents, template-created agents, and fully
custom agents will use the same control plane, runtime, memory system, tool gateway, channel
gateway, and operational controls.

This checklist must be updated during implementation:

- Mark an item complete only when code, tests, documentation, or operational evidence exists.
- Do not mark a phase complete until its exit gate passes.
- Add newly discovered work to the appropriate phase before implementing it.
- Record significant architecture changes as ADRs and update this document.
- Do not silently weaken isolation, approval, audit, or durability requirements to complete a
  feature faster.

## 2. Confirmed architecture decisions

- [x] Build one shared Agent Platform for all agent types.
- [x] Treat KasiAi as one protected system-owned agent on the shared platform.
- [x] Keep the Agent Platform in the KasiTek monorepo.
- [x] Deploy the Agent Platform separately from `kasitek-core`.
- [x] Containerize platform services and worker pools, not individual agents.
- [x] Represent agents as versioned durable data, not permanent processes or filesystems.
- [x] Use shared stateless workers to execute active runs.
- [x] Preserve the Waku architecture: gateway, working context, bounded loop, tools, memory,
  graph workflows, tracing, and evaluations.
- [x] Productionize Waku's local concepts with durable storage, identity, authorization,
  approvals, multi-agent configuration, and horizontal workers.
- [x] Store no authoritative state on container filesystems.
- [x] Use a Tool Gateway for platform actions; models and agent workers receive no direct
  database or provider credentials.
- [x] Use ephemeral sandboxes only for untrusted code, shell, browser automation, or unsafe
  extensions.
- [x] Support multiple channel bindings per agent through channel adapters.
- [x] Build for Railway first without introducing Railway-specific runtime assumptions.
- [x] Keep the system portable through Docker, PostgreSQL, standard object storage,
  OpenTelemetry, and environment-based configuration.
- [x] Implement the Agent Platform and shared Agent workers in TypeScript on Node.js.
- [x] Keep `kasitek-core` in Rust as the authoritative boundary for platform data,
  authorization, and consequential actions.
- [x] Use Temporal as the durable execution engine for agent runs, waits, retries,
  approvals, schedules, and recovery.
- [x] Use Temporal Cloud for the initial production proof of concept and trial period.
- [x] Preserve a tested migration path to self-hosted Temporal on Railway before the Cloud
  trial expires; do not make Agent Platform contracts depend on Cloud-only capabilities.
- [x] Use a dedicated PostgreSQL service and database for the Agent Platform from the first
  deployment; do not place Agent Platform tables in the `kasitek-core` database.
- [x] Keep the model runtime provider-neutral and use OpenRouter as the initial model gateway.
- [x] Keep OpenRouter behind a KasiTek-owned adapter so agent definitions, run history, tool
  contracts, and provider-neutral model events do not depend on OpenRouter response types.
- [x] Implement OpenRouter, OpenAI, Anthropic, and Google Gemini model adapters in the initial
  Agent Platform delivery.
- [x] Use OpenRouter as the default gateway while allowing agent policy to select an approved
  direct provider for provider-specific features, outage mitigation, or user-owned credentials.
- [x] Use PostgreSQL with pgvector and PostgreSQL full-text search as the initial memory and
  knowledge retrieval store.
- [x] Keep canonical memory text, ownership, permissions, and provenance in PostgreSQL; vectors
  are a rebuildable search index rather than the source of truth.
- [x] Access vector search through a provider-neutral store interface so a dedicated engine such
  as Qdrant can be introduced later without changing memory or knowledge contracts.
- [x] Preserve Waku's working, semantic, episodic, and procedural memory separation, retrieval
  gate, bounded context, and batched loss-safe consolidation.
- [x] Use KasiTek-managed model credentials for KasiAi and as the default for agents operating
  within plan entitlements and usage budgets.
- [x] Allow users to optionally provide OpenRouter, OpenAI, Anthropic, or Google Gemini
  credentials for eligible agents.
- [x] Attribute every model call and cost to the funding source: KasiTek-managed or user-funded.
- [x] Encrypt user-provided credentials, expose only opaque credential references to the Agent
  Platform, and never place provider secrets in prompts, workflow history, traces, or sandboxes.
- [x] Implement the direct KasiTek product first; do not implement the tenant runtime in this
  delivery plan.
- [x] Preserve explicit organization ownership so later tenant support does not require a new
  agent model.

## 3. Decisions that require ADRs before production implementation

- [x] ADR: Record the confirmed TypeScript/Node.js Agent Platform runtime and select the
  service framework and package boundaries.
- [x] ADR: Record Temporal as the confirmed durable execution engine and document the
  workflow/activity boundary.
- [x] ADR: Record Temporal Cloud as the initial deployment, including the trial deadline,
  spend alerts, self-hosted Railway exit plan, and active-workflow cutover procedure.
- [x] ADR: Record the confirmed dedicated Agent Platform PostgreSQL service, database ownership,
  backup policy, connection limits, and prohibition on cross-database coupling to core tables.
- [x] ADR: Record the confirmed provider-neutral model contract and OpenRouter-first gateway,
  including capability negotiation, pinned model identifiers, fallback compatibility, actual
  provider/model attribution, privacy routing, and first-release direct adapters for OpenAI,
  Anthropic, and Google Gemini.
- [x] ADR: Record the confirmed mixed credential model, including KasiTek-managed defaults,
  optional user-provided keys, usage metering, budgets, billing attribution, key precedence,
  encrypted storage, revocation, and fallback rules.
- [x] ADR: Record PostgreSQL/pgvector as the initial vector store, hybrid retrieval and namespace
  filtering requirements, embedding-version migrations, and the dedicated-vector-store exit
  criteria.
- [ ] ADR: Choose the production secrets manager and local-development secret workflow.
- [ ] ADR: Choose object storage and define an S3-compatible storage interface.
- [ ] ADR: Choose Redis or another transient coordination layer for streaming, caching, and
  rate limits.
- [ ] ADR: Define message-stream delivery: SSE initially, WebSocket, or both.
- [ ] ADR: Define audit retention, trace retention, content redaction, and support access.
- [ ] ADR: Define the first sandbox provider for future untrusted execution.
- [x] ADR: Define how declarative workflow definitions are represented and versioned. **Version 1
  is a validated immutable graph embedded in the agent version configuration; execution is
  provider-neutral and traced.**
- [x] ADR: Define how the Agent Platform authenticates internal calls to `kasitek-core`.
- [x] ADR: Define the external channel identity-pairing protocol. **Generic one-time pairing is
  implemented; provider webhook verification and channel-specific UX remain separate.**

## 4. System boundaries

### 4.1 Agent Platform responsibilities

The Agent Platform owns:

- agent definitions, versions, templates, and installations;
- agent identities, policies, tool grants, and channel bindings;
- conversations, participants, messages, attachments, and delivery state;
- runs, attempts, steps, tool proposals, approvals, and run events;
- context construction, model routing, bounded agent loops, and graph workflows;
- memory, summaries, knowledge ingestion, retrieval, and provenance;
- schedules, triggers, handoffs, and proactive agent work;
- agent telemetry, evaluations, feedback, usage, cost, and operational controls.

### 4.2 `kasitek-core` responsibilities

`kasitek-core` remains authoritative for:

- users, organizations, memberships, roles, sessions, and product identity;
- billing, entitlements, limits, and product capabilities;
- product domains such as content, inbox, social, bookings, customers, and campaigns;
- connected provider accounts and their credentials;
- final authorization and execution of KasiTek business actions.

The Agent Platform must call typed internal APIs or action contracts. It must not query or
mutate core product tables directly.

### 4.3 Initial deployment boundary

```text
KasiTek clients and external channels
                  |
                  v
         kasitek-agents-api
                  |
        durable run orchestration
                  |
                  v
       kasitek-agents-worker
          |              |
          v              v
   Agent database   Tool Gateway
                         |
                         v
                    kasitek-core
```

## 5. Core platform resources

The implementation must keep the following concepts separate.

- [x] `AgentDefinition`: stable agent identity and ownership.
- [x] `AgentVersion`: immutable instructions, policies, workflows, and bindings snapshot.
- [x] `AgentInstallation`: deployment of an agent into a user/organization/business scope.
- [x] `AgentPrincipal`: machine identity used by an agent to request operations.
- [x] `ToolDefinition`: versioned input/output and security contract for one capability.
- [x] `ToolGrant`: permission for an agent version or installation to request a tool. **Version
  and installation grants are persisted, revocable, audited, and intersected with policy at
  execution.**
- [x] `ChannelConnection`: verified provider connection and credential reference.
- [x] `ChannelBinding`: routing from a channel/account to an agent installation.
- [x] `Conversation`: durable thread belonging to one agent installation.
- [x] `Participant`: user, customer, staff member, agent, or system actor in a conversation.
- [x] `Message`: immutable inbound or outbound conversation event.
- [x] `AgentRun`: one durable attempt to process a trigger or message.
- [x] `RunStep`: ordered retrieval, model, routing, approval, or tool execution step.
- [x] `ToolInvocation`: proposed and executed tool operation with policy evidence. **Migration
  005 records the request, stable argument hash, approval state, outcome, latency, and effect
  identifier.**
- [x] `ApprovalRequest`: exact, expiring authorization for a consequential invocation. **Tool
  invocation records persist the pending action, arguments hash, approval decision, actor, and
  bounded expiry.**
- [x] `MemoryRecord`: scoped durable fact, preference, episode, or workflow state.
- [x] `KnowledgeSource`: owned source from which approved chunks can be retrieved.
- [x] `AgentSchedule`: durable scheduled trigger for proactive work. **Schedule records, timezone,
  input, status, and next-run state are persisted; Temporal trigger polling remains deployment
  work.**
- [x] `AgentEvaluation`: versioned deterministic or model-judged assessment. **Deterministic
  scenario assertions and durable evaluation results are implemented; model-judged rubrics remain
  optional.**
- [x] `AgentEvent`: canonical lifecycle and operational event.

## 6. Runtime invariants

- [x] Every run is pinned to one immutable agent version.
- [x] Every run carries organization, agent, installation, conversation, trigger, and actor
  scope where applicable.
- [x] Every run has a globally unique run ID and correlation ID.
- [x] Every inbound provider message is deduplicated before starting a run. **Provider/message
  identity uniqueness and run idempotency keys are persisted.**
- [x] Messages within one conversation are processed in order. **Sequence numbers are allocated
  transactionally and unique per conversation.**
- [x] Different conversations may execute concurrently. **No process-local conversation lock is
  used; runs are independently durable.**
- [x] Workers are stateless and interchangeable.
- [x] Context is rebuilt from durable references for every run.
- [x] Recent conversation context is bounded.
- [x] Older context is summarized or retrieved selectively.
- [x] Agent loops have iteration, token, cost, tool-call, and wall-clock limits.
- [x] Terminal run history is append-only.
- [x] Retries create attempt records and do not rewrite history. **Run attempts and ordered steps
  are append-oriented; idempotent starts return the original run.**
- [x] A paused or approval-waiting run can resume on a different worker.
- [ ] External effects are idempotent or explicitly reconciled when their outcome is unknown.
- [ ] Cancellation prevents future work and never pretends an existing external effect was
  reversed.

## 7. Run state machine

```text
received
  -> queued
  -> running
  -> awaiting_approval | awaiting_human | awaiting_external_event
  -> running
  -> completed | failed | cancelled | expired
```

- [x] Define the typed run-state enum and valid transitions.
- [x] Reject invalid or backward transitions.
- [x] Define retryable and terminal failure classes. **The runtime classifies provider, core,
  timeout, tool, workflow, and policy failures; Temporal retry execution and effect-aware replay
  remain deployment/runtime follow-up work.**
- [x] Define model, tool, delivery, policy, and infrastructure failure categories. **Runtime
  failure codes classify provider, timeout, tool, policy, workflow, and delivery boundaries;
  provider-specific codes remain extensible.**
- [ ] Define workflow timeouts and heartbeat behaviour.
- [x] Define cancellation semantics. **A cancellation signal transitions non-terminal runs to
  `cancelled` and never claims an already-started external effect was reversed.**
- [x] Define approval timeout and expiry semantics. **Approvals are hash-bound and expire after
  a bounded 15-minute resume window; a production-configurable timeout is still pending.**
- [ ] Define unknown external-effect reconciliation.
- [ ] Test crash recovery at every non-terminal state.

## 8. Waku-derived execution architecture

### 8.1 Working context

- [x] Build context from immutable agent instructions and policies.
- [x] Add current time, locale, channel, and execution identity.
- [x] Add bounded recent conversation history.
- [x] Add the rolling conversation summary. **Summaries are bounded, durable, scoped, and wrapped
  as untrusted context.**
- [ ] Add temporary page/resource context supplied by a trusted KasiTek client.
- [x] Run the retrieval gate before loading long-term memory.
- [x] Load only memory permitted by the current namespace and actor scope. **Retrieval applies
  organization, agent, installation, and conversation predicates before ranking.**
- [ ] Match procedural skills/workflows relevant to the request.
- [x] Add only currently authorized tool schemas.
- [x] Mark customer content, documents, web content, and tool output as untrusted data.
- [x] Enforce total context and per-source token budgets.

### 8.2 Bounded agent loop

- [x] Implement the provider-neutral model request/response contract.
- [x] Implement model text responses.
- [x] Implement structured tool requests.
- [x] Validate every tool request against its declared schema.
- [x] Route every tool request through policy before execution.
- [x] Feed structured tool results back into the model.
- [x] Stop naturally when the model returns no tool calls.
- [x] Stop safely at configured iteration, tool-call, cost, token, or time limits.
- [x] Support cancellation while a run is active. **Temporal cancellation signals are durable;
  provider/tool cancellation propagation remains a follow-up.**
- [x] Emit structured events for every loop iteration.
- [x] Do not persist or expose hidden chain-of-thought as application state.

### 8.3 Graph workflows

- [x] Define a versioned declarative graph schema. **Version 1 supports deterministic, model,
  loop, tool, route, fan-out/fan-in, approval, and wait node contracts.**
- [x] Support deterministic function nodes.
- [x] Support one-call model nodes. **The executor injects the model implementation so graph
  definitions remain provider-neutral.**
- [x] Support full bounded agent-loop nodes. **The executor injects the existing bounded loop.**
- [x] Support tool nodes.
- [x] Support routing nodes whose final control decision is deterministic code.
- [x] Support fan-out and fan-in. **Fan-out executes branches concurrently against isolated state
  snapshots and merges completed branch state.**
- [x] Support bounded cycles. **Node iteration limits are enforced at execution; graph validation
  rejects unbounded cycles.**
- [x] Support human approval and human handoff nodes. **Approval nodes durably return a pause
  result; handoff signaling remains a channel/control-plane integration.**
- [x] Support waits for schedules and external events. **Wait nodes durably return an external
  event pause result.**
- [x] Validate graph topology before publication.
- [x] Prevent parallel branches from silently overwriting the same state key. **Parallel nodes
  must declare a group and duplicate local writes are rejected.**
- [x] Trace the executed path and node outcomes.

## 9. Agent control plane

### 9.1 Definitions and versions

- [x] Create an agent definition.
- [x] Create a draft version.
- [x] Validate the version before publication.
- [x] Publish an immutable version.
- [x] Activate a published version.
- [x] Roll back to an earlier published version.
- [x] Retire a version without corrupting historical runs.
- [x] Archive an agent while retaining audit history.
- [x] Prevent deletion of protected system-owned agents. **System-owned protected definitions are
  created through the bootstrap repository path and archive/delete operations reject them.**
- [x] Record who changed and published each version.
- [x] Compute a checksum over the effective version configuration.

### 9.2 Templates and customization

- [ ] Define templates as versioned creation inputs, not runtime types.
- [ ] Allow templates to create ordinary agent definitions and draft versions.
- [ ] Support protected system templates.
- [ ] Support organization templates later without changing runtime contracts.
- [ ] Define structured customization fields.
- [ ] Validate custom instructions and workflow configuration.
- [ ] Keep mandatory platform safety policy outside user-editable instructions.
- [ ] Defer the free-form visual workflow builder until publication, policy, and run operations
  are proven.

### 9.3 Installations

- [x] Install an agent into an organization/user/business scope.
- [x] Activate, pause, resume, and disable an installation.
- [x] Bind an installation to channels and triggers. **Installation/channel bindings and generic
  one-time pairing are implemented; provider trigger adapters remain pending.**
- [x] Apply installation-level settings without mutating the agent version.
- [x] Apply installation-level budgets and rate limits. **Installation settings cap context,
  model calls, tokens, and spend; distributed request rate limiting remains a Redis/deployment
  concern.**
- [x] Resolve an effective configuration deterministically. **Runtime tool access is the
  intersection of version policy and active version/installation grants; installation settings
  apply restrictive context and model budgets without mutating the immutable version.**

## 10. Identity, authorization, and policy

- [ ] Define human, native-agent, external-agent, API-client, and platform actor types.
- [x] Give every active agent installation an agent principal. **Installation creation atomically
  creates its principal; revocation remains an operator control follow-up.**
- [ ] Support human delegation to an agent for one run.
- [ ] Support service-agent execution without a live human session.
- [x] Mint short-lived audience-bound tokens for internal tool calls. **HMAC verifier and signer are implemented; core issuance and key rotation remain deployment work.**
- [ ] Include agent, version, installation, organization, user/delegator, run, and invocation
  identifiers in signed internal context.
- [x] Re-authorize every tool invocation at execution time. **The Tool Gateway checks the active
  grant set and schema on every invocation, not only when context is built.**
- [x] Enforce least privilege and deny by default. **The initial Tool Gateway requires explicit grants.**
- [ ] Evaluate tool availability as the intersection of version grants, installation grants,
  actor rights, entitlements, connection capability, channel policy, and kill switches.
- [x] Define read, draft, controlled-write, external-effect, and privileged risk classes.
  **Tool manifests carry risk classes; external write tools remain disabled in the first slice.**
- [x] Bind approvals to the exact action, arguments hash, and expiry. **Durable decision updates
  require the pending status, exact arguments hash, and unexpired approval payload.**
- [x] Invalidate approval if any bound value changes. **A changed hash or already-decided action
  is rejected as stale.**
- [ ] Prevent privilege escalation through prompt content or tool arguments.
- [x] Add global, organization, agent, channel, and tool kill switches. **Organization operators
  can manage scoped switches; runtime checks global, organization, agent, installation, and tool
  scopes before executing a run. Platform-global authorization remains outside org auth.**

## 11. Tool Gateway

- [x] Define the versioned tool manifest format.
- [x] Require JSON Schema input and output contracts.
- [x] Require risk, approval, and timeout metadata. Retry, idempotency, audit, and usage metadata remain open for consequential tools.
- [x] Build a tool registry that rejects duplicates and invalid manifests.
- [x] List tools filtered by runtime scope and grants.
- [x] Validate model arguments before policy evaluation.
- [x] Validate tool results before returning them to the model.
- [x] Execute trusted KasiTek tools only through authenticated internal APIs. **The initial
  read-only customer boundary is implemented; write tools remain disabled.**
- [x] Pass correlation and causation IDs through every call. **Core read calls carry run and
  correlation headers; durable events retain the run correlation ID.**
- [x] Redact secrets and restricted fields from model-visible results. **Recursive key-based
  redaction runs before tool output is added to model context or recorded by runtime callbacks;
  provider-specific field redaction remains a future policy extension.**
- [x] Record request hash, decision, latency, outcome, and effect identifiers. **Tool
  invocation records are persisted in migration 005.**
- [ ] Define connector adapters for future MCP tools.
- [ ] Treat third-party tool descriptions and results as untrusted.

## 12. Conversations, messages, and channels

### 12.1 Canonical message envelope

- [x] Define a CloudEvents-compatible internal event envelope.
- [x] Define canonical text, attachment, reaction, status, command, and system message types.
  **Canonical schemas reject malformed provider payloads before persistence.**
- [x] Preserve provider message IDs and timestamps. **Provider message IDs are unique and retained;
  provider timestamps/metadata fields remain an adapter extension.**
- [x] Preserve channel-specific metadata outside model-visible content. **Connection metadata and
  canonical channel fields are stored separately from message content.**
- [x] Add idempotent message ingestion. **Provider/message identity uniqueness rejects duplicates.**
- [x] Add outbound delivery attempts and status events. **Attempts can be claimed, marked sent
  with a provider ID, or marked failed; provider-specific transport remains adapter work.**

### 12.2 Channel adapters

- [x] Define the channel adapter interface.
- [x] Implement the authenticated platform/sidebar adapter first. **The adapter normalizes
  canonical inbound events; API authentication remains the trust boundary.**
- [ ] Implement secure Telegram account pairing and message delivery.
- [ ] Implement secure WhatsApp account pairing and message delivery.
- [x] Verify provider webhook signatures and replay windows. **A provider-neutral timestamped
  HMAC verifier with constant-time comparison and bounded replay tolerance is implemented;
  provider-specific secret/signature extraction remains adapter work.**
- [ ] Acknowledge provider webhooks after durable receipt, before model execution.
- [ ] Normalize channel events before dispatching them to agents.
- [ ] Support channel-specific rate, size, and formatting limits.
- [ ] Support attachments through signed, scoped object references.
- [x] Support revocation of an external identity binding. **Bindings can be revoked through the
  organization-scoped control API; provider re-authentication remains adapter work.**

### 12.3 Conversation semantics

- [x] Support multiple conversations per installation.
- [x] Support participants with user, customer, staff, agent, and system roles.
- [x] Keep channel conversation histories separate by default.
- [ ] Share only explicitly permitted durable memory across conversations.
- [x] Support conversation archive, rename, export, and deletion policies. **Archive/delete
  status controls and scoped export via conversation inspection are implemented; rename policy
  remains a UI refinement.**
- [ ] Support human handoff without losing agent/run history.
- [ ] Define how and when an agent resumes after human handoff.

## 13. Memory and knowledge plane

### 13.1 Memory types and namespaces

- [x] Implement conversation working context.
- [x] Implement rolling conversation summaries.
- [x] Implement semantic facts and preferences.
- [x] Implement episodic history.
- [x] Implement procedural skills and workflows through versioned configuration.
- [x] Implement operational workflow state separately from semantic memory. **Each run gets a
  durable `run_workflow_state` record with revision-checked updates; semantic memory remains in
  the memory tables.**
- [x] Define `conversation`, `user_private`, `organization_shared`, `agent_private`,
  `customer_agent`, and `system_knowledge` scopes.
- [x] Enforce namespace predicates before retrieval and ranking.
- [ ] Enforce PostgreSQL row-level security where appropriate.

### 13.2 Memory safety

- [x] Record source, provenance, author, sensitivity, confidence, and timestamps.
- [x] Record whether memory was explicit, imported, or inferred.
- [x] Add expiry and revalidation policies.
- [x] Require explicit policy before automatic memory creation.
- [x] Prevent untrusted content from becoming procedural instructions. **Inferred procedural
  memory requires a separate explicit policy flag.**
- [x] Detect and review suspected memory poisoning. **Imported/inferred memory matching
  instruction-override, secret-exfiltration, safety-bypass, or prompt-extraction patterns is
  quarantined with provenance signals and excluded from retrieval; review UI remains pending.**
- [x] Allow users and operators to inspect, correct, and delete memory. **Repository-level controls are implemented; operator/user UI remains pending.**
- [x] Propagate deletion to embeddings, summaries, and derived artifacts. **Canonical deletion jobs are recorded; embedding/derived propagation remains limited until those stores exist.**

### 13.3 Knowledge ingestion

- [x] Define knowledge collections and source ownership.
- [x] Support explicit document upload. **Canonical source/chunk persistence is implemented; object storage/upload transport remains pending.**
- [x] Support explicit URL ingestion with bounded fetching. **HTTP(S)-only fetches enforce
  redirect, credential, content-type, timeout, declared-length, and streaming byte limits;
  deterministic text chunking preserves URL and fetch provenance.**
- [ ] Store original files in object storage.
- [ ] Scan files before parsing.
- [ ] Separate fetch, extract, chunk, embed, index, and publish steps.
- [x] Preserve document revision and chunk provenance.
- [ ] Use PostgreSQL and pgvector initially. **The provider-neutral schema currently uses PostgreSQL full-text search and an optional rebuildable embedding field; pgvector enablement is a deployment gate.**
- [x] Evaluate exact search before adding approximate indexes.
- [ ] Add hybrid keyword and vector retrieval.
- [ ] Test cross-agent and cross-organization retrieval isolation.

## 14. Durable execution and workers

- [ ] Build a production spike for the selected durable workflow engine.
- [ ] Prove run start, activity execution, retry, signal, cancellation, timeout, and recovery.
- [ ] Prove an approval-waiting run resumes after all workers restart.
- [ ] Prove a run can resume on a different worker replica.
- [x] Use one durable workflow per run, not one unbounded workflow per conversation. **The
  Temporal contract uses `agent-run-<runId>` workflow identity.**
- [ ] Create separate task queues by workload/risk where supported.
- [ ] Separate interactive runs from background ingestion and evaluation work.
- [ ] Add worker concurrency and backpressure controls.
- [ ] Add per-organization fairness and rate limits.
- [ ] Add dead-letter or terminal-failure handling.
- [ ] Add controlled replay with external-effect tools disabled by default.

## 15. Model gateway

- [x] Define a provider-neutral messages, tools, usage, and error contract.
- [x] Implement OpenRouter as the default adapter plus direct OpenAI, Anthropic, and Google
  Gemini adapters in the initial delivery.
- [x] Define capability flags so unsupported provider features fail validation instead of
  silently degrading. **Tool-calling capability checks are enforced by the gateway.**
- [ ] Add a small/fast model route for gates, classifiers, and summaries.
- [x] Add versioned model policies rather than hard-coded model IDs. **Published policy can
  select a primary target, bounded fallbacks, a fast target, funding fallback policy, and run
  token/cost caps; legacy configuration remains supported for existing drafts.**
- [ ] Add provider and model fallbacks permitted by data policy.
- [x] Add token accounting and estimated cost per model call. **Pricing is deployment-configured
  through `MODEL_PRICING_JSON`; unknown models report zero rather than inventing a price.**
- [x] Add request timeouts and retry classification. **Gateway retries bounded retryable provider
  failures and aborts timed-out requests.**
- [x] Add structured-output validation. **OpenAI-compatible adapters send JSON Schema mode and
  the gateway parses and validates returned JSON with AJV; providers without an implemented
  contract fail capability validation.**
- [x] Add streaming response support. **The provider-neutral gateway contract and OpenAI/
  OpenRouter-compatible SSE adapter stream text/tool deltas; unsupported providers fail the
  capability check instead of silently buffering.**
- [x] Add provider circuit breakers. **The gateway tracks provider/model failures, opens after a
  bounded threshold, and expires the circuit after a cooldown; open circuits fail fast.**
- [x] Resolve credentials through opaque references and an explicit precedence policy.
- [x] Support KasiTek-funded and user-funded provider credentials. **The resolver supports
  opaque vault references for user-funded keys and environment-backed KasiTek defaults.**
- [x] Enforce entitlement, token, request, and spend budgets before each model call. **Per-run
  token/request/spend ledgers are checked against durable model-call usage before each call;
  product entitlement lookup remains a `kasitek-core` boundary.**
- [x] Record the credential funding source without exposing credential material. **Vault records
  carry the funding source and model-call attribution stores only that source and reference.**
- [x] Do not fall back from a user-funded key to a KasiTek-funded key unless agent policy
  explicitly permits it. **A supplied opaque reference must resolve successfully; no implicit
  environment fallback occurs.**
- [x] Support credential rotation and revocation. **Rotation atomically creates a new encrypted
  record and revokes the prior reference; provider validation and failure notification remain
  operational follow-up work.**
- [x] Prevent secrets from entering prompts or model-visible tool output. **Credentials are opaque
  references and tool outputs are recursively redacted before model context/audit callbacks.**
- [x] Record the actual provider, model, tokens, latency, and finish reason.

## 16. Sandboxing and custom execution

- [ ] Keep trusted platform tools out of the sandbox path.
- [ ] Execute declarative workflows with approved nodes on shared workers.
- [ ] Define the sandbox request/result contract before enabling custom code.
- [ ] Provide no database or provider master credentials to sandboxes.
- [ ] Use short-lived, narrowly scoped capability tokens.
- [ ] Use read-only base images and ephemeral working directories.
- [ ] Enforce CPU, memory, process, file, output, and time limits.
- [ ] Deny network egress by default and support explicit allowlists.
- [ ] Destroy execution environments after each task.
- [ ] Evaluate an external sandbox provider for the Railway phase.
- [ ] Evaluate gVisor on Kubernetes for later self-hosted sandboxing.
- [ ] Reserve Firecracker or dedicated infrastructure for higher-risk isolation tiers.
- [ ] Do not enable unrestricted custom code until sandbox escape and exfiltration testing
  passes.

## 17. Observability, evaluations, and administration

### 17.1 OpenTelemetry

- [ ] Instrument agent runs using OpenTelemetry GenAI conventions where stable.
- [ ] Create root spans for agent invocation.
- [ ] Create child spans for context, retrieval, model calls, policy, approvals, tools, and
  delivery.
- [ ] Record agent, version, installation, conversation, run, model, token, and cost metadata.
- [ ] Keep prompt and response content recording disabled by default.
- [ ] Add controlled content capture with redaction and restricted access.
- [ ] Correlate traces, logs, run records, audit records, and provider effects.

### 17.2 Metrics and alerts

- [ ] Monitor queue depth and oldest queued-run age.
- [ ] Monitor success, failure, cancellation, and timeout rates.
- [ ] Monitor time to first token and total latency.
- [ ] Monitor model-provider latency and errors.
- [ ] Monitor token use and estimated cost by organization, agent, version, and model.
- [ ] Monitor tool proposal, approval, execution, and failure rates.
- [ ] Monitor memory retrieval and write activity.
- [ ] Monitor channel ingestion and delivery failures.
- [ ] Monitor stuck or repeatedly retrying runs.
- [ ] Alert on cost anomalies and denial-of-wallet patterns.

### 17.3 Admin console

- [ ] Build the agent fleet overview.
- [ ] Build agent, version, and installation detail views.
- [ ] Build conversation and run search.
- [x] Build the complete run timeline. **The organization-scoped timeline API joins lifecycle
  events, run steps, and tool invocation outcomes.**
- [ ] Build approval inspection and decisions.
- [ ] Build tool-call and external-effect inspection.
- [x] Build memory and knowledge inspection. **Organization-scoped inspection, deletion, and
  memory revalidation APIs are implemented; admin UI remains pending.**
- [ ] Build usage and cost dashboards. **The underlying organization-scoped operational summary
  API is implemented; dashboard UI remains pending.**
- [ ] Build failure grouping and diagnostics.
- [ ] Build kill-switch controls.
- [ ] Build version canary, activation, and rollback controls.
- [ ] Audit every operator access to sensitive content.

### 17.4 Evaluation platform

- [x] Create deterministic runtime and tool-policy tests.
- [x] Create agent-version scenario datasets. **Scenarios support optional agent ownership,
  structured inputs, deterministic assertions, tags, and rubrics.**
- [ ] Add model-judged quality evaluations separately from deterministic tests.
- [ ] Add adversarial prompt-injection and tool-abuse suites.
- [ ] Add memory-poisoning and cross-scope retrieval suites.
- [ ] Add channel delivery and duplicate-message suites.
- [ ] Define publication gates for agent versions.
- [x] Store evaluation version, rubric, result, and reviewed evidence. **Evaluation runs persist
  the evaluator version, scenario rubric, actual output, assertion result, and failure evidence;
  human review metadata remains an admin-console follow-up.**

## 18. Railway-first deployment

- [x] Add Dockerfiles for Agent Platform process types. **The Dockerfile uses the committed pnpm
  lockfile and builds reproducibly.**
- [x] Make process mode configurable through start commands. **Railway can run the API and worker
  from the same image with separate commands.**
- [ ] Deploy `kasitek-agents-api` as a Railway service.
- [ ] Deploy `kasitek-agents-worker` as a separate Railway service.
- [ ] Keep the worker private through Railway private networking.
- [ ] Provision the Agent Platform PostgreSQL database.
- [ ] Enable pgvector in the selected PostgreSQL deployment.
- [ ] Provision Redis if selected by ADR.
- [ ] Connect to managed durable workflow infrastructure.
- [ ] Configure object storage outside container filesystems.
- [x] Configure health, readiness, and liveness endpoints.
- [ ] Configure zero-downtime-compatible migrations.
- [ ] Configure backups and prove restoration.
- [ ] Configure horizontal worker replicas.
- [ ] Ensure no feature depends on sticky sessions.
- [ ] Route streaming events through shared coordination, not process memory.
- [ ] Add staging and production environments with separate credentials and data.
- [ ] Verify internal service authentication even over the private network.

## 19. Cloud portability

- [ ] Use OCI-compatible container images.
- [ ] Use environment-based configuration with startup validation.
- [ ] Abstract object storage behind an S3-compatible interface.
- [ ] Keep PostgreSQL migrations provider-neutral.
- [ ] Keep Redis/coordination behind a narrow interface.
- [ ] Keep durable workflow calls behind a runtime adapter.
- [ ] Export telemetry through OpenTelemetry rather than a Railway-specific API.
- [ ] Store no durable state on Railway volumes or worker filesystems.
- [ ] Document AWS deployment mapping.
- [ ] Document Google Cloud deployment mapping.
- [ ] Add Kubernetes manifests or Helm packaging only when scaling/sandbox needs justify it.
- [ ] Test restoring production-like data and configuration into a non-Railway environment.

## 20. Security and threat model checklist

- [x] Threat-model direct and indirect prompt injection.
- [x] Threat-model excessive agency and overly broad tools.
- [x] Threat-model cross-organization and cross-agent data access.
- [x] Threat-model memory and knowledge poisoning.
- [x] Threat-model external identity takeover and channel pairing.
- [x] Threat-model replayed webhooks and duplicate messages.
- [x] Threat-model approval replay and payload mutation.
- [x] Threat-model tool-result injection.
- [x] Threat-model data exfiltration through tools, models, traces, and sandboxes.
- [x] Threat-model denial of service and denial of wallet.
- [x] Threat-model compromised providers and third-party MCP servers.
- [x] Threat-model support/operator abuse.
- [x] Assign owners and mitigations for every high-risk finding. **See `agents/docs/THREAT_MODEL.md`; production reviews and residual controls remain explicit.**
- [ ] Complete a production security review before enabling external effects.
- [ ] Complete a separate security review before enabling untrusted custom code.

## 21. Delivery phases and exit gates

### Phase 0 — Architecture and proof spikes

- [ ] Complete all required initial ADRs.
- [ ] Complete the threat model.
- [ ] Prove durable run pause, recovery, and signal handling.
- [ ] Prove provider-neutral tool calling with one model provider.
- [ ] Prove PostgreSQL/pgvector namespace-filtered retrieval.
- [ ] Prove Railway API-to-worker coordination without sticky sessions.

**Exit gate**

- [ ] Architecture review accepts the service, data, identity, workflow, and security boundaries.
- [ ] No critical implementation decision remains implicit.

### Phase 1 — Agent control plane foundation

- [x] Implement definitions, versions, installations, and publication.
- [x] Implement agent principals, policies, and tool grants.
- [x] Implement conversations, participants, messages, and canonical events.
- [x] Implement run and step persistence. **Run attempts, ordered steps, and idempotent starts are
  persisted in migration 006.**
- [x] Implement operator-readable audit records. **`GET /v1/audit` is organization-scoped and
  supports action/resource filters; sensitive values remain redacted at write/runtime boundaries.**

**Exit gate**

- [x] A versioned agent can be created, published, installed, paused, resumed, and inspected.
- [x] Historical runs remain pinned to immutable versions.

### Phase 2 — First complete runtime slice

- [x] Implement context assembly, retrieval gate, bounded history, and provider gateway.
- [x] Implement the bounded Waku-style agent loop.
- [x] Implement the Tool Gateway with read-only demonstration tools.
- [ ] Implement durable run execution, streaming, cancellation, and recovery. **The contracts,
  signals, SSE stream, and persistence are implemented; live worker-restart recovery remains a
  Temporal deployment gate.**
- [x] Implement run tracing and basic admin timeline. **`GET /v1/runs/:runId/timeline` joins
  events, ordered steps, and tool invocations.**

**Exit gate**

- [x] A generic agent—not a hard-coded KasiAi path—can complete a streamed conversation using
  a read-only tool. **The generic runtime, graph executor, model gateway, and channel contracts
  have no KasiAi-only branch; live provider/Temporal deployment remains a gate.**
- [ ] The run recovers after an intentional worker restart.
- [ ] Cross-agent and cross-organization isolation tests pass.

### Phase 3 — Memory and knowledge

- [x] Implement summaries, scoped semantic/episodic memory, and memory controls. **Rolling
  summaries, scoped retrieval, expiry, revalidation, and deletion controls are implemented.**
- [x] Implement document ingestion and scoped retrieval. **Bounded URL ingestion and PostgreSQL
  full-text retrieval are implemented; object storage and vector hybrid retrieval remain gates.**
- [x] Implement memory and knowledge admin inspection. **The Agent Platform API exposes scoped
  records and deletion/revalidation controls; UI wiring remains a product-surface task.**
- [ ] Implement deletion propagation and retention jobs.

**Exit gate**

- [ ] Retrieval cannot cross an agent or organization boundary.
- [ ] Users can inspect and delete durable memories.
- [ ] Every retrieved knowledge chunk has provenance.

### Phase 4 — Channels

- [x] Ship the platform/sidebar channel. **The authenticated core bridge, durable conversation
  contract, idempotent inbound operation, SSE stream, cancellation, and sidebar UI are shipped;
  external channel adapters remain separate work.**
- [ ] Ship Telegram pairing, inbound processing, and delivery.
- [ ] Ship WhatsApp pairing, inbound processing, and delivery.
- [x] Ship conversation history and channel health controls for the platform/sidebar channel.

**Exit gate**

- [ ] The same generic agent installation operates correctly through more than one channel.
- [ ] Duplicate webhooks do not create duplicate agent runs or replies.

### Phase 5 — Approvals and controlled actions

- [ ] Implement approval requests, exact previews, decisions, expiry, and durable resume.
- [ ] Implement controlled-write and external-effect tools.
- [ ] Implement idempotency, reconciliation, cancellation, and effect audit.
- [ ] Implement user and operator approval interfaces.

**Exit gate**

- [ ] No external effect can bypass policy and approval requirements.
- [ ] Duplicate execution and mutated-approval tests pass.
- [ ] Every external effect is traceable from message to provider outcome.

### Phase 6 — First system-owned agent

- [x] Create KasiAi as a protected system-owned agent definition.
- [x] Automatically install it under the selected user/organization policy.
- [x] Bind it to the platform/sidebar channel.
- [x] Configure its initial platform-guidance knowledge.
- [x] Grant its initial fixed, low-risk platform tools.
- [x] Expose its permitted settings without exposing protected policy.
- [x] Display it in the normal Agents management experience.

**Exit gate**

- [x] KasiAi runs entirely through the generic Agent Platform.
- [x] No KasiAi-only runtime, memory, conversation, or tool path exists.

### Phase 7 — Templates and organization-created agents

- [ ] Ship the first booking, support, lead, and channel-agent templates.
- [ ] Support organization-owned agent definitions and service identities.
- [ ] Support customer-facing conversation participants and handoffs.
- [ ] Support template-specific configuration without runtime branching.

**Exit gate**

- [ ] Multiple materially different agents run on the same engine and operational controls.
- [ ] Template-created agents are ordinary versioned agents after creation.

### Phase 8 — Advanced workflows and custom execution

- [ ] Ship the declarative workflow editor and validator.
- [ ] Ship advanced custom agents using approved nodes.
- [ ] Integrate the sandbox service for custom code/browser nodes.
- [ ] Add marketplace/import/export only after permission and signing design is approved.

**Exit gate**

- [ ] Custom workflows cannot escape their declared tools, scope, budgets, or sandbox.
- [ ] Security and recovery suites pass under concurrent production-like load.

## 22. Initial implementation sequence

When implementation begins, work in this order:

1. Complete Phase 0 ADRs and proof spikes.
2. Define the domain model and migrations. **completed in `agents/migrations/001_agent_platform_foundation.sql`**
3. Establish the separate Agent Platform service and Railway process layout. **API and worker process types are implemented under `agents/`**
4. Implement agent versioning and installation resolution. **control-plane repository and routes are implemented**
5. Implement durable conversations, messages, runs, and events. **foundation persistence and scoped routes are implemented; canonical CloudEvents envelope remains open**
6. Implement the provider-neutral Waku-style loop.
7. Implement the Tool Gateway with safe read-only actions.
8. Implement streaming and the first generic chat surface.
9. Implement traces, admin inspection, and evaluations.
10. Add memory and channels.
11. Add approvals and external effects.
12. Deploy KasiAi as the first system-owned agent.
13. Add templates and custom agents on the proven platform.

## 23. Research and standards basis

The implementation should continue to reference primary documentation for:

- Kubernetes multi-tenancy and sandboxing guidance;
- PostgreSQL Row-Level Security;
- pgvector filtering and indexing;
- Temporal durable workflow execution or the selected alternative;
- CloudEvents event envelopes;
- OpenTelemetry Generative AI semantic conventions;
- Model Context Protocol authorization and tool safety;
- OWASP guidance for excessive agency, prompt injection, memory poisoning, and agent security;
- NIST AI Risk Management Framework and Generative AI profile;
- Railway Dockerfile, private networking, scaling, PostgreSQL, and Redis deployment guidance;
- gVisor and Firecracker isolation guidance when untrusted execution is introduced.

Framework and provider documentation may inform adapters, but no external agent framework is the
source of truth for KasiTek agent identity, versions, policy, runs, memory, tools, or audit history.

## 24. Implementation tranche evidence (2026-08-11)

- `agents/` is a standalone TypeScript service with separate API and Temporal worker entrypoints.
- `agents/migrations/001_agent_platform_foundation.sql` through `016_*` define scoped agent,
  installation, conversation, message, run, event, audit, credential, evaluation, channel,
  workflow-state, schedule, memory-quarantine, and kill-switch persistence.
- `agents/src/domain/types.ts` defines the typed run state machine and rejects invalid transitions.
- `agents/src/temporal/workflows.ts` defines the durable received → queued → running → completed
  workflow boundary; activities invoke the bounded runtime, persist state through repositories,
  and are retry-safe for repeated transitions.
- `agents/src/model/` contains the provider-neutral contract and OpenRouter, OpenAI, Anthropic,
  and Gemini adapters, structured-output validation, streaming, model policy, budgets, retries,
  pricing, and circuit breakers. `agents/src/tools/` contains the JSON-Schema Tool Gateway,
  approval argument hashing, and secret redaction. `agents/src/runtime/loop.ts` implements bounded
  model/tool iterations.
- `agents/src/runtime/context.ts` rebuilds bounded context from durable messages, applies the
  retrieval gate, scopes authorized tool manifests, and marks external content as untrusted.
- `agents/migrations/003_memory_knowledge.sql` and the memory/knowledge repositories provide
  scoped canonical records, provenance, full-text retrieval, expiry, deletion jobs, bounded URL
  ingestion, and suspicious-memory quarantine. Runtime activities load matches only after the
  retrieval gate and include them as untrusted context.
- `agents/src/events/envelope.ts` defines the canonical CloudEvents-compatible envelope and
  `004_event_envelopes.sql` persists its metadata for operational records.
- `agents/src/temporal/activities.ts` resolves the pinned version and model credential inside
  the activity, runs the generic loop, records model usage, and returns only redacted runtime
  results to the workflow.
- `agents/src/http/auth.ts` provides the explicit local-header versus signed HMAC internal-auth
  boundary. Production startup rejects header-only authentication; core token issuance and secret
  rotation remain an open deployment decision.
- Verification completed: the migration runner applied migrations 001–016 to a dedicated local
  `kasitek_agents` database. Integration coverage includes lifecycle rollback/archive, encrypted
  credential rotation/revocation, channel pairing/delivery, memory/knowledge isolation,
  workflow-state concurrency, kill switches, model budgets, and approval expiry.
- Control-plane and conversation routes require explicit organization and actor headers in this
  local foundation. Core-issued internal authentication is still an open production ADR.
- Verification completed: `pnpm run build` and `AGENTS_DATABASE_URL=... RUN_AGENTS_DB_INTEGRATION_TESTS=true
  pnpm test` in `agents/` (**65 tests passing**). `cargo fmt --check && cargo check -p kasitek-core`
  also pass.
- Not yet claimed: Temporal Cloud recovery, live provider model calls, pgvector/hybrid retrieval,
  provider-specific channel transport, OpenTelemetry export, object storage/Redis, sandboxing,
  production secrets-manager configuration, production authentication rotation, or admin UI.
