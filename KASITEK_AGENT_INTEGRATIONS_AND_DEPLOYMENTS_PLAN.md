# KasiTek Agent Integrations and Deployments Plan

**Status:** In progress — the agent-level Integrations tab and initial connection reuse slice are implemented; the provider-neutral bridge and remaining deployment surfaces are still pending.
**Owner:** Direct KasiTek product and shared Agent Platform
**Scope:** Reusable provider connections, agent deployments, messaging channels, website delivery, and developer delivery surfaces
**Checklist:** [`KASITEK_AGENT_INTEGRATIONS_AND_DEPLOYMENTS_CHECKLIST.md`](KASITEK_AGENT_INTEGRATIONS_AND_DEPLOYMENTS_CHECKLIST.md)

## Purpose

This plan defines how a workspace connects an existing KasiTek agent to external channels and
public delivery surfaces through one consistent product flow.

The target user flow is:

```text
Integrations
  -> choose a provider or delivery surface
  -> reuse an existing workspace connection or connect a new one
  -> choose an agent
  -> configure routing and deployment settings
  -> test
  -> publish
```

The plan deliberately separates the user experience from the underlying ownership model. A user
should see a simple Connect or Use with agent action. The system must still preserve provider
credentials, workspace ownership, agent capability policy, routing, audit, and delivery state.

## Scope

### Included in this release

- WhatsApp
- Telegram
- Discord
- Slack
- Facebook Page messaging, presented to users as Messenger where appropriate
- Instagram messaging
- Website chat deployment
- WordPress installation instructions for the website deployment
- Custom Button configuration for the website deployment
- Bot API
- MCP and the existing Developers surface
- KasiAi and hosted user agents through the same deployment model

### Explicitly deferred

- Zapier
- Make
- Email
- Publishing an npm or other public package
- A native WordPress plugin; the first WordPress path uses the website embed
- Commercial plan or payment gates during the testing phase

## Product and architecture decisions

1. Connections are workspace-owned. The user who creates or reconnects one is recorded for audit,
   but the connection is not tied permanently to that user's browser session.
2. A connection is separate from an agent deployment. One connected WhatsApp number, Facebook Page,
   or Instagram profile may be assigned to one or more supported agents subject to routing rules.
3. Agents receive a reference to a connection. Provider access tokens remain owned by the service
   that already owns the provider integration; they are not copied into the Agent Platform database.
4. The existing `ExternalConnection` projection is the common product-facing connection identity.
   `WhatsappConnection` and `SocialChannelConnection` remain the provider-specific source records
   until a later migration is explicitly approved.
5. The Agent Platform's `channel_connections` and `channel_bindings` remain responsible for agent
   routing, pairing, delivery attempts, and channel runtime state. They need a safe reference to a
   core-owned connection rather than a second provider credential store.
6. There are no MCP-versus-REST read/write checkboxes. Developer access is controlled by the shared
   API-key principal, capabilities, resource policy, approval rules, and provider availability.
7. A provider is labelled `Ready` only after its authentication, inbound path, outbound path,
   health reporting, error handling, and end-to-end tests are working.
8. The testing phase removes commercial entitlement guards. It does not remove organization
   isolation, secret protection, approval requirements, provider restrictions, or audit records.

## Current repository findings

### Existing linked profiles that should be reused

| User-facing provider | Existing source of truth | Existing shared projection | Current finding | Planned agent use |
| --- | --- | --- | --- | --- |
| WhatsApp | `WhatsappConnection` | `ExternalConnection` with `sourceType = WHATSAPP` | Existing phone-number connection, inbox, webhook, and KasiAi pairing flow | Select the existing connection and create an agent binding; do not ask for the token again |
| Messenger / Facebook Page | `SocialChannelConnection` with `platform = FACEBOOK` | `ExternalConnection` with `sourceType = SOCIAL` | Meta OAuth loads Pages, stores the Page access token and external Page ID, subscribes Page webhooks, and the inbox handles Facebook messages | Select the existing Facebook Page connection and bind it to an agent; retain `FACEBOOK` internally while displaying Messenger where the product means messaging |
| Instagram | `SocialChannelConnection` with `platform = INSTAGRAM` | `ExternalConnection` with `sourceType = SOCIAL` | Meta OAuth can load connected professional accounts; direct Instagram Login is also supported; webhook and outbound message paths exist | Select the existing Instagram profile and bind it to an agent; do not create a second Instagram credential flow |

