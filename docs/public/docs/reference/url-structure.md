---
title: URL Structure
---

# URL Structure

## Tenant portal hosts

The current tenant platform supports:

- hosted workspace subdomains, for example `workspace.portal.kasitek.co.za`
- mapped custom portal domains, for example `portal.clientbrand.com`

## Tenant staff routes

Current main tenant routes include:

- `/`
- `/clients`
- `/leads`
- `/content`
- `/reporting`
- `/nurturing`
- `/aeo`
- `/voice`
- `/reviews`
- `/adcreative`
- `/settings`

## Client routes

Current client routes include:

- `/client`
- `/client/leads`
- `/client/conversations`
- `/client/conversations/[id]`

## Auth routes in the backend

Current auth route groups in `kasitek-tenants` include:

- `/api/auth/*` for tenant staff and shared session access
- `/api/client-auth/*` for invite preview, accept-invite, and client sign-in

## Workspace operations

Current workspace operations include:

- `/api/workspace`
- `/api/workspace/branding`
- `/api/workspace/domains`
- `/api/workspace/email-sending`

## Client operations

Current client operations include:

- `/api/clients`
- `/api/clients/{id}/users`
- `/api/clients/{id}/invites`

## Client portal data

Current client-facing data routes include:

- `/api/client/overview`
- `/api/client/leads`
- `/api/client/leads/stats`
- `/api/client/conversations`
- `/api/client/conversations/{id}`
- `/api/client/conversations/{id}/messages`
