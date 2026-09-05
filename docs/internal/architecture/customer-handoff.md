---
title: Consent-gated customer handoff
---

# Consent-gated customer handoff

## Contract

Customer-service conversations have two separate concepts:

- A **handoff offer** records that an agent cannot safely complete the request and has asked whether the customer wants a person.
- A **handoff request** changes ownership and pauses automated replies.

The Agent Platform owns the transition. Model tool calls can create offers only. The platform evaluates the next trusted inbound customer message and creates a request only for a clear direct request or an explicit confirmation of a pending offer.

## Decision rules

The classifier is deterministic and versioned as `v1-en`:

- clear phrases such as “connect me to a human” are direct customer consent;
- `yes`, `please do that`, and equivalent bounded affirmative replies confirm a pending offer;
- bounded negative replies decline a pending offer;
- all other replies are ambiguous or ordinary conversation and never create a request;
- structured `request_human` and `confirm_handoff` actions are treated as customer consent only when received as an inbound message; the former is a direct request and the latter requires a pending offer.

The model’s `customerMessage` or summary is not accepted as proof of consent. Inbound evidence is tied to the authenticated installation, resolved customer conversation, and durable message ID.

## State and compatibility

Offers are stored in `agent_handoff_offers` with a short expiry and idempotency key. The platform emits `conversation.handoff.offer_created` when an offer is recorded and `conversation.handoff.offer_accepted` only after consent. Requests retain `request_source`, source message, offer, classifier revision, and consent time. Existing `conversation.request_human` capability grants remain valid during the compatibility period, but the registered handler now records an offer and cannot create ownership.

Both platform and provider inbound paths use the same coordinator, so website, WhatsApp, Messenger, Instagram, and future channels share the same decision rules. Personal agents are not granted the handoff capability.

## Operational behavior

Pending offers leave the conversation in `agent_active`. Confirmed requests transition it to `handoff_requested`; the existing operator claim, release, resolve, and expiry controls continue to manage ownership. Requests created before this change are marked `legacy_unverified` and remain visible for operator resolution.

When a request is created from an external channel, the platform persists a deterministic conversational acknowledgement and delivery attempt in the same transaction as the handoff. The inbound adapter delivers that acknowledgement through the channel-specific provider boundary. Provider redelivery can retry a queued or failed acknowledgement without creating a second handoff. Direct Telegram and Discord webhooks use the same delivery routine. If a customer messages an already pending or claimed handoff, the platform returns `handoff_active`; it does not start an agent run and can queue or retry a missing acknowledgement for that existing request. Website Chat displays the active-handoff state from the accepted response and does not create a second provider delivery.
