# Rust migration baseline

The implementation-start repository snapshot was recorded 2026-10-02. The route and process inventories were regenerated 2026-10-04 from pinned Git source baselines. These are source records, not proof of runtime behavior or TypeScript parity. No services were started or stopped and no database was queried or changed during inventory generation.

## Files and reproduction

- [ROUTES.json](ROUTES.json) contains one record per registered method/path, preserving registration order within each registry. Each record links its handler source and line, exact handler signature, parsed JSON/query/path/form/stream inputs, request type declaration locations across the pinned repos, direct authorization/error/status/effect evidence, delegated calls, transport details and intended owner. This is static tracing aid; it does not prove transitive authorization or runtime behavior. The generator also records manual web::Query::<T>::from_query calls inside handler bodies; the updated inventory captures Growth /api/agents and Agency /api/client-auth/invite.
- [processes.json](processes.json) records process modes, worker sources/environment names, repository state, migration files with checksums/SQL declarations, and literal consumer references.
- Run `python3 plans/typescript-migration/tools/inventory.py` from the workspace to regenerate both JSON files. It reads the pinned Rust source commits below with `git show`/`git ls-tree`, plus current consumer and repository metadata. The Rust files do not need to exist in the active checkouts, and the tool does not start services or access a database.
- [PARITY.md](PARITY.md) remains the acceptance record. Route IDs in this fixture identify operations to account for there; a source record does not close a parity row.

## Repository snapshot

| Repository | Branch | HEAD | Local status entries |
| --- | --- | --- | --- |
| kasitek-growth | `rewrite` | `322926ec14e4e01449adb18ac6984498c2867731` | 0 |
| kasitek-labs | `main` | `cebeab86fcc8ab985cdf4250e76feedbd8b2328e` | 0 |
| kasitek-agency | `main` | `a925ee9fb63c2b034ab73860b24df961879ae65d` | 0 |
| kasitek-agents | `main` | `19de0881385e09d6ce1c4c110cf11a9b37d97b81` | 0 |

The repository table above is the recorded implementation-start snapshot. `processes.json` records repository heads and worktree state at its latest regeneration. The original Analytics Rust source is recoverable from `kasitek-labs@4eb66ad`; the route fixture reads pinned Git baselines rather than expecting Rust files in the active checkouts.

## Registered HTTP operations

| Owner | Operations |
| --- | --- |
| growth | 537 |
| agency | 81 |
| analytics | 15 |

Growth comprises product 173, public v1 22, internal 200, provider webhooks 10, website 17 and admin 115 operations. Agency has 81 and Analytics has 15. All six Growth registries are mounted through `routes::configure`, `bootstrap/routes.rs` and `bootstrap/app.rs`.

The parser's route count matches every `.route(` occurrence in each registration file. All registered handlers resolve to an existing source file. Nested `scope` and `resource` expressions are composed rather than treated as independent paths. For example, nested social OAuth paths resolve under `/api/social/oauth/`, and Admin nested billing scopes retain `/api/admin`.

This count excludes framework-generated HEAD/OPTIONS behavior and unmatched-path fallbacks. Global CORS middleware may generate preflight responses without an explicit registered OPTIONS operation. The website registry has explicit widget OPTIONS routes, which are included. No conditional registration was found in Growth or Agency registries. Analytics app registration is conditional on ProcessKind::Api. Health configuration accepts Worker, but the actual Analytics worker executable does not start an HTTP server; do not invent worker health endpoints from that reusable function.

Registration order matters for literal versus dynamic paths, especially `/api/agents/conversations/live`, `/events/stream` and `/{conversationId}`. JSON order preserves the order within each source; alphabetical enumeration of registry files does not represent cross-registry startup order.

## Transport-sensitive routes

The route manifest tags these operations separately from ordinary JSON endpoints. IDs resolve to full source, caller, input and response evidence in `ROUTES.json`; the counts below are inventory evidence, not runtime parity claims.

