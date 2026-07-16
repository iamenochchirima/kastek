# Product Workspace Implementation Plan

Temporary implementation tracker for reorganising the direct Kasitek product workspace. Delete this file after the refactor is complete and the relevant permanent decisions are reflected in Architecture.

## Scope

This work changes the direct Kasitek app from a set of product-branded navigation areas into one organisation workspace.

The visible app navigation will use work-oriented labels:

```text
Home
  Overview

Customer
  Inbox
  Contacts

Growth
  Campaigns
  Templates
  Content
  Calendar
  Analytics

Automation
  Agents
  Workflows
  Activity

Manage
  Connections
  Team
  Billing and usage
  Workspace settings
```

`KasiAgents`, `KasiReach`, and `KasiSocial` remain product and billing names. They are not the primary navigation labels. `KasiInbox` becomes the shared Inbox workspace area rather than a separately billed product for the first release.

Every organisation can enter the workspace. Access is controlled at feature and usage level:

- Features remain discoverable in navigation and relevant workflows.
- Unavailable features show the product or plan that enables them and link to Billing and usage.
- The server enforces entitlements for restricted actions; the client only explains the state.
- Product names bundle commercial capability sets, while the entitlement resolver controls the individual actions a workspace can take.

## Delivery Rules

- [x] Treat an organisation as the owner of product data, subscriptions, connections, usage, and entitlements.
- [x] Keep `userId` as the actor, creator, or audit identity where needed; do not use it as the main workspace data boundary.
- [ ] Do not enable a feature based only on a client-side check or successful payment redirect.
- [ ] Do not make an external connection belong to one product when several products can use it.
- [ ] Preserve existing production data through explicit migrations and backfills.
- [ ] Keep the direct Kasitek system separate from `kasitek-tenants` and the tenant database.
- [ ] Keep the work in reviewable phases. Do not combine schema migration, billing integration, and broad UI redesign in one change set.

## Phase 0: Confirm the Product Model

### Product catalogue

- [x] Confirm the initial sellable products:
  - [x] `KasiAgents`
  - [x] `KasiReach`
  - [x] `KasiSocial`
- [x] Confirm that `Inbox`, `Contacts`, `Connections`, `Team`, and workspace settings are shared workspace capabilities rather than initial standalone products.
- [x] Organisations can start with a workspace without a paid base subscription. Plans and products unlock additional features and limits.
- [ ] Define whether products can be purchased individually, only in bundles, or both.
- [ ] Define the first plan names and currencies without putting amounts into application code.
- [ ] Define which product includes each capability:
  - [ ] Agent creation and managed deployments
  - [ ] Campaign sending
  - [ ] Contact and audience management
  - [ ] Social publishing
  - [ ] Social analytics
  - [ ] Inbox access for connected channels
  - [ ] Team seats
  - [ ] External-agent access
- [ ] Define which capabilities are available during trial, grace period, suspension, and cancellation.

### Usage model

- [ ] Define the unit that is measured for each product before building meters:
  - [ ] KasiAgents: active agents, agent conversations, or successful resolutions
  - [ ] KasiReach: opted-in contacts, sends, or campaign recipients
  - [ ] KasiSocial: connected accounts, scheduled posts, or publishing actions
  - [ ] Shared workspace: seats and connected channels
- [ ] Decide which limits are hard blocks and which are warnings.
- [ ] Decide whether overage is charged, requires an upgrade, or pauses the feature.
- [ ] Define the retention period for usage events and billing/audit records.

### Completion criteria

- [ ] Product names, included capabilities, limits, and trial rules are written down and approved before schema work starts.

## Phase 1: Audit and Stabilise the Current Workspace

- [ ] Inventory every direct-app route under `client/apps/client/src/app`.
- [ ] Mark each route as retained, renamed, redirected temporarily, or removed.
- [ ] Inventory every client data model that is currently scoped by `userId`.
- [ ] Inventory every Rust service/controller query that filters by `userId`.
- [ ] Inventory all existing organisation-aware models and determine whether their `orgId` is optional or required.
- [ ] Identify all real data that needs a default organisation backfill.
- [ ] Document the existing `/dashboard/*` compatibility routes and their final destination routes.
- [ ] Add route-level tests for current redirects before changing them.
- [ ] Confirm the organisation switcher only exposes organisations to which the user belongs.
- [x] Add an explicit active-organisation resolver on the server; do not trust only the browser cookie value.

### Completion criteria

- [ ] There is a written migration inventory for user-scoped records and legacy routes.
- [ ] Every request can resolve an authenticated user and an authorised active organisation.

## Phase 2: Make the Direct Product Organisation-Scoped

