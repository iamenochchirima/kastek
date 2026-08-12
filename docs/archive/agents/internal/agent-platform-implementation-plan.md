---
title: KasiTek Agent Platform Implementation Plan
slug: /architecture/agent-platform-implementation-plan
sidebar_position: 5
---

# KasiTek Agent Platform Implementation Plan

**Status:** Proposed implementation plan
**Owner:** KasiTek engineering
**Last reviewed:** 2026-08-05

## 1. Purpose

KasiTek needs a native agent platform through which direct-product workspaces create and operate customer-facing agents for WhatsApp, Messenger, Instagram, web chat, bookings, lead qualification, and internal workflows. This is the implementation plan for the **Agents** section in the main KasiTek workspace.

The platform must be owned by KasiTek. A customer agent definition, its permissions, its run history, approval decisions, conversation state, knowledge sources, and provider effects must remain KasiTek records. n8n can remain available for internal integration work during the transition, but it must not remain the execution model or source of truth for customer agents.

The direct KasiTek application is the first implementation target. White-label support is not a parallel first-release deliverable in this plan; it is a compatibility constraint: keep ownership and scope explicit now so a tenant implementation can adopt the same contracts later without sharing data or credentials.

This document defines the implementation direction. It is intentionally separate from the [Agent Protocol Implementation Plan](./agent-protocol-implementation-plan.md):

- this document covers customer-created agents and their runtime;
- the protocol plan covers exposing approved business actions to MCP clients and, later, A2A peers;
- both use the same typed action and policy boundary rather than creating two ways to perform product operations.

## 2. Decision summary

KasiTek should build a custom control plane and policy layer, with a Rust-native agent worker and durable workflow execution. It should not wrap n8n, Flowise, Langflow, or Typebot as the core product.

The recommended initial stack is:

| Layer | Decision | Reason |
| --- | --- | --- |
| Product control plane | Custom Rust services and PostgreSQL | Keeps organisation scope, agent definitions, permissions, audit, and commercial rules in KasiTek. |
| LLM and structured tool calls | A small KasiTek model gateway; use Rig selectively for Rust provider/tool primitives | Provider choice, schemas, cost controls, and safety rules stay behind one interface. Rig is a library, not the platform architecture. |
| Durable run execution | Restate evaluated as the default runtime, with the workflow state mirrored in KasiTek PostgreSQL | Rust support, durable steps, signals, timers, retries, and keyed state without writing a workflow engine from scratch. |
| Business actions and provider effects | The existing action-platform design | All reads and writes receive deterministic authorization, idempotency, approval, and audit treatment. |
| Knowledge retrieval | PostgreSQL + pgvector behind a knowledge service | Simple ownership, tenant filtering, document provenance, and fewer data stores at the current scale. |
| Events and delivery | Transactional outbox + worker consumers | No domain change is treated as complete until its event can be delivered and reconciled. |
| Observability | OpenTelemetry traces, structured logs, run ledger, evaluation data | Operators need to answer what the agent saw, decided, called, and changed. |

Restate is an execution dependency, not an agent product dependency. If the evaluation proves it is unsuitable, its adapter can be replaced while the KasiTek run ledger, action contracts, agent definitions, and UI remain unchanged.

## 3. Non-negotiable rules

1. The model is not an authority boundary. It may select from already permitted tools and draft output. It does not decide organisation access, role access, approvals, billing access, or provider credentials.
2. Every tool call goes through a typed action contract. No agent has direct SQL, arbitrary HTTP, shell, or provider-token access.
3. Every request is scoped before retrieval to the direct KasiTek organisation, workspace, actor, and applicable customer record.
4. Agent state and customer content are data, not instructions. Retrieved documents, conversation text, attachments, and tool results are marked untrusted before being placed in model context.
5. External effects use idempotency keys, durable records, and reconciliation. “Exactly once” means once per KasiTek logical effect; external providers can still have unknown outcomes that must be reconciled.
6. High-risk work requires human approval. Approval is bound to the exact action, target, payload hash, actor scope, and expiry.
7. A manager agent delegates to narrow specialists as tools. The customer-facing agent retains ownership of the conversation unless a real handoff is required.
8. Future white-label support retains separate databases and identity boundaries. Shared code may share contracts, never authoritative records or database connections.
9. No agent, tool, connector, or prompt is enabled merely because it was configured. It must be versioned, validated, published, and authorised.
10. Build the smallest vertical slice first. Do not build a generic visual canvas before templates, policy, durable runs, and operator controls work in production-like conditions.