| Behavior | Source route IDs | Migration concern |
| --- | --- | --- |
| Streaming/SSE | `R0013`, `R0116`, `R0304`, `R0307`, `R0315` | Event framing, reconnect/cursor behavior, cancellation, backpressure and response headers. |
| Multipart uploads | `R0350`, `R0431`, `R0456`, `R0470` | File/field limits, MIME checks, exact bytes, parser errors and persistence. |
| Streamed binary request bodies | `R0141`, `R0251`, `R0299` | Ogg and generic binary media must remain byte-exact and bounded. |
| Signed raw-body webhooks | `R0489`, `R0491`, `R0493`, `R0494` | Paystack, WhatsApp, Meta and TikTok signatures depend on the unparsed request bytes. |
| Other byte-body operation | `R0426` | The social-post DELETE handler receives an opaque request body; preserve its parsing/error behavior. |
| Cookie/session operations | `R0001`, `R0002`, `R0359`, `R0360`, `R0391–R0400`, `R0404`, `R0405`, `R0541`, `R0542`, `R0545`, `R0548`, `R0549`, `R0551–R0553` | Session scope, cookie flags, clearing, state binding and cross-origin behavior. |
| Redirect/callback and header-sensitive responses | `R0359`, `R0360`, `R0390–R0400`, `R0404–R0409` | OAuth return targets, callback errors, content type and response headers. `append_header`/`insert_header` also tag stream and download routes; inspect the specific route rather than assuming every header tag is a redirect. |

Public widget/deployment credentials, public-v1 API keys, provider signatures, Analytics producer credentials, Agency API keys and Growth's signed internal delegation are separate machine-auth boundaries. They are described in [Authorization boundaries](#authorization-boundaries); they must not be collapsed into the user-cookie cases above.

## Authorization boundaries

- Growth product handlers use user extraction, active-organization resolution, role and billing-capability checks as appropriate. OIDC initiation/callback, invitation previews and health are exceptions. Cookie Origin checks are implemented in identity/user extraction, not a route-group wrapper.
- Growth `/v1` has `services::public_api::middleware`. Handler/service request context still owns authentication, principal scopes, entitlement, rate limits and effect authorization. Preserving that wrapper alone is insufficient.
- Growth internal Agent actions use signed delegation keys and a per-action capability. The static Bearer fallback is disabled in production and requires organization context in development. Product Agent proxy paths use customer/session permissions rather than this machine boundary. They are registered in the same `internal` file but are distinct access models.
- Growth Admin retains its own authentication and role/entitlement checks. Website widgets use public deployment/session credentials and deployment Origin restrictions. Provider webhooks use provider-specific validation rather than customer cookies.
- Agency has separate workspace/staff and client sessions, API-key contexts, tenant/client filtering and privileged administration. `controllers/admin.rs::require_admin_secret` returns success if no secret is configured. Its comment says development only, but this function does not itself check environment. This is existing behavior to flag explicitly during parity/security review.
- Analytics ingestion/reconciliation/work queues authenticate producers; reporting authenticates signed reporting grants and applies scope authorization in the transaction; scope resolution authenticates a source-service resolver; rollout authenticates allowlisted producers; metrics has its own access configuration. Health endpoints are unauthenticated dependency probes.

The per-route `directAuthorizationEvidence` and `authorizationCallSites` describe direct calls, not the full transitive call graph. Delegated service calls must be inspected when porting an operation. A record with no direct guard does **not** imply public access. Many Admin and product handlers delegate their entire implementation. Authorization/error/response behavior still requires focused runtime fixtures before retirement.

## Process modes

| Owner | Mode | Embedded work or role |
| --- | --- | --- |
| growth | `api` | whatsapp_inbox, email_inbox, social_publishing, social_insights, whatsapp_campaigns, public_webhooks, billing_reconciliation |
| growth | `social-publishing-worker` | social_publishing |
| growth | `social-insights-worker` | social_insights |
| growth | `whatsapp-marketing-worker` | whatsapp_campaigns |
| growth | `whatsapp-inbox-worker` | whatsapp_inbox |
| growth | `email-inbox-worker` | email_inbox |
| growth | `billing-reconciliation-worker` | billing_reconciliation |
| growth | `analytics-publisher` | analytics_publisher, analytics_backfill |
| growth | `analytics-backfill-worker` | analytics_backfill |
| growth | `public-webhooks-worker` | public_webhooks |
| growth | `all-workers` | whatsapp_inbox, email_inbox, social_publishing, social_insights, whatsapp_campaigns, public_webhooks, billing_reconciliation, analytics_publisher, analytics_backfill |
| agency | `api` | see source |
| agency | `analytics-publisher` | analytics_publisher, analytics_backfill |
| agency | `analytics-backfill-worker` | analytics_backfill |
| analytics | `analytics-api` | HTTP API |
| analytics | `analytics-migrate` | see source |
| analytics | `analytics-registry` | see source |
| analytics | `analytics-worker` | see source |