The relevant existing code is in `server/kasitek-core`, including the connection synchronizer,
Meta OAuth callbacks, provider connection upserts, Meta webhook handling, and outbound Meta message
logic. The direct client already loads workspace connections and social channels. The current gap is
that the KasiAi UI exposes WhatsApp pairing, while the generic Agent Platform channel UI still asks
for provider-specific channel keys and credential references instead of offering these existing
workspace connections.

### Ownership map

| Area | Repository owner | Responsibility |
| --- | --- | --- |
| Existing provider accounts and OAuth | `server/kasitek-core` | Provider credentials, linked profiles, webhook verification, provider health, provider API effects |
| Common connection list | `server/kasitek-core` and direct product API | Workspace-scoped connection identity, capabilities, status, and safe metadata |
| Agent definitions and installations | `agents` | Agent versions, execution modes, capability grants, runs, conversations, channel runtime |
| Agent bindings and delivery | `agents` | Which installation receives a channel, normalized messages, delivery attempts, pairing where needed |
| Integrations and deployment UI | `client/apps/client` | Catalog, reuse-existing-connection flow, agent selection, deployment status, setup instructions |
| Website client | Direct product/web delivery surface | Public deployment session, widget rendering, origin policy, visitor conversation transport |
| White-label product | `server/kasitek-tenants` and `client/apps/tenant-portal` | Not part of this first direct-product implementation; preserve the separate boundary |

## Target concepts

### Integration catalog

An integration definition is product metadata, not a credential. It describes:

- slug and display name
- category: channel, website, developer, or installation helper
- supported capabilities
- authentication method
- current readiness state
- setup requirements
- whether an existing workspace connection can be reused

Initial catalog entries:

- WhatsApp
- Messenger
- Instagram
- Telegram
- Discord
- Slack
- Website Chat
- WordPress
- Custom Button
- Bot API
- MCP

### Workspace connection

A workspace connection is an authenticated external account or provider resource. The product
should expose safe fields only:

- provider
- display name and handle
- external account identifier where safe
- status
- credential status
- health status
- webhook status
- supported consumers
- last checked time

Raw provider tokens remain encrypted and server-side.

### Agent deployment and binding

An agent deployment connects an agent installation to a connection or public surface. It records:

- organization and installation identity
- connection or deployment reference
- channel type
- routing key or default route
- enabled/paused/revoked status
- public origin configuration where applicable
- created-by and audit metadata

The existing Agent Platform `channel_bindings` model should remain the routing authority. The
implementation should add a provider-neutral reference to the core connection rather than making
the Agent Platform own Meta or WhatsApp tokens.

## Agent page navigation

The agent detail page should add an **Integrations** tab under **Deployment**, alongside the existing
**Channels & status** tab:

```text
DEPLOYMENT
  Integrations
  Channels & status
```

These two areas have different jobs:

- **Integrations** is the setup and assignment experience. It lists supported providers, shows
  existing workspace connections, lets the user reuse or connect one, chooses this agent, and
  creates or updates the deployment.
- **Channels & status** is the operational view. It shows active bindings, provider health,
  delivery state, recent errors, pause/revoke controls, and links to activity.

The global **Connections** area remains the source for managing provider accounts themselves. The
agent's Integrations tab should link to it when the user needs to add or repair a provider account,
then return with the newly available connection selected. It must not ask the user to paste the same
WhatsApp, Facebook Page, or Instagram credentials again.

Bot API and MCP remain owned by **Developers** for key creation and protocol setup. The agent
Integrations tab may show that developer access is available for this agent and link to setup, but it
must not create a second API-key flow inside the agent page.

## Provider implementation order

### Phase 0: Contract and inventory

