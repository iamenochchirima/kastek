---
title: Email Sending
---

# Email Sending

The platform now supports two email-sending modes at workspace level:

- KasiTek-managed shared sending
- tenant-owned custom sending domains

## Shared sending

Shared sending is the fastest starting point.

In shared mode, the tenant still controls:

- sender name
- reply-to email
- shared sender local part

The actual sending address is generated on the shared KasiTek sending domain:

```text
{workspaceSlug}-{localPart}@send.kasitek.co.za
```

This allows tenants to start sending operational email before they have configured their own domain.

## Custom sending domain

When the tenant is ready, they can connect a custom sending subdomain such as:

```text
mail.clientbrand.com
```

This is separate from the portal domain. The recommended setup is:

- portal domain for the app itself
- dedicated sending subdomain for email authentication

## Current domain onboarding flow

The current `Settings` screen supports this flow:

1. enter a sending domain
2. backend creates the domain in Resend
3. DNS records are returned and stored
4. the tenant copies those DNS records into their DNS provider
5. the tenant clicks `Verify`
6. once verified, the domain becomes selectable for custom sending

## What the tenant can configure today

The workspace email settings currently support:

- sending mode
- sender name
- reply-to email
- shared sender local part
- selected custom sending domain
- test email delivery

## Which emails use this sender

The invite flow for tenant client users now resolves the workspace sender automatically.

That means client invite emails can now send from:

- the shared KasiTek sending domain
- or the tenant's verified custom sending domain

depending on the workspace configuration.

## What is not included yet

The current implementation does **not** yet include:

- bounce/complaint event history
- delivery event dashboards
- provider health monitoring
- bring-your-own provider support

The current provider model is a KasiTek-managed Resend account with per-tenant domains configured through the workspace UI.