## 4. What users will create

The first UI should be template-led. Users should configure a constrained agent rather than assemble arbitrary nodes.

| First templates | Primary channels | Initial responsibilities |
| --- | --- | --- |
| Inbox assistant | WhatsApp, Messenger, Instagram, web chat | Answer known questions, collect intent, create a lead, hand off to a team member. |
| Website lead assistant | Website chat | Qualify a lead, capture contact details with consent, create a follow-up task. |
| Booking assistant | Website chat, WhatsApp | Explain availability, propose slots, request or create bookings through approved actions. |
| FAQ / knowledge assistant | Website chat, social inbox | Answer only from selected knowledge sources and cite those sources internally. |
| Follow-up assistant | Internal trigger / approved channels | Draft or schedule approved follow-ups; never send outside its policy. |
| Internal operations assistant | Internal UI only | Find customer context, summarise conversations, draft work for a human to review. |

Template configuration should include only decisions that matter:

- name, purpose, avatar, language and tone;
- enabled channels and connected accounts;
- knowledge sources;
- allowed actions and approval policy;
- business hours, handoff rules, fallback response, and assigned team;
- model policy and spend limits;
- publication status.

The advanced workflow editor comes later. It will compile a typed workflow specification into the same runtime rather than storing a third-party workflow export.

## 5. Target architecture

```text
Provider webhooks / web chat / scheduled trigger / internal user
                              |
                              v
                     Channel and trigger gateway
                              |
          verified event + runtime scope + correlation identifier
                              |
                              v
                       Agent dispatcher
                              |
                 Agent version and channel policy lookup
                              |
                              v
                 Durable AgentRun workflow (Restate adapter)
                              |
      +-----------------------+-------------------------+
      |                       |                         |
      v                       v                         v
 Context assembler       Model gateway            Human handoff / approval
 (conversation,          (routing, structured           |
 knowledge, policy)       output, usage)                 |
      |                       |                         |
      +-----------------------+-------------------------+
                              |
                              v
                    Tool proposal / response plan
                              |
                              v
                  Action invocation and policy gateway
                              |
             grants + entitlement + approval + idempotency
                              |
                              v
          domain services / provider adapters / outbox events
                              |
                              v
                  run ledger + audit + trace + evaluation
```

The dispatcher is thin. It validates the ingress event, resolves a single agent version for the channel/account, creates or deduplicates a run, and hands work to the durable runner. It must return webhook acknowledgements quickly; provider retry handling cannot depend on model latency.

### 5.1 Services and ownership

| Component | Responsibility | Must not do |
| --- | --- | --- |
| `agent-control` | Create, validate, version, publish, pause, and retire definitions. | Execute a model turn or call a provider directly. |
| `agent-dispatcher` | Resolve inbound event to an agent and start/deduplicate a run. | Infer tenancy from a provider payload without a connection mapping. |
| `agent-runner` | Execute one durable state machine, assemble context, ask models, request tools, and resume after signals. | Bypass the action/policy layer. |
| `model-gateway` | Model routing, request shaping, structured output validation, usage/cost records, safety checks. | Hold tenant-wide business permissions. |
| `knowledge-service` | Ingest, classify, index, retrieve, cite, and delete source content. | Treat retrieved content as trusted instructions. |
| `action gateway` | Deterministic authorization, approvals, idempotency, effects, and audit. | Let transport or model prompts choose access. |
| `channel adapters` | Map provider payloads to canonical messages and send approved outbound messages. | Store provider credentials in run context or prompts. |
| `operator console` | Run inspection, approvals, replay, pause, policy changes, and evaluation review. | Mutate completed audit history. |

For the first release these modules live in `server/kasitek-core`. A later white-label implementation can use the same pure contracts in `server/kasitek-tenants`, against its own database and identity system. A shared crate may hold types and validation only.

## 6. Core data model

Use immutable versioned definitions and append-only records for decisions and external effects. Every primary key and index begins with the owning scope where that improves isolation and query planning.

