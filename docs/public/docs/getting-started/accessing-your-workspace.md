---
title: Accessing Your Workspace
---

# Accessing Your Workspace

The tenant portal is host-aware. Workspace resolution is based on the request host and the backend workspace/domain mapping.

## Supported access patterns

The current implementation supports:

- hosted subdomain access, for example `workspace.portal.kasitek.co.za`
- mapped custom portal domain access, for example `portal.clientbrand.com`
- a local fallback slug in development through `TENANT_DEFAULT_WORKSPACE_SLUG`

## Shared login screen

The login screen is shared for:

- tenant staff users
- tenant client users

The portal backend decides which audience the credentials belong to and routes the user accordingly:

- tenant staff users land on `/`
- tenant client users land on `/client`

## Tenant branding at login

The login and activation screens already pull tenant context from the public tenant-context endpoint. That means the screen can show:

- tenant display name
- tagline
- logo
- color branding
- workspace slug

This branding is derived from workspace branding and the active host.

## Invite activation flow

Client users do not create accounts directly from a public signup page.

The current flow is:

1. a tenant invites the client user
2. the user receives an activation link
3. they open `/activate?token=...`
4. they set a password
5. a client session is created
6. they are redirected into `/client`

If invite email sending is not configured, the portal currently falls back to exposing the activation link directly after invite creation.
