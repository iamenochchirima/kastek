# ADR 0009: External channel identity pairing

- Status: accepted
- Date: 2026-08-11
- Updated: 2026-08-31

## Decision

Channel connections are installation-scoped. An authenticated user creates a short-lived pairing
token for one active connection. The browser does not choose or submit the external identity. The
database stores only a SHA-256 hash of the token. The raw token is returned once, expires within a
bounded TTL, and can be consumed exactly once by a provider adapter after that adapter has verified
the provider webhook and extracted the sender's stable provider identity. Consumption creates or
reactivates the channel binding for the authenticated user who issued the token.

Pairing never grants product permissions by itself. Every inbound event must still resolve to an
active installation, channel connection, binding, and organization scope. Provider adapters verify
webhook authenticity and normalize the provider identity before calling the service-only
`channels:ingest` consume or inbound boundary. Ordinary browser claims do not receive that scope.

## Consequences

- A leaked, unconsumed token has a short window and no reusable secret in the database.
- Replays fail after `consumed_at` is set; binding updates are idempotent on provider identity.
- Telegram, WhatsApp, Discord, and other providers use the same pairing contract while retaining
  provider-specific identity, signature, replay, and delivery rules.
- WhatsApp consumes codes only after Meta signature verification and uses the normalized sender
  phone number as its external identity.
- Revoking either the binding or its connection blocks new ingestion and outbound delivery without
  removing historical conversation messages.

## Provider adapter contract

Every adapter must:

1. verify the provider signature or secret before parsing an event;
2. reject unsupported, stale, or malformed events at its public boundary;
3. derive `organizationId`, `channelType`, stable `externalIdentity`, provider event/message IDs,
   and external conversation ID from trusted provider/core state rather than browser input;
4. consume `kasiai_pair_...` codes through `/v1/channel-pairing/consume` using a service identity
   with `channels:ingest`;
5. submit normal messages through `/v1/channels/inbound`, where active connection and binding state
   are checked and provider IDs are deduplicated. When present, `occurredAt` is an RFC3339
   timestamp and may use either `Z` or an explicit UTC offset;
6. deliver replies through the authenticated core delivery boundary and submit provider receipts
   to `/v1/channels/delivery-status`.

WhatsApp implements this contract now. Telegram and Discord must satisfy the same contract before
their adapters are enabled; canonical Agent Platform support for a channel name alone does not make
that provider connected.

## Operator customer queue

Customer-service installations share one operator conversation surface regardless of provider. The
Agent Platform `GET /v1/conversations/customer` projection returns active customer conversations
from every connected channel, including website chat, Facebook Messenger, Instagram, WhatsApp,
Telegram, and Discord when those adapters have produced a conversation. `GET /v1/conversations/live`
returns the subset that is still customer-facing and active: the conversation is active, its
handoff state is `agent_active`, and its latest message is no more than 30 minutes old. The
projection deliberately does not require an active `agent_runs` row, because a completed workflow
run does not mean that the customer conversation is no longer live. Pending handoffs, assigned
human conversations, and resolved/expired/cancelled conversations are excluded. Channel filters
use the stored channel type (`facebook` for Messenger).

Website delivery polling refreshes the Core-side visitor session `lastSeenAt`, which is the
browser-presence signal for website chat. The Agent API and Core currently use separate databases,
so the shared Live queue uses message activity as its cross-channel source of truth until that
presence signal is explicitly propagated to Agent Platform.