Growth selects modes with KASITEK_PROCESS. Unset **and unrecognized** values fall through to API. Its API embeds seven workers unless KASITEK_DISABLE_BACKGROUND_WORKERS is truthy. Analytics publisher/backfill are not among those API defaults. The `analytics-publisher` mode runs publisher and backfill together; `all-workers` runs all nine workers. Do not start overlapping real workers during comparison.

Agency migrates with SQLx before dispatching **every** process mode. Its API starts no embedded publisher/backfill. Its `analytics-publisher` mode runs both together. Unrecognized KASITEK_PROCESS falls through to API.

Analytics has four executables. `analytics-api` exposes HTTP and loads registry/auth/cache dependencies; `analytics-worker` runs projections with maintenance each poll and has Ctrl-C shutdown; `analytics-migrate` runs migrations; `analytics-registry` checks generated bindings by default or with --check and writes with --write, rejecting simultaneous --check/--write with exit 2. Growth and Agency worker modules do not have an explicit Ctrl-C branch in the inspected files; OS termination and runtime shutdown semantics need actual verification rather than an invented graceful-drain guarantee.

## Database and worker contracts

The pinned source inventory contains 82 Growth Prisma migrations, 12 Agency SQLx migrations and 23 Analytics SQLx migrations. Original paths and content hashes are recorded. Keep Growth `_prisma_migrations` authority and SQLx `_sqlx_migrations` histories. The JSON includes SHA-256 for recovery comparison and SHA-384 for SQLx checksum comparison. Live applied versions and checksums were not inspected here.

Analytics migrations use stable advisory lock `7482031945` on the same acquired connection passed to SQLx. Readiness requires PostgreSQL and successful foundation migration `20260822000000` plus the `analytics` schema. The replacement must preserve these deployment/readiness semantics.

Worker source records identify explicit environment names and transaction/locking mechanisms. They point to the canonical code for leases, retries, batches, outbox claims, backfill checkpoints and quarantine. SQL declaration extraction lists tables/indexes/functions/triggers/RLS policies from migration files but is supplemental to the original SQL. It cannot establish current live database state or all query effects.

Analytics projection worker invokes maintenance then processes up to the configured batch, continuing after logged failures. Its worker ID, polling interval, lease duration and batch size are environment-configurable. Source defaults, retry envelopes, event hashes, projection generations and reporting scope/RLS semantics must be copied from the service and shared crates, not inferred from route names.

## Consumers and remaining baseline work

Consumer references cover Growth customer frontend, Labs Admin, Labs site, Agency portal, Agency React API client and Agents. Literal path references are saved with source paths. Dynamic/interpolated URLs, runtime environment targets, imported client wrappers, provider callback registration and hosted configuration still need semantic inspection. No secret values are recorded. The inventory generator points each owner at the actual `src-ts/` implementation directory.

### Local consumers, service wiring and external callbacks

Inspected 2026-10-03 from the current manifests, environment examples, launch scripts, route registrations and service configuration. `processes.json` has the full literal consumer references; this section resolves the dynamic base URLs. Environment names below are names only. Never copy values from local dotenv files into this record.

