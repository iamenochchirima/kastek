# Live Chat operator console rebuild

**Status:** Active

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
- Deployment. The user will decide when to deploy after verification.

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
9. [in_progress] Run targeted tests, full Agent tests, Client lint and build, then record remaining gaps.

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
Platform release version or release ID: pending
API/schema/migration changes: Added authenticated assignment filters and summary fields; added conversation SSE endpoints; migration 109 adds PostgreSQL conversation notification triggers
Feature flag or rollout method: existing customer_handoff_enabled gate; staged organization rollout recommended
Analytics events and success metrics: claim latency, first-human-response latency, delivery failures, retries, queue feed reconnects
Logs, metrics, dashboards, and alerts: structured delivery and stream lifecycle logs; dashboard decision pending
User, API, internal, and operational documentation: customer handoff architecture and Conversations operator guide
Validation evidence: 696 Agent tests pass (86 integration/environment skips); targeted HTTP, repository, notification, and migration tests pass; Agent build, Client TypeScript check, changed-file lint, and Client production build pass. Migration application, provider smoke, and responsive browser checks remain pending.
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

Migration 109 must be applied before the SSE feed can receive database notifications. Provider delivery and browser smoke checks require the deployed Agent API, Client, Core delivery boundary, and channel credentials.
