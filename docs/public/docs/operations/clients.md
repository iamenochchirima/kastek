---
title: Clients
---

# Clients

The client management flow is live and backed by the tenant backend.

## What tenant staff can do today

From the `Clients` screen, tenant staff with the correct roles can:

- create a tenant client account
- assign a slug
- attach an external reference
- list invited users per client
- invite a client user by email

## Invite flow

When a client user is invited:

1. a tenant client user record is created or updated
2. an invite token is created
3. pending invites for that user are revoked
4. an activation URL is generated
5. email is sent if configured
6. otherwise the UI exposes the activation link directly

## Roles for client users

The current invite UI exposes:

- `member`
- `owner`

Client users are scoped to a single tenant client account, not the full tenant workspace.

## Why this matters

This is the current bridge between tenant staff operations and the client-facing portal. It is the mechanism that creates the third layer of the white-label model.
