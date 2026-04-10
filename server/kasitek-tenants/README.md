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
- `TENANT_CORS_ALLOW_CREDENTIALS`
- `TENANT_SESSION_COOKIE_NAME`
- `TENANT_SESSION_COOKIE_DOMAIN`
- `TENANT_SESSION_COOKIE_SECURE`
- `TENANT_SESSION_COOKIE_SAME_SITE`
- `TENANT_SESSION_TTL_HOURS`
- `TENANT_CLIENT_SESSION_COOKIE_NAME`
- `TENANT_CLIENT_SESSION_TTL_HOURS`
- `TENANT_INVITE_TTL_HOURS`

## Bootstrap A Tenant

Create a tenant workspace, branding row, domain, first tenant admin, and initial API key:

```bash
cargo run -p kasitek-tenants --bin bootstrap_tenant -- \
  --workspace-slug acme \
  --workspace-name "Acme Agency" \
  --admin-email owner@acme.com \
  --admin-password "change-this-password" \
  --admin-name "Acme Owner" \
  --domain portal.acme.local \
  --primary-color "#0f172a" \
  --secondary-color "#334155" \
  --api-key-label "initial-provisioning-key"
```

The command prints:

- `workspace_id`
- `tenant_admin_user_id`
- `api_key`

Store the printed API key securely. Only the hash is stored in the database.
