---
title: Domains and Branding
---

# Domains and Branding

Tenant workspaces currently support both a hosted portal domain and a mapped custom domain.

## Hosted tenant domain

When `TENANT_PLATFORM_BASE_DOMAIN` is configured, the platform derives a hosted domain in this shape:

```text
{workspace_slug}.portal.kasitek.co.za
```

This hosted domain acts as the immediate fallback entry point for the workspace.

## Custom portal domain

Tenants can also connect a branded portal domain from the `Settings` screen.

The current implementation stores portal domains in the `workspace_domains` table and verifies them by checking whether they resolve to the configured shared portal target.

Typical setup:

```text
portal.clientbrand.com CNAME portal.kasitek.co.za
```

## How verification works today

The portal-domain verification logic currently:

1. normalizes the submitted hostname
2. resolves the public IPs for the submitted domain
3. resolves the public IPs for `TENANT_PORTAL_HOST_TARGET`
4. compares them
5. marks the domain as:
   - `pending`
   - `verified`
   - `misconfigured`

## Primary domain behavior

Tenants can store more than one custom portal domain, but one can be marked as primary.

The primary domain is also synced back into workspace branding as the current `custom_domain` value.

## Branding data used by the portal

The public tenant context currently exposes:

- display name
- primary color
- secondary color
- logo URL
- custom domain
- widget configuration

That branding is used to style the tenant login and portal experience dynamically.

## Website Chat embed

Website Chat deployments provide an embed snippet with an absolute Kasitek API URL. Copy the
snippet from the deployment controls and paste it into the target website; the website does not
need to know or proxy the Kasitek API domain.

The widget keeps the deployment's title, welcome message, primary colour, launcher position,
size, corner radius, screen offset, avatar, and branding setting. Visitors can send text, use
the audio controls when enabled, choose a starter question, and expand the chat window. The
widget also shows an AI accuracy notice.

## Feature flags through branding

The current portal also reads feature configuration from `widgetConfig`.

Supported patterns include:

- `widgetConfig.features`
- `widgetConfig.enabledModules`

This lets a tenant or platform operator hide modules such as:

- voice
- AEO
- reviews
- content
- settings