```text
agent_definitions
  id, organisation_id, workspace_id
  display_name, template_key, status, current_version_id
  created_by, created_at, archived_at

agent_versions
  id, agent_id, version_number, state (draft|published|retired)
  config_json, instruction_set_id, model_policy_id, policy_snapshot_id
  checksum, created_by, published_at

agent_channel_bindings
  id, agent_version_id, connection_id, channel, provider_account_id
  inbound_enabled, outbound_enabled, priority, business_hours_policy_id

agent_tool_bindings
  id, agent_version_id, action_name, action_version
  mode (read|draft|controlled_write), approval_policy_id, enabled

agent_knowledge_bindings
  id, agent_version_id, knowledge_collection_id, retrieval_policy

agent_runs
  id, runtime scope, agent_id, agent_version_id, trigger_type
  conversation_id, initiating_event_id, status, correlation_id
  model_policy_snapshot, cost_snapshot, started_at, completed_at

agent_run_steps
  id, run_id, sequence, kind, state, input_redaction_ref, output_redaction_ref
  started_at, finished_at, retry_count

agent_tool_calls
  id, run_id, step_id, action_name, action_version, request_hash
  decision, approval_id, idempotency_key, result_code, effect_id

agent_memories
  id, scope, subject_id, memory_type, source, content_ref, confidence
  expires_at, review_state, created_at

knowledge_documents / knowledge_chunks / knowledge_ingestions
  scope, source metadata, classification, content reference, embedding, retention

agent_evaluations / agent_feedback
  run_id, rubric version, result, labels, human review, created_at
```

`config_json` is permitted only after schema validation. Important policy values are also denormalised into queryable columns where needed for operations, reporting, and enforcement.

## 7. Run state machine

```text
received
  -> queued
  -> running
  -> awaiting_tool
  -> awaiting_approval | awaiting_human | awaiting_external_event
  -> running
  -> completed | failed | cancelled | expired
```

Rules:

- terminal states are immutable;
- a retry creates a new attempt record, not an edited history;
- the inbound provider event identifier is unique within a connection;
- each external provider effect has its own idempotency key and reconciliation status;
- retries are classified: transient provider failure, model timeout, validation failure, policy denial, and unknown effect are different paths;
- cancellation stops future steps. Compensation is explicit and action-specific; it is never an automatic reverse of arbitrary provider work.

## 8. Model gateway and multi-agent design

### 8.1 Model gateway contract

The runner calls a single internal model interface:

```text
generate_turn(
  run_context,
  instruction_bundle,
  trusted_policy_context,
  untrusted_customer_content,
  available_tool_schemas,
  response_schema,
  model_policy
) -> structured_response | retryable_error | terminal_error
```

The gateway must:

- choose a model only from the versioned model policy;
- validate structured output before it reaches the runner;
- enforce request, token, tool-call, wall-clock, and monetary limits;
- record provider/model/version, token use, latency, cache status, and cost;
- redact sensitive content from normal logs while retaining controlled audit references;
- support provider fallback only when the response schema and data-residency policy allow it;
- never send credentials, private keys, raw connection secrets, or unbounded tenant data to a model.

Use a provider abstraction so OpenAI, Anthropic, Google, OpenRouter, or a self-hosted model can be added without changing agent definitions. Start with the providers already contractually acceptable to KasiTek; do not add providers just because a framework supports them.

### 8.2 Multi-agent rule

Start with one customer-facing agent per conversation. A coordinator may call specialised agents as internal tools and receive structured results:

```text
inbox assistant
  -> knowledge specialist: answer evidence + citations
  -> booking specialist: availability options only
  -> lead specialist: structured qualification fields
  -> human handoff: queue assignment and context summary
```

Use a true handoff only when another actor owns the next interaction: a human teammate, a different regulated workflow, or a separately authorised specialist. Do not create open-ended peer conversations, unrestricted recursive delegation, or a group-chat of agents.

Initial limits:

- delegation depth: one;
- maximum specialist calls per turn: two;
- every specialist has a narrower tool set than its coordinator;
- specialists return schema-validated data, never provider credentials or raw hidden reasoning;
- the coordinator is accountable for the customer-visible answer.

## 9. Context, memory, and knowledge

### 9.1 Context categories

| Category | Examples | Handling |
| --- | --- | --- |
| Trusted policy context | active agent version, scope, tool contracts, business hours, approval state | Generated server-side; never sourced from customer content. |
| Customer conversation | messages, reactions, attachments, channel metadata | Untrusted; bounded window and channel-aware formatting. |
| Knowledge retrieval | approved FAQs, services, documents, website extracts | Untrusted evidence with source provenance; not executable instructions. |
| Operational state | booking availability, lead status, order state | Retrieved through typed read actions, not embedded as broad database exports. |
| Long-term memory | consented preferences, unresolved issue, interaction summary | Typed, scoped, reviewed/expiring; never append raw model guesses as fact. |

