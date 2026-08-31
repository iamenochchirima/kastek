# Agent Handoff Consent and Escalation Plan

**Status:** Deployed; production channel acceptance pending

**Owner:** Platform

**Last updated:** 2026-08-31

## Objective

Make human handoff safe, deterministic, and consistent for every customer-service agent and
supported channel. An agent may offer a human when it cannot help, but a handoff request must be
created only after either an explicit customer request or an affirmative customer response to the
offer.

Success means that an agent cannot silently move a customer into the human queue, ownership changes
are server-enforced and auditable, and website, WhatsApp, Messenger, Instagram, Telegram, Discord,
hosted, and external-connected agents follow the same contract.

## Scope

### Included

- A shared handoff-consent contract owned by Agent Platform.
- Direct customer requests for a human.
- Agent offers followed by explicit customer confirmation or decline.
- Deterministic confirmation handling with an ambiguous outcome that never changes ownership.
- Durable offer, consent, request, assignment, release, resolution, expiry, and cancellation history.
- One handoff module used by hosted agents, workflows, MCP/REST agents, and all channel adapters.
- Provider-neutral inbound routing before a new agent run is started.
- Queue semantics where Handoff Requests contains only confirmed requests and Assigned contains
  operator-claimed conversations.
- Idempotency, transaction locking, authorization, audit, analytics, structured logs, and rollout
  controls.

### Excluded

- Automatic handoff solely because an agent is uncertain, lacks knowledge, detects sentiment, or
  labels a request `policy_required`.
- Automatic transfer based only on model-supplied tool arguments or a free-form `customerMessage`.
- Personal-agent handoff or customer channels for personal agents.
- Provider-specific handoff rules implemented independently in Meta, WhatsApp, website, Telegram, or
  Discord adapters.
- Emergency, regulated, or business-specific mandatory-transfer overrides. These require a separate
  approved policy extension after the default consent path is stable.

## Context and constraints

### Current implementation finding

The existing `conversation.request_human` action is both a model-facing capability and a committed
ownership transition. It accepts `customer_requested`, `agent_uncertain`, `policy_required`,
`high_value`, and `configured_workflow` without requiring customer evidence, has
`requiresApproval: false`, creates `agent_handoff_requests`, changes `conversations.handoff_state`
to `handoff_requested`, and pauses automation. A configured workflow `handoff` node reaches the same
action path. This is why an agent can turn an unanswered question into a handoff without customer
agreement.

### Existing platform boundaries

- Agent Platform owns customer conversation ownership and handoff state.
- Core and channel adapters own provider authentication, inbound normalization, and outbound
  delivery, but must not decide ownership.
- Customer-service agents are already separated from personal agents by `agent_audience`.
- Existing handoff states are `agent_active`, `handoff_requested`, `human_owned`, `resolved`,
  `expired`, and `cancelled`.
- Existing operator controls, optimistic concurrency, idempotency, history, analytics events, and
  Agent Conversations queue are reusable foundations.
- The current Live view is based on customer activity and `agent_active` ownership. A pending
  customer confirmation therefore remains Live and must not enter Handoff Requests.

### Product language

- **Handoff offer:** The agent says a person can help and asks the customer whether to connect them.
- **Handoff request:** The customer has explicitly requested or accepted a human; the item may enter
  the operator queue.
- **Assigned:** An authorized operator has claimed the confirmed request.
- **Resolved:** The human interaction is closed, with a recorded outcome.
- **Customer consent:** A trusted inbound customer message or structured customer action that
  authorizes the transition to `handoff_requested`.

## Canonical behavior

### Decision rules

1. A clear direct customer request for a person is customer consent. It may create a handoff request
   immediately, subject to the installation and authorization checks.
2. If the agent cannot help, it may offer a handoff. The offer must not create a queue item, pause
   ownership, or suppress normal agent operation.
3. Only an affirmative response to a pending offer may convert that offer into a handoff request.
4. A negative response returns the conversation to ordinary agent handling.
5. An ambiguous response never creates a handoff. The agent may ask the confirmation question again
   within bounded retry and expiry limits.