### Data migration

- [ ] Add required `orgId` ownership to direct-product records that belong to a workspace.
- [ ] Start with the active product records:
  - [ ] Business profile
  - [x] WhatsApp connections
  - [x] WhatsApp contacts and list memberships
  - [x] WhatsApp templates
  - [x] WhatsApp campaigns and recipients
  - [x] Conversations and message records
  - [x] Social channel connections
  - [x] Social posts, variants, and publish jobs
  - [x] Bot configurations, events, and deployments
  - [ ] Notifications where they represent workspace work
- [ ] Decide which records remain user-owned:
  - [ ] Personal sessions
  - [ ] Personal notification delivery preferences
  - [ ] User profile and authentication providers
  - [ ] Personal device push subscriptions
- [ ] Add database indexes for each common organisation query.
- [ ] Add uniqueness constraints that include `orgId` where a value only needs to be unique inside a workspace.
- [ ] Create a safe backfill that assigns each existing user-owned record to the user’s original organisation.
- [ ] Verify backfill counts before making `orgId` non-null.
- [ ] Keep a rollback procedure for the migration.

### Server changes

- [x] Replace direct-product `userId` query filters with authorised `orgId` filters across Agents, Social, Connections, Reach, and Inbox.
- [ ] Keep `userId` in create/update records as the acting user where audit history requires it.
- [x] Require organisation membership for every organisation-scoped endpoint.
- [x] Require organisation admin or owner roles for sensitive settings, connections, billing, and team actions.
- [x] Update realtime channel naming from user-scoped channels to organisation-scoped channels where events are shared by a team.
- [ ] Preserve personal notifications separately from shared workspace activity.
- [ ] Update workspace summary queries to aggregate active-organisation data only.
- [ ] Add tests proving one organisation cannot read or modify another organisation’s records.

### Client changes

- [ ] Pass or resolve the active organisation consistently for all dashboard reads and writes.
- [x] Refresh active data when the organisation switcher changes organisation.
- [ ] Handle the case where a user has no organisation or no selected organisation.
- [ ] Show the active organisation name consistently in page headers and settings.
- [ ] Verify that team members see shared records according to their role.

### Completion criteria

- [ ] Switching organisation changes all workspace data, not only the organisation label.
- [ ] A team member can work in shared Inbox, Campaigns, Social, and Agents data without seeing another organisation’s data.

## Phase 3: Create the Product, Entitlement, and Usage Foundation

### Product catalogue and plans

- [x] Create a server-owned product catalogue with stable keys, display names, and lifecycle status.
- [x] Create plan definitions with product membership, currency, billing interval, and versioned pricing references.
- [x] Keep plan definitions separate from payment-provider plan codes.
- [ ] Add product availability states: active, hidden, retired, and internal-only.
- [ ] Add plan availability states: draft, active, retired.
- [ ] Add a plan change policy for upgrades, downgrades, cancellation, and grandfathered plans.

### Subscriptions and entitlements

- [x] Create an organisation subscription record with status, start/end dates, trial dates, cancellation dates, and provider references.
- [ ] Create subscription items so an organisation can hold a base plan and multiple product subscriptions.
- [ ] Create entitlement definitions with typed values:
  - [x] Boolean product/capability access
  - [x] Integer limits
  - [ ] Metered usage allowances
  - [ ] Feature configuration values where needed
- [x] Create entitlement grants resolved from active subscriptions, trials, manual grants, and internal overrides.
- [x] Create a single server-side entitlement resolver used by APIs and UI data endpoints.
- [x] Make manual/internal grants explicit, audited, and time-bound where possible.
- [ ] Define suspension and grace-period behaviour in the resolver.
- [ ] Ensure one expired subscription item does not accidentally remove access granted by another valid item.

### Usage metering

- [x] Create append-only usage events with organisation, product, metric, quantity, timestamp, source entity, and idempotency key.
- [ ] Create usage-period summaries for fast billing and UI queries.
- [x] Emit usage events from the actual server-side action that consumes the resource.
- [x] Make repeatable jobs and webhooks idempotent so they do not double-count usage.
- [x] Add limit checks before actions that must be blocked.
- [ ] Add warning thresholds for actions that remain allowed until the end of a period.
- [ ] Add reconciliation jobs that can compare raw events with summaries.

### Completion criteria

- [x] The server can answer: which products, capabilities, limits, and current-period usage does this organisation have?
- [x] Product access can be granted manually without Paystack being connected.
- [x] Access checks are enforced by the server, not only hidden in the UI.

## Phase 4: Make Connections a Shared Workspace Domain

