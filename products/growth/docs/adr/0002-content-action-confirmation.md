# 0002: Content action confirmation and requested private writes

Date: 2026-11-02. Status: superseded by [ADR 0003](0003-direct-authorized-content-actions.md). Owner: Enoch Chirima.

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

MCP App-capable clients receive a static embedded exact-preview card. A short-lived HMAC token
bound to the preview, action, identity, workspace, client and request travels only in hidden UI
metadata. Explicit buttons call an app-only transport control, which reuses the existing decision
and execution handlers. The model does not receive the token or an approval argument. Static HTML
contains no user data, and the app renders saved copy as text with a strict content policy.

Other MCP protocol `2026-07-28` clients can use a required form with a scoped signed request state.
Both mechanisms trust the authorized host to hide UI metadata, render the requested interface and
report the user's action. They are not independent cryptographic proof of a human click. Current
membership, grants, expiry, snapshot and single-use claims remain server-side requirements.

Live testing found a host that advertised form support but returned an empty accepted answer for
both boolean and enum schemas. The owner rejected the browser detour as the intended UX. MCP content
actions now require working in-chat confirmation; unsupported clients remain blocked instead of
being directed to another page. Manual/team review pages remain available outside that flow.
REST and internal agents share the business operations and durable ledger. Internal agents use
task-bound reviews directly. No parallel business executor or approval engine is introduced.

The nullable `decisionSource` column distinguishes `requested_draft`, `growth_ui`, `mcp_form` and `mcp_app`.
Current manifest/policy revision 9 and adapter release 6 publish this behavior. Revisions 2–8 and
their descriptors/digests remain unchanged; customized workspace selections never auto-upgrade.

## Consequences and verification

Private saves become direct while public actions retain exact confirmation. Clients without working in-chat
confirmation retain reads/private writes but cannot confirm a new public action in chat. Tests must cover write classification, scope and membership,
immutable snapshots, replay, stale confirmation, protocol capability negotiation and uncertain
outcomes. Controlled protocol fixtures do not establish native host rendering or provider delivery.
Those remain explicit production acceptance checks in the release record.

Implementation references: [operation coverage](../internal/architecture/growth-operations.md),
[agent-access runbook](../internal/operations/growth-agent-access.md),
[MCP form elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).