6. A pending offer expires without changing ownership.
7. `agent_uncertain`, `policy_required`, `high_value`, and `configured_workflow` are internal reasons
   for an offer unless a separately approved mandatory policy exists.
8. The server, not the model, decides whether a direct request or confirmation is valid. Model output
   may propose an offer but cannot assert that the customer consented.

### Ownership state flow

```text
agent_active
    │
    ├─ agent offers a human
    │       ↓
    │  pending customer confirmation
    │       ├─ affirmative → handoff_requested → human_owned
    │       ├─ negative    → agent_active
    │       ├─ ambiguous   → pending confirmation or bounded re-prompt
    │       └─ timeout     → agent_active
    │
    └─ customer explicitly requests a human
            ↓
       handoff_requested → human_owned
```

The pending confirmation state should be represented by a durable offer record, not by
`conversations.handoff_state`. The conversation remains `agent_active` until consent is accepted.

## Architecture and module interface

### Shared handoff module

Create one deep `ConversationHandoff` module at the Agent Platform seam. Its implementation owns
state transitions, source-message validation, policy checks, idempotency, transactions, events,
expiry, and audit. Callers should not write `handoff_state` or `agent_handoff_requests` directly.

The small interface should expose these operations:

```text
offerHandoff(agent context, reason, summary, source run)
decideInbound(trusted inbound message, pending offer or direct intent)
expireOffer(offer)
claimHandoff(operator)
releaseHandoff(operator)
continueWithAgent(operator)
resolveHandoff(operator)
```

`offerHandoff` is non-blocking and returns an offer identifier. `acceptCustomerHandoff` is the only
normal path that creates `agent_handoff_requests` and changes ownership to `handoff_requested`.
Existing operator operations remain behind the same module.

### Model-facing capability

Replace the current model-facing committed action with a non-committing `conversation.offer_handoff`
capability:

- accepts a bounded reason and summary;
- records an offer with the current run and conversation context;
- returns `continue`, not `awaiting_human`;
- cannot set `handoff_state`;
- cannot provide customer consent through a boolean or free-form evidence field;
- is rate-limited and idempotent per conversation, run, and offer window.

The server-side direct-customer-intent path may create a handoff without an offer when the trusted
inbound message contains a clear human request. External-connected agents use the same guarded
platform capability and cannot bypass this distinction through MCP or REST.

### Deterministic customer intent

Normalize every inbound customer event into one of:

- `request_human`
- `confirm_handoff`
- `decline_handoff`
- `other`
- `ambiguous`

Prefer structured customer actions, such as a website confirmation button, where the channel
supports them. Text handling uses a strict, versioned phrase/intent interpreter with an explicit
ambiguous fallback. It must be conservative: uncertain text stays non-mutating. The general agent
model must not be the authorization source for this decision.

## Data and event design

### Durable offer record

Add a migration for a dedicated `agent_handoff_offers` record containing, at minimum:

- organization, installation, agent definition/version, conversation, and source run;
- offer reason and bounded summary;
- offer status: `pending`, `accepted`, `declined`, `expired`, or `cancelled`;
- source offer message/run identifiers and the customer decision message identifier;
- policy revision, idempotency key, created time, decision time, and expiry time.

Keep `conversations.handoff_state` as the ownership projection. Do not add a customer-confirmation
state to that column unless implementation proves a separate projection cannot support recovery.

### Handoff request evidence

Extend confirmed handoff records with explicit provenance where needed:

- request source: `customer_direct`, `customer_confirmed`, or approved mandatory policy;
- source inbound message ID;
- originating offer ID when applicable;
- confirmation message ID and consent timestamp;
- policy revision and classifier revision;
- bounded reason and summary.

Never use a model-provided message body as proof of consent. Store identifiers and bounded metadata;
avoid copying unnecessary message content into audit or analytics payloads.

### Lifecycle events

Emit transactional, organization-scoped events for:

- `conversation.handoff.offer_created`
- `conversation.handoff.offer_accepted`
- `conversation.handoff.offer_declined`
- `conversation.handoff.offer_expired`
- `conversation.handoff.requested`
- existing claim, release, human-message, continue, resolve, expiry, and cancellation events

