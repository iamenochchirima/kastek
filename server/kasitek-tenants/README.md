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

## Verify A Tenant Workspace

Validate that a bootstrapped workspace still has its core tenant setup in place:

```bash
cargo run -p kasitek-tenants --bin verify_tenant_workspace -- \
  --workspace-slug acme \
  --expect-domain portal.acme.local
```

The command prints a small summary including:

- workspace status
- domain count
- owner/admin bootstrap count
- tenant client count
- client user count
- lead count
- conversation count
- API key count

## Seed Demo Data

Once a workspace exists, you can seed a tryable tenant client account plus sample portal data:

```bash
cargo run -p kasitek-tenants --bin seed_tenant_demo -- \
  --workspace-slug acme \
  --client-name "Acme Dental" \
  --client-slug acme-dental \
  --client-user-email owner@acmedental.com \
  --client-user-password "change-this-password" \
  --client-user-name "Acme Dental Owner"
```

This creates:

- 1 active tenant client
- 1 active client user with password login
- 2 active agents
- 4 leads
- 3 conversations
- 6 messages
- usage events for the tenant dashboard

If `TENANT_APP_BASE_URL` is set, the command also prints the tenant login URL and the client portal URL.

## Local Trial Flow

1. Start the tenant backend with a tenant database configured.
2. Bootstrap a workspace with `bootstrap_tenant`.
3. Seed a tenant client with `seed_tenant_demo`.
4. Start `client/apps/tenant-portal`.
5. Sign in at `/login` with the tenant admin credentials from bootstrap.
6. Inspect dashboard, clients, leads, and client activity.
7. Sign out, then sign back in with the seeded client-user credentials to test `/client`, `/client/leads`, and `/client/conversations`.