### Connection model

- [x] Define a common connection record for organisation-owned external accounts.
- [x] Define provider-specific records for credentials, account metadata, scopes, health, and webhook status.
- [x] Model a connection’s capabilities separately from the product that uses it.
- [x] Record which products currently consume each connection.
- [x] Support connection states: not connected, connecting, connected, needs attention, disconnected, and revoked.
- [x] Encrypt provider access tokens and secrets at rest.
- [x] Define credential rotation and revocation behaviour.
- [x] Define webhook verification and health checks for each provider.

### Initial connections screen

- [x] Move WhatsApp setup out of `KasiReach` settings.
- [x] Add an organisation-level Connections screen.
- [x] Show each connection’s provider account, status, permissions, webhook health, and products using it.
- [x] Show the product entitlement required before a user can connect or use a provider capability.
- [ ] Support WhatsApp first, then Facebook, Instagram, Threads, LinkedIn, X, email, and website chat as each integration becomes real.
- [x] Keep manual connection and OAuth connection flows behind the same connection lifecycle.

### Completion criteria

- [x] A WhatsApp or Meta connection is owned by the organisation and can be used by Inbox, Agents, Reach, and Social according to granted capabilities.
- [x] No product settings page is the hidden owner of a shared provider connection.

## Phase 5: Unify the Inbox and Customer Work

- [ ] Define the canonical customer/contact record for an organisation.
- [ ] Map WhatsApp contacts, social identities, email addresses, and website-chat identities to the customer model without assuming they are always the same person.
- [ ] Define the canonical conversation record with channel, connection, participants, assignee, status, source, and linked campaign/agent context.
- [ ] Move Inbox ownership from a WhatsApp-only user-scoped surface to an organisation-scoped multi-channel surface.
- [ ] Keep the first release limited to channels that are actually connected; do not show fake empty channels as functional.
- [ ] Show the source of each conversation: agent, campaign reply, direct inbound, social, web, or manual.
- [ ] Add assignment, handoff, notes, and status controls before adding complex automation.
- [ ] Make campaign replies and agent handoffs open the same conversation record.
- [ ] Add per-user unread state separately from organisation-level conversation state.
- [ ] Update realtime events to refresh the correct organisation inbox.
- [ ] Add audit records for human and agent actions taken in a conversation.

### Completion criteria

- [ ] Inbox is the single place for active customer conversation work.
- [ ] The same customer history is available to the relevant agent, campaign, and social workflows within the authorised organisation.

## Phase 6: Replace Product-Branded Navigation and Routes

### Navigation

- [x] Replace the current product list in the sidebar with the work-oriented navigation defined in Scope.
- [x] Keep product names out of daily navigation labels.
- [x] Preserve product names in billing, plan comparison, feature enablement, and locked-state explanations.
- [x] Add a stable Home/Overview route.
- [x] Group navigation by Customer, Growth, Automation, and Manage.
- [x] Show a deliberate locked state for purchasable features instead of hiding a product that users may need to discover.
- [ ] Show navigation badges only for meaningful attention states, such as unread conversations or failed connections.
- [x] Keep the organisation switcher at the top of the sidebar.
- [x] Add a direct Billing and usage entry under Manage.

### Route migration

- [x] Define the final route map before changing links.
- [ ] Suggested final routes:
  - [x] `/workspace` for Overview
  - [x] `/inbox`
  - [x] `/contacts`
  - [x] `/campaigns`
  - [x] `/templates`
  - [x] `/content`
  - [x] `/calendar`
  - [x] `/analytics`
  - [x] `/agents`
  - [ ] `/workflows`
  - [ ] `/activity`
  - [x] `/connections`
  - [x] `/workspace/team`
  - [x] `/billing`
  - [x] `/workspace/settings`
- [ ] Redirect current `/reach/*` routes to their final non-product-branded routes.
- [ ] Redirect current `/social/*` routes to their final non-product-branded routes.
- [ ] Remove or preserve `/dashboard/*` compatibility redirects only after usage confirms they are no longer needed.
- [ ] Update all links, page titles, breadcrumbs, metadata, and tests.
- [ ] Verify direct links, browser history, and bookmarks after redirects.

### Overview page

- [ ] Replace the current mixed Workspace Pulse page with an action-oriented overview.
- [ ] Show only items that need attention:
  - [ ] Unassigned or unread conversations
  - [ ] Failed or paused agents
  - [ ] Campaigns requiring review or with failures
  - [ ] Social posts awaiting approval or failed publishing
  - [ ] Connections requiring reconnection
  - [ ] Usage approaching a limit
  - [ ] Billing action required
