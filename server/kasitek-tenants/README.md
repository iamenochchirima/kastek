# tenant-server

Separate Rust backend for white-label tenant services.

Initial scope:

- workspace-scoped API key auth
- tenant-isolated agent configuration
- tenant-isolated conversation history
- usage reporting and limits
- branding/domain configuration

This service is intentionally separate from the KasiTek core `server/` deployment.

## Required Environment

Minimum environment for local development:

- `TENANT_DATABASE_URL`
- `TENANT_SERVER_PORT` or `PORT`
- `TENANT_ALLOWED_ORIGINS`

Useful auth and portal settings:

- `TENANT_APP_BASE_URL`
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
- `TENANT_INVITE_TTL_HOURS`

## Real Provisioning Flow

Tenant workspaces are provisioned through the admin application, not through local bootstrap scripts.

Expected flow:

1. Start `kasitek-core`, `kasitek-tenants`, the admin app, and the tenant portal app.
2. In the admin UI, create a new agency workspace from `/agencies/new`.
3. Use the tenant admin email and password entered there to sign into the tenant portal.
4. Inside the tenant portal, create tenant clients from the Clients screen.
5. Invite client users from the same screen and complete activation through `/activate?token=...`.

## Local Testing Notes

- Workspace resolution depends on request host or `TENANT_DEFAULT_WORKSPACE_SLUG`.
- For local development, set `TENANT_DEFAULT_WORKSPACE_SLUG` if you are not routing real tenant domains locally.
- Client-user invites send through Resend when `TENANT_APP_BASE_URL` and `TENANT_RESEND_API_KEY` or `AUTH_RESEND_KEY` are configured.
- If invite email delivery is not configured locally, the API and portal UI fall back to exposing the activation link directly so the account-activation flow can still be tested.

## Local Trial Flow

1. Start the tenant backend with a tenant database configured.
2. Start the admin app and provision a workspace from the admin UI.
3. Start `client/apps/tenant-portal`.
4. Sign in at `/login` with the tenant admin credentials created in admin.
5. If the workspace does not have its own mapped domain locally, set `TENANT_DEFAULT_WORKSPACE_SLUG` to the new workspace slug before testing the portal.
6. Inspect dashboard, clients, leads, and tenant activity.
7. Create a tenant client and invite a client user.
8. Open the activation link, or receive the real invite email if Resend is configured, create the client-user password, and verify `/client`, `/client/leads`, and `/client/conversations`.