### 9.2 Knowledge ingestion standard

1. A source is connected by a scoped actor and classified before ingestion.
2. Fetching, parsing, malware scanning, text extraction, chunking, embedding, and indexing are separate durable steps.
3. Every chunk retains source, owner scope, document revision, classification, and retention metadata.
4. Retrieval filters by runtime and owning organisation/tenant/workspace before vector ranking.
5. The answer builder includes source references internally; unsupported claims must fall back to clarification or handoff.
6. Source deletion creates an outbox event that removes or tombstones all derived chunks and memories.

Do not implement autonomous website crawling in the first release. Start with explicit URL/document uploads and a bounded crawl policy after security review.

## 10. Tool, permission, and approval model

The agent UI exposes useful tasks; the server translates those tasks into typed actions from the existing action-platform design.

| Risk class | Examples | Default behaviour |
| --- | --- | --- |
| Read | Find booking availability, search contacts, get conversation summary | Allowed only with scope and entitlement. |
| Draft | Draft reply, draft follow-up, propose booking options | Allowed; human or agent may present the result. |
| Controlled write | Create lead, tag conversation, create booking hold | Explicit tenant policy; idempotency required. |
| External effect | Send message, publish post, confirm booking, charge/payment request | Exact target and payload preview; approval by default until each template is proven safe. |
| Privileged | Change access, credentials, billing, mass export/delete | Not agent-callable in initial releases. |

Tool availability is the intersection of:

```text
agent version binding
  ∩ actor/team permission
  ∩ runtime + tenant/workspace scope
  ∩ product entitlement
  ∩ connection capability
  ∩ operational kill switch
  ∩ action risk and approval policy
```

The final action gateway repeats this calculation immediately before execution. A model’s tool proposal is not a permission grant.

## 11. Security baseline

Prompt injection, excessive agency, indirect instructions in documents, and poisoned long-term memory are normal design threats, not exceptional edge cases. OWASP specifically recommends strict schemas, least-privilege tool access, external enforcement, and human approval for high-risk actions; its guidance also notes that retrieval and fine-tuning do not eliminate prompt injection risk.

Required controls:

- strict JSON Schema input and output validation for every tool and specialist result;
- deterministic server-side authorisation and field-level scope checks;
- allowlisted tool contracts rather than arbitrary URL, SQL, code, or shell tools;
- trust labels separating policy, provider output, customer text, attachments, and retrieved content;
- attachment scanning and media access through signed/scoped endpoints;
- per-agent, per-connection, per-workspace, per-model, and per-action rate/cost limits;
- explicit approval for send, publish, booking confirmation, and similar effects until a policy says otherwise;
- content and tool-call redaction in standard logs; protected audit references for investigations;
- revocation and kill switches that take effect before the next model or action step;
- adversarial test corpus for direct injection, indirect injection, data exfiltration, cross-tenant references, and tool misuse;
- data retention, deletion, export, and consent behaviour documented per channel and tenant contract.

Prompts are not secrets and must not contain credentials, connection strings, role maps, or security policy that only code can enforce.

## 12. Reliability, scale, and operations

### 12.1 Required operational behaviour

- Webhooks are verified and durably recorded before asynchronous processing.
- The UI receives run and conversation updates from the outbox/realtime stream; it must not poll full inbox datasets every few seconds.
- Agent runs are partitionable by runtime and workspace/organisation. A hot tenant must not block another tenant.
- Workers are horizontally scalable and stateless between durable steps.
- Provider sends/publishes are reconciled when a timeout leaves an unknown outcome.
- Each deployment supports graceful draining: stop claiming new work, finish or checkpoint active steps, then exit.
- Backpressure is explicit: channel-level queue depth, model concurrency, retrieval concurrency, and provider rate limits are monitored and can reject/defer work safely.

### 12.2 Initial service-level objectives

These are targets to measure, not promises before production evidence:

| Measure | Initial target |
| --- | --- |
| Verified webhook acknowledgement | p95 under 500 ms, excluding provider network delivery time |
| First agent response for simple no-tool turn | p95 under 8 seconds, measured by channel capability |
| Duplicate inbound event processing | 0 duplicate logical messages/effects |
| Run recovery after worker failure | resumes from last durable step without lost work |
| Action denial due to missing scope | fail closed with auditable reason code |
| Traceability | every outbound effect linked to run, action, provider reference, and correlation ID |

### 12.3 Operator controls

Before broad customer access, implement:

- run timeline: trigger, context retrieval, model turn, tool proposal, policy decision, provider effect, result;
- safe replay, retry, cancel, pause, and resume controls;
- per-agent and per-connection health, latency, cost, and error views;
- approval inbox with effect preview and expiry;
- feature flags and kill switches by agent, action, connection, workspace, tenant, and model provider;
- dead-letter queue with reviewed replay path;
- audit search by correlation ID, conversation, effect, actor, and agent version;
- evaluation dashboard separate from customer transcript data.

## 13. Delivery plan

### Phase 0 — Confirm constraints and prepare the direct-product seam

- [ ] Audit the current `services/agents` n8n provisioning path, deployed workflows, ingress routes, and data currently relied on by the agents UI.
- [ ] Adopt the action-platform contracts as the only write path for agent effects.
- [ ] Record ADRs for Restate adoption, model providers, data residency, model retention, and initial approval defaults.
- [ ] Keep future white-label boundaries documented; do not merge its database or auth into the direct product.
- [ ] Add a feature flag that selects `legacy_n8n` or `native_runtime` per agent version.
- [ ] Define the first two templates: website lead assistant and inbox assistant.

**Exit gate:** existing agents continue to be observable; no new n8n workflow is created once the native pilot is enabled.

### Phase 1 — Control plane and versioning

- [ ] Add migrations for definitions, immutable versions, channel bindings, tool bindings, knowledge bindings, model policies, and agent lifecycle audit.
- [ ] Implement create/edit/validate/publish/pause/retire APIs.
- [ ] Publish only schema-valid versions with explicit channels, tools, and limits.
- [ ] Build template-led UI; no generic workflow canvas.
- [ ] Import existing agent records as paused or legacy-managed records, not as guessed native definitions.

**Exit gate:** a workspace can publish a paused native agent version with no runtime execution yet.

### Phase 2 — Native inbound run vertical slice

- [ ] Create canonical trigger/event types for website chat and one existing social inbox channel.
- [ ] Implement the dispatcher, durable run creation, run ledger, and idempotent inbound event handling.
- [ ] Implement one no-tool model response and one read-only knowledge retrieval path.
- [ ] Emit run lifecycle events through the existing outbox/realtime infrastructure.
- [ ] Add run timeline and operator pause/kill controls.

**Exit gate:** a single inbound message produces exactly one scoped run, a traceable response, and an operator-visible timeline after worker restart.

### Phase 3 — Typed tools, handoff, and approvals

- [ ] Implement the first action catalogue: `conversation.get_summary`, `customer.search`, `lead.create_draft`, and `conversation.draft_reply`.
- [ ] Add human handoff with assignment, generated summary, and a hard stop on agent sending.
- [ ] Add approval records and one approved external action: `conversation.send_message` on one supported channel.
- [ ] Add provider-effect records, idempotency, retry classification, and reconciliation.
- [ ] Add test fixtures for policy denial, duplicate webhooks, provider timeout, approval expiry, and restart recovery.

**Exit gate:** the inbox assistant can answer from approved knowledge, create a lead draft, or hand off. It cannot make an unapproved provider effect.

### Phase 4 — Knowledge and booking

- [ ] Implement scoped document/URL ingestion, source provenance, delete/reindex lifecycle, and retrieval quality checks.
- [ ] Implement booking availability and booking-hold read/write actions.
- [ ] Add booking assistant template with approval/confirmation policy.
- [ ] Add evaluated answer citations and no-answer/handoff fallback.

**Exit gate:** a booking workflow survives a restart, prevents duplicate holds, and explains why it cannot perform a forbidden action.

### Phase 5 — Multi-channel and specialist agents

- [ ] Add channel bindings for WhatsApp, Messenger, Instagram, and web chat using their existing canonical message layer.
- [ ] Add the narrow knowledge, lead, and booking specialists as structured internal tools.
- [ ] Add per-channel capability differences to action policy rather than hiding them in prompts.
- [ ] Add model fallback policy, quotas, cost budget alerts, and channel-specific response constraints.

