# Monorepo hosting cutover

Status: Deferred. The owner requested source consolidation only, with no deployment now.
Only Growth is known to have been deployed. This runbook is for future fresh product deployments
and any later update to Growth hosting; it is not a gate for source consolidation.

The repository is now `Kasitek-Labs/kastek`. The source-only regrouping and rename do not
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
| Growth client | Monorepo root | Build shared packages, generate `@kasitek/database`, then build `client`; app path `products/growth/web` |
| Growth Core | Monorepo root | Build shared packages then `@kasitek/growth-core`; run in `products/growth/api` |
| Agents API | Monorepo root | `products/agents/api/railway.api.json`; Dockerfile `products/agents/api/Dockerfile` |
| Agents gateway | Monorepo root | `products/agents/api/railway.gateway.json`; same backend image, separate process |
| Agents worker | Monorepo root | `products/agents/api/railway.worker.json`; same backend image, separate process |
| Agents UI | Monorepo root | Dockerfile `products/agents/web/Dockerfile` |
| Agency API | Monorepo root | Build shared packages then `@kasitek/agency-tenants`; run in `products/agency/api` |
| Agency portal | Monorepo root | Build `tenant-portal`; app path `products/agency/web` |
| Analytics API/workers | Monorepo root | Build shared packages then `@kasitek/analytics`; keep independent start commands |
| Labs site | Monorepo root | Build `labs`; app path `apps/labs-site` |
| Admin site | Monorepo root | Build `@kasitek/admin-site`; app path `apps/admin-site` |
| Collector | `infra/observability/otel-collector` | Existing Dockerfile/profile; update repository source only at cutover |
| Identity | `infra/identity` | Preserve native Keycloak lifecycle and its own database/configuration |

Vercel root-directory settings may use the app path with access to workspace files outside that
root, or root commands with an explicit output path. Verify the provider-specific choice in a
preview before recording it as canonical. Growth client, Agency portal and Admin currently disable
Git deployments in their checked-in Vercel files; Labs enables them. Preserve this intent.

The Collector Railway IaC now identifies `Kasitek-Labs/kastek` on `rewrite`, where its source
exists. This prepares future deployment only; no provider setting has been applied. Confirm the
exact environment before applying it, and do not apply unrelated Railway resources.

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

## Vercel frontend release candidate

The 2 November 2026 rollout prepares five separate Vercel projects. Set each project's root to
its application directory and enable access to workspace files outside that root. Growth,
Agents and Agency use the checked-in application `vercel.json` to build from the frozen root
workspace, then run `scripts/hosting/vercel-output.mjs`. That command writes the application's
`.vercel/output` Build Output API artifact. Admin and Labs use their normal Next.js builds.
The source configuration does not establish hosted acceptance or change production aliases.

Supply these build-time origins before packaging:

| App | Backend origin | Public frontend origin |
| --- | --- | --- |
| Growth | `CORE_API_BASE_URL` | `FRONTEND_URL` |
| Agents | `AGENTS_API_PROXY_TARGET` | `FRONTEND_URL` |
| Agency | `TENANT_BACKEND_URL` | `FRONTEND_URL` |

Origins must use HTTPS, with no credentials, path, query or fragment. Generated routing includes
public origins only; it does not copy backend environment files or secrets. Set `VERCEL_ENV` to
`production` only for a production artifact; other artifacts receive `X-Robots-Tag: noindex`.
A prebuilt promotion must use the same tested origins and environment configuration.

Static assets are served by Vercel. Browser APIs use native external rewrites instead of a
function proxy, preserving the upload path outside Vercel Functions' payload limit. Growth's
organization-switch endpoint accepts the exact `FRONTEND_URL` or `KASITEK_CORE_PUBLIC_URL` Host
and still requires the exact frontend Origin, session cookie and workspace membership. This permits
the Railway HTTPS routing Host without trusting caller-supplied forwarded-host headers. Growth
private routes follow the route inventory, unknown routes and missing assets return 404, source
maps and hidden files remain unavailable, and documents use `no-store`. No Growth Vercel function
or function runtime environment is required.

MCP clients must connect to the Railway Growth API's canonical public origin. Its OAuth discovery,
registration, authorization, token and revocation endpoints remain on that API origin. Do not
advertise the Vercel frontend as the canonical MCP resource: Vercel reserves `/.well-known`
routing, and a function proxy would introduce payload and invocation-duration restrictions.

Agency accepts its exact `FRONTEND_URL` host and an explicitly configured verified wildcard.
For the existing deployment, set `FRONTEND_URL=https://portal.kasitek.co.za` and
`AGENCY_VERIFIED_WILDCARD_DOMAIN=*.portal.kasitek.co.za`. The wildcard must match that frontend's
hostname. Routing removes caller-supplied `x-kasitek-tenant-host`; the canonical portal route sets
its fixed host, while valid single-label tenant subdomains capture the matched public hostname
and set `x-kasitek-tenant-host` from that capture. Railway overwrites standard forwarded-host
headers, so tenant identity must use this separately sanitized header. This preserves each
tenant's hostname instead of replacing it with the portal hostname. Unrelated, malformed and unconfigured hosts return 421. Other custom domains remain
blocked. Native edge host forwarding, spoof resistance and tenant/session isolation must pass a
hosted preview before the existing wildcard production alias can be promoted.

Before promoting any alias, verify a real Vercel preview: OIDC callback and logout cookies,
organization switching, multipart upload above 5 MB where supported by the API, media downloads,
SSE first-chunk delivery/reconnect, query strings, redirect targets, private caching and missing
asset responses. Verify native edge rewrites and Agency header transforms in the hosted preview;
local route-contract tests cannot establish Vercel behavior. Canonical-host browser cookies must
remain separate from preview cookies. Record deployment IDs, source SHA, configuration revision
and previous alias targets. Roll back by restoring the previous Vercel deployment and matching
backend configuration; retain database state and do not replay provider effects.

This hosting change adds no analytics event or database migration. Existing API outcome logs and
telemetry remain authoritative. Hosting-specific validation is
`node --test scripts/hosting/vercel-output.test.mjs`; hosted preview acceptance remains required.
