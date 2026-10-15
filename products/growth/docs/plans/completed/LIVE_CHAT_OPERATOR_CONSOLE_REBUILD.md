# Live Chat operator console rebuild

**Status:** Active — deployed; channel and browser smoke checks remain

**Owner:** Agent Platform and Client

**Last updated:** 2026-09-05

## Objective

Make customer handoffs usable as a real operator inbox. Claiming a request must keep the same
conversation open, replies must expose their delivery state, queue counts must update from events,
and each ownership action must have one clear result.

## Scope

### Included

- Separate unclaimed requests, the current operator's assignments, and other operators' assignments.
- Preserve conversation selection across claim, release, resume-agent, and resolve transitions.
- Show operator messages immediately with sending, sent, delivered, or failed state and safe retry.
- Replace browser polling with a server-sent event feed for customer-conversation changes.
- Simplify the claimed-conversation actions and their labels.
- Add backend contract tests, frontend validation, documentation, and release evidence.

### Excluded

- A general replacement for the Agent Platform event journal.
- New customer channels or provider connection work.
- A broader redesign of the Inbox product outside customer-agent handoffs.
- Production deployment execution beyond the release record.

## Context and constraints

- Agent Platform owns conversations, messages, handoff state, and delivery attempts.
- Core remains the provider-delivery boundary for Website Chat, WhatsApp, Messenger, and Instagram.
- Telegram delivery remains in Agent Platform until its existing adapter boundary changes.
- Provider delivery must remain idempotent and must never create duplicate operator messages on retry.
- Existing unrelated planning changes in the worktree must remain untouched.

## Operator lifecycle

| Action | Meaning | Result |
| --- | --- | --- |
| Take over | Assign the pending request to the current operator. | Keep the conversation open and move it to Mine. |
| Return to queue | Stop handling it without resuming automation. | Remove the assignment and return it to Inbox. |
| Resume agent | End human ownership and let the agent continue. | Close the handoff and return the conversation to agent-owned state. |
| Resolve conversation | Finish the customer conversation without asking the agent to respond now. | Close the handoff and conversation; a later inbound message may start a new active interaction. |
| Send | Send an operator reply. | Add one durable message and expose delivery progress independently of resolution. |

## Implementation plan

1. [x] Add red tests for operator-specific queue ownership, stable claim selection, and delivery failure semantics.
2. [x] Extend the handoff read model with Mine and Team filters derived from the authenticated actor.
3. [x] Add a database-backed Agent event notification feed and organization conversation SSE endpoint.
4. [x] Separate accepted operator messages from provider delivery results and add safe retry for failed attempts.
5. [x] Rebuild the Live Chat page around Inbox, Mine, Team, and All with one stable selected conversation.
6. [x] Put the reply composer below the transcript and show per-message delivery state and retry.
7. [x] Move Return to queue, Resume agent, and Resolve conversation into clear contextual actions.
8. [x] Update handoff architecture, operator documentation, analytics, logs, and release evidence.
9. [x] Run targeted tests, full Agent tests, Client lint and build, then record remaining gaps.

## Verification

- [x] Agent API tests cover authenticated Mine and Team projections.
- [x] Agent API tests cover accepted, sent, failed, and retried human messages without duplicates.
- [x] Event notification tests prove organization filtering, unsubscribe behavior, and durable event fan-out; runtime smoke evidence remains pending deployment.
- [x] Client lint on changed files and production build pass.
- [in_progress] Website Chat and Telegram handoff smoke paths are recorded.
- [in_progress] Desktop, tablet, and mobile operator layouts are checked.

## Release record

