---
id: local-development
title: Local Development
sidebar_position: 2
owner: engineering
last_reviewed: 2026-10-24
---

# Local Development

This page describes the supported local development paths for the KasiTek monorepo. Start only
the services needed for the change; the complete stack is useful for integration work but is not
required for ordinary UI or library changes.

Paths and commands on this page are relative to `products/growth/` unless stated otherwise.
Install dependencies from the repository root with `pnpm install --frozen-lockfile`. Root
`pnpm dev:growth` and `pnpm dev:growth-api` also start the frontend and API directly.

## Shared frontend controls

Growth imports workspace controls and theme tokens from `@kasitek-labs/ui` in
`packages/ui/`. Growth dev, build and typecheck commands build its JavaScript and
declarations first. Rebuild that package after changing a shared React control during
a running development session. Theme CSS is consumed directly from source. See the
[root package guide](https://github.com/Kasitek-Labs/kastek/blob/main/packages/ui/README.md) for exports and styling boundaries.

## Toolchain

Use the versions pinned by the repository where they exist:

- Node.js: root `.nvmrc`
- pnpm: root `package.json` `packageManager`
- PostgreSQL and Redis for services that require them

Check the installed versions before debugging application failures. A mismatched toolchain can
look like a code or dependency problem.

## Core build output

Core uses native TypeScript under `api/src`. Build its production
JavaScript with:

```bash
pnpm --dir api build
```

The compiler writes `api/dist`. Growth no longer carries a Rust
Core build directory. The prior Rust source remains recoverable from Git history.
For standalone Core setup, use [`api/.env.example`](https://github.com/Kasitek-Labs/kastek/blob/main/products/growth/api/.env.example)
as the non-secret baseline. OIDC client values are listed separately in
[`api/.env.identity.example`](https://github.com/Kasitek-Labs/kastek/blob/main/products/growth/api/.env.identity.example);
the root dotenv vault remains the source for local credentials.

## Environment files

The local stack uses the root dotenv-vault as the merged source of truth. The working copies are
generated into service-specific dotenv files and must not be committed with secrets.

```bash
./scripts/sync_dotenv_vaults.sh login   # one-time bootstrap
./scripts/sync_dotenv_vaults.sh pull
./scripts/sync_dotenv_vaults.sh status
```

After changing a local environment file, push the intended change to the vault only when that is
part of the task:

```bash
./scripts/sync_dotenv_vaults.sh push
```

Never paste credentials into a plan, issue, log, test fixture, or documentation page.

## Shared login

Growth login requires the native shared Keycloak service. From the repository root, start it
before Core and the client:

```bash
cd infra/identity
./identity.sh start
```

The first setup requires explicit `./identity.sh install` and secret configuration described in
root `infra/identity/README.md`. No Docker. Identity PostgreSQL is a separate local cluster on
port 55432; Growth's existing database is unchanged. Stop identity with `./identity.sh stop` when
it is not needed.

Set the Core OIDC variables from [the shared login contract](../architecture/shared-login.md).
Use `http://localhost:3000/api/auth/callback` through the same-origin frontend proxy. The account console owns
email/password, Google, passkeys, optional two-factor authentication and recovery. The development
email inbox is `http://localhost:8025/`; set Core `LOCAL_MAILPIT_URL` for organization invitations.

## Starting services

### Fixed local ports

From the repository root, `pnpm dev:ports` lists the reserved service ports. The local
Agents + Labs profile starts with `pnpm dev:local start`; use `restart`, `status` or `stop`
with the same command. It never searches for another port or stops an unowned process.

| Service | Port |
| --- | --- |
| Labs | 3050 |
| Agents web | 3150 |
| Agents API | 4150 |
| Agents worker | 9150 |
| Restate ingress / admin | 18580 / 19570 |

This command starts the existing Agents + Labs workspace with the real configured model.
Private `.runtime/local-dev/profile.json` identifies the existing organization, agent and
website deployment; its `environmentFile` points to private JSON environment values containing
the local database and vault settings. Both files are ignored by Git. Configure these once;
startup reuses them and never creates or drops a database, replaces an agent, or chooses a model.
The profile requires an owned loopback development database. It is not a production launcher.
Other product commands remain independent; the port list reserves their addresses without
starting them. Automated isolated test fixtures retain their own separate lifecycle.

The development-only owner sign-in link is printed on startup. API, web and Labs listeners stay
on loopback. The worker listens on the Docker bridge for Restate. Stop retains the database and
owned Restate journal volume. Only recorded process identities are stopped. A stale process record
cannot authorize stopping an unrelated process. Inspect `.runtime/local-dev/runtime.log` on failure.

Release impact: local CLI/configuration only; production rollout, analytics events, new business
migrations and production version changes are not applicable. Existing API/worker/model logic is
reused. Validation covers fixed-port conflicts and the real Labs widget. To disable this local
profile, run `pnpm dev:local stop`; keep private data and credentials for the next start.

### Facebook development tunnel

The existing Cloudflare `KasiTek Dev` tunnel publishes `https://dev-client.kasitek.co.za`.
Its published application must target the running Growth frontend, currently
`http://localhost:3002`, rather than an unrelated application on port 3000. The frontend
proxies `/api` to Growth Core on port 4000. The system `cloudflared` service uses a
remotely managed route; inspect it in Cloudflare Networking → Tunnels before changing
local ports. Keep identity and other product services on loopback.

For a tunnel session, align Core `FRONTEND_URL` and the web server's `FRONTEND_URL` with
`https://dev-client.kasitek.co.za`, Core `KASITEK_CORE_PUBLIC_URL` with the same origin,
and Core `OIDC_REDIRECT_URI` with `https://dev-client.kasitek.co.za/api/auth/callback`.
Register that exact callback, origin and `/login` logout return on the local Keycloak
Growth client. Preserve other product registrations and existing local callbacks.
The Meta callback remains `https://dev-client.kasitek.co.za/api/social/oauth/meta/callback`.

Start Growth sign-in and Facebook Connect from the public tunnel origin. A login or
connection started on localhost has different cookies and cannot finish on the tunnel
origin. After changing origins, restart Growth API and web with their other settings
preserved. Returning to local-only work requires restoring the localhost frontend and
OIDC callback settings. Do not push a temporary tunnel override to the dotenv vault.

The launcher uses the native Node.js 24 Core. See
[TypeScript Core commands and worker modes](typescript-core.md). Stop any Core
process already using port 4000 before starting it.

The launcher opens requested Growth processes in their own terminals. It does not start the moved
Analytics, Agency, or Agent services. Their source and local commands are under root
`services/analytics/`, `products/agency/` and `products/agents/`. Growth retains its product
publishers and consumer integrations.

```bash
./scripts/run_local_stack.sh core client
./scripts/run_local_stack.sh internal-docs  # Internal docs at http://localhost:3006
./scripts/run_local_stack.sh --help
```

This launcher does not start the tenant API or portal. Their source and local commands are in the
`products/agency/README.md`.

The default no-argument invocation starts Growth-owned Core, client apps, and internal docs. The
moved services and their migrations are maintained in their owning product packages.

For focused work, manual commands are also supported:

```bash
./scripts/dev_core_watch.sh
pnpm --dir web run dev
```

## Growth frontend build

Growth uses React 19 with Vite and React Router framework mode. Development runs on port 3000.
The production build prerenders `/` and emits the private application shell separately.
React Router client loaders replace Next server components; Core still owns authorization,
cookies, data, and mutations. Route declarations are in `web/src/routes.ts`.

From the repository root, build the shared packages and Growth services with:

```bash
pnpm build:growth
```

To run the built frontend against an existing Core process:

```bash
CORE_API_BASE_URL=http://localhost:4000 FRONTEND_URL=http://localhost:3000 pnpm --dir products/growth/web start -- --hostname 127.0.0.1 --port 3000
```

The frontend serves `web/build/client` through `web/scripts/serve.mjs`. Its `/api/*` reverse
proxy preserves browser cookies, multiple Set-Cookie headers, uploads, and streaming responses.
Use this server for production-path checks; `vite preview` is not the production server.
Do not put API secrets or signing keys in `VITE_*` variables. Those values enter the browser bundle.
`VITE_META_APP_ID` and `VITE_META_EMBEDDED_SIGNUP_CONFIG_ID` are public build-time identifiers
for WhatsApp embedded signup. Set them before building when that flow is required.

See the [frontend release runbook](../operations/growth-frontend-release.md) for proxy configuration,
SEO, PWA updates, validation, and rollback. The root `dev:growth` command continues to use the
`client` workspace package; other products retain their own frontend frameworks.

The central Admin UI is under root `apps/admin-site/`. Run `pnpm dev:admin` from the repository root.

## Local service ports

| Service | Default port | Liveness or readiness check |
| --- | ---: | --- |
| Core API | 4000 | `/health` (liveness; PostgreSQL is checked before the server listens) |
| Client | 3000 | browser application |

The launcher is the authoritative list for local service names and ports. If an individual
service changes its port, update the launcher and this table together.

## Local OpenTelemetry export

The Collector is under root `infra/observability/`. Use its
[local-run instructions](https://github.com/Kasitek-Labs/kastek/blob/main/infra/observability/otel-collector/README.md).
It accepts OTLP over gRPC on `4317`, OTLP over HTTP/protobuf on `4318`, and exposes its health
endpoint on `13133`. The debug exporter is for local inspection only; it is not durable storage.
When a local Collector is running, point a Growth producer at it with:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_DEPLOYMENT_ENVIRONMENT=local
export OTEL_SERVICE_NAME=kasitek-core
```

For Core also set `KASITEK_VERSION`, `KASITEK_RELEASE_ID`, and `KASITEK_COMMIT_SHA`
when testing release identity. The application continues with stdout logging when these
variables are absent or `OTEL_SDK_DISABLED=true`. For Collector operation, see the
[Labs Collector runbook](https://github.com/Kasitek-Labs/kastek/blob/main/docs/labs/otel-collector-runbook.md).

## Verification before opening a pull request

- Run the narrowest relevant test or type check.
- Run the service build when changing deployment or integration boundaries.
- Exercise the changed user or API path locally.
- Confirm logs contain no credentials or unnecessary personal data.
- Record any required migration, environment, analytics, logging, or documentation change in the
  release record.

For release work, follow the internal [Feature and Platform Release Process](../operations/release-process.md).

## Growth agent setup worker

New organisations queue four managed agents and their model automatically. Configure the explicit
model profile and independent provisioning keypair in [Growth integration](https://github.com/Kasitek-Labs/kastek/blob/main/products/agents/docs/growth-integration.md#automatically-provision-organisation-defaults).
When API background workers are disabled, start a dedicated API process with
`KASITEK_PROCESS=growth-agent-setup-worker`. Run `pnpm --filter @kasitek/growth-core agents:setup status`
to inspect setup counts, attempts, pending age and duration; use its bounded `backfill 100` command
for organisations created before this worker was enabled. No model inference or evaluations run
as part of setup.


Defaults revision 3 keeps the existing Growth assistant, Research, Content and Campaigns. The
assistant can coordinate the three specialist versions through the shared adaptive runtime;
Growth remains the authority for business membership, record access and exact draft approval.
New setup jobs and bounded missing-organisation backfill target revision 3. Existing revision 2
jobs retain their original signed publication. To upgrade an existing organisation explicitly,
run `pnpm --filter @kasitek/growth-core agents:setup upgrade-defaults <organisation-id>`; unchanged
managed defaults can advance while owner customisations remain protected. Do not substitute a
database update for the setup operation.

The browser sends active-task instructions through `POST /api/agents/tasks/:taskId/instructions`
with a stable `requestId` and at most 4,000 characters. Accepted instructions are queued for a later
model step. A lost acknowledgment retries the same request; it does not create another task.
`POST /api/agents/tasks/:taskId/continue` requests renewed access. Both commands enforce the current
Growth origin and business/member scope before signed execution. Cancellation keeps the task and
conversation available for inspection and subsequent messages. Root review routes include only
specialist reviews verified as belonging to that authorized root; exact decisions retain the
actual child operation and payload digest.

The current capability endpoint accepts exact published manifest/policy pairs for revisions 2 and
3. It validates arguments against the selected version, rejects mixed digests, and returns bounded
argument feedback for malformed model calls. Chat-only drafting does not prepare a saved-draft
review. Publishing, scheduling, external web research, personal memory and sandbox execution remain
unavailable through these Growth defaults.

Completed specialist work can be inspected from its conversation turn. Growth authenticates the root task export and returns only a direct child's terminal state and output, in pages of 4,096 Unicode code points. Redacted output stays unavailable. The raw execution capture is not exposed by this result route. Task progress and failure messages remain attached to the corresponding turn; model interruption does not imply an uncertain external action or enable terminal-task continuation. Draft decisions require the scoped task review endpoint; the unscoped legacy decision route rejects before changing a review. Failed new-conversation creation retries the same creation identity instead of reopening the saved conversation.

Conversation refreshes adopt the server title after the first prompt while preserving unsent drafts. The floating assistant launcher is hidden on full conversation routes so it cannot cover the composer.