- Confirm the source-of-truth and ownership mapping above.
- Map current `ExternalConnection`, `WhatsappConnection`, `SocialChannelConnection`,
  `channel_connections`, and `channel_bindings` fields.
- Define the internal connection-reference contract between Core and Agents.
- Define how inbound provider events reach the correct agent binding.
- Define how outbound agent effects are sent through the provider owner.
- Remove or hide UI that asks users to paste a credential when a linked workspace connection exists.

### Phase 1: Shared connection-to-agent bridge

- Add a workspace-scoped endpoint for listing agent-compatible existing connections.
- Allow an authorized user to select an existing connection for an agent.
- Create or update an Agent Platform channel connection using a safe core connection reference.
- Keep raw credentials out of Agent Platform responses and storage.
- Add status propagation from Core to Agents.
- Add disconnect, pause, revoke, and reconnect behavior.

### Phase 2: Unified Integrations and Deployments UX

- Add an Integrations catalog to the direct product.
- Add clear states: Ready, Connected, Setup required, Needs attention, Beta, Coming soon.
- Make Connect reuse an existing connection before offering a new provider-auth flow.
- Add agent selection and deployment configuration.
- Add a deployment details page with test, status, routing, activity, and revoke controls.
- Remove payment CTAs from this testing flow.
- Do not add an Account IDs section; connection/account identity remains under Connections.

### Phase 3: Website, WordPress, and Custom Button

- Create a public website deployment for an agent.
- Issue a public deployment identifier and short-lived visitor session, not a secret API key.
- Build the embeddable widget and streaming conversation transport.
- Add allowed-origin configuration, rate limits, abuse controls, and session expiry.
- Provide a copyable script for ordinary websites.
- Provide WordPress installation instructions using the same script.
- Add Custom Button configuration as a website deployment option.

### Phase 4: Telegram and Discord

- Complete Telegram connection setup, webhook registration, verification, inbound normalization,
  outbound Bot API delivery, retries, health, and disconnect.
- Complete Discord bot connection setup, event verification, inbound normalization, outbound
  delivery, retries, health, and disconnect.
- Route both through the same Agent Platform binding and delivery contract.
- Do not mark either provider Ready based only on the existing adapter scaffolding.

### Phase 5: Existing Meta and WhatsApp channels

- Reuse existing WhatsApp connections in agent deployment setup.
- Reuse existing Facebook Page connections for Messenger.
- Reuse existing Instagram connections for Instagram messaging.
- Preserve existing inbox, message history, provider receipts, and webhook behavior.
- Add agent routing without duplicating provider credentials or breaking current social publishing.
- Test multiple connected Pages/profiles in one workspace to prevent ambiguous routing.

### Phase 6: Slack and developer delivery

- Add Slack OAuth or bot-token setup through the shared connection model.
- Complete inbound event and outbound message delivery before marking Slack Ready.
- Expose Bot API through the existing Developer API-key model.
- Keep MCP in Developers as a developer access surface, linking it to agent deployments and activity
  without turning it into another provider credential flow.

## Required API boundaries

The exact route names can follow existing conventions, but the product needs equivalent contracts for:

- list integration definitions
- list workspace connections safe for agent use
- connect or reconnect a provider
- create/update an agent deployment
- list deployments for an agent or workspace
- test a deployment
- pause, revoke, or disconnect a deployment
- report provider and deployment health
- issue a website visitor session
- retrieve the website embed configuration

Mutating operations must retain organization checks, capability checks, idempotency where effects are
possible, audit events, and provider receipt/reconciliation behavior.

## Definition of done

The first release is complete when a workspace user can:

1. Open Integrations.
2. See which providers are actually ready.
3. Select an existing WhatsApp, Facebook Page, or Instagram connection without reconnecting it.
4. Attach that connection to KasiAi or a hosted user agent.
5. Test inbound and outbound behavior.
6. Pause or revoke the deployment.
7. Publish an agent to a website using a safe embed flow.
8. Connect and test Telegram and Discord through the same model.
9. View meaningful health and activity state when a provider or route fails.

No unfinished adapter, placeholder card, or payment message should be presented as a working
integration.
