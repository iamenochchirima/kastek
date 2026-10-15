# Monorepo hosting cutover

Status: Source wiring prepared locally. Hosted cutover is blocked pending access and staging verification.

The destination remains `Kasitek-Labs/kasitek-growth`. The migration does not rename the repository,
merge databases, rotate secrets, change domains or deploy services. Keep existing repositories
available until every source consumer is reconciled and rollback is tested.

## Access and current evidence

The available Vercel account returned HTTP 403. The accessible Railway account did not list the
KasiTek projects. No live source settings, environment variables or deployments were changed.
Checked-in configuration cannot establish the actual running source branch, artifact or commands.

Before cutover, capture each provider project/service, environment, repository, branch, root,
configuration path, build/install/start command, health endpoint, watch paths, secret references,
previous artifact and rollback source settings. Record names and references without secret values.

## Intended source settings

| Deployable | Source/build root | Configuration or command |
| --- | --- | --- |
| Growth client | Monorepo root | Build shared packages, generate `@kasitek/database`, then build `client`; app path `products/growth/client/apps/client` |
| Growth Core | Monorepo root | Build shared packages then `@kasitek/growth-core`; run in `products/growth/server/kasitek-core` |
| Agents API | Monorepo root | `products/agents/railway.api.json`; Dockerfile `products/agents/Dockerfile` |
| Agents gateway | Monorepo root | `products/agents/railway.gateway.json`; same backend image, separate process |
| Agents worker | Monorepo root | `products/agents/railway.worker.json`; same backend image, separate process |
| Agents UI | Monorepo root | Dockerfile `products/agents/client/apps/agent-platform/Dockerfile` |
| Agency API | Monorepo root | Build shared packages then `@kasitek/agency-tenants`; run in `products/agency/server/kasitek-tenants` |
| Agency portal | Monorepo root | Build `tenant-portal`; app path `products/agency/client/apps/tenant-portal` |
| Analytics API/workers | Monorepo root | Build shared packages then `@kasitek/analytics`; keep independent start commands |
| Labs site | Monorepo root | Build `labs`; app path `apps/labs-site` |
| Admin site | Monorepo root | Build `@kasitek/admin-site`; app path `apps/admin-site` |
| Collector | `infra/observability/otel-collector` | Existing Dockerfile/profile; update repository source only at cutover |
| Identity | `infra/identity` | Preserve native Keycloak lifecycle and its own database/configuration |

Vercel root-directory settings may use the app path with access to workspace files outside that
root, or root commands with an explicit output path. Verify the provider-specific choice in a
preview before recording it as canonical. Growth client, Agency portal and Admin currently disable
Git deployments in their checked-in Vercel files; Labs enables them. Preserve this intent.

The Collector Railway IaC still identifies the old Labs repository. Change that source in the
approved cutover, after confirming the exact target branch and environment. Do not apply unrelated
resources from the shared Railway project.

Agents Docker builds use a root allowlist that excludes environment files, Git metadata, databases,
local artifacts and dependency directories. Runtime images contain packaged production dependencies,
compiled JavaScript and migrations. API, gateway and worker start commands remain image-relative.
Node 24 and pnpm 10.30.1 build these images. The docs sites retain their independent Node 22 installs,
and Railway IaC retains its isolated npm lockfile.

## Verification and promotion

1. Run a clean frozen workspace install, boundary checks, shared tests and the selected product builds.
2. Build both Agents images from the repository root. Confirm packaged contracts can be loaded,
   migrations are present, and no secret/local files enter the context or runtime image.
3. Start each artifact with isolated staging dependencies. Verify readiness, sign-in, service
   authentication, gateway/worker execution and existing telemetry as applicable.
4. Configure source settings per service, retain its previous artifact, and deploy to staging.
5. Record tested SHA/artifact digest/configuration revision. Promote only after rollout approval.
6. Observe health, errors, queue behavior and service/release identities. Revert that service to its
   previous tested artifact and source settings if checks fail. No database change is part of this move.

## Required checks and retirement

`Monorepo required checks` is the stable aggregate build/shared check. Product selection includes
all consumers for root tooling, lockfile and shared-package changes. Documentation and Collector
validation retain separate workflows; preserve their required checks where applicable. Confirm
branch protection against the actual workflow results before switching the canonical branch.

Do not archive or delete old repositories while source connections, scripts, external consumers,
branches or local work still depend on them. Hosted access, full artifact smoke checks, independent
rollbacks and final source reconciliation remain completion gates.
