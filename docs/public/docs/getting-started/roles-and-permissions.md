---
title: Roles and Permissions
---

# Roles and Permissions

The tenant portal already enforces role-based access in the frontend and backend.

## Tenant staff roles in the current codebase

The current role model includes:

- `owner`
- `admin`
- `account_manager`
- `viewer`
- `support`
- `sales_manager`
- `content_manager`
- `automation_manager`

## Current route access model

The current portal navigation is gated by route access rules:

- `dashboard`: broad tenant access
- `clients`: owner, admin, account manager
- `leads`: owner, admin, account manager, sales manager, support
- `content`: owner, admin, account manager, content manager
- `reporting`: owner, admin, account manager, viewer
- `nurturing`: owner, admin, account_manager, automation_manager, support
- `aeo`: content roles
- `voice`: owner, admin, automation_manager, support
- `reviews`: owner, admin, account_manager, support
- `adcreative`: content roles
- `settings`: owner, admin

## Client user access

Client users are a separate auth audience. They do not use the tenant staff role system.

They are restricted to client-scoped routes and data:

- `/client`
- `/client/leads`
- `/client/conversations`
- `/client/conversations/[id]`

## Enforcement model

Role checks currently exist in both layers:

- frontend route protection in the tenant portal
- backend permission checks in the tenant API

That means hiding a screen in the UI is not the only control. Backend handlers also validate access for sensitive operations such as:

- managing workspace settings
- creating and inviting client users
- creating leads
- accessing tenant-level summaries