Analytics and logs must distinguish offers from confirmed requests. An offer is not a queue request,
not an assignment, and not a human-owned conversation.

## Inbound and runtime sequencing

Every channel adapter must submit a trusted normalized inbound event. Agent Platform processes it in
this order:

```text
Authenticate and normalize provider event
        ↓
Persist/deduplicate inbound message
        ↓
Evaluate direct human intent or pending offer decision
        ↓
If confirmed: create handoff and do not start agent automation
If declined/other: continue normal agent routing
```

This sequencing applies to website, WhatsApp, Messenger, Instagram, Telegram, Discord, hosted
agents, and external-connected agents. Provider adapters must not implement a second confirmation
protocol.

For an agent-initiated offer, the run may complete after sending the confirmation question. If a
workflow must wait for the customer reply, it uses a customer-confirmation external event while the
conversation remains `agent_active`; it must not use `awaiting_human` or create a queue request.

## Workflow and agent policy

- Add an `offer_handoff` workflow node that records an offer and waits for a customer decision.
- Reserve the existing committed handoff behavior for a separately configured mandatory policy,
  which is out of scope for the default release.
- Add per-installation handoff settings for enablement, allowed offer reasons, confirmation expiry,
  maximum re-prompts, and supported structured actions.
- Store the policy revision on each offer and confirmed request.
- Keep the customer-service audience gate and the existing feature flag; add a consent-protocol
  revision flag for gradual rollout.

## Operator and customer surfaces

- Handoff Requests shows only confirmed, pending requests.
- Assigned shows only claimed human-owned conversations.
- Live includes active agent conversations, including those awaiting customer confirmation.
- Conversation detail shows whether the request came from a direct customer request or an accepted
  offer, with timestamps and safe source identifiers.
- An offer awaiting customer confirmation may be shown as a non-queue status, but it must not inflate
  Handoff Requests or Assigned counts.
- Existing claim, release, continue, resolve, and human-message controls remain available through
  the shared handoff module.

## Implementation checklist

### Contract and regression seam

- [x] Add a red-capable regression test for the reported case: an agent cannot answer a location
      question, offers a human, and does not create a handoff before the customer agrees.
- [x] Define the canonical `HandoffIntent`, offer, consent, and request types.
- [x] Define the versioned deterministic phrase/structured-action interpreter and ambiguous fallback.
- [x] Document direct customer requests as consent and agent-initiated offers as non-committing.
- [x] Reopen or supersede the handoff-policy items in
      `AGENT_CONVERSATIONS_HANDOFF_PLAN.md` that currently treat model/workflow handoff as complete.

### Data model and migration

- [x] Add the durable handoff-offer migration with organization and conversation indexes.
- [x] Add offer status, expiry, and decision provenance constraints.
- [x] Extend confirmed requests with source and consent provenance.
- [x] Add idempotency constraints for repeated provider deliveries, repeated confirmations, and
      duplicate model offers.
- [x] Define recovery for offers and requests interrupted during a transaction or deployment.
- [x] Inventory existing pending/claimed requests without consent evidence; do not silently convert
      or delete them. Provide an explicit operator recovery path.

### Shared handoff module

- [x] Extract offer, accept, decline, expiry, and confirmed-request transitions into one module.
- [x] Validate that source messages belong to the organization, installation, conversation, and
      active customer-service agent context.
- [x] Lock the conversation during consent and request transitions.
- [x] Prevent a new agent run from starting after a confirmed handoff.
- [x] Prevent agent replies after `handoff_requested` or `human_owned`.
- [x] Preserve the existing race-safe operator claim and resolution behavior.
- [x] Reject direct application-level request attempts that omit trusted consent provenance.

### Agent runtime and workflows

- [x] Replace or restrict `conversation.request_human` so the model cannot commit a handoff directly.
- [x] Add non-blocking `conversation.offer_handoff` behavior.
- [x] Ensure `agent_uncertain`, `policy_required`, `high_value`, and `configured_workflow` produce
      offers unless an approved mandatory policy explicitly applies.
- [x] Add `offer_handoff` workflow support and prevent the existing workflow node from bypassing
      customer consent.