```text
Change: Rebuild Live Chat ownership, reply delivery feedback, and real-time updates
Owner: Agent Platform and Client
Risk: high
Affected services and user surfaces: agents API, Agent PostgreSQL schema, client Live Chat, Core channel delivery
Platform release version or release ID: Railway Agents API 2fd28c83-b895-493b-93c5-a15c308e376d; Agents Worker c33c00ab-a8b0-43ce-aa4c-3ba8a4ea98dc; MCP Gateway 5deb004b-ee53-48e5-b97c-50a56a2bab69; Vercel dpl_CTwnUZ9Zm8KxGHedmN4vksLLWMyh
API/schema/migration changes: Added authenticated assignment filters and summary fields; added conversation SSE endpoints; migration 109 adds PostgreSQL conversation notification triggers
Feature flag or rollout method: existing customer_handoff_enabled gate; staged organization rollout recommended
Analytics events and success metrics: claim latency, first-human-response latency, delivery failures, retries, queue feed reconnects
Logs, metrics, dashboards, and alerts: structured delivery and stream lifecycle logs; dashboard decision pending
User, API, internal, and operational documentation: customer handoff architecture and Conversations operator guide
Validation evidence: 696 Agent tests pass (86 integration/environment skips); targeted HTTP, repository, notification, and migration tests pass; Agent build, Client TypeScript check, changed-file lint, and Client production build pass. Railway deployments are healthy, migration 109 applied successfully in one-shot deployment 46c02e7c-77e6-4210-b2c9-ed131a5c3df9, Vercel deployment is READY and aliased to app.kasitek.co.za, and the public MCP Gateway health check returned 200. Provider smoke and responsive browser checks remain pending.
Rollback or disable plan: revert Client surface and API additions; disable customer_handoff_enabled if ownership safety regresses
Post-release review date: pending deployment date
```

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Operator tabs | Inbox, Mine, Team, and All replace ambiguous Live and Assigned tabs. | Product | Decided |
| Delivery | Saving a message and delivering it are separate observable states. | Agent Platform | Decided |
| Realtime | SSE is primary; reconnect reconciliation replaces periodic browser polling. | Agent Platform | Decided |
| Resolution | Resolve closes the interaction; Resume agent explicitly returns control to automation. A later inbound message reopens a resolved customer thread. | Product and Agent Platform | Decided |

## Notes and blockers

Migration 109 is applied and the normal Agents API start command has been restored. Provider delivery and browser smoke checks still require an end-to-end test through the deployed Agent API, Client, Core delivery boundary, and channel credentials.

## Follow-up: Core proxy compatibility

The first Live Chat release exposed two Core boundary gaps and one incomplete proxy query contract:

- The Client connected to `/api/agents/conversations/events/stream`, but Core had only mounted the selected-conversation stream. Core now proxies the organization-scoped Agent Platform feed.
- Operator replies send `Idempotency-Key`; Core CORS now allows that header so the browser preflight reaches the message endpoint.
- Core now forwards `assignment=mine|team` to the Agent Platform instead of silently dropping the filter.

Regression coverage includes the Core route registry, the actual CORS preflight middleware, the organization feed upstream path, and assignment query forwarding. Production verification on 2026-09-05 returned a successful operator-message preflight, an authenticated response rather than `404` for the feed, and a healthy Core response.

Follow-up release record:

```text
Change: Restore Core Live Chat realtime feed proxy, operator-message CORS, and assignment query forwarding
Owner: Agent Platform and Core
Risk: medium
Affected services and user surfaces: Core API, Live Chat operator console
Platform release version or release ID: Railway Core 4258f25e-968a-443f-9d3a-a05a70db4379
API/schema/migration changes: Added the Core organization conversation-feed proxy route; added Idempotency-Key to dashboard CORS; forwarded handoff assignment filters
Feature flag or rollout method: Existing Live Chat surface; no new flag
Analytics events and success metrics: Existing queue feed, message delivery, and reconnect metrics; no new event
Logs, metrics, dashboards, and alerts: Existing Core request correlation and HTTP logs; production preflight and feed checks passed
User, API, internal, and operational documentation: Existing customer handoff architecture and Conversations operator guide remain current
Validation evidence: Core package tests passed (268 passed, 3 ignored), Core binary CORS regression passed, Core build passed, production OPTIONS returned 200 with Idempotency-Key allowed, production feed returned 401 instead of 404 without credentials, and /health returned 200
Rollback or disable plan: Redeploy the previous Core deployment 2d63b490-61e9-466c-9444-c45c0327f3ef if the proxy boundary regresses
Post-release review date: pending browser smoke confirmation
```
