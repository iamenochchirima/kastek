# 0002: Content action confirmation and requested private writes

Date: 2026-11-02. Status: accepted. Owner: Enoch Chirima.

## Context

[ADR 0001](0001-growth-owned-delegation-and-operation-parity.md) places business operations,
authority and durable outcomes in Growth. Requiring a separate browser approval for every explicitly
requested private draft save prevents useful content work in chat. Public actions still need users
to inspect the exact copy, media, destination and timing. A model-generated approval argument cannot
establish that inspection, and MCP hosts differ in protocol and form support.

## Decision

Requested private content draft creation/update, duplication, media upload and transfer preparation
use a product-only `draft_write` policy. They require current write authority and durable receipts;
status-only recovery observes an existing ledger entry instead of admitting another write. Other
internal record writes retain their existing review policy. Generic connected tools cannot select
this unreviewed product-write policy.

One canonical `content.actions.preview` operation prepares every supported public/destructive content
action across Facebook, Instagram, Threads, TikTok, LinkedIn, X and Bluesky. It binds exact business
input/version to content, media, account/permission and publishing-job revisions in the existing
review ledger. It does not synchronize providers or imply support for an unavailable provider action.
Execution rechecks that binding, current authority and action-specific readiness. An edit to the
proposal requires a new preview and confirmation. Unknown outcomes remain reconciliation work.

MCP protocol `2026-07-28` clients can present that exact artifact through form elicitation. Growth
uses per-request capabilities, including the OpenAI extension for registered ChatGPT clients, and
accepts only a matching protocol input response carrying a scoped, expiring HMAC-authenticated
request state. The dedicated confirmation secret never enters model input. This authenticates the
interaction binding; it is not independent cryptographic proof of a human click. Growth trusts the
authorized client to render the requested confirmation and report its user's response.

Legacy clients, missing capabilities and oversized exact forms retain the authenticated Growth
review page. REST and internal agents use the same business operations, ledger and guards; internal
agents avoid MCP latency and retain their trusted review mechanism for public actions. No parallel
executor, approval engine or browser component is introduced.

The nullable `decisionSource` column distinguishes `requested_draft`, `growth_ui` and `mcp_form`.
Current manifest/policy revision 9 and adapter release 6 publish this behavior. Revisions 2–8 and
their descriptors/digests remain unchanged; customized workspace selections never auto-upgrade.

## Consequences and verification

Private saves become direct while public actions retain exact confirmation. Hosts without native
forms remain usable through the app. Tests must cover write classification, scope and membership,
immutable snapshots, replay, stale confirmation, protocol capability negotiation and uncertain
outcomes. Controlled protocol fixtures do not establish native host rendering or provider delivery.
Those remain explicit production acceptance checks in the release record.

Implementation references: [operation coverage](../internal/architecture/growth-operations.md),
[agent-access runbook](../internal/operations/growth-agent-access.md),
[MCP form elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).