**Exit gate:** a template behaves consistently across supported channels while respecting each provider’s feature limits.

### Phase 6 — Evaluations, controlled rollout, and n8n retirement

- [ ] Build representative evaluation sets by template and channel: normal conversations, provider errors, multilingual use, abuse, prompt injection, and tool boundary tests.
- [ ] Score response quality, grounding, correct handoff, policy compliance, tool selection, latency, and cost.
- [ ] Run shadow mode: native agent plans/actions are recorded but no external effect occurs.
- [ ] Run limited workspace pilots with explicit rollback.
- [ ] Migrate eligible legacy agents to explicit native versions.
- [ ] Remove the n8n provisioning path, workflow IDs, and old templates once every supported legacy path has a native replacement or a documented retirement decision.

**Exit gate:** native runtime is the only customer-agent execution path. No production decision depends on an n8n workflow export.

### Phase 7 — Advanced builder and external protocols

- [ ] Introduce an advanced editor only after templates, policy, evaluations, and operations show a real need.
- [ ] Compile editor output to a versioned typed specification; reject arbitrary code and unbounded loops.
- [ ] Expose MCP read/draft actions only through the separate protocol plan’s readiness gates.
- [ ] Consider A2A only when an independent partner-agent use case requires it.

## 14. Testing standard

Every phase requires the following test categories before a wider rollout:

- unit tests for definition validation, state transitions, schemas, and policy calculations;
- integration tests against the direct KasiTek database and scope rules;
- provider contract tests using recorded/sanitised webhook and API fixtures;
- durability tests: restart between every critical run step;
- idempotency and race tests for duplicate inbound events and duplicate send/publish requests;
- security tests for cross-tenant IDs, forged scope, prompt injection, poisoned retrieval, malicious attachments, and approval replay;
- load tests for queue backlog, model concurrency, provider rate limits, and one noisy workspace;
- end-to-end tests for each shipped template and supported channel;
- human review of evaluation failures before any autonomous external action is enabled.

## 15. Explicit non-goals for the first native release

- a general node-canvas workflow builder;
- autonomous browser use, arbitrary web fetching, arbitrary code execution, or direct database querying;
- agent-controlled billing, access management, credential management, bulk deletion, or bulk export;
- unbounded recursive/multi-agent delegation;
- automatic long-term memory inferred from raw conversations;
- changing the future white-label architecture or sharing its database with the direct product.
- claiming end-to-end encryption for conversations where channel providers or model processing make that impossible.

## 16. Open decisions to resolve before Phase 1

| Decision | Recommendation | Required owner decision |
| --- | --- | --- |
| Durable runtime | Run a Restate technical spike against the existing Rust service and Railway/deployment target. Keep an adapter boundary. | Approve or reject after spike results. |
| Initial model provider | Use the current approved provider path behind `model-gateway`; add providers by policy, not per agent. | Confirm data-processing and cost constraints. |
| Knowledge storage | PostgreSQL + pgvector initially. | Confirm attachment/document retention and deletion obligations. |
| Default send policy | Human approval for all external sends in the first pilot, then per-template opt-in after evaluation evidence. | Confirm acceptable autonomy by channel/use case. |
| Website widget | Use the existing client/runtime boundary; give every widget request a signed workspace/agent binding. | Confirm product design and embed domains. |
| n8n end date | Retire customer-facing provisioning after native templates cover the supported paths. | Set a migration window after Phase 3 pilot. |

## 17. References used to refine this plan

- [Restate durable execution and Rust support](https://docs.restate.dev/) — durable steps, state, reliable communication, timers, and workflows.
- [Restate workflow model](https://docs.restate.dev/foundations/services) — use keyed stateful objects for agents and workflows for multi-step work requiring interaction.
- [OpenAI Agents SDK: multi-agent orchestration](https://openai.github.io/openai-agents-js/guides/multi-agent/) — manager-as-tools versus explicit handoffs; KasiTek should default to the former.
- [LangGraph persistence](https://langchain-ai.github.io/langgraph/concepts/persistence/) — durable checkpoints and thread state are useful patterns, but not a reason to make a Python framework the KasiTek core.
- [OWASP prompt injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) — retrieval/fine-tuning do not eliminate injection risk; restrict tools and validate output deterministically.
- [OWASP excessive agency guidance](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) — preserve least privilege, per-user scope, and human review for high-risk actions.
