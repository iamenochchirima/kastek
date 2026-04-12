---
id: intro
title: KasiTek Platform Docs
sidebar_position: 1
---

# KasiTek Platform Docs

These docs cover the user-facing parts of the current KasiTek platform based on the live codebase, not just product plans.

Today the platform has three practical layers:

- KasiTek platform provisioning and operations
- tenant staff workspaces for agencies, consultants, or operators
- tenant client portals for the tenant's own customers

The current public docs focus on the tenant-facing product:

- tenant workspace access and sign-in
- custom portal domains
- branded email sending
- client account management
- lead and conversation visibility
- the current service modules exposed in the tenant portal

## What is live today

The strongest live backend-backed areas right now are:

- tenant workspace resolution by host/domain
- tenant staff and tenant client authentication
- client invitation and activation
- client management
- lead pipeline
- client-scoped conversation views
- custom portal domains
- workspace email sending configuration with Resend-backed custom domains

## What is exposed in the portal but still lighter-weight

Several modules are already present in the portal UI, but some of them still rely on the temporary `api-client-react` layer and placeholder responses rather than dedicated tenant backend services.

Those areas are documented here as current product surfaces, with notes where they are still in a preview or staged state.

## Recommended reading order

1. [Getting Started Overview](getting-started/overview)
2. [Accessing Your Workspace](getting-started/accessing-your-workspace)
3. [Roles and Permissions](getting-started/roles-and-permissions)
4. [Domains and Branding](workspace/domains-and-branding)
5. [Email Sending](workspace/email-sending)