| Component | Local consumer and traffic | Port and health | Native build/start commands | Environment and credential sources |
| --- | --- | --- | --- | --- |
| Growth customer app | Next app on 3000; `/api/*` uses its same-origin Core proxy. Calls Core; social/email/provider callbacks return through that proxy. | 3000; no dedicated health route | `pnpm --dir client dev`; `pnpm --dir client/apps/client build`; root local launcher `./scripts/run_local_stack.sh core client` | App reads `CORE_API_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_USE_API_PROXY`, `NEXT_PUBLIC_META_APP_ID`, `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID`, `OPENROUTER_API_KEY`, and `OPENROUTER_MODEL`. There is no app-level `.env.example`; root dotenv vault and the app source are the current configuration record. |
| Growth Core | Serves Growth app, Labs Admin, Labs public-site/embed, Agents product bridge, provider integrations, and Growth's own workers. Calls Analytics and Agents. | 4000; `GET /health` | `pnpm --dir server/kasitek-core build`, then `pnpm --dir server/kasitek-core start`; `pnpm --dir server/kasitek-core dev` for watch mode. Prisma migration command is `pnpm --dir client db:migrate`. | `server/kasitek-core/.env.example` and `.env.identity.example`; `DATABASE_URL` is required. Identity secrets are named in the latter and Labs identity example. Provider credentials are conditional by feature: `AUTH_*` for social providers and `KASITEK_EMAIL_GOOGLE_*` / `KASITEK_EMAIL_MICROSOFT_*` for mailbox OAuth. Production Agents bridge requires `AGENTS_API_URL` and `AGENTS_INTERNAL_AUTH_SECRET`. |
| Labs Admin | Admin UI calls Growth Core (`CORE_BACKEND_URL`) and Agency Tenant (`TENANTS_BACKEND_URL`); links to Agency portal. | 3001; no dedicated health route | `pnpm --dir apps/admin-site dev`, `build`, or `start` from its standalone app checkout | `apps/admin-site/.env.example`: `CORE_BACKEND_URL`, `TENANTS_BACKEND_URL`, `NEXT_PUBLIC_TENANT_PORTAL_URL`, `TENANT_ADMIN_SECRET`, `SMTP_*`, and `OUTREACH_DRAFTS_DIR`. Admin credential and SMTP values are secrets when configured. |
| Labs public site | Next site and embedded widget call Growth Core's website/chat API; its API URL may be configured at build/runtime. | 3007; no dedicated health route | `pnpm --dir apps/labs-site dev`, `build`, or `start` from its standalone app checkout | Source reads `CORE_API_BASE_URL`, `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_KASITEK_PUBLIC_API_URL`, and `NEXT_PUBLIC_KASITEK_CONTACT_EMAIL`. No app-level `.env.example` was present at inspection. |
| Agency portal and React API client | Portal sends same-origin proxy requests to Agency Tenant; Admin also calls Tenant directly for privileged provisioning. Tenant publishes to and queries Analytics. | Portal 3010; no dedicated UI health route. Tenant 8090; `GET /health` (also `/`). | From Agency repo, `pnpm --dir client dev` / `build`; Tenant `pnpm --dir server/kasitek-tenants dev`, `build`, then `start`. `KASITEK_PROCESS` selects API, Analytics publisher, or backfill mode. | `server/kasitek-tenants/.env.example` is the full service variable list; required database key is `TENANT_DATABASE_URL`. Credential names include `TENANT_ADMIN_SECRET`, `TENANT_RESEND_API_KEY`, `ANALYTICS_TENANT_INGESTION_TOKEN`, `ANALYTICS_REPORTING_PRIVATE_KEY`, and `ANALYTICS_REPORTING_RESOLVER_TOKEN`. Portal reads `NEXT_PUBLIC_TENANT_API_BASE_URL` and `TENANT_BACKEND_URL`. |
| Labs Analytics | Internal producers Growth, Agency and Agents call ingestion/reconciliation; Growth and Agency reporting consumers query it. The projection/maintenance worker uses the same Analytics database. | API 4300; `/health`, `/health/live`, `/health/ready`. Worker, migrate and registry commands do not expose HTTP health. | From Labs repo: `pnpm build:analytics`; then `pnpm start:analytics`, `pnpm start:analytics-worker`, `pnpm migrate:analytics`, or `pnpm registry:check:analytics`. | `services/analytics/.env.example` and `src-ts/config.ts`; `ANALYTICS_DATABASE_URL` is required. Ingestion credentials and reporting/resolver keys are conditionally required for their corresponding flows; Redis is optional and cache-only. |
| Agents UI and services | Vite UI proxies `/api` to Agents API; Agents API calls Growth Core for product actions and publishes events to Analytics. Gateway calls Agents API. Temporal, Discord, Analytics-publisher and other worker modes are separately started. | UI 3100 (strict port; no health route); API 4100 (`/health/live`, `/health/ready`); gateway 4200 (`/health`, `/health/ready`). Standalone workers have no HTTP health route. | From Agents repo: `pnpm dev`, `pnpm dev:api`, `pnpm dev:gateway`, `pnpm dev:worker`, `pnpm dev:discord`, `pnpm dev:analytics-publisher`; production equivalents are `build`, `build:ui`, `start:api`, `start:gateway`, `start:worker`, `start:discord`, and `start:analytics-publisher`. | Root `.env.example` plus UI `.env.example` (`AGENTS_API_PROXY_TARGET`). `AGENTS_DATABASE_URL` is required. Provider API keys are model/provider dependent; machine-auth names include `INTERNAL_AUTH_SECRET`, `KASITEK_CORE_INTERNAL_TOKEN`, `KASITEK_CORE_DELEGATION_PRIVATE_KEY`, and installation/gateway signing secrets. OAuth callback variables are listed below. |
| Shared login and local mail | Labs-owned native Keycloak provides Growth OIDC; Mailpit receives development mail. Keycloak has its own PostgreSQL cluster, separate from Growth's business database. | Keycloak 8080; readiness 9000 `/health/ready`; identity PostgreSQL 55432; Mailpit UI 8025 and SMTP 1025. | From `kasitek-labs/infra/identity`: `./identity.sh install` (explicit one-time local install), then `./identity.sh start`, `status`, `stop`. No Docker. | `infra/identity/.env.example` names Keycloak admin, identity DB, Google broker, and Growth client/session-admin secrets. `kasitek-growth/server/kasitek-core/.env.identity.example` names the Core OIDC settings. No values are recorded here. |

