---
title: Getting Started Overview
---

# Getting Started Overview

KasiTek's white-label platform is designed for tenant workspaces that manage their own clients inside a branded environment.

## Current operating model

The implemented platform supports:

- a tenant workspace
- tenant staff users inside that workspace
- tenant client accounts created by the tenant
- tenant client users invited into those client accounts

That means one workspace can act as the operating layer for an agency, consultant, or service provider while still giving each client a separate scoped view into their own data.

## How onboarding works today

The current flow in the codebase is:

1. KasiTek provisions a workspace through the admin application.
2. A tenant staff user signs into the tenant portal.
3. The tenant creates client accounts from the `Clients` screen.
4. The tenant invites client users by email.
5. The invited client activates access from the invite link.
6. The client signs into the same tenant portal, but lands in the client-scoped area.

## Main portal areas for tenant staff

The tenant staff portal currently exposes:

- Dashboard
- Clients
- Leads
- Content Pipeline
- Client Reporting
- Nurturing
- AEO
- Voice Agents
- Reputation
- Ad Creatives
- Settings

Whether a tenant sees a module can be controlled by workspace feature configuration in branding settings.

## Main portal areas for tenant clients

The client user experience is currently scoped to:

- client home overview
- lead register
- conversation list
- conversation detail

Only records associated with that client account are visible in those areas.
