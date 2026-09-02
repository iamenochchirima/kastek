# Agent Conversations handoff rollout

> Superseded for new handoff creation by [AGENT_HANDOFF_CONSENT_PLAN.md](./AGENT_HANDOFF_CONSENT_PLAN.md).
> The existing operator lifecycle and rollout controls remain applicable; new ownership-changing
> requests now require a direct customer request or explicit confirmation of a durable offer.

This document covers the non-analytics rollout for customer-service agent conversations. Analytics rollups, dimensions, and dashboards remain in the analytics plan and are intentionally not part of this rollout.

## Deployment order

1. Apply the Agent Platform migrations through `069_customer_handoff_feature_flag.sql`.
2. Deploy the Agent Platform API/runtime and the client surface together. The runtime owns the handoff action; the API owns operator transitions and transcript reads.
3. Confirm the existing audience/profile backfill has completed before enabling customer channels. Migration `056_agent_creation_profile_backfill.sql` supplies the profile defaults, `063_agent_audiences.sql` supplies the audience values, and `055_agent_conversation_projections.sql` classifies existing transcripts.
4. Keep new customer handoff requests disabled during smoke testing by setting `customer_handoff_enabled=false` for the target organization or installation through the approved operator feature-flag command.
5. Enable the flag for one customer-service installation, verify a request, claim, human message, release/continue, resolve, expiry, and a second-operator claim conflict, then expand by installation or organization.

## Ownership rules

- `conversation_kind=personal` is private to the owning actor and is never a customer-service transcript.
- `conversation_kind=test` is available only through the hosted agent test surface.
- `conversation_kind=customer` is installation-scoped and is readable through the customer conversation surface only when the installation's definition has `agent_audience=customer_service`.
- Handoff queue, live conversation, history, and event-stream queries enforce organization scope and the customer-service audience at the repository boundary.
- A customer handoff changes conversation ownership to `handoff_requested` or `human_owned`; a generic workflow wait does not grant a human operator ownership by itself.

## Rollback

The first rollback is a scoped feature-flag change, not a database rollback:

1. Clear or disable `customer_handoff_enabled` for the affected installation or organization.
2. Keep the operator queue available so existing pending/claimed requests can be claimed, messaged, released, continued, resolved, or expired.
3. Existing personal/test conversations and customer transcript ownership remain intact while new requests are blocked.
4. If the client must be rolled back, deploy the previous client/runtime pair while retaining migrations; the handoff tables and columns are additive and safe for older readers.
5. Investigate failed requests using the immutable lifecycle/audit events before re-enabling the flag.

Do not delete handoff rows or reset `handoff_state` during an incident. That would destroy the ownership history and can allow an agent reply while a human still owns a conversation.

## Acceptance evidence

The Agent Platform test suite covers the standard action contract, disabled-flag fail-closed behavior, organization-scoped operator APIs, idempotent human messages, fresh continuation runs, and transcript ownership guards. The production smoke checklist must additionally verify responsive queue/detail behavior at desktop, tablet, and mobile widths.

## Deferred

Confidence thresholds, sentiment routing, business-hours routing, advanced assignment rules, and analytics rollups/dashboards are deferred to their respective later plans.
