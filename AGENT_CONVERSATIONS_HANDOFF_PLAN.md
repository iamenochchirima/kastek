# Agent Conversations and Human Handoff Plan

Status: approved for implementation

This plan covers the split between personal and customer-service agents, customer conversation ownership, human handoff, and the live Agent Conversations surface. Analytics reporting remains in `ANALYTICS_PLAN.md` and `ANALYTICS_EXECUTION_PLAN.md`; this plan emits the lifecycle data those documents require.

## Product boundary

- KasiAi remains a protected, system-hosted personal agent.
- Personal agents are private/test assistants and do not expose customer channels or human handoff.
- Customer-service agents can serve customer channels and support human handoff.
- The existing builder type (`general` or `custom`) remains separate from the agent audience.
- External-connected customer-service agents receive the same handoff capability through the MCP/REST boundary; ownership controls still remain in the platform.

## 1. Audience and capability model

- [x] Add `agent_audience`: `personal` or `customer_service`.
- [x] Return organization-scoped Personal and Customer service counts.
- [x] Show those counts in the Agents overview.
- [x] Keep builder type independent from audience.
- [x] Gate hosted customer channels by audience and installation mode; customer-service agents receive the handoff capability by default.
- [x] Ensure KasiAi and personal agents cannot enable customer handoff through UI or API.
- [x] Add migration/backfill rules for existing definitions and installations.

## 2. Agent creation flow

- [x] Ask whether a new agent is Personal or Customer service.
- [x] Keep personal creation focused on private/test use.
- [ ] Show customer-service setup only for customer-service agents.
- [x] Preserve existing general and custom builder paths.
- [ ] Add inline validation and loading/error feedback.

## 3. Template catalog

- [ ] Add audience metadata to templates.
- [ ] Split Personal and Customer service template browsing.
- [ ] Add personal templates other than KasiAi.
- [ ] Add support, FAQ escalation, lead intake, and booking intake customer-service templates.
- [ ] Declare supported channels, handoff support, required connections, capabilities, and setup fields.

## 4. Handoff policy

- [x] Support an explicit customer request for a human through the standard `conversation.request_human` capability.
- [x] Route the configured workflow handoff node through the same handoff action service.
- [x] Record reason code, triggering message, triggering run, agent/version/installation, channel, and timestamps.
- [ ] Define queue, timeout/expiry, eligible claimers, and fallback behavior.
- [ ] Leave confidence, sentiment, business-hours, and advanced routing for a later extension.

## 5. Conversation ownership and state machine

- [ ] Keep Agent Platform transcript ownership and distinguish customer handoff from generic workflow waits.
- [x] Add states: `agent_active`, `handoff_requested`, `human_owned`, `resolved`, `expired`, and `cancelled`.
- [ ] Add an append-only handoff request/history record.
- [x] Add assignment revision/concurrency protection for atomic claims.
- [x] Add atomic claim, continue-with-agent, and resolve transitions behind a shared operator control service.
- [ ] Block agent replies while handoff is pending or human-owned.
- [x] Support Stop response without claiming the conversation.
- [x] Support Take over, Continue with agent, Resolve, and cancellation transitions; expiry remains pending.
- [ ] Continue with agent starts a fresh run from the latest transcript.

## 6. Runtime and API contract

- [x] Register the handoff action in the hosted runtime and MCP/REST capability registry.
- [x] Pause the model loop with an `awaiting_human` control after a successful handoff request.
- [x] Define queue pagination/filter inputs and keep operator mutations on the same repository boundary.
- [x] Expose an organization-scoped handoff queue/detail API with claim, continue-with-agent, and resolve transitions.
- [x] List live conversations with organization-scoped installation, agent, search, and bounded-limit filters; cursor pagination remains pending.
- [ ] Get transcript, participants, active runs, ownership, and handoff history.
- [x] Add atomic claim, pause/stop, resume, human-message, and resolve operations.
- [ ] Add release and expiry operations.
- [ ] Apply organization scope, permissions, idempotency keys, and optimistic concurrency.
- [x] Apply organization scoping and read/write scopes to the operator API; keep handoff creation idempotent and claims transactionally race-safe.
- [x] Emit transactional handoff lifecycle events to `agent_events` for request, claim, human message, continue, and resolve transitions.
- [ ] Emit lifecycle events compatible with the analytics handoff contract.
- [x] Add polling refresh for live and handoff views; realtime updates remain pending.

## 7. Agent Conversations live interface

- [x] Add `/agents/conversations`.
- [x] Add Handoff requests, Human owned, and All views; Agent live remains tied to active-run data.
- [ ] Add agent, channel, status, reason, priority, and search filters.
- [x] Build responsive list/detail navigation for desktop, tablet, and mobile.
- [ ] Show customer, agent, human, and system attribution.
- [x] Add Take over, Continue with agent, Resolve, Stop response, and Send as human controls.
- [ ] Deep-link to filtered conversations from agent details and Inbox projections.

## 8. Existing surfaces and navigation

- [ ] Replace links-only agent conversation cards with live queue links/actions.
- [ ] Keep personal agent chats in the private/test surface.
- [ ] Keep Agent Platform customer transcripts distinct from legacy Inbox ownership.
- [x] Add Agent Conversations to the Automation navigation group.
- [ ] Avoid duplicating handoff controls across surfaces.

## 9. Analytics integration

- [ ] Emit request created, shown, claimed, first human response, human message, released, resolved, expired, and cancelled events.
- [ ] Include organization, agent definition/version/installation, conversation, channel, connection, run, actor, reason, timestamps, and idempotency key.
- [ ] Keep rollups, dimensions, and dashboards in the analytics plan.
- [ ] Add organization and installation isolation tests.

## 10. Permissions, audit, and safety

- [ ] Gate handoff by audience/profile and supported channel.
- [ ] Restrict claim and response actions to authorized workspace members.
- [ ] Make claims race-safe.
- [ ] Audit ownership, pause, release, message, resolve, and expiry transitions.
- [ ] Never expose unauthorized transcript content.

## 11. Migration and rollout

- [ ] Preserve existing KasiAi personal/test conversations.
- [ ] Classify existing hosted channel conversations as customer conversations where supported.
- [ ] Add a customer-handoff feature flag.
- [ ] Roll out profile model, templates, data contract, runtime, APIs, live UI, analytics events, then broader channels.
- [ ] Document rollback behavior.

## 12. Verification and acceptance

- [ ] Personal agents never expose customer channels, handoff, or live-queue controls.
- [ ] Customer-service creation offers correct templates and handoff configuration.
- [ ] A human request pauses automation, blocks agent output, and appears in the queue.
- [ ] Two operators cannot claim the same conversation.
- [ ] Human messages are attributed and delivered correctly.
- [ ] Manual takeover, Stop response, Continue with agent, and Resolve work correctly.
- [ ] KasiAi remains unchanged.
- [ ] Organization isolation, permissions, idempotency, audit, and responsive UI tests pass.

## Approved defaults

- User-facing profiles: **Personal** and **Customer service**.
- Internal field: `agent_audience: personal | customer_service`.
- Live route: `/agents/conversations`.
- Initial channel scope: Agent Platform-hosted customer channels; legacy WhatsApp/Meta bridging follows the stable ownership contract.
- Continue-with-agent resumes the paused workflow when one exists; a fresh-run mode remains a later extension.
- Initial claim permission: authorized workspace members; team routing can follow.