#### Callback and webhook targets

- Growth OIDC returns through the app at `http://localhost:3000/api/auth/callback`; Keycloak's Google broker callback is `http://localhost:8080/realms/kasitek/broker/google/endpoint`. Growth's backchannel logout target is `http://localhost:4000/api/auth/backchannel-logout`. Keycloak issuer and account-console URLs are in `infra/identity/README.md`.
- Growth email-provider redirect URIs are configured explicitly with `KASITEK_EMAIL_GOOGLE_REDIRECT_URI` and `KASITEK_EMAIL_MICROSOFT_REDIRECT_URI`; handlers are `/api/email/oauth/{provider}/callback`.
- Growth social-provider callbacks are based on `KASITEK_CORE_PUBLIC_URL` (local default `http://localhost:4000`) plus `/api/social/oauth/{meta,instagram,x,linkedin,threads,tiktok,bluesky}/callback`. Meta additionally registers `/api/webhooks/meta` and the Threads data-deletion endpoints.
- Growth inbound provider webhooks use the same Core public base URL: Paystack, WhatsApp, Meta, TikTok, Telegram, and Twilio callback routes are enumerated as `R0489`–`R0498` in `ROUTES.json`. Public-v1 outbound webhook destinations are user-configured and are not fixed callback URLs.
- Agents OIDC callback is `${AGENTS_PUBLIC_URL}/api/auth/callback`. Google, Microsoft and MCP integration redirects are explicit `GOOGLE_OAUTH_REDIRECT_URI`, `MICROSOFT_OAUTH_REDIRECT_URI`, and `MCP_OAUTH_REDIRECT_URI` values; provider callback handlers are registered in `kasitek-agents/src/http/app.ts`.
- Agency Tenant and Analytics have no third-party OAuth callback in the inspected service contract. Tenant email/invitation delivery is outbound; Analytics is consumed through authenticated internal HTTP routes.

Callback origins above describe local development only. The provider console registrations, external DNS, email delivery, and hosted callback origins are not verified here and remain outside the local implementation gate. The optional Collector uses OTLP gRPC 4317 / HTTP 4318 and health port 13133; it does not participate in request routing. Agents' optional Temporal default is localhost:7233. No services were started or stopped for this inventory.

Still required before claiming complete phase 0:

- Runtime baseline requests on synthetic data for status/error/body/cookie/stream/upload behavior.
- Full request DTO and response serialization fixtures; signatures identify DTOs but do not enumerate every nested field.
- Transitive authorization/effect review and one owner/destination/evidence decision for every route/process in parity records.
- Applied migration/checksum, current database schema, transaction rollback, queues and isolation evidence.
- Actual build/start/health/environment/deployment consumer validation, including unavailable-provider exceptions.

These gaps are explicit; the fixture provides a complete registration inventory rather than claiming that registration coverage proves functional parity.
