# ADR 0009: External channel identity pairing

- Status: accepted for the generic channel contract
- Date: 2026-08-11

## Decision

Channel connections are installation-scoped. A user or operator creates a short-lived pairing
token for one active connection and one external identity. The database stores only a SHA-256
hash of the token. The raw token is returned once, expires within a bounded TTL, and can be
consumed exactly once in a transaction. Consumption creates or reactivates the channel binding
and writes an audit record.

Pairing never grants product permissions by itself. Every inbound event must still resolve to an
active installation, channel connection, and organization scope. Provider adapters must add their
own webhook signature verification and replay window before calling the consume/ingest boundary.

## Consequences

- A leaked, unconsumed token has a short window and no reusable secret in the database.
- Replays fail after `consumed_at` is set; binding updates are idempotent on provider identity.
- Telegram, WhatsApp, and other providers can use the same pairing contract while retaining
  provider-specific identity and signature rules.
- Provider adapters, webhook verification, revocation UI, and channel delivery remain separate
  implementation work.