- [x] Keep offer confirmation separate from Temporal `awaiting_human`.
- [x] Add bounded offer expiry; re-prompt retry policy remains deferred.

### Channel and inbound processing

- [x] Normalize trusted inbound message IDs, channel type, binding, and customer identity for every
      supported adapter.
- [x] Evaluate direct human intent and pending-offer decisions before starting an agent run.
- [ ] Add website structured confirmation actions where the widget supports them.
- [x] Add conservative text confirmation handling for channels without structured actions.
- [x] Ensure Messenger, Instagram, WhatsApp, Telegram, Discord, and website paths share the same
      Agent Platform decision service.
- [ ] Verify outbound confirmation, handoff acknowledgement, and human routing delivery behavior.

### Operator UI and API

- [x] Update API contracts to expose consent provenance without exposing sensitive
      message bodies or credentials.
- [x] Keep Handoff Requests and Assigned counts limited to their intended states.
- [ ] Show a clear non-queue pending-confirmation state when needed.
- [x] Show direct-request versus accepted-offer origin in conversation detail.
- [x] Keep all operator mutations authorized, idempotent, and concurrency-safe.
- [x] Update customer-facing and internal documentation for the new handoff behavior.

### Verification

- [x] Unit-test the deterministic intent interpreter with direct requests, affirmative replies,
      negative replies, ambiguous text, unrelated messages, and prompt-injection-like content.
- [x] Test offer creation does not change conversation ownership or queue counts.
- [x] Test affirmative acceptance creates exactly one request and pauses automation.
- [x] Test decline and expiry return to ordinary agent handling.
- [x] Test duplicate inbound events and duplicate confirmations are harmless.
- [x] Test operator claim races, release, continue-with-agent, resolve, and stale requests through
      the existing handoff repository suite.
- [x] Test hosted, workflow, MCP/REST, and supported channel adapters through the shared seam where
      existing contract tests cover those boundaries.
- [x] Run Agent lint, typecheck, targeted tests, full tests, Core checks, and client checks.
- [ ] Run end-to-end channel smoke tests on a dedicated test agent/channel without contacting
      customer traffic.

### Rollout and operations

- [x] Use the existing organization/installation-scoped `customer_handoff_enabled` rollout flag.
- [ ] Roll out to a dedicated test agent and test channel first.
- [ ] Monitor offer-to-acceptance rate, unconfirmed offer expiry, confirmed requests, duplicate
      decisions, blocked unauthorized transitions, and provider delivery failures.
- [x] Add structured logs with organization, installation, conversation, offer/request IDs,
      correlation ID, policy revision, outcome, and bounded error code; exclude full message bodies.
- [x] Define rollback without re-enabling unguarded model-created handoffs.
- [ ] Move this plan to `docs/plans/completed/` only after production acceptance and evidence are
      recorded.

## Verification

- [x] Type checks: Agent Platform and client.
- [x] Targeted tests: handoff module, intent interpreter, runtime loop, workflow executor, inbound
      routing, and operator API.
- [ ] Integration tests: transaction recovery, idempotency, concurrent confirmation/claim, and
      organization isolation.
- [ ] Channel tests: website, WhatsApp, Messenger, Instagram, Telegram, and Discord fixtures or
      dedicated test accounts where available.
- [x] Build and runtime checks: Agent Gateway, Core, client production build, health/readiness,
      authenticated handoff flow, and operator queue counts.
- [x] Acceptance scenario: “I cannot answer that. Would you like a human?” followed by `yes` creates
      one confirmed request; the same scenario followed by `no` creates none.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Direct customer request | A clear direct request is itself customer consent; no redundant confirmation is required by default. | Product / Platform | Decided |
| Agent inability | Agent inability creates an offer, never a request, until the customer agrees. | Product / Platform | Decided |
| Source of truth | Agent Platform owns the handoff state machine; Core and adapters provide trusted inbound events and delivery. | Platform | Decided |
| Model authority | The model may propose an offer but cannot authorize customer consent or mutate ownership. | Platform | Decided |
| Pending offer storage | Use a durable offer record separate from confirmed handoff requests. | Platform | Decided; migration `077` |
| Confirmation interpreter | Start with conservative structured actions and versioned text rules; ambiguous input remains non-mutating. | Platform | Decided; `v1-en` |
| Offer expiry | Pending offers expire after 30 minutes; re-prompt policy is deferred. | Product / Platform | Decided for this release |
| Mandatory policy override | Define separately for regulated or emergency cases; not part of the default customer-support flow. | Product / Legal / Platform | Open |
| Existing unverified requests | Preserve history and provide explicit operator recovery; do not silently mark them customer-confirmed. | Platform / Support | Open |

