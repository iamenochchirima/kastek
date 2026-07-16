---
title: Kasitek Project Plan
slug: /architecture/project-plan
---

# Kasitek Project Plan

This file captures the current product and architecture direction so implementation work stays aligned with the intended system shape.

## Product Surfaces

Kasitek currently operates across three main surfaces:

- `server/kasitek-core`: direct Kasitek product backend
- `server/kasitek-tenants`: white-label tenant backend
- `client/apps/client`: direct Kasitek client-facing app
- `client/apps/admin`: internal Kasitek operations app
- `client/apps/tenant-portal`: unified white-label tenant web app

## White-Label Direction

White-label is a first-class product line, not a future add-on.

The active direction is:

- `kasitek-core` remains the backend for Kasitek's direct product
- `kasitek-tenants` is the separate backend for white-label tenants
- `tenant-portal` is the unified white-label frontend for both tenant staff and tenant client users
- the tenant platform uses its own database and its own auth/session model

Future work should not collapse white-label back into `kasitek-core`.

## Three-Layer Operating Model

The white-label system must support all three layers from the start:

1. `Kasitek platform`
2. `Tenant admin / agency`
3. `Tenant clients / customer accounts`

### Layer 1: Kasitek Platform

Kasitek provisions and operates the system:

- create tenant workspaces
- manage tenant deployments and domains
- issue API keys
- configure plans, limits, and billing
- manage support and internal platform operations

### Layer 2: Tenant Admin / Agency

This is Kasitek's direct paying client.

Tenant admins and staff must be able to:

- log into their tenant admin portal
- manage workspace settings and branding
- manage tenant staff users
- add and manage their own clients
- invite client accounts
- manage services, automations, conversations, reporting, and usage

### Layer 3: Tenant Clients / Customer Accounts

These are the agency's own clients.

They must be first-class identities in the system from the beginning.

Expected flow:

- tenant admin adds a client
- client receives an invite or secure onboarding link
- client creates credentials
- client logs into the tenant's branded environment
- client accesses only their own allowed services and data

This is core to the product model, not a later enhancement.

## Required Auth Modes

The platform must support multiple auth models in parallel:

- `platform/internal auth` for Kasitek operations
- `tenant staff auth` for agency admins and staff
- `tenant client auth` for the agency's own clients
- `API key auth` for integrations and server-to-server access

Do not simplify the architecture to only:

- direct Kasitek users
- tenant API keys

That is insufficient for the real white-label flow.

## Implementation Direction

Current implementation should move in this order:

1. establish tenant workspace resolution by domain/host
2. establish tenant staff identity, roles, and sessions
3. establish tenant client identity, invites, credentials, and sessions
4. connect the unified tenant portal to real tenant backend APIs
5. add provisioning flows for workspace, domain, branding, keys, and first admin
6. add usage metering, billing controls, and service entitlements

## Architectural Boundaries

Keep these boundaries clear:

- `kasitek-core` should not absorb white-label tenant runtime concerns
- `kasitek-tenants` should own tenant-specific auth, routing, data isolation, and branded portal concerns
- direct Kasitek users and tenant users are different identity systems
- tenant staff and tenant clients are different identity layers inside the same tenant
- tenant staff and tenant client users should share one frontend app where practical, but remain separated by auth, layouts, and route areas

## Working Assumption

Unless explicitly changed, future work should assume:

- separate white-label backend: `server/kasitek-tenants`
- unified white-label frontend: `client/apps/tenant-portal`
- separate tenant database
- three-layer model is mandatory:
  1. Kasitek platform
  2. tenant admin/staff
  3. tenant client/customer accounts
