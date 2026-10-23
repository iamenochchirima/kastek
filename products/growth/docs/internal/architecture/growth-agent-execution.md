---
title: Growth agent execution
owner: engineering
last_reviewed: 2026-10-23
---

# Growth agent execution

Growth owns the Agents workspace, the general assistant launcher, user membership, business
permissions, attached records, and saved business results. Shared Agents execution owns its own
tenant mapping, configured features, conversations, tasks, model calls, evidence and artifacts.
Growth users do not need a standalone Agents account or membership.

The browser calls Growth's authenticated /api/agents routes. Growth signs the complete
versioned command and calls the shared product API through agents/client.ts. The destination
action API verifies a separate Agents worker signature and rechecks Growth membership, feature
permission and attached context. Neither backend reads the other product's database.

The shared schema is packages/contracts/src/growth-agents.ts. Growth's api/src/agents/ owns the
browser routes, current scope resolver, business reviews and domain effects. Changing this
contract requires matching client, API and worker artifacts.

## Configuration

The optional service values are listed in api/.env.example. Configure the shared API origin,
Growth's signing key and issuer, and the public keys/issuer permitted for destination actions.
Private keys never enter browser configuration. Model credentials and permitted defaults belong
to protected execution configuration, with explicit Growth use grants and tenant usage attribution.

Ordinary Growth startup and business APIs do not require Agents. An unavailable execution service
produces an unavailable agent state. It must not start a separate local model loop or replace
missing tasks with empty counts. Workspace summary leaves its retired agent counters null;
the new Agents endpoints own agent activity.

## Business effects

Content suggestions remain proposals until the user reviews the exact final fields and selected
publishing account. Growth owns the durable review and draft-save receipt. The shared task retains
the corresponding operation reference. A changed proposal, record or authorization cannot reuse
an old approval. Saves use Growth's ordinary content service and retain the initiating actor.
A lost acknowledgement is reconciled from the original operation before another save is considered.

Current campaign context refers to Growth's WhatsApp campaigns. It does not create a generic
social campaign model or authorize publishing, scheduling, recipient changes or campaign launch.

## Customer channels

Customer website and messaging automation belongs to standalone Agents deployments. Growth keeps
its normal human Inbox, provider receipt handling, campaign opt-out and calling services. Growth
does not forward inbound WhatsApp, Facebook or Instagram messages to a second agent responder.
The old Telegram callback proxy, personal pairing, installation management and widget transport
are removed.

The Labs website uses a configured Agents publication URL and deployment UUID. Its allowed origin
must include the actual Labs website. Missing or invalid configuration shows a contact fallback.
Growth retains /api/quote-requests and /api/waitlist independently.

## External clients and operations

Developer API keys keep scoped access to supported Growth REST operations, with local audits,
rate limits, expiry and revocation. Old installation JWTs are rejected without falling back to
a browser cookie. Product OAuth MCP remains unavailable.

The central admin Operations page retains Growth webhook recovery and support access. Retired
remote runtime projections and operator commands are removed. Shared execution monitoring belongs
to its owning service; the Growth admin cannot acquire that authority through an old proxy.

## Verification boundary

Use isolated state for browser-to-Growth-to-Agents-to-worker checks and inspect authoritative
Growth records. Direct adapter tests and mocked routes do not prove that full path. Purpose
evaluations and live provider acceptance remain owner-run. Source changes do not enable a hosted
deployment, reset an owner database or apply the obsolete widget-table removal migration.

The [shared architecture](../../../../agents/docs/architecture/agent-platform-architecture.md)
defines execution categories and authorization responsibilities. Current shared runtime support
is recorded in its [source boundary](../../../../agents/docs/source-boundary.md).