## Notes and blockers

- The current handoff implementation is a usable foundation for operator claim, release, continue,
  resolve, audit, and analytics behavior. Its creation seam is now split into offer and confirmed
  request.
- The existing `AGENT_CONVERSATIONS_HANDOFF_PLAN.md` records the earlier direct-request behavior as
  complete. This plan is the narrower consent and escalation correction and should become the
  governing handoff-policy execution document.
- Local implementation and build verification are complete. Production API, worker, gateway, and
  migration rollout are complete. Dedicated channel acceptance remains open because it requires a
  non-customer test conversation. Existing unverified requests remain explicitly marked
  `legacy_unverified`.

## Release record

**Change:** Introduce deterministic, consent-gated human handoff for customer-service agent conversations.

**Owner:** Platform

**Risk:** high

**Affected services and user surfaces:** Agent Platform runtime, handoff repository and database,
Core inbound proxy and channel delivery coordination, hosted/MCP/REST agent execution, website,
WhatsApp, Messenger, Instagram, Telegram, Discord, Agent Conversations, and customer-facing handoff
prompts.

**Platform release version or release ID:** Commit `261d6b96a1c0c2a8e35ea754c9b3511d2c354964`,
including feature commit `29a6a84b`, merged and pushed to `origin/main`. Consent policy revision is
`v1-en`. Railway production deployments: Agents API
`4940e42b-4e00-46e9-b99d-88d9bb6e8b50`, Agents worker
`1e7e03e7-193f-42aa-af39-3836f2fc0373`, and MCP Gateway
`abb29b6c-9e15-4e94-9ebf-efb13b7cd1ad`; all report `SUCCESS`.

**API/schema/migration changes:** Durable `agent_handoff_offers` table, consent provenance fields,
versioned intent contract, and guarded request transition. Existing operator APIs remain backward
compatible; provenance fields are additive.

**Feature flag or rollout method:** Existing organization/installation-scoped
`customer_handoff_enabled` flag; start with a dedicated test agent/channel and expand after
acceptance evidence.

**Analytics events and success metrics:** Existing versioned handoff lifecycle analytics continues
to cover confirmed requests and operator outcomes. Offer-created/declined/expired decisions are
recorded as organization-scoped `agent_events` in this release; a separate analytics contract for
offer-only metrics is not applicable to the correctness release. Do not record full customer
message bodies in analytics.

**Logs, metrics, dashboards, and alerts:** Durable `agent_events` include organization,
installation, conversation, offer/request, actor, and classifier outcome fields without full
message bodies. New dashboards and alerts are not applicable to this correctness release; existing
server-side OpenTelemetry requirements apply.

**User, API, internal, and operational documentation:** Updated the Agent Conversations plan,
customer handoff architecture reference, and public conversation operations documentation. A
separate API page was not applicable because the existing response contract remains additive.

**Validation evidence:** Post-merge focused Agent coverage has 66 passing tests and 9 database
integration tests skipped without a database. The client TypeScript check, client webpack
production build, client lint, Agent build, and Core checks pass. The client is responding HTTP
200 at `https://app.kasitek.co.za`; direct Vercel deployment inspection is unavailable because
this environment is logged out of Vercel. Railway migration `077_consent_gated_handoff.sql`
logged `migration.applied`. `https://api.kasitek.co.za/health` and
`https://agents.kasitek.co.za/health/ready` both returned HTTP 200.

**Rollback or disable plan:** Disable the consent-protocol feature for new offers while preserving
confirmed requests and historical evidence. Do not roll back to an unguarded model-to-queue path.
Provide an operator recovery path for in-flight offers and legacy requests.

**Post-release review date:** 2026-09-14
