# Kasitek Agency

Agency owns the tenant API, its database schema and migrations, and the tenant portal.

## Source layout

- `api/` — Tenant Platform API and SQL migrations.
- `web/` — tenant and client portal.
- `api-client/` — the portal's required tenant API client.

## Local commands

Use Node 24.15.0 and pnpm 10.30.1 from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:shared
pnpm dev:agency
# In a second terminal, after configuring Agency's local environment:
pnpm dev:agency-api
```

The TypeScript Tenant API is under `api/src/`. The retired Rust implementation remains
recoverable at Agency commit `2c7902170a8f75257c0e47b86ffaf38068dd2227`.

Copy `api/.env.example` to `.env` in the same directory and
configure a dedicated Agency PostgreSQL database. `TENANT_DEFAULT_WORKSPACE_SLUG`
is optional and is only needed for legacy staff/client login without a selected
portal URL. Partner signup and business creation do not need a pre-created
workspace. Then run:

```sh
pnpm --dir products/agency/api start
```

The API binds port 8090 by default and exposes `/health`. Startup applies the
all Agency SQL migrations using the same SQLx ledger, SHA-384 checksums
and database advisory lock. Do not start it against another product's database.
The portal runs on port 3010 and proxies through `TENANT_BACKEND_URL`, defaulting
to `http://localhost:8090`.

For partner self-service locally, start Labs Keycloak and Mailpit, configure the
Labs `agency-partner` client with the same client secrets as the Tenant API, then
open `http://localhost:3010/register`. Email verification links are captured in
Mailpit at `http://localhost:8025`; messages are not delivered to external inboxes
in local development. See the [Agency implementation checklist](../../docs/programs/agency-self-service/IMPLEMENTATION.md)
for the current feature and verification status.

Run the Analytics publisher and backfill in separate native processes using
`KASITEK_PROCESS=analytics-publisher` or `analytics-backfill-worker`. The publisher
mode runs both loops, matching the source service. They require private ingestion
configuration; the API does not start these loops automatically.

Shared TypeScript packages resolve through the root workspace and explicit package exports.
Hosted source paths and production settings still require verification.
No hosted deployment has been performed.

## Ownership and integration

The TypeScript migration has not deployed either service. Labs Admin consumes
the Tenant API's provisioning endpoints. Portal routing, authentication
cookies, tenant domains, Analytics publication, and private TypeScript package
ownership are recorded in
[source boundaries](docs/source-boundaries.md).

For a future Railway deployment, configure the monorepo workspace and service source
`products/agency/api/`; see the [hosting cutover record](../../docs/operations/hosting-cutover.md).
The service package retains `pnpm build` and `pnpm start`. Set `TENANT_SERVER_PORT` or Railway's `PORT`, health path
`/health`, and a dedicated Agency database URL. The API and dedicated workers use
the same artifact with different `KASITEK_PROCESS` values. All processes run the
same guarded migration startup. Hosted build access and deployment settings have
not been verified or applied.

## Agency frontend

The landing page, partner business manager and white-label portal use React,
TypeScript, React Router and Vite. The visual foundation is copied from the
Agents app, including Geist fonts, sidebar/header and appearance preferences.
Business branding is separate from the partner's appearance preferences.

Use Node 24. From the repository root run `pnpm dev:agency` for the frontend at `http://localhost:3010`.
The Tenant API remains at port 8090. Vite forwards `/api/tenant/*` to it,
including cookies and authentication redirects. Set `TENANT_BACKEND_URL` in
`web/.env.local` if the API is elsewhere. Never put client
secrets in `VITE_*` variables.

For a local production build, run `pnpm build:agency`, followed by
`pnpm --dir products/agency/web start`. This starts the native
static server and API proxy on port 3010. `PORT` and `HOST` override the listening
address; the default is loopback. When hosted behind HTTPS, configure
`PORTAL_PUBLIC_PROTOCOL=https` and the corresponding existing Agency auth/public
URL settings. Deployment itself is outside this UI migration.

Focused proxy verification: `pnpm --dir products/agency/web test:server`.
The visual migration checklist is in
[`UI_IMPLEMENTATION.md`](../../docs/programs/agency-self-service/UI_IMPLEMENTATION.md).

## Shared agent execution

Authorized staff can open **Assistant** from a client detail page. Agency owns the session,
workspace/client assignment, setup mappings and metadata grant; the shared Agents runtime owns
accepted work and context. Conversations, activity, elapsed time, subagent modals and reviewed
memory management use the shared UI package. Memory starts disabled. Legacy voice/metadata
records do not become executable shared agents automatically.

Configure separate private ingress/action trust and an explicit managed model profile before use.
The [capability reference](docs/agent-capabilities.md) lists endpoints, current client boundaries,
environment settings, migrations, verification and rollback. Ordinary Agency features continue
independently when shared execution is unavailable. No production rollout is implied.