- [ ] Keep performance reporting in Analytics instead of turning Home into a reporting dashboard.

### Completion criteria

- [ ] A user can find a task without knowing Kasitek product names.
- [ ] Every existing useful route has a working final route or redirect.

## Phase 7: Reorganise Product Screens Around Work

### Customer

- [x] Make Contacts a shared organisation record list, not a Reach-only list.
- [ ] Add customer detail pages that link conversations, campaign participation, social identity, and agent activity.
- [ ] Define contact import, merge, consent, and deletion behaviour.

### Growth

- [ ] Move campaign pages from `/reach/campaigns` to `/campaigns`.
- [ ] Move templates from `/reach/templates` to `/templates`.
- [ ] Keep WhatsApp-specific configuration inside the connection or campaign flow, not in a broad Reach settings area.
- [ ] Move social planning, posts, calendar, and analytics to the final Growth routes.
- [ ] Define whether content analytics and campaign analytics share an Analytics landing page with separate views.

### Automation

- [ ] Keep agent creation and management under `/agents`.
- [ ] Define a separate workflow model before creating `/workflows`; do not label n8n deployment records as a complete workflow product by default.
- [ ] Add an Activity view that combines agent execution, deployment, errors, and manual intervention records.
- [ ] Link agents to their permitted connection capabilities and organisation entitlements.
- [ ] Block agent deployment when the relevant product, connection, or limit is unavailable.

### Manage

- [ ] Move business profile and organisation settings into Workspace settings.
- [ ] Keep user profile settings separate from workspace settings.
- [ ] Move team management and invitations under Team.
- [ ] Create Billing and usage as the only place for plan, product, invoice, payment method, usage, and upgrade actions.

## Phase 8: Build the Billing and Usage Area

### Read-only first release

- [x] Build a Billing and usage page before live payments are connected.
- [x] Show active products by their commercial names: KasiAgents, KasiReach, and KasiSocial.
- [x] Show current plan, status, billing period, trial/grace status, and cancellation date.
- [x] Show current usage against each included limit.
- [x] Show payment history from internal checkout records.
- [ ] Show invoices from internal invoice records when provider invoices are synchronized.
- [x] Show manual/internal access grants separately from paid subscriptions.
- [x] Add server-side checkout initialisation; payment redirects do not grant access.
- [x] Restrict billing changes to organisation owners or explicitly authorised billing admins.

### Internal admin support

- [x] Add internal admin tools to create and update products, plans, provider plan codes, prices, and entitlement definitions.
- [x] Add internal admin API tools to create, inspect, and expire manual access and limit grants.
- [x] Require a reason and actor audit entry for manual entitlement changes.
- [x] Add support procedures for refunds, failed payment, disputes, and incorrect usage counts.

### Completion criteria

- [x] Billing UI is driven by real internal subscription and entitlement records even before a payment provider is enabled.

## Phase 9: Add the Paystack Provider Adapter

### Provider boundary

- [x] Define a `BillingProvider` interface in the server layer.
- [x] Keep provider API configuration, HTTP calls, webhook verification, and provider event mapping inside the Paystack adapter.
- [x] Keep internal product, subscription, entitlement, invoice, and usage models provider-neutral.
- [ ] Store Paystack customer, plan, subscription, transaction, invoice, and authorisation references as external IDs, never as the source of truth for access.
- [x] Keep all Paystack secret-key calls on the server.
- [x] Add separate test and live environment configuration.

### Checkout and verification

- [x] Create a checkout intent from an authorised organisation billing action.
- [x] Attach internal organisation, plan, user, and provider metadata to the Paystack transaction reference/metadata.
- [x] Initialise checkout from the server through Paystack’s transaction API.
- [x] Use the client only to redirect to the returned authorisation URL or render the approved checkout flow.
- [x] Verify the transaction server-side after return.
- [x] Treat browser return as a status display only; grant or update access only after verified provider data and/or verified webhook processing.
- [x] Record the provider transaction references and normalized verification results needed for checkout reconciliation without storing card details.
- [x] Make checkout creation idempotent so retries cannot create duplicate transactions.

### Recurring billing

- [ ] Confirm Paystack recurring capability for the Kasitek merchant account and target markets before committing to a provider plan design.
- [ ] Map internal plan versions to Paystack plan codes only after prices and intervals are approved.
- [ ] Decide whether Kasitek uses Paystack subscriptions, recurring authorisations, or invoice/checkout renewal flows for each market.
- [ ] Do not assume one Paystack recurring mechanism works in every target country. Paystack documents subscriptions and recurring authorisations separately, with market/payment-method constraints.
- [x] Support provider-backed cancellation at period end and reactivation through authorised workspace billing actions.
- [ ] Enable plan upgrades and downgrades after the replacement-subscription billing policy is approved.
- [ ] Keep entitlement changes tied to verified paid status and explicitly defined grace rules.

