# Kasitek Agency

Agency owns the tenant API, its database schema and migrations, and the tenant portal.

## Source layout

- `server/kasitek-tenants/` — Tenant Platform API and SQL migrations.
- `client/apps/tenant-portal/` — tenant and client portal.
- `client/packages/api-client-react/` — the portal's required tenant API client.

## Local commands

Install and run the portal:

```sh
corepack pnpm --dir client install --frozen-lockfile
corepack pnpm --dir client dev
```

The TypeScript Tenant API is implemented under `server/kasitek-tenants/src-ts/`.
The Rust source remains while consumer and retirement checks are completed.
Use Node 24.15.0 and pnpm 10.30.1:

```sh
corepack pnpm --dir ../kasitek-labs install --frozen-lockfile
node server/kasitek-tenants/scripts/prepare-shared.mjs ../kasitek-labs
corepack pnpm --dir server/kasitek-tenants install --frozen-lockfile
corepack pnpm --dir server/kasitek-tenants build
```

Copy `server/kasitek-tenants/.env.example` to `.env` in the same directory,
configure a dedicated Agency PostgreSQL database and workspace host/slug, then run:

```sh
corepack pnpm --dir server/kasitek-tenants start
```

The API binds port 8090 by default and exposes `/health`. Startup applies the
existing twelve SQL migrations using the same SQLx ledger, SHA-384 checksums
and database advisory lock. Do not start it against another product's database.
The portal runs on port 3010 and proxies through `TENANT_BACKEND_URL`, defaulting
to `http://localhost:8090`.

Run the Analytics publisher and backfill in separate native processes using
`KASITEK_PROCESS=analytics-publisher` or `analytics-backfill-worker`. The publisher
mode runs both loops, matching the source service. They require private ingestion
configuration; the API does not start these loops automatically.

Shared TypeScript packages are pinned local private artifacts for now. Their
authenticated package-registry delivery and production settings remain pending.
No hosted deployment has been performed.

## Ownership and integration

The source move does not change runtime behavior or deploy either service. Labs Admin consumes the Tenant API's provisioning endpoints. Portal routing, authentication cookies, tenant domains,
Analytics publication, and the shared Rust crate boundary are recorded in
[source boundaries](docs/source-boundaries.md).
