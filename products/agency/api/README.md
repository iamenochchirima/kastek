# KasiTek Tenant API

TypeScript API and worker processes for white-label tenant services. The Rust
implementation was retired after the TypeScript replacement passed its local
service and consumer checks. Its recoverable source baseline is Agency commit
`2c7902170a8f75257c0e47b86ffaf38068dd2227`.

Initial scope:

- workspace-scoped API key auth
- tenant-isolated agent configuration
- tenant-isolated conversation history
- usage reporting and limits
- branding/domain configuration

This service keeps its own database and deployment lifecycle, separate from Growth Core.
Install dependencies from the root workspace; this API package is `products/agency/api/`.

## Required Environment

Minimum environment for local development:

- `KASITEK_TENANTS_DATABASE_URL`
- `TENANT_SERVER_PORT` or `PORT`
- `TENANT_ALLOWED_ORIGINS`

Useful auth and portal settings:

- `TENANT_DATABASE_URL` as a legacy fallback if you are migrating old envs
- `TENANT_APP_BASE_URL`
- `TENANT_PORTAL_HOST_TARGET`
- `TENANT_PLATFORM_BASE_DOMAIN`
- `TENANT_DEFAULT_WORKSPACE_SLUG`
- `TENANT_RESEND_API_KEY` or `AUTH_RESEND_KEY`
- `TENANT_RESEND_FROM_EMAIL` or `RESEND_FROM_EMAIL`
- `TENANT_CORS_ALLOW_CREDENTIALS`
- `TENANT_SESSION_COOKIE_NAME`
- `TENANT_SESSION_COOKIE_DOMAIN`
- `TENANT_SESSION_COOKIE_SECURE`
- `TENANT_SESSION_COOKIE_SAME_SITE`
- `TENANT_SESSION_TTL_HOURS`
- `TENANT_CLIENT_SESSION_COOKIE_NAME`
- `TENANT_CLIENT_SESSION_TTL_HOURS`
- `TENANT_PARTNER_SESSION_COOKIE_NAME`
- `TENANT_PARTNER_SESSION_IDLE_DAYS` (default 7)
- `TENANT_PARTNER_SESSION_ABSOLUTE_DAYS` (default 30)
- `TENANT_PARTNER_MAX_BUSINESSES` (default 10)
- `TENANT_PARTNER_OIDC_ISSUER_URL`, `TENANT_PARTNER_OIDC_CLIENT_ID`, `TENANT_PARTNER_OIDC_CLIENT_SECRET`
- `TENANT_PARTNER_OIDC_ADMIN_CLIENT_ID` and `TENANT_PARTNER_OIDC_ADMIN_CLIENT_SECRET` for all-device provider logout
- `TENANT_PARTNER_OIDC_REDIRECT_URI` and `TENANT_PARTNER_APP_BASE_URL`
- `TENANT_INVITE_TTL_HOURS`

Agency partner sign-in uses the Labs Keycloak client `agency-partner`. Set its client secret in the ignored Labs identity `.env` and in this service's ignored `.env`, then run the Labs identity configuration script. The partner's Keycloak identity is separate from agency-specific staff and client accounts. Workspace membership is checked for every owner operation.

Analytics publication is a separate worker process. To enable it, set these values in the Tenant
service environment; the token must match the `tenant-platform` credential configured in the
Analytics service:

- `ANALYTICS_INGESTION_URL` (default `http://127.0.0.1:4300`)
- `ANALYTICS_TENANT_INGESTION_TOKEN`
- `ANALYTICS_TENANT_PRODUCER_ID` (default `tenant-platform-customer-analytics`)
- `ANALYTICS_TENANT_PUBLISHER_ID` (default `tenant-platform-analytics-publisher`)

From the repository root, run the publisher and backfill worker as separate
native processes:

```sh
KASITEK_PROCESS=analytics-publisher corepack pnpm --dir api start
KASITEK_PROCESS=analytics-backfill-worker corepack pnpm --dir api start
```

The publisher claims the Tenant outbox, sends authenticated batches, and applies
each Analytics acknowledgement without affecting the API process.

## Partner signup and self-service provisioning

Agency partners register through Labs Keycloak and create their own businesses
from the Agency portal. The partner becomes the primary owner. Workspace
creation does not require Labs Admin, an admin secret, or a manual database
insert. Internal admin provisioning remains available for platform support.

Start native Keycloak and Mailpit from the Labs checkout, configure the
`agency-partner` client, then start the Tenant API and portal using the
[repository setup](../README.md). In local development, visit
`http://localhost:3010/register`, complete email verification from
`http://localhost:8025`, sign in, and create a business. Keep the browser,
Keycloak and WebAuthn relying-party hostname on `localhost`.

The local Mailpit inbox captures verification messages; it does not deliver to
the address's external inbox. Real inbox delivery needs a configured production
email service. Google login also needs the authorized Google callback URI to
match the Labs Keycloak broker. Partners can manage branding, invite staff,
create clients, and preview `/portal/<slug>` from their Agency workspace.

Business creation saves an automatically generated portal slug, the selected
IANA reporting time zone, initial brand color, owner membership, and default
workspace limits in one transaction. Repeated submits reuse an idempotency key.
Custom-domain activation stays disabled until ownership verification is
implemented.

## Local Testing Notes

- Workspace resolution depends on request host or `TENANT_DEFAULT_WORKSPACE_SLUG`.
- Hosted tenant domains can be derived automatically from `{workspace_slug}.{TENANT_PLATFORM_BASE_DOMAIN}`.
- For local development, set `TENANT_DEFAULT_WORKSPACE_SLUG` if you are not routing real tenant domains locally.
- Domain verification compares tenant domains against `TENANT_PORTAL_HOST_TARGET`. In local development this can be `localhost`; in production it should be your shared portal host such as `portal.kasitek.com`.
- Client-user invites send through Resend when `TENANT_APP_BASE_URL` and `TENANT_RESEND_API_KEY` or `AUTH_RESEND_KEY` are configured.
- If invite email delivery is not configured locally, the API and portal UI fall back to exposing the activation link directly so the account-activation flow can still be tested.

## Existing staff and client accounts

Staff and client accounts remain workspace-specific and continue to use the
existing invitation and password activation flow. If Resend is not configured,
the portal displays a development activation link. A local default workspace
slug is only needed when testing legacy staff/client routes without a selected
portal URL; partner registration and business creation do not need it.
