# ADR 0009: External channel identity pairing

- Status: accepted
- Date: 2026-08-11
- Updated: 2026-08-12

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