### Webhooks and reconciliation

- [x] Add a public Paystack webhook endpoint.
- [x] Verify the `x-paystack-signature` before processing a webhook.
- [x] Persist raw event metadata, provider event type, received time, processing result, and idempotency key.
- [x] Process duplicate webhook deliveries safely.
- [x] Handle at minimum:
  - [x] Successful charge
  - [x] Failed invoice/payment
  - [x] Subscription created
  - [x] Subscription non-renewing
  - [x] Subscription disabled/completed
  - [x] Processed full refund
  - [x] Partial or unverifiable refund escalation
  - [x] Dispute escalation
- [x] Add a reconciliation job that periodically verifies recent unresolved checkout transactions with Paystack.
- [x] Extend reconciliation to verify active subscription states with Paystack.
- [x] Record and surface provider errors and payment/entitlement state mismatches for internal operators.
- [ ] Connect open reconciliation issues to an external operator alert channel.

### Completion criteria

- [x] A successful verified Paystack payment activates only the intended organisation product/plan entitlement.
- [x] Failed, cancelled, duplicate, forged, or mismatched payment events do not grant access.
- [ ] Test mode covers the complete checkout, webhook, entitlement, and cancellation path before live keys are used.

## Phase 10: Test, Migrate, and Roll Out

### Automated verification

- [x] Unit-test entitlement merge rules and the access effect of trial, active, grace, past-due, suspended, and cancelled states.
- [x] Unit-test Paystack signature validation, transaction/subscription normalization, and refund/dispute event mapping.
- [ ] Unit-test entitlement resolution for trial, active, grace, suspended, cancelled, overridden, and multi-product states.
- [x] Database-test usage aggregation and idempotency against the final Prisma schema.
- [x] Database-test billing organisation isolation, checkout idempotency, and reconciliation issue lifecycle.
- [ ] Integration-test organisation isolation for every moved product domain.
- [ ] Integration-test active organisation switching.
- [ ] Integration-test role restrictions for connections, team, and billing.
- [ ] Integration-test the final route map and legacy redirects.
- [ ] Integration-test payment verification and signed webhook processing with Paystack test data.
- [ ] Add end-to-end tests for: connect a channel, create an agent, receive a conversation, send a campaign, schedule content, hit a limit, and upgrade a product.

### Migration and release

- [ ] Run the organisation backfill in a staging copy of real-shaped data.
- [ ] Compare row counts and organisation ownership before and after migration.
- [ ] Release schema changes before code that requires non-null organisation ownership.
- [ ] Put new navigation behind a rollout flag until route and entitlement tests pass.
- [ ] Release read-only Billing and usage before live checkout.
- [ ] Enable Paystack test mode for internal organisations first.
- [ ] Run an internal test subscription through payment, webhook, usage, cancellation, and restoration.
- [ ] Enable live Paystack only after reconciliation and support procedures are tested.
- [ ] Monitor errors, failed webhooks, permission denials, and organisation-switch inconsistencies after each release.

### Documentation and handoff

- [x] Move permanent product, connection, entitlement, and billing decisions into the Architecture document.
- [ ] Update Product Features and Product Roadmap to match the delivered behaviour.
- [x] Document required Paystack environment variables without recording secret values.
- [x] Document local webhook testing and production webhook configuration.
- [x] Write the billing support runbook for payment failure, access disputes, refunds, usage corrections, and entitlement correction.
- [x] Write the connection failure support runbook.
- [ ] Remove this temporary implementation plan after completion.

## Final Acceptance Checklist

- [ ] The app is organised by customer work, growth work, automation work, and management work.
- [ ] Product names remain visible only where commercial context is useful.
- [ ] Organisation switching changes the underlying data across all product areas.
- [x] Inbox, Contacts, and Connections are shared workspace domains.
- [x] Products consume shared connections through explicit capabilities.
- [x] Subscription and entitlement records are organisation-owned and provider-neutral.
- [x] Usage is measured by server-side events and checked before restricted actions.
- [x] Billing and usage works before Paystack is enabled.
- [x] Paystack checkout, verification, signed webhooks, and checkout reconciliation are isolated behind a provider adapter.
- [x] Direct Kasitek and white-label tenant architecture remain separate.
- [ ] Legacy routes are removed or intentionally redirected.
- [ ] The final Architecture document contains only durable decisions, not this delivery checklist.
