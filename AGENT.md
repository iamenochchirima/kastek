# KasiTek Platform Understanding

This file captures the current architectural understanding of the `kasitek` repository so future work stays aligned with the actual product shape.

## What KasiTek Is Today

KasiTek is already a product monorepo, not just a company website.

It currently combines:

- a Rust backend in `server/`
- a customer-facing Next.js app in `apps/client/`
- an internal operations/admin Next.js app in `apps/admin/`
- a shared Prisma database package in `packages/database/`
- a small call bridge app in `apps/call-bridge/`

The active product surfaces already represented in the codebase are:

- `KasiAgents`: agent/bot configuration and automation
- `KasiReach`: WhatsApp contacts, templates, campaigns, and outbound messaging
- `KasiInbox`: inbox and live conversation handling
- `KasiSocial`: social planning, publishing, and analytics
- internal sales/admin operations: leads, quotations, invoices, outreach, conversations

## Current Platform Model

The current backend is already close to a multi-tenant platform, but the tenant unit is primarily a `User`.

Most product tables are scoped by `userId`, including:

- `BusinessProfile`
- `BotConfiguration`
- `WhatsappConnection`
- `WhatsappContact`
- `WhatsappTemplate`
- `WhatsappCampaign`
- `WhatsappSendEvent`
- `SocialChannelConnection`
- `SocialPost`
- `SocialPublishJob`
- `WhatsappCallSession`

That means the system already supports isolated customer workspaces at the data layer for most core product functions.

## How The Apps Map To The Business

### `apps/client`

This is not just marketing.

It has:

- marketing pages and product positioning
- auth and onboarding
- workspace dashboard
- customer product areas for agents, reach, inbox, social, templates, campaigns, settings, notifications

This app is effectively the primary customer-facing product shell for direct KasiTek clients.

### `apps/admin`

This is the internal KasiTek operations console.

It handles:

- lead management
- quote requests
- quotations
- invoices
- outreach campaigns
- conversation oversight
- internal notifications

This is the business operations layer for KasiTek itself.

### `server`

The Rust backend is already the main product backend.

It exposes:

- auth/session APIs
- workspace summary APIs
- bot CRUD APIs
- WhatsApp connection, template, inbox, campaign, and call APIs
- social channel, post, publishing, and AI helper APIs
- public quote/waitlist endpoints
- admin auth and stats endpoints
- realtime stream endpoints

It also runs embedded background workers for WhatsApp, inbox, and social publishing.

## What This Means Strategically

KasiTek does **not** need a completely separate backend just to start offering white-label services.

The existing `server/` is already the correct base to evolve into the platform backend.

The real work is to move from:

- direct customer workspaces owned by individual users

to:

- structured tenant accounts
- agency-managed client accounts
- branded external surfaces
- usage metering and billing controls

## Recommended Direction

### Keep the current backend as the platform core

Promote the existing backend into the platform backend instead of building a second backend that duplicates product logic.

### Add a stronger tenant/account model

The next architectural step should likely be:

- `Account` or `Workspace` as the true tenant
- users belonging to an account
- optional parent/child structure for agency -> client relationships
- branded configuration stored per tenant
- API keys scoped per tenant/application
- usage and billing records scoped per tenant

This is more important than spinning up a new standalone backend.

### Keep direct and partner experiences separate at the frontend layer

The existing `apps/client` should remain the main direct KasiTek client product.

A separate white-label frontend repo or app can make sense for:

- embeddable chat widgets
- branded mini-portals
- client-facing dashboards for agencies
- reusable shells that can be skinned per partner/client

That separate frontend should call the same platform backend.

## White-Label Gaps To Close

The current codebase already has strong product foundations, but partner-grade white-label will need explicit additions:

- tenant/account model beyond plain `userId`
- agency/client relationship model
- API key issuance and revocation for partner integrations
- usage metering per tenant
- billing and overage tracking
- white-label branding config
- domain/subdomain mapping
- auditability for partner-visible actions
- clearer separation between internal KasiTek admin data and partner/customer data

## Important Architectural Caution

Some older/public-facing pieces still look more single-purpose than platform-ready.

Examples:

- `/api/chat` currently forwards to a single upstream webhook and is not obviously tenant-routed
- `Conversation` does not currently carry a direct `userId` in the Prisma schema, unlike most newer product models
- the separate `kasitek-whitelable/` repo exists but is essentially still a placeholder

These are not reasons to start over.

They are signals for where platform hardening should happen first.

## Business Interpretation

KasiTek is already operating as three businesses inside one codebase:

1. product company for direct clients
2. internal service-delivery system for KasiTek operations
3. emerging platform infrastructure for white-label/agency work

The correct move is not to split all of this immediately.

The correct move is to:

1. formalize tenancy
2. add partner and billing primitives
3. expose branded frontend surfaces
4. keep one core platform backend unless scale or org structure later forces separation

## Working Assumption For Future Implementation

Unless there is a strong technical reason otherwise, future white-label work should assume:

- `kasitek/server` remains the core platform backend
- `apps/client` remains the direct KasiTek customer app
- `apps/admin` remains internal KasiTek ops
- white-label partner experiences are added as separate frontend surfaces on top of the same backend
- the biggest backend upgrade is tenancy/account architecture, not backend duplication
